import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { gteWithEpoch } from "../src/lib/console-epoch";
import { estimateModelUsageCostUsd } from "../src/lib/model-usage-cost";
import { HOLD_PUBLISH_DECISIONS } from "../src/lib/project-visibility";
import { classifySchedulerFailures, isBudgetCapFailure, SCHEDULER_FAILURE_LOOKBACK_DAYS } from "../src/lib/scheduler-run-health";
import { createPrismaClient } from "./prisma-client";

// 派生incidentの遡及窓。これより前の失敗はincident化しない（lastSeenAt=nowで起票するため
// 窓が無いと過去の失敗が毎回「今起きた」incidentとして対応キューを埋めてしまう）。
// PRODIA_CONSOLE_EPOCH が設定されていれば、そのepochとこの窓の遅い方を下限にする。
// scheduler失敗の分類(scheduler-run-health)もこの窓と同じ値を共有する。
const DERIVED_INCIDENT_LOOKBACK_DAYS = SCHEDULER_FAILURE_LOOKBACK_DAYS;

// incident化する検証statusは「実際の失敗」のみ(表示側 console-summary と統一)。
// pending(未実行)や warn(助言/初期ロールアウトのhold)や high_risk_topic等の意図的ゲート結果を
// incident化すると、対応キューが「実障害でないもの」で埋まり総合状態が慢性的に異常になる。
const VALIDATION_FAILURE_STATUSES = ["fail", "failed", "error", "blocked"];

type GovernanceFinding = {
  id?: string;
  severity?: string;
  category?: string;
  targetType?: string;
  targetId?: string;
  recommendation?: string;
  proposedAction?: string;
  evidence?: unknown;
};

type GovernanceReport = {
  id?: string;
  generatedAt?: string;
  governanceAgentId?: string;
  overallStatus?: string;
  summary?: string;
  findings?: GovernanceFinding[];
};

type IncidentInput = {
  fingerprint: string;
  severity: string;
  source: string;
  impact: string;
  category: string;
  priority: string;
  nextAction?: string;
  title: string;
  summary?: string;
  runId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  notificationStatus?: string;
  metadata?: Record<string, unknown>;
};

const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 20)}`;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseDate = (value: string | undefined, fallback: Date) => {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : fallback;
};

const targetLinks = (finding: GovernanceFinding) => {
  const targetType = asString(finding.targetType);
  const targetId = asString(finding.targetId);
  return {
    targetType,
    targetId,
    projectId: targetType === "project" || targetId?.startsWith("proj_") ? targetId : undefined,
    runId: targetType === "run" || targetId?.startsWith("run_") ? targetId : undefined,
    agentId: targetType === "agent" || targetId?.startsWith("agent_") ? targetId : undefined,
  };
};

const incidentSeverityFromFinding = (severity: string) => {
  if (severity === "blocker" || severity === "critical") return "critical";
  if (severity === "high" || severity === "warning") return "warning";
  return "info";
};

const shouldOpenIncidentForFinding = (finding: GovernanceFinding, publishedProjectIds: Set<string>) => {
  const severity = (finding.severity ?? "").toLowerCase();
  const category = (finding.category ?? "").toLowerCase();
  const targetType = (finding.targetType ?? "").toLowerCase();
  const targetId = asString(finding.targetId);
  const proposedAction = (finding.proposedAction ?? "").toLowerCase();
  const publicationRisk =
    proposedAction === "hold_for_review" ||
    proposedAction === "withdrawal_review" ||
    category.includes("publish") ||
    category.includes("public") ||
    category.includes("evidence") ||
    category.includes("artifact") ||
    category.includes("provenance");
  return (
    ["blocker", "critical", "high"].includes(severity) &&
    targetType === "project" &&
    Boolean(targetId && publishedProjectIds.has(targetId)) &&
    publicationRisk
  );
};

const priorityForSeverity = (severity: string) => {
  if (severity === "critical" || severity === "blocker") return "P0";
  if (severity === "warning" || severity === "high") return "P1";
  return "P2";
};

const qualityImpactFromFinding = (finding: GovernanceFinding) => {
  const category = (finding.category ?? "").toLowerCase();
  const proposedAction = (finding.proposedAction ?? "").toLowerCase();
  if (category.includes("evidence") || category.includes("artifact") || category.includes("provenance")) {
    return "data_integrity";
  }
  if (proposedAction === "hold_for_review" || proposedAction === "withdrawal_review") {
    return "publish_risk";
  }
  return "quality_risk";
};

async function upsertIncident(prisma: PrismaClient, input: IncidentInput) {
  const now = new Date();
  const existing = await prisma.incident.findUnique({
    where: { fingerprint: input.fingerprint },
    select: { id: true, status: true, acknowledgedById: true },
  });

  const base = {
    severity: input.severity,
    source: input.source,
    impact: input.impact,
    category: input.category,
    priority: input.priority,
    nextAction: input.nextAction,
    title: input.title,
    summary: input.summary,
    runId: input.runId,
    projectId: input.projectId,
    agentId: input.agentId,
    lastSeenAt: now,
    notificationStatus: input.notificationStatus ?? "not_sent",
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : undefined,
  };

  if (existing) {
    // 人間が「解決」したincident(acknowledgedById がセットされる)は、同じ失敗を再検知しても
    // 復活させない。sync が自動resolveしたもの(acknowledgedById=null)だけ reopen する。
    const canReopen = existing.status === "resolved" && existing.acknowledgedById == null;
    return prisma.incident.update({
      where: { id: existing.id },
      data: {
        ...base,
        status: canReopen ? "open" : existing.status,
        // reopen時は前回のresolvedAtを消す(openなのにresolvedAtが残る不整合を防ぐ)。
        resolvedAt: canReopen ? null : undefined,
      },
    });
  }

  return prisma.incident.create({
    data: {
      id: stableId("incident", input.fingerprint),
      fingerprint: input.fingerprint,
      status: "open",
      firstSeenAt: now,
      ...base,
    },
  });
}

async function syncGovernanceReports(prisma: PrismaClient) {
  const reportDir = path.resolve(process.cwd(), "artifacts", "governance-reports");
  const entries = await readdir(reportDir, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      entries
        .filter((item) => item.isFile() && item.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(reportDir, entry.name);
          const [raw, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
          const report = JSON.parse(raw) as GovernanceReport;
          const reportId = report.id ?? path.basename(entry.name, ".json");
          return {
            filePath,
            raw,
            report,
            reportId,
            generatedAt: parseDate(report.generatedAt, fileStat.mtime),
          };
        }),
    )
  ).sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
  const latestReportId = files[0]?.reportId;
  const projectTargetIds = Array.from(
    new Set(
      files.flatMap(({ report }) =>
        (report.findings ?? [])
          .filter((finding) => (finding.targetType ?? "").toLowerCase() === "project")
          .map((finding) => asString(finding.targetId))
          .filter((targetId): targetId is string => Boolean(targetId)),
      ),
    ),
  );
  const publishedProjectIds = new Set(
    (
      await prisma.project.findMany({
        where: {
          id: { in: projectTargetIds },
          OR: [
            { status: "published" },
            { publishDecision: { in: ["published", "auto_published", "human_approved"] } },
            { publishedAt: { not: null } },
          ],
        },
        select: { id: true },
      })
    ).map((project) => project.id),
  );
  const activeQualityIncidentFingerprints = new Set<string>();
  let reportCount = 0;
  let findingCount = 0;
  let incidentCount = 0;

  for (const { filePath, raw, report, reportId, generatedAt } of files) {
    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

    await prisma.qualityReport.upsert({
      where: { id: reportId },
      create: {
        id: reportId,
        generatedAt,
        governanceAgentId: report.governanceAgentId,
        overallStatus: report.overallStatus ?? "unknown",
        summary: report.summary,
        reportPath: relativePath,
        rawJson: raw,
      },
      update: {
        generatedAt,
        governanceAgentId: report.governanceAgentId,
        overallStatus: report.overallStatus ?? "unknown",
        summary: report.summary,
        reportPath: relativePath,
        rawJson: raw,
      },
    });
    reportCount += 1;

    const syncedFindingIds: string[] = [];
    for (const [index, finding] of (report.findings ?? []).entries()) {
      const findingId = finding.id ?? stableId("quality_finding", `${reportId}:${index}`);
      syncedFindingIds.push(findingId);
      const severity = (finding.severity ?? "info").toLowerCase();
      const category = finding.category ?? "general";
      const links = targetLinks(finding);
      const summary =
        finding.recommendation ??
        finding.proposedAction ??
        `${category}${links.targetId ? ` / ${links.targetId}` : ""}`;
      let incidentId: string | undefined;
      const incidentFingerprint = `quality:${category}:${links.targetType ?? "unknown"}:${links.targetId ?? findingId}`;

      const shouldOpenIncident = shouldOpenIncidentForFinding(finding, publishedProjectIds);

      if (reportId === latestReportId && shouldOpenIncident) {
        activeQualityIncidentFingerprints.add(incidentFingerprint);
        const incident = await upsertIncident(prisma, {
          fingerprint: incidentFingerprint,
          severity: incidentSeverityFromFinding(severity),
          source: "quality_report",
          impact: qualityImpactFromFinding(finding),
          category,
          priority: priorityForSeverity(severity),
          nextAction: links.projectId ? "review_quality_project" : "review_quality_report",
          title: `Quality finding: ${category}`,
          summary,
          runId: links.runId,
          projectId: links.projectId,
          agentId: links.agentId,
          notificationStatus: severity === "blocker" ? "pending" : "not_sent",
          metadata: { reportId, findingId, severity, proposedAction: finding.proposedAction },
        });
        incidentId = incident.id;
        incidentCount += 1;
      }

      await prisma.qualityFinding.upsert({
        where: { id: findingId },
        create: {
          id: findingId,
          reportId,
          severity,
          category,
          targetType: links.targetType,
          targetId: links.targetId,
          projectId: links.projectId,
          runId: links.runId,
          agentId: links.agentId,
          summary,
          proposedAction: finding.proposedAction,
          status: shouldOpenIncident ? "open" : "observed",
          notificationStatus: incidentId ? "pending" : "not_required",
          incidentId,
          metadataJson: JSON.stringify({
            evidence: finding.evidence,
            recommendation: finding.recommendation,
          }),
        },
        update: {
          severity,
          category,
          targetType: links.targetType,
          targetId: links.targetId,
          projectId: links.projectId,
          runId: links.runId,
          agentId: links.agentId,
          summary,
          proposedAction: finding.proposedAction,
          status: shouldOpenIncident ? "open" : "observed",
          notificationStatus: incidentId ? "pending" : "not_required",
          incidentId,
          metadataJson: JSON.stringify({
            evidence: finding.evidence,
            recommendation: finding.recommendation,
          }),
        },
      });
      findingCount += 1;
    }

    // 同じレポートidを再syncしたとき、今回のレポートから消えたfinding（旧コードの偽陽性等）を
    // 剪定する。upsertだけだと孤児行が残り、コンソールの検出件数が過大表示になる。
    // findingが0件のレポートは notIn: [] が全件一致となり、そのレポートのfindingを全削除する。
    await prisma.qualityFinding.deleteMany({
      where: { reportId, id: { notIn: syncedFindingIds } },
    });
  }

  const freshnessThresholdMs = 24 * 60 * 60 * 1000;
  const latestGeneratedAt = files[0]?.generatedAt;
  const stalePatrolFingerprint = "quality:patrol:stale";
  if (!latestGeneratedAt || Date.now() - latestGeneratedAt.getTime() > freshnessThresholdMs) {
    activeQualityIncidentFingerprints.add(stalePatrolFingerprint);
    await upsertIncident(prisma, {
      fingerprint: stalePatrolFingerprint,
      severity: "warning",
      source: "quality_report",
      impact: "observability_gap",
      category: "quality_patrol_stale",
      priority: "P1",
      nextAction: "review_quality_report",
      title: "Quality patrol is stale",
      summary: latestGeneratedAt
        ? `Latest quality report is older than 24 hours: ${latestGeneratedAt.toISOString()}`
        : "No quality report has been synced.",
      notificationStatus: "not_sent",
      metadata: { latestGeneratedAt: latestGeneratedAt?.toISOString() ?? null, thresholdHours: 24 },
    });
    incidentCount += 1;
  }

  // sync が自動管理する open の quality incident のうち、今回activeでないものをresolveする。
  // 人間が確認/監視/解決したもの(acknowledged/monitoring/resolved)は触らない。
  const staleQualityIncidentWhere =
    activeQualityIncidentFingerprints.size > 0
      ? {
          source: "quality_report",
          status: "open",
          fingerprint: { notIn: [...activeQualityIncidentFingerprints] },
        }
      : {
          source: "quality_report",
          status: "open",
        };

  await prisma.incident.updateMany({
    where: staleQualityIncidentWhere,
    data: {
      status: "resolved",
      resolvedAt: new Date(),
    },
  });

  if (activeQualityIncidentFingerprints.size > 0) {
    await prisma.incident.updateMany({
      where: {
        source: "quality_report",
        fingerprint: { in: [...activeQualityIncidentFingerprints] },
        status: "resolved",
        // 人間が解決したもの(acknowledgedByセット済)は復活させない。sync自動resolve分のみreopen。
        acknowledgedById: null,
      },
      data: {
        status: "open",
        resolvedAt: null,
      },
    });
  }

  return { reportCount, findingCount, incidentCount };
}

async function syncDerivedIncidents(prisma: PrismaClient) {
  let incidentCount = 0;
  // 派生incidentのうち sync が自動管理する open のものを一旦resolvedにし、この後のupsertで
  // activeなものだけreopenさせる(quality側と同じ自己修復)。失敗が窓外に出た/再発しなくなった
  // incidentは自動クローズされる。人間が確認/監視/解決したもの(acknowledged/monitoring/resolved)は
  // ここで触らず、人間の判断を尊重する。
  await prisma.incident.updateMany({
    where: { source: { in: ["run", "scheduler", "validation", "usage"] }, status: "open" },
    data: { status: "resolved", resolvedAt: new Date() },
  });
  const lookbackStart = gteWithEpoch(
    new Date(Date.now() - DERIVED_INCIDENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
  );
  const [failedRuns, failedSchedulers, completedSchedulerMarkers, validationChecks, todayUsage] = await Promise.all([
    prisma.run.findMany({
      where: {
        OR: [{ status: "failed" }, { failedProjectCount: { gt: 0 } }],
        updatedAt: { gte: lookbackStart },
      },
      take: 100,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.schedulerRun.findMany({
      where: { status: "failed", startedAt: { gte: lookbackStart } },
      take: 100,
      orderBy: { startedAt: "desc" },
    }),
    // 回復判定(scheduler-run-health)用の成功マーカー。毎時レーン×7日でも数百行程度。
    prisma.schedulerRun.findMany({
      where: { status: "completed", startedAt: { gte: lookbackStart } },
      select: { scheduleName: true, startedAt: true },
      take: 1000,
      orderBy: { startedAt: "desc" },
    }),
    prisma.validationCheck.findMany({
      where: {
        status: { in: VALIDATION_FAILURE_STATUSES },
        createdAt: { gte: lookbackStart },
        // まだ人間の公開判断を待っている作品のみincident化する。公開済み(承認済)や取り下げ済みは
        // 決着済みで、対応キューに検証フラグを出しても手を打てない(=ノイズ)。held/pendingに限定。
        project: {
          OR: [{ status: "held_for_review" }, { publishDecision: { in: HOLD_PUBLISH_DECISIONS } }],
        },
      },
      take: 100,
      orderBy: { createdAt: "desc" },
    }),
    prisma.modelUsageLog.findMany({
      where: {
        provider: "google-gemini",
        createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) },
      },
      select: {
        id: true,
        model: true,
        operation: true,
        runId: true,
        step: true,
        agentId: true,
        requestId: true,
        status: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  ]);

  for (const run of failedRuns) {
    await upsertIncident(prisma, {
      fingerprint: `run:${run.id}`,
      severity: "critical",
      source: "run",
      impact: "generation_blocked",
      category: run.failedProjectCount > 0 ? "partial_generation_failed" : "run_failed",
      priority: "P0",
      nextAction: "open_run_trace",
      title: `Run failed: ${run.id}`,
      summary: run.errorMessage ?? run.summary ?? "Run failed or produced failed projects.",
      runId: run.id,
      notificationStatus: "pending",
      metadata: { status: run.status, failedProjectCount: run.failedProjectCount },
    });
    incidentCount += 1;
  }

  // 失敗SchedulerRunの分類(2026-07-10恒久対策)。一過性の失敗が7日間P0として残り、
  // 手動DB操作(neutralize-failed-scheduler-runs.ts)でしか消せなかった事故への対応:
  //  - recovered: その後に同scheduleの成功がある = incident化しない(冒頭のblanket
  //    auto-resolveが既存incidentを自動クローズする)。
  //  - budgetCapped: 予算上限による想定内の遮断 = P2(対応キュー/総合状態に乗せない)。
  //  - active: 未回復の実失敗 = 単発はP1。P0は下のscheduler_repeated_failure(繰り返し)に
  //    予約する(validationゲートと同じ「P0=生成停止・公開事故・コスト超過」方針)。
  const classifiedSchedulerFailures = classifySchedulerFailures(failedSchedulers, completedSchedulerMarkers);
  for (const run of classifiedSchedulerFailures.active) {
    await upsertIncident(prisma, {
      fingerprint: `scheduler:${run.id}`,
      severity: "warning",
      source: "scheduler",
      impact: "generation_blocked",
      category: "scheduler_failed",
      priority: "P1",
      nextAction: "check_scheduler_run",
      title: `Scheduler failed: ${run.scheduleName}`,
      summary: run.errorMessage ?? run.reason ?? "Scheduler run failed.",
      runId: run.runId,
      notificationStatus: "pending",
      metadata: { schedulerRunId: run.id, source: run.source, planner: run.planner },
    });
    incidentCount += 1;
  }

  for (const run of classifiedSchedulerFailures.budgetCapped) {
    await upsertIncident(prisma, {
      fingerprint: `scheduler:${run.id}`,
      severity: "warning",
      source: "scheduler",
      impact: "cost_risk",
      category: "scheduler_budget_capped",
      priority: "P2",
      nextAction: "review_usage",
      title: `Scheduler paused by daily budget cap: ${run.scheduleName}`,
      summary: run.errorMessage ?? "Daily Gemini budget cap reached; the lane resumes after the UTC day rollover.",
      runId: run.runId,
      notificationStatus: "not_sent",
      metadata: { schedulerRunId: run.id, source: run.source, planner: run.planner },
    });
    incidentCount += 1;
  }

  const repeatedSchedulerFailureThreshold = Number(process.env.SCHEDULER_REPEATED_FAILURE_THRESHOLD ?? 3);
  if (Number.isFinite(repeatedSchedulerFailureThreshold) && repeatedSchedulerFailureThreshold > 1) {
    // 繰り返し失敗の検知は回復済みも含めた「窓内の全失敗」を母数にする(フラッピング検知)。
    // ただし予算上限の遮断は想定内なので繰り返してもP0にしない。
    const repeatedFailureCandidates = failedSchedulers.filter((run) => !isBudgetCapFailure(run.errorMessage));
    const failuresBySchedule = repeatedFailureCandidates.reduce((groups, run) => {
      const key = run.scheduleName || "unknown";
      const group = groups.get(key) ?? [];
      group.push(run);
      groups.set(key, group);
      return groups;
    }, new Map<string, typeof failedSchedulers>());

    for (const [scheduleName, failures] of failuresBySchedule) {
      if (failures.length < repeatedSchedulerFailureThreshold) continue;
      const latestFailure = failures[0];
      await upsertIncident(prisma, {
        fingerprint: `scheduler:${scheduleName}:repeated_failed`,
        severity: "critical",
        source: "scheduler",
        impact: "generation_blocked",
        category: "scheduler_repeated_failure",
        priority: "P0",
        nextAction: "check_scheduler_run",
        title: `Scheduler repeatedly failed: ${scheduleName}`,
        summary: `${failures.length} failed scheduler run(s) in the recent window.`,
        runId: latestFailure?.runId,
        notificationStatus: "pending",
        metadata: {
          scheduleName,
          threshold: repeatedSchedulerFailureThreshold,
          failureCount: failures.length,
          latestSchedulerRunId: latestFailure?.id,
        },
      });
      incidentCount += 1;
    }
  }

  for (const check of validationChecks) {
    await upsertIncident(prisma, {
      fingerprint: `validation:${check.id}`,
      // 個別プロダクトの検証失敗はレビュー項目=P1/warning。P0(至急=生成停止・公開事故・
      // コスト超過)は run/scheduler/コストのシステム障害に予約する(対応キューの意味を保つ)。
      severity: "warning",
      source: "validation",
      impact: "publish_risk",
      category: "validation_failed",
      priority: "P1",
      nextAction: "review_validation",
      title: `Validation check: ${check.key}`,
      summary: check.summary ?? `Validation status is ${check.status}.`,
      runId: check.runId,
      projectId: check.projectId,
      notificationStatus: "not_sent",
      metadata: { validationCheckId: check.id, status: check.status },
    });
    incidentCount += 1;
  }

  // 監視しきい値(全レーン合算)。遮断用の GEMINI_DAILY_MAX_COST_USD とは別枠。console:sync は
  // scheduler jobの中で動くため、ここで遮断envを使うと監視と遮断が同値に縛られてしまう。
  const dailyMaxCostUsd = Number(process.env.PRODIA_CONSOLE_DAILY_COST_ALERT_USD ?? 70);
  const dailyCost = todayUsage.reduce((sum, row) => sum + estimateModelUsageCostUsd(row), 0);
  if (Number.isFinite(dailyMaxCostUsd) && dailyMaxCostUsd > 0 && dailyCost >= dailyMaxCostUsd * 0.7) {
    await upsertIncident(prisma, {
      fingerprint: `usage:google-gemini:${new Date().toISOString().slice(0, 10)}`,
      severity: dailyCost >= dailyMaxCostUsd ? "critical" : "warning",
      source: "usage",
      impact: "cost_risk",
      category: dailyCost >= dailyMaxCostUsd ? "daily_cost_exceeded" : "daily_cost_warning",
      priority: dailyCost >= dailyMaxCostUsd ? "P0" : "P1",
      nextAction: "review_usage",
      title: "Gemini usage is approaching the daily cap",
      summary: `$${dailyCost.toFixed(2)} / $${dailyMaxCostUsd.toFixed(2)}`,
      notificationStatus: dailyCost >= dailyMaxCostUsd ? "pending" : "not_sent",
      metadata: { dailyCost, dailyMaxCostUsd, requestCount: todayUsage.length },
    });
    incidentCount += 1;
  }

  const retryFailureThreshold = Number(process.env.MODEL_USAGE_RETRY_FAILURE_THRESHOLD ?? 3);
  const failedUsageRows = todayUsage.filter((row) => !["success", "ok", "pass", "passed"].includes(row.status.toLowerCase()));
  if (Number.isFinite(retryFailureThreshold) && retryFailureThreshold > 1) {
    const failuresByOperation = failedUsageRows.reduce((groups, row) => {
      const key = [row.operation, row.step ?? "unknown_step", row.runId ?? "unknown_run"].join(":");
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
      return groups;
    }, new Map<string, typeof failedUsageRows>());

    for (const [key, failures] of failuresByOperation) {
      if (failures.length < retryFailureThreshold) continue;
      const latestFailure = failures.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      await upsertIncident(prisma, {
        fingerprint: `usage:retry_waste:${new Date().toISOString().slice(0, 10)}:${key}`,
        severity: "warning",
        source: "usage",
        impact: "cost_risk",
        category: "model_retry_waste",
        priority: "P1",
        nextAction: "review_usage",
        title: "Model usage has repeated failed requests",
        summary: `${failures.length} failed request(s) for ${latestFailure.operation}/${latestFailure.step ?? "unknown step"}.`,
        runId: latestFailure.runId,
        agentId: latestFailure.agentId,
        notificationStatus: "not_sent",
        metadata: {
          threshold: retryFailureThreshold,
          failureCount: failures.length,
          operation: latestFailure.operation,
          step: latestFailure.step,
          model: latestFailure.model,
          latestRequestId: latestFailure.requestId,
          latestErrorMessage: latestFailure.errorMessage,
        },
      });
      incidentCount += 1;
    }
  }

  const stepCostWarningUsd = Number(process.env.PRODIA_CONSOLE_STEP_COST_ALERT_USD ?? 10);
  if (Number.isFinite(stepCostWarningUsd) && stepCostWarningUsd > 0) {
    const costByStep = todayUsage.reduce((groups, row) => {
      const key = [row.model, row.operation, row.step ?? "unknown_step", row.runId ?? "unknown_run"].join(":");
      const current = groups.get(key) ?? {
        model: row.model,
        operation: row.operation,
        step: row.step,
        runId: row.runId,
        agentId: row.agentId,
        cost: 0,
        requestCount: 0,
      };
      current.cost += estimateModelUsageCostUsd(row);
      current.requestCount += 1;
      groups.set(key, current);
      return groups;
    }, new Map<string, { model: string; operation: string; step: string | null; runId: string | null; agentId: string | null; cost: number; requestCount: number }>());

    for (const [key, group] of costByStep) {
      if (group.cost < stepCostWarningUsd) continue;
      await upsertIncident(prisma, {
        fingerprint: `usage:high_cost_step:${new Date().toISOString().slice(0, 10)}:${key}`,
        severity: "warning",
        source: "usage",
        impact: "cost_risk",
        category: "high_cost_model_step",
        priority: "P1",
        nextAction: "review_usage",
        title: "Model usage has a high-cost step",
        summary: `$${group.cost.toFixed(2)} for ${group.operation}/${group.step ?? "unknown step"}.`,
        runId: group.runId,
        agentId: group.agentId,
        notificationStatus: "not_sent",
        metadata: {
          thresholdUsd: stepCostWarningUsd,
          costUsd: group.cost,
          requestCount: group.requestCount,
          model: group.model,
          operation: group.operation,
          step: group.step,
        },
      });
      incidentCount += 1;
    }
  }

  return { incidentCount };
}

async function main() {
  const prisma = createPrismaClient();
  try {
    const [governance, derived] = await Promise.all([
      syncGovernanceReports(prisma),
      syncDerivedIncidents(prisma),
    ]);
    console.log(
      JSON.stringify(
        {
          ok: true,
          governance,
          derived,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/sync-console-observability.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
