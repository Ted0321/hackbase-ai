import Link from "next/link";
import { buildAgentPublicTags } from "@/lib/agent-public-tags";
import { adminWriteKeyConfigured, adminWriteRequiresKey, consoleReadOnly } from "@/lib/admin-auth";
import { ConsoleReadOnlyNotice } from "./console-readonly-note";
import { readAdminAgentRegistryWithContracts } from "@/lib/agent-operating-contract-store";
import { getConsoleLogEpoch, gteWithEpoch } from "@/lib/console-epoch";
import { consoleIncidentHref, readConsoleSummary } from "@/lib/console-summary";
import { prisma } from "@/lib/db";
import { formatDateTimeJst, formatShortDateTimeJst } from "@/lib/format-datetime";
import { estimateModelUsageCostUsd, type ModelUsageCostInput } from "@/lib/model-usage-cost";
import { activeProjectWhere, publishDecisionLabel } from "@/lib/project-visibility";
import { readSchedulerStateRecord } from "@/lib/scheduler-state";
import { AppFooter, AppHeader } from "../shared-chrome";
import styles from "../detail.module.css";
import { updateIncidentStatusAction } from "./actions";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ demo?: string; incident?: string; reason?: string; view?: string }>;
};

type SchedulerState = {
  lastCompletedAt?: string;
  lastRunId?: string;
  lastStatus?: string;
  nextDueAt?: string;
  configuredSource?: string;
  planner?: string;
  limit?: number;
  agents?: Record<
    string,
    {
      lastCompletedAt?: string;
      lastRunId?: string;
      lastStatus?: string;
      lastError?: string;
      nextDueAt?: string;
    }
  >;
};

const VIEW_KEYS = ["overview", "incidents", "runs", "products", "quality", "agents", "usage", "external"] as const;

type ViewKey = (typeof VIEW_KEYS)[number];

// 導線から外して非表示にするビュー。ページ構造・データ・描画ブロックは残したまま、
// ナビゲーションからのリンクと直URL(?view=usage)アクセスの両方を塞ぐ。将来復帰させるときは
// この配列を空にするだけでよい（VIEW_KEYS と usage 描画ブロックは温存している）。
// usage(利用量/Token・Cost): コストが生々しく外部公開したくないため一時的に非表示。
const HIDDEN_NAV_KEYS: ViewKey[] = ["usage"];

const isHiddenViewKey = (value: ViewKey): boolean => HIDDEN_NAV_KEYS.includes(value);

// 非表示ビューへ deep-link する導線(インシデントCTA等)が /human?view=<hidden> を指していないか判定する。
// /human は未認証で誰でも閲覧できるため、隠したページ(利用量)への入口はラベルごと中立化して残さない。
const hrefTargetsHiddenView = (href: string): boolean => {
  const match = /[?&]view=([a-zA-Z]+)/.exec(href);
  return !!match && HIDDEN_NAV_KEYS.includes(match[1] as ViewKey);
};

const isViewKey = (value?: string): value is ViewKey =>
  VIEW_KEYS.includes(value as ViewKey);

const formatElapsed = (from: Date | string | null | undefined, now: Date) => {
  if (!from) return "なし";
  const timestamp = from instanceof Date ? from.getTime() : Date.parse(from);
  if (!Number.isFinite(timestamp)) return "不明";
  const hours = Math.max(0, Math.floor((now.getTime() - timestamp) / (60 * 60 * 1000)));
  if (hours >= 24) return `${Math.floor(hours / 24)}日`;
  return `${hours}時間`;
};

const formatDuration = (value?: number | null) => {
  if (value == null) return "-";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 100) / 10}s`;
};

const formatCost = (value: number) => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const formatTokens = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
};

const runStatusLabel = (status: string) => {
  if (status === "completed") return "完了";
  if (status === "failed") return "失敗";
  if (status === "running") return "実行中";
  return status;
};

const overallStatusLabel = (status: "healthy" | "warning" | "critical") => {
  if (status === "critical") return "異常";
  if (status === "warning") return "注意";
  return "正常";
};

const overallReasonLabel = (summary: {
  overall: {
    status: "healthy" | "warning" | "critical";
    p0IncidentCount: number;
    p1IncidentCount: number;
    monitoringIncidentCount: number;
  };
  usage: {
    warning: boolean;
    critical: boolean;
  };
}) => {
  if (summary.overall.status === "critical") {
    if (summary.overall.p0IncidentCount > 0) {
      return `P0が${summary.overall.p0IncidentCount}件あります`;
    }
    if (summary.usage.critical) return "本日のLLM利用コストが日次上限を超過しています";
    return "至急対応が必要な異常があります";
  }
  if (summary.overall.status === "warning") {
    if (summary.overall.p1IncidentCount > 0 || summary.overall.monitoringIncidentCount > 0) {
      return `P1が${summary.overall.p1IncidentCount}件、監視中が${summary.overall.monitoringIncidentCount}件あります`;
    }
    if (summary.usage.warning) return "本日のLLM利用コストが注意ラインを超えています";
    return "注意状態ですが、至急対応のP0はありません";
  }
  return "至急確認が必要な項目はありません";
};

const incidentStatusLabel = (status: string) => {
  if (status === "open") return "未確認";
  if (status === "acknowledged") return "確認済み";
  if (status === "monitoring") return "監視中";
  if (status === "resolved") return "解決済み";
  return status;
};

const qualityStatusLabel = (status?: string | null) => {
  if (!status) return "未生成";
  if (status === "clear") return "正常";
  if (status === "needs_review") return "要確認";
  if (status === "hold_recommended") return "注意";
  if (status === "blocked") return "異常";
  return status;
};

const severityClass = (severity?: string | null) => {
  if (severity === "critical" || severity === "blocker") return styles.opsChipCritical;
  if (severity === "warning" || severity === "high") return styles.opsChipWarning;
  return styles.opsChipNeutral;
};

const statusClass = (status?: string | null) => {
  if (status === "completed" || status === "success" || status === "pass" || status === "active") {
    return styles.opsChipOk;
  }
  if (status === "failed" || status === "error" || status === "critical" || status === "blocked") {
    return styles.opsChipCritical;
  }
  if (
    status === "running" ||
    status === "open" ||
    status === "warning" ||
    status === "needs_review" ||
    status === "hold_recommended"
  ) {
    return styles.opsChipWarning;
  }
  return styles.opsChipNeutral;
};

const priorityClass = (priority?: string | null) => {
  if (priority === "P0") return styles.opsChipCritical;
  if (priority === "P1" || priority === "MON") return styles.opsChipWarning;
  return styles.opsChipNeutral;
};

const nextActionLabel = (nextAction?: string | null) => {
  if (nextAction === "review_quality_project") return "Qualityへ";
  if (nextAction === "review_quality_report") return "Qualityへ";
  if (nextAction === "review_usage") return "Usageへ";
  if (nextAction === "open_run_trace") return "詳細ログへ";
  if (nextAction === "check_scheduler_run") return "Incidentsへ";
  if (nextAction === "review_validation") return "Qualityへ";
  return "詳細へ";
};

const incidentHref = (incident: {
  nextAction?: string | null;
  runId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
}) => consoleIncidentHref(incident);

const IncidentAdminFields = ({ incidentId }: { incidentId: string }) => (
  <>
    <input name="incidentId" type="hidden" value={incidentId} />
    <input name="adminName" type="hidden" value="Local Admin" />
    {adminWriteKeyConfigured() || adminWriteRequiresKey() ? (
      <label className={styles.opsIncidentKeyField}>
        <span>admin key</span>
        <input name="adminWriteKey" type="password" placeholder="required" />
      </label>
    ) : null}
  </>
);

const rollupUsage = (rows: ModelUsageCostInput[]) => ({
  tokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
  cost: rows.reduce((sum, row) => sum + estimateModelUsageCostUsd(row), 0),
});

const usageBy = <T extends ModelUsageCostInput>(
  rows: T[],
  keyOf: (row: T) => string | null | undefined,
) => {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const label = keyOf(row) || "unknown";
    buckets.set(label, [...(buckets.get(label) ?? []), row]);
  }
  return [...buckets.entries()]
    .map(([label, items]) => ({ label, ...rollupUsage(items) }))
    .sort((a, b) => b.cost - a.cost);
};

export default async function HumanConsole({ searchParams }: PageProps) {
  const resolvedSearchParams = await searchParams;
  const viewParam = resolvedSearchParams?.view;
  // 非表示ビューへの直URLアクセス(?view=usage 等)は overview へフォールバックさせる。
  const requestedView: ViewKey = isViewKey(viewParam) ? viewParam : "overview";
  const activeView: ViewKey = isHiddenViewKey(requestedView) ? "overview" : requestedView;
  const incidentUpdateStatus = resolvedSearchParams?.incident;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dailyCostCap = Number(process.env.PRODIA_CONSOLE_DAILY_COST_ALERT_USD ?? 70);
  const logEpoch = getConsoleLogEpoch();

  const [
    agents,
    agentContracts,
    recentRuns,
    recentProducts,
    openIncidents,
    qualityReports,
    sevenDayUsageRows,
    runtimeMetrics,
    failedSchedulerRuns,
    runEventCount,
    artifactCount,
    agentSchedulerState,
    contractRegistry,
    consoleSummary,
  ] = await Promise.all([
    prisma.agent.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        oneLiner: true,
        active: true,
        updatedAt: true,
        primaryCategory: {
          select: { name: true },
        },
        _count: {
          select: {
            projects: { where: activeProjectWhere },
          },
        },
      },
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.agentOperatingContract.findMany({
      select: {
        agentId: true,
        status: true,
        role: true,
        updatedAt: true,
        activatedAt: true,
      },
    }),
    prisma.run.findMany({
      where: logEpoch ? { createdAt: { gte: logEpoch } } : {},
      include: {
        _count: {
          select: {
            artifacts: true,
            events: true,
            projects: true,
            validationChecks: true,
          },
        },
        projects: {
          where: activeProjectWhere,
          select: {
            id: true,
            title: true,
            status: true,
            publishDecision: true,
            validationStatus: true,
          },
          orderBy: { createdAt: "desc" },
          take: 3,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.project.findMany({
      where: activeProjectWhere,
      include: {
        agent: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        category: {
          select: { name: true },
        },
        run: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
        },
        validations: {
          select: {
            status: true,
            summary: true,
            checkedAt: true,
          },
          orderBy: { checkedAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            artifacts: true,
            validationChecks: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 24,
    }),
    prisma.incident.findMany({
      where: {
        status: { notIn: ["resolved", "ignored"] },
        ...(logEpoch ? { lastSeenAt: { gte: logEpoch } } : {}),
      },
      orderBy: [{ lastSeenAt: "desc" }],
      take: 20,
    }),
    prisma.qualityReport.findMany({
      where: logEpoch ? { generatedAt: { gte: logEpoch } } : {},
      include: {
        findings: {
          orderBy: { createdAt: "desc" },
          take: 8,
        },
      },
      orderBy: { generatedAt: "desc" },
      take: 5,
    }),
    prisma.modelUsageLog.findMany({
      where: { createdAt: { gte: gteWithEpoch(sevenDaysAgo) } },
      orderBy: { createdAt: "desc" },
      take: 3000,
    }),
    prisma.agentRuntimeMetric.findMany({
      where: { eventType: "self_directed_run", ...(logEpoch ? { createdAt: { gte: logEpoch } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 160,
    }),
    prisma.schedulerRun.findMany({
      where: { status: "failed", ...(logEpoch ? { startedAt: { gte: logEpoch } } : {}) },
      orderBy: { startedAt: "desc" },
      take: 5,
    }),
    prisma.runEvent.count({ where: logEpoch ? { createdAt: { gte: logEpoch } } : {} }),
    prisma.artifact.count({ where: logEpoch ? { createdAt: { gte: logEpoch } } : {} }),
    readSchedulerStateRecord<SchedulerState>(prisma, "agent-creation-daily"),
    readAdminAgentRegistryWithContracts(prisma),
    readConsoleSummary(prisma, { now, dailyCostCapUsd: dailyCostCap }),
  ]);

  const contractsByAgent = new Map(agentContracts.map((contract) => [contract.agentId, contract]));
  const contractProfileById = new Map(contractRegistry.agents.map((profile) => [profile.agentId, profile] as const));
  const latestQualityReport = qualityReports[0];
  const p0IncidentCount = consoleSummary.overall.p0IncidentCount;
  const p1IncidentCount = consoleSummary.overall.p1IncidentCount;
  const monitoringIncidentCount = consoleSummary.overall.monitoringIncidentCount;
  const sevenDayUsage = rollupUsage(sevenDayUsageRows);
  const overallLevel = overallStatusLabel(consoleSummary.overall.status);
  const overallClass =
    consoleSummary.overall.status === "critical"
      ? styles.opsStatusCritical
      : consoleSummary.overall.status === "warning"
        ? styles.opsStatusWarning
        : styles.opsStatusOk;
  const overallReason = overallReasonLabel(consoleSummary);

  const runtimeByAgent = new Map<string, (typeof runtimeMetrics)[number]>();
  for (const metric of runtimeMetrics) {
    if (!runtimeByAgent.has(metric.agentId)) {
      runtimeByAgent.set(metric.agentId, metric);
    }
  }

  const runtimeHistoryByAgent = new Map<string, Array<(typeof runtimeMetrics)[number]>>();
  for (const metric of runtimeMetrics) {
    runtimeHistoryByAgent.set(metric.agentId, [...(runtimeHistoryByAgent.get(metric.agentId) ?? []), metric]);
  }

  const agentRows = agents.map((agent) => {
    const runtime = runtimeByAgent.get(agent.id);
    const dueState = agentSchedulerState?.agents?.[agent.id];
    const history = runtimeHistoryByAgent.get(agent.id) ?? [];
    const firstRecoveredIndex = history.findIndex((metric) => !["failed", "error"].includes(metric.status));
    const contract = contractsByAgent.get(agent.id);
    const publicTags = buildAgentPublicTags({
      profile: contractProfileById.get(agent.id),
      max: 4,
      maxArtifacts: 2,
      maxSpecialties: 2,
    });

    return {
      agent,
      runtime,
      dueState,
      contract,
      publicTags,
      consecutiveFailures: firstRecoveredIndex === -1 ? history.length : Math.max(0, firstRecoveredIndex),
      status: !agent.active
        ? "paused"
        : runtime?.status === "failed" || dueState?.lastStatus === "failed"
          ? "error"
          : runtime?.status ?? dueState?.lastStatus ?? contract?.status ?? "not_recorded",
    };
  });

  // step未記録の行(画像・コメント生成等)が「unknown」1本に混ざらないようoperationへフォールバック
  const usageStepRows = usageBy(sevenDayUsageRows, (row) => row.step ?? row.operation).slice(0, 6);
  const usageModelRows = usageBy(sevenDayUsageRows, (row) => row.model).slice(0, 5);
  const highCostRows = [...sevenDayUsageRows]
    .map((row) => ({ row, cost: estimateModelUsageCostUsd(row) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);

  const activeAgentsCount = consoleSummary.agents.activeCount;
  const abnormalQualityReports = consoleSummary.patrol.overallStatus && consoleSummary.patrol.overallStatus !== "clear" ? 1 : 0;
  const patrolGeneratedAt = consoleSummary.patrol.latestGeneratedAt;
  const patrolStale = patrolGeneratedAt
    ? now.getTime() - patrolGeneratedAt.getTime() > 24 * 60 * 60 * 1000
    : false;
  const recentAutoPublishedProducts = recentProducts
    .filter((product) => product.status === "auto_published")
    .slice(0, 6);
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const runningRunCount = recentRuns.filter((run) => run.status === "running").length;
  const oldestHeldCreatedAt = consoleSummary.projects.oldestHeldCreatedAt;
  const oldestHeldOver24h = oldestHeldCreatedAt ? oldestHeldCreatedAt.getTime() < last24Hours.getTime() : false;
  const recentRunScale = recentRuns.reduce(
    (acc, run) => ({
      projects: acc.projects + run.generatedProjectCount,
      published: acc.published + run.publishedProjectCount,
      failed: acc.failed + run.failedProjectCount,
      artifacts: acc.artifacts + run._count.artifacts,
      checks: acc.checks + run._count.validationChecks,
      events: acc.events + run._count.events,
    }),
    { projects: 0, published: 0, failed: 0, artifacts: 0, checks: 0, events: 0 },
  );
  const recentRuntimeAgentIds = new Set(
    runtimeMetrics
      .filter((metric) => metric.createdAt >= last24Hours)
      .map((metric) => metric.agentId)
      .filter(Boolean),
  );
  const recentAgentNames = recentProducts
    .filter((product) => recentRuntimeAgentIds.has(product.agentId))
    .map((product) => product.agent.name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .slice(0, 3);
  const latestProject = recentProducts[0];
  const navItems: Array<{ key: ViewKey; label: string; helper: string; count: string }> = [
    { key: "overview", label: "概要", helper: "全体状況", count: overallLevel },
    { key: "incidents", label: "対応", helper: "対応キュー", count: String(consoleSummary.overall.actionCount) },
    { key: "runs", label: "Run", helper: "生成履歴", count: String(consoleSummary.runs.totalCount) },
    { key: "products", label: "プロダクト", helper: "一覧", count: String(consoleSummary.projects.totalActiveCount) },
    { key: "quality", label: "巡回", helper: "品質レポート", count: consoleSummary.patrol.latestReportId ? String(abnormalQualityReports) : "–" },
    { key: "agents", label: "Agent", helper: "稼働サマリー", count: String(activeAgentsCount) },
    { key: "usage", label: "利用量", helper: "Token/Cost", count: formatCost(consoleSummary.usage.todayCostUsd) },
    { key: "external", label: "外部確認", helper: "GCP / DB", count: String(consoleSummary.runs.failedSchedulerRunCount) },
  ];
  const navHelperLabels: Record<ViewKey, string> = {
    overview: "全体状況",
    incidents: "対応キュー",
    runs: "生成履歴",
    products: "プロダクト一覧",
    quality: "巡回レポート",
    agents: "稼働サマリー",
    usage: "Token/Cost",
    external: "失敗Scheduler",
  };
  const displayNavItems = navItems
    .filter((item) => !isHiddenViewKey(item.key))
    .map((item) => ({
      ...item,
      helper: navHelperLabels[item.key],
    }));
  const consoleLatestRun = consoleSummary.runs.latest;
  const consoleLatestRunningRun = consoleSummary.runs.latestRunning;
  const consoleLatestSuccessfulRun = consoleSummary.runs.latestSuccessful;
  const schedulerLanes = [
    { label: "Research更新", state: consoleSummary.scheduler.researchCache },
    { label: "Agent生成", state: consoleSummary.scheduler.agentCreation },
    { label: "Agent交流", state: consoleSummary.scheduler.agentInteractions },
    { label: "品質巡回steward", state: consoleSummary.scheduler.steward },
  ];
  const laneCompletedAtMs = (lane: (typeof schedulerLanes)[number]) => {
    const parsed = Date.parse(lane.state?.lastCompletedAt ?? "");
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  const latestSchedulerLane =
    schedulerLanes
      .filter((lane) => laneCompletedAtMs(lane) > -Infinity)
      .sort((a, b) => laneCompletedAtMs(b) - laneCompletedAtMs(a))[0] ?? null;

  const selectedView = (() => {
    if (activeView === "incidents") {
      return (
        <section className={styles.opsViewStack}>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Incident Queue</p>
                <h2>未解決エラー</h2>
                <p>Open incidents. 対応が必要なエラーと監視中の項目を優先度順に確認します。</p>
              </div>
              <span>{openIncidents.length}件 open</span>
            </div>
            {incidentUpdateStatus ? (
              <p className={styles.opsNotice}>Incidentを{incidentStatusLabel(incidentUpdateStatus)}に更新しました。</p>
            ) : null}
            <div className={styles.opsMetricGrid}>
              <div className={`${styles.opsMetric} ${consoleSummary.overall.actionCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>対応キュー</span>
                <strong>{consoleSummary.overall.actionCount}</strong>
                <small>Human Adminが見る項目</small>
              </div>
              <div className={`${styles.opsMetric} ${p0IncidentCount > 0 ? styles.opsStatusCritical : ""}`}>
                <span>P0 / 即時確認</span>
                <strong>{p0IncidentCount}</strong>
                <small>即時確認</small>
              </div>
              <div className={`${styles.opsMetric} ${p1IncidentCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>P1 / 要確認</span>
                <strong>{p1IncidentCount}</strong>
                <small>次回運用確認</small>
              </div>
              <div className={`${styles.opsMetric} ${monitoringIncidentCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>監視中</span>
                <strong>{monitoringIncidentCount}</strong>
                <small>再発監視中</small>
              </div>
            </div>
            <div className={styles.opsRows}>
              {openIncidents.length === 0 ? (
                <p className={styles.opsEmptyState}>未解決Incidentはありません。</p>
              ) : (
                openIncidents.map((incident) => (
                  <article className={`${styles.opsRow} ${styles.opsIncidentRow}`} key={incident.id}>
                    <span className={`${styles.opsChip} ${severityClass(incident.severity)}`}>
                      {incident.severity}
                    </span>
                    <div>
                      <strong>{incident.title}</strong>
                      <small>{incident.summary ?? incident.fingerprint}</small>
                    </div>
                    <div>
                      <strong>{incident.source}</strong>
                      <small>{formatDateTimeJst(incident.lastSeenAt)}</small>
                    </div>
                    <span className={`${styles.opsChip} ${statusClass(incident.status)}`}>
                      {incidentStatusLabel(incident.status)}
                    </span>
                    <div className={styles.opsIncidentActions}>
                      <Link
                        className={styles.opsPrimaryAction}
                        href={incident.runId ? `/human/runs/${incident.runId}` : incident.projectId ? `/human/projects/${incident.projectId}` : "/human?view=incidents"}
                      >
                        詳細
                      </Link>
                      {consoleReadOnly() ? (
                        <ConsoleReadOnlyNotice label="審査用環境のため、Incident操作は無効化されています（閲覧のみ）。" />
                      ) : (
                        <>
                          <form action={updateIncidentStatusAction}>
                            <IncidentAdminFields incidentId={incident.id} />
                            <input name="intent" type="hidden" value="acknowledge" />
                            <button className={styles.opsSecondaryAction} type="submit">
                              対応開始
                            </button>
                          </form>
                          <form action={updateIncidentStatusAction}>
                            <IncidentAdminFields incidentId={incident.id} />
                            <input name="intent" type="hidden" value="monitor" />
                            <button className={styles.opsSecondaryAction} type="submit">
                              監視
                            </button>
                          </form>
                          <form action={updateIncidentStatusAction}>
                            <IncidentAdminFields incidentId={incident.id} />
                            <input name="intent" type="hidden" value="resolve" />
                            <button className={styles.opsSecondaryAction} type="submit">
                              解決
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>
      );
    }

    if (activeView === "runs") {
      return (
        <section className={styles.opsViewStack}>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Runs And Evidence</p>
                <h2>生成Runの履歴</h2>
                <p>Generation runs. 生成・公開・失敗・証跡の状態をRun単位で確認します。</p>
              </div>
              <span>エポック以降の累計 {runEventCount} event / {artifactCount} artifact</span>
            </div>
            <div className={styles.opsMetricGrid}>
              <div className={`${styles.opsMetric} ${consoleLatestRun ? statusClass(consoleLatestRun.status) : ""}`}>
                <span>最新Run</span>
                <strong>{consoleLatestRun?.status ?? "none"}</strong>
                <small>{consoleLatestRun?.id ?? "runなし"}</small>
              </div>
              <div className={styles.opsMetric}>
                <span>最新成功Run</span>
                <strong>{consoleLatestSuccessfulRun?.id ?? "none"}</strong>
                <small>{consoleLatestSuccessfulRun ? formatShortDateTimeJst(consoleLatestSuccessfulRun.completedAt) : "成功runなし"}</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.runs.failedSchedulerRunCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>失敗Scheduler</span>
                <strong>{consoleSummary.runs.failedSchedulerRunCount}</strong>
                <small>external tabで確認</small>
              </div>
              <div className={styles.opsMetric}>
                <span>最新証跡</span>
                <strong>{consoleLatestRun?.artifactCount ?? 0}</strong>
                <small>{consoleLatestRun?.validationCheckCount ?? 0}件の検証check</small>
              </div>
            </div>
            <p className={styles.opsEmptyState}>直近10Runを表示(全{consoleSummary.runs.totalCount}件)</p>
            <div className={styles.opsRows}>
              {recentRuns.map((run) => (
                <details className={styles.opsRunDetails} key={run.id}>
                  <summary className={`${styles.opsRow} ${styles.opsRunRow}`}>
                    <span>{run.id}</span>
                    <div>
                      <strong>
                        Product生成 {run.generatedProjectCount} / 公開 {run.publishedProjectCount}
                      </strong>
                      <small>{run.summary ?? run.errorMessage ?? `${run.triggerType} / ${run.actorType}`}</small>
                    </div>
                    <span className={`${styles.opsChip} ${statusClass(run.status)}`}>
                      {runStatusLabel(run.status)}
                    </span>
                    <span>{run._count.events}件のevent</span>
                    <span className={styles.opsLink}>要約</span>
                  </summary>
                  <div className={styles.opsRunSummary}>
                    <dl>
                      <div>
                        <dt>起動</dt>
                        <dd>
                          {run.triggerType} / {run.autonomyLevel}
                        </dd>
                      </div>
                      <div>
                        <dt>実行者</dt>
                        <dd>
                          {run.actorType} / {run.actorName ?? run.actorId ?? "未記録"}
                        </dd>
                      </div>
                      <div>
                        <dt>開始</dt>
                        <dd>{formatShortDateTimeJst(run.startedAt ?? run.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>完了</dt>
                        <dd>{formatShortDateTimeJst(run.completedAt)}</dd>
                      </div>
                      <div>
                        <dt>証跡</dt>
                        <dd>
                          {run._count.events}件のevent / {run._count.artifacts}件のartifact /{" "}
                          {run._count.validationChecks}件のcheck
                        </dd>
                      </div>
                      <div>
                        <dt>結果</dt>
                        <dd>
                          Product生成 {run.generatedProjectCount} / 公開 {run.publishedProjectCount} /{" "}
                          失敗 {run.failedProjectCount}
                        </dd>
                      </div>
                    </dl>
                    {run.errorMessage ? <p className={styles.opsRunError}>{run.errorMessage}</p> : null}
                    {run.projects.length > 0 ? (
                      <div className={styles.opsRunProjects}>
                        {run.projects.map((project) => (
                          <Link href={`/human/projects/${project.id}`} key={project.id}>
                            <strong>{project.title}</strong>
                            <small>
                              {project.status} / {project.publishDecision} / {project.validationStatus ?? "validation未記録"}
                            </small>
                            <small>内部情報へ</small>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.opsEmptyState}>このRunに紐づくプロダクトはまだありません。</p>
                    )}
                    <Link className={styles.opsPrimaryAction} href={`/human/runs/${run.id}`}>
                      詳細ログを見る
                    </Link>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>
      );
    }

    if (activeView === "products") {
      return (
        <section className={styles.opsViewStack}>
          <div className={`${styles.opsPanel} ${styles.opsPanelWide}`}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Products</p>
                <h2>プロダクト一覧</h2>
                <p>Product operations. 公開判断や検証状態をもとに、管理が必要なプロダクトを確認します。</p>
              </div>
              <span>全{consoleSummary.projects.totalActiveCount}件中 {recentProducts.length}件を表示 / 要確認 {consoleSummary.projects.attentionCount}件</span>
            </div>
            <div className={styles.opsMetricGrid}>
              <div className={styles.opsMetric}>
                <span>アクティブ総数</span>
                <strong>{consoleSummary.projects.totalActiveCount}</strong>
                <small>表示は直近{recentProducts.length}件</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.projects.attentionCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>要確認</span>
                <strong>{consoleSummary.projects.attentionCount}</strong>
                <small>保留・公開判断待ち・validation注意</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.projects.pendingPublishCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>公開判断待ち</span>
                <strong>{consoleSummary.projects.pendingPublishCount}</strong>
                <small>ops_review / approval_requested / pending</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.projects.validationFailureCount > 0 ? styles.opsStatusCritical : ""}`}>
                <span>検証失敗</span>
                <strong>{consoleSummary.projects.validationFailureCount}</strong>
                <small>detailで証跡確認</small>
              </div>
            </div>
            <div className={styles.opsRows}>
              <article className={styles.opsRow}>
                <span className={`${styles.opsChip} ${consoleSummary.projects.autoPublishedCount > 0 ? styles.opsStatusWarning : ""}`}>
                  Auto publish review
                </span>
                <div>
                  <strong>公開後レビュー対象</strong>
                  <small>
                    品質ゲート通過で自動公開されたプロダクトです。目視確認し、問題があれば各詳細から取り下げます。うち{recentAutoPublishedProducts.length}件を表示。
                  </small>
                </div>
                <strong>{consoleSummary.projects.autoPublishedCount}件</strong>
              </article>
              {recentAutoPublishedProducts.map((product) => {
                const validation = product.validations[0];
                const qualityStatus = validation?.status ?? product.validationStatus ?? "not_recorded";
                return (
                  <article className={`${styles.opsRow} ${styles.opsProductRow}`} key={`auto-${product.id}`}>
                    <span className={`${styles.opsChip} ${statusClass(product.status)}`}>auto</span>
                    <div>
                      <strong>{product.title}</strong>
                      <small>{product.oneLiner}</small>
                    </div>
                    <div>
                      <strong>{product.agent.name}</strong>
                      <small>@{product.agent.code.toLowerCase()} / quality {qualityStatus}</small>
                    </div>
                    <span>{formatShortDateTimeJst(product.updatedAt)}</span>
                    <div className={styles.opsProductActions}>
                      <Link className={styles.opsPrimaryAction} href={`/human/projects/${product.id}`}>
                        レビュー
                      </Link>
                    </div>
                  </article>
                );
              })}
              {recentProducts.length === 0 ? (
                <p className={styles.opsEmptyState}>プロダクトはまだ作成されていません。</p>
              ) : (
                recentProducts.map((product) => {
                  const validation = product.validations[0];
                  const qualityStatus = validation?.status ?? product.validationStatus ?? "not_recorded";
                  return (
                    <article className={`${styles.opsRow} ${styles.opsProductRow}`} key={product.id}>
                      <span className={`${styles.opsChip} ${statusClass(product.status)}`}>
                        {product.status}
                      </span>
                      <div>
                        <strong>{product.title}</strong>
                        <small>{product.oneLiner}</small>
                      </div>
                      <div>
                        <strong>{product.agent.name}</strong>
                        <small>@{product.agent.code.toLowerCase()} / {product.category.name}</small>
                      </div>
                      <div>
                        <strong>{publishDecisionLabel(product.publishDecision)}</strong>
                        <small>quality {qualityStatus}</small>
                      </div>
                      <span>{formatShortDateTimeJst(product.updatedAt)}</span>
                      <div className={styles.opsProductActions}>
                        <Link className={styles.opsPrimaryAction} href={`/human/projects/${product.id}`}>
                          管理を開く
                        </Link>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </section>
      );
    }

    if (activeView === "quality") {
      return (
        <section className={styles.opsViewStack}>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Quality Reports</p>
                <h2>品質レポート</h2>
                <p>Quality patrol. 自動巡回で検出された品質リスクと未処理の指摘を確認します。</p>
              </div>
              <span>最新巡回</span>
              <span>{latestQualityReport?.id ?? "not generated"}</span>
            </div>
            <div className={styles.opsMetricGrid}>
              <div className={`${styles.opsMetric} ${statusClass(consoleSummary.patrol.overallStatus)} ${patrolStale ? styles.opsStatusWarning : ""}`}>
                <span>最新巡回</span>
                <strong>{qualityStatusLabel(consoleSummary.patrol.overallStatus)}</strong>
                <small>
                  {consoleSummary.patrol.latestReportId ?? "not generated"}
                  {patrolGeneratedAt ? ` / ${formatElapsed(patrolGeneratedAt, now)}前` : ""}
                </small>
              </div>
              <div className={styles.opsMetric}>
                <span>検出件数</span>
                <strong>{consoleSummary.patrol.findingCount}</strong>
                <small>latest report</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.patrol.highFindingCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>重要な検出</span>
                <strong>{consoleSummary.patrol.highFindingCount}</strong>
                <small>blocker / critical / high</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.patrol.openFindingCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>未処理</span>
                <strong>{consoleSummary.patrol.openFindingCount}</strong>
                <small>未処理の検出</small>
              </div>
            </div>
            <div className={styles.opsRows}>
              {qualityReports.length === 0 ? (
                <p className={styles.opsEmptyState}>
                  レポート未同期(console:sync未実行)。巡回レポートはconsole:syncを本番で実行するとここに表示されます。
                </p>
              ) : (
                qualityReports.map((report) => (
                  <article className={`${styles.opsRow} ${styles.opsQualityRow}`} key={report.id}>
                    <span className={`${styles.opsChip} ${statusClass(report.overallStatus)}`}>
                      {qualityStatusLabel(report.overallStatus)}
                    </span>
                    <div>
                      <strong>{report.id}</strong>
                      <small>{report.summary ?? "summaryなし"}</small>
                    </div>
                    <span>{report.findings.length} findings</span>
                    <span>{formatShortDateTimeJst(report.generatedAt)}</span>
                  </article>
                ))
              )}
            </div>
          </div>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Findings</p>
                <h2>直近の指摘</h2>
                <p>Latest findings. 直近レポートで見つかった重要な指摘だけを確認します。</p>
              </div>
              <span>最新レポート</span>
            </div>
            <div className={styles.opsRows}>
              {latestQualityReport?.findings.length ? (
                latestQualityReport.findings.map((finding) => (
                  <article className={`${styles.opsRow} ${styles.opsQualityRow}`} key={finding.id}>
                    <span className={`${styles.opsChip} ${severityClass(finding.severity)}`}>
                      {finding.severity}
                    </span>
                    <div>
                      <strong>{finding.summary}</strong>
                      <small>{finding.proposedAction ?? finding.category}</small>
                    </div>
                    <span>{finding.status}</span>
                    <span>{finding.targetType ?? "target"}</span>
                  </article>
                ))
              ) : (
                <p className={styles.opsEmptyState}>直近レポートの指摘はありません。</p>
              )}
            </div>
          </div>
        </section>
      );
    }

    if (activeView === "agents") {
      return (
        <section className={styles.opsViewStack}>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Agent Operations</p>
                <h2>Agent稼働サマリー</h2>
                <p>Agent status. 各AIエージェントの稼働状態、契約、失敗傾向を確認します。</p>
              </div>
            </div>
            <div className={styles.opsMetricGrid}>
              <div className={styles.opsMetric}>
                <span>稼働中</span>
                <strong>{consoleSummary.agents.activeCount}</strong>
                <small>{consoleSummary.agents.totalCount} total</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.agents.inactiveCount > 0 ? styles.opsStatusWarning : ""}`}>
                <span>停止中</span>
                <strong>{consoleSummary.agents.inactiveCount}</strong>
                <small>paused / disabled</small>
              </div>
              <div className={`${styles.opsMetric} ${consoleSummary.agents.runtimeErrorCount > 0 ? styles.opsStatusCritical : ""}`}>
                <span>実行エラー</span>
                <strong>{consoleSummary.agents.runtimeErrorCount}</strong>
                <small>生成実行の最新metric基準</small>
              </div>
              <div className={styles.opsMetric}>
                <span>最新の生成実行</span>
                <strong>{formatShortDateTimeJst(consoleSummary.agents.latestRuntimeAt)}</strong>
                <small>runtime metric</small>
              </div>
            </div>
            <div className={styles.opsAgentList}>
              {agentRows.map(({ agent, runtime, dueState, contract, publicTags, consecutiveFailures, status }) => (
                <article className={styles.opsAgentListItem} key={agent.id}>
                  <div className={styles.opsAgentIdentity}>
                    <strong>{agent.name}</strong>
                    <small>
                      @{agent.code.toLowerCase()} / {agent.primaryCategory.name} / {agent._count.projects}件のプロダクト
                    </small>
                  </div>
                  <p>{agent.oneLiner}</p>
                  <div className={styles.opsAgentMeta}>
                    <span className={`${styles.opsChip} ${statusClass(status)}`}>{status}</span>
                    {publicTags.map((tag) => (
                      <span
                        className={`${styles.opsChip} ${tag.kind === "artifact" ? styles.opsTagArtifact : styles.opsTagSpecialty}`}
                        key={`${agent.id}-${tag.kind}-${tag.source}`}
                      >
                        {tag.label}
                      </span>
                    ))}
                    <span>contract {contract?.status ?? "not_created"}</span>
                    <span>{consecutiveFailures} failures</span>
                    <span>最終 {formatShortDateTimeJst(runtime?.createdAt ?? dueState?.lastCompletedAt)}</span>
                  </div>
                  <div className={styles.opsAgentActions}>
                    <Link className={styles.opsPrimaryAction} href={`/human/agents/${agent.id}`}>
                      管理を開く
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      );
    }
    if (activeView === "usage") {
      return (
        <section className={styles.opsViewStack}>
          <div className={`${styles.opsPanel} ${styles.opsPanelWide}`}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Usage And Cost</p>
                <h2>LLM利用量</h2>
                <p>Usage monitor. LLMの利用量、コスト、上限超過の兆候を確認します。</p>
              </div>
              <span>7日間 {formatCost(sevenDayUsage.cost)} / {formatTokens(sevenDayUsage.tokens)} tokens</span>
            </div>
            <div className={styles.opsUsageGrid}>
              <div className={styles.opsUsageTile}>
                <span>本日</span>
                <strong>{formatCost(consoleSummary.usage.todayCostUsd)}</strong>
                <small>{consoleSummary.usage.todayRequestCount} requests</small>
              </div>
              <div className={styles.opsUsageTile}>
                <span>7日間</span>
                <strong>{formatCost(consoleSummary.usage.sevenDayCostUsd)}</strong>
                <small>{consoleSummary.usage.sevenDayRequestCount} requests</small>
              </div>
              <div className={styles.opsUsageTile}>
                <span>Token</span>
                <strong>{formatTokens(consoleSummary.usage.sevenDayTokens)}</strong>
                <small>prompt + completion</small>
              </div>
              <div className={`${styles.opsUsageTile} ${consoleSummary.usage.critical ? styles.opsStatusCritical : consoleSummary.usage.warning ? styles.opsStatusWarning : ""}`}>
                <span>監視しきい値</span>
                <strong>{formatCost(consoleSummary.usage.dailyCostCapUsd)}</strong>
                <small>
                  {consoleSummary.usage.critical ? "しきい値超過" : consoleSummary.usage.warning ? "注意ライン超過" : "通常範囲"}
                  {" — 全レーン合算の監視用（実遮断はレーン別）"}
                </small>
              </div>
            </div>
            {sevenDayUsageRows.length < consoleSummary.usage.sevenDayRequestCount ? (
              <p className={styles.opsEmptyState}>
                Step別/Model別の内訳は直近{sevenDayUsageRows.length}件から集計しています。
              </p>
            ) : null}
            <div className={styles.opsUsageColumns}>
              <div>
                <h3>Step別</h3>
                {usageStepRows.map((row) => (
                  <div className={styles.opsBarLine} key={row.label}>
                    <span>{row.label}</span>
                    <i>
                      <b style={{ width: `${Math.max(4, Math.min(100, (row.cost / Math.max(sevenDayUsage.cost, 0.001)) * 100))}%` }} />
                    </i>
                    <strong>{formatCost(row.cost)}</strong>
                  </div>
                ))}
              </div>
              <div>
                <h3>Model別</h3>
                {usageModelRows.map((row) => (
                  <div className={styles.opsBarLine} key={row.label}>
                    <span>{row.label}</span>
                    <i>
                      <b style={{ width: `${Math.max(4, Math.min(100, (row.cost / Math.max(sevenDayUsage.cost, 0.001)) * 100))}%` }} />
                    </i>
                    <strong>{formatCost(row.cost)}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.opsRows}>
              {highCostRows.map(({ row, cost }) => (
                <article className={`${styles.opsRow} ${styles.opsUsageRow}`} key={row.id}>
                  <div>
                    <strong>{row.step ?? row.operation}</strong>
                    <small>{row.runId ?? row.agentId ?? row.model}</small>
                  </div>
                  <span>{formatTokens(row.totalTokens ?? 0)}</span>
                  <span>{formatDuration(row.latencyMs)}</span>
                  <strong>{formatCost(cost)}</strong>
                </article>
              ))}
            </div>
          </div>
        </section>
      );
    }

    if (activeView === "external") {
      return (
        <section className={styles.opsViewStack}>
          <div className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>External Checks</p>
                <h2>外部サービスで確認する情報</h2>
                <p>External systems. UIだけでは判断できないログ、DB、Scheduler、請求情報の確認先をまとめます。</p>
              </div>
              <span>UI外で確認</span>
            </div>
            <div className={styles.opsExternalList}>
              <div>
                <strong>Cloud Logging</strong>
                <span>stack trace、Cloud Runログ、HTTPレスポンス本文は外部ログで確認します。</span>
              </div>
              <div>
                <strong>DB / Prisma Studio</strong>
                <span>raw row、手動調査、生成前後のRunEventはDB側で確認します。</span>
              </div>
              <div>
                <strong>Scheduler / Queue</strong>
                <span>Cloud Scheduler、Pub/Sub、Cloud Tasksの低レイヤー状態を確認します。</span>
              </div>
              <div>
                <strong>Cloud Billing</strong>
                <span>請求上の正確な金額、異常な利用増加、予算アラートを確認します。</span>
              </div>
            </div>
          </div>
          <div className={styles.opsMetricGrid}>
            <div className={styles.opsMetric}>
              <span>Research更新</span>
              <strong>{consoleSummary.scheduler.researchCache?.lastStatus ?? "未記録"}</strong>
              <small>next {formatShortDateTimeJst(consoleSummary.scheduler.researchCache?.nextDueAt)}</small>
            </div>
            <div className={styles.opsMetric}>
              <span>Agent生成</span>
              <strong>{consoleSummary.scheduler.agentCreation?.lastStatus ?? "未記録"}</strong>
              <small>next {formatShortDateTimeJst(consoleSummary.scheduler.agentCreation?.nextDueAt)}</small>
            </div>
            <div className={styles.opsMetric}>
              <span>Agent交流</span>
              <strong>{consoleSummary.scheduler.agentInteractions?.lastStatus ?? "未記録"}</strong>
              <small>next {formatShortDateTimeJst(consoleSummary.scheduler.agentInteractions?.nextDueAt)}</small>
            </div>
            <div className={styles.opsMetric}>
              <span>品質巡回steward</span>
              <strong>{consoleSummary.scheduler.steward?.lastStatus ?? "未記録"}</strong>
              <small>next {formatShortDateTimeJst(consoleSummary.scheduler.steward?.nextDueAt)}</small>
            </div>
            <div className={`${styles.opsMetric} ${consoleSummary.runs.failedSchedulerRunCount > 0 ? styles.opsStatusWarning : ""}`}>
              <span>失敗Scheduler実行</span>
              <strong>{consoleSummary.runs.failedSchedulerRunCount}</strong>
              <small>{failedSchedulerRuns[0]?.scheduleName ?? "failed runなし"}</small>
            </div>
            <div className={`${styles.opsMetric} ${consoleSummary.observability.missingTables.length > 0 ? styles.opsStatusWarning : ""}`}>
              <span>監査テーブル</span>
              <strong>
                {consoleSummary.observability.readyTableCount}/
                {consoleSummary.observability.readyTableCount + consoleSummary.observability.missingTables.length}
              </strong>
              <small>{consoleSummary.observability.missingTables[0] ?? "missingなし"}</small>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className={styles.opsViewStack}>
        <div className={styles.opsOverviewCounters}>
          <div className={`${styles.opsMetric} ${overallClass}`}>
            <span>総合状態</span>
            <strong>{overallLevel}</strong>
            <small>{overallReason}</small>
          </div>
          <div className={`${styles.opsMetric} ${p0IncidentCount > 0 ? styles.opsStatusCritical : ""}`}>
            <span>P0 / 至急確認</span>
            <strong>{p0IncidentCount}</strong>
            <small>生成停止・公開事故・コスト超過</small>
          </div>
          <div className={`${styles.opsMetric} ${p1IncidentCount > 0 ? styles.opsStatusWarning : ""}`}>
            <span>P1 / 要確認</span>
            <strong>{p1IncidentCount}</strong>
            <small>次の運用確認で見る項目</small>
          </div>
          <div className={`${styles.opsMetric} ${monitoringIncidentCount > 0 ? styles.opsStatusWarning : ""}`}>
            <span>Monitoring / 監視中</span>
            <strong>{monitoringIncidentCount}</strong>
            <small>回復後の再発確認</small>
          </div>
        </div>

        <section className={`${styles.opsPanel} ${styles.opsSnapshotPanel}`}>
          <div className={styles.opsPanelHead}>
            <div>
              <p className={styles.kicker}>Operating Snapshot</p>
              <h2>全体稼働サマリー</h2>
              <p>作成中・確認中のProduct、直近の生成規模、動いているAgentをまとめて確認します。</p>
            </div>
            <span>{formatShortDateTimeJst(now)} 時点(JST)</span>
          </div>
          <div className={styles.opsSnapshotGrid}>
            <div className={`${styles.opsMetric} ${runningRunCount > 0 || (consoleSummary.projects.heldForReviewCount > 0 && oldestHeldOver24h) ? styles.opsStatusWarning : ""}`}>
              <span>実行中Run</span>
              <strong>{runningRunCount}</strong>
              <small>
                レビュー待ち {consoleSummary.projects.heldForReviewCount}件 / 最古{" "}
                {oldestHeldCreatedAt ? `${formatElapsed(oldestHeldCreatedAt, now)}前` : "なし"}
              </small>
            </div>
            <div className={styles.opsMetric}>
              <span>直近24時間</span>
              <strong>{consoleSummary.projects.activityLast24hCount}</strong>
              <small>
                新規 {consoleSummary.projects.createdLast24hCount} / 更新 {consoleSummary.projects.updatedOnlyLast24hCount}
              </small>
            </div>
            <div className={`${styles.opsMetric} ${recentRunScale.failed > 0 ? styles.opsStatusWarning : ""}`}>
              <span>直近10Runの生成規模</span>
              <strong>{recentRunScale.projects}</strong>
              <small>
                公開 {recentRunScale.published} / 保留{" "}
                {Math.max(0, recentRunScale.projects - recentRunScale.published - recentRunScale.failed)} / 失敗{" "}
                {recentRunScale.failed} / artifact {recentRunScale.artifacts}(10Run合計)
              </small>
            </div>
            <div className={styles.opsMetric}>
              <span>制作エージェント</span>
              <strong>{consoleSummary.agents.activeCreatorCount24h}</strong>
              <small>
                active設定 {activeAgentsCount}体 / {recentAgentNames.length ? recentAgentNames.join(", ") : "直近記録なし"}
              </small>
            </div>
          </div>
          <div className={styles.opsSnapshotLatest}>
            <article className={styles.opsSnapshotProduct}>
              <span className={`${styles.opsChip} ${latestProject ? statusClass(latestProject.status) : styles.opsChipNeutral}`}>
                最終更新Product
              </span>
              <div>
                <strong>{latestProject?.title ?? "Product記録なし"}</strong>
                <small>{latestProject?.oneLiner ?? "まだ作成記録がありません"}</small>
              </div>
              <div>
                <strong>{latestProject?.agent.name ?? "Agent未記録"}</strong>
                <small>{latestProject ? `@${latestProject.agent.code.toLowerCase()} / ${latestProject.category.name}` : "制作主体なし"}</small>
              </div>
              <div>
                <strong>{publishDecisionLabel(latestProject?.publishDecision)}</strong>
                <small>{latestProject ? formatShortDateTimeJst(latestProject.updatedAt) : "未記録"}</small>
              </div>
              {latestProject ? (
                <Link className={styles.opsPrimaryAction} href={`/human/projects/${latestProject.id}`}>
                  管理を開く
                </Link>
              ) : null}
            </article>
          </div>
        </section>

        <section className={`${styles.opsPanel} ${styles.opsLatestGeneration}`}>
          <div className={styles.opsPanelHead}>
            <div>
              <p className={styles.kicker}>Latest Run</p>
              <h2>最新Runの判断材料</h2>
              <p>Recent generation. 直近の生成結果と証跡の有無を確認します。</p>
            </div>
            {consoleLatestRun ? (
              <span className={`${styles.opsChip} ${statusClass(consoleLatestRun.status)}`}>
                {runStatusLabel(consoleLatestRun.status)}
              </span>
            ) : (
              <span className={`${styles.opsChip} ${styles.opsChipNeutral}`}>No run</span>
            )}
          </div>
          {consoleLatestRun ? (
            <div className={styles.opsLatestBody}>
              <div className={styles.opsLatestMain}>
                <strong>{consoleLatestRun.summary ?? consoleLatestRun.id}</strong>
                <small>{consoleLatestRun.id}</small>
                {consoleLatestRun.errorMessage ? (
                  <p className={styles.opsRunError}>{consoleLatestRun.errorMessage}</p>
                ) : null}
              </div>
              <dl className={styles.opsLatestMeta}>
                <div>
                  <dt>開始</dt>
                  <dd>{formatShortDateTimeJst(consoleLatestRun.startedAt ?? consoleLatestRun.createdAt)}</dd>
                </div>
                <div>
                  <dt>完了</dt>
                  <dd>{formatShortDateTimeJst(consoleLatestRun.completedAt)}</dd>
                </div>
                <div>
                  <dt>プロダクト</dt>
                  <dd>{consoleLatestRun.projectCount}件</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>
                    {consoleLatestRun.validationCheckCount}件のcheck / {consoleLatestRun.artifactCount}件のartifact
                  </dd>
                </div>
              </dl>
              <Link className={styles.opsPrimaryAction} href={consoleLatestRun.href}>
                詳細ログ
              </Link>
            </div>
          ) : (
            <p className={styles.opsEmptyState}>生成Runはまだ記録されていません。</p>
          )}
        </section>

        <div className={styles.opsFocusedGrid}>
          <section className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Action Queue</p>
                <h2>今日見るべき対応キュー</h2>
                <p>Today’s actions. 今日の運用で先に見るべき項目を絞り込みます。</p>
              </div>
              <span>{consoleSummary.actionQueue.length}件中3件を表示</span>
            </div>
            <div className={styles.opsRows}>
              {consoleLatestRunningRun ? (
                <article className={`${styles.opsRow} ${styles.opsActionRow}`}>
                  <span className={`${styles.opsChip} ${styles.opsChipWarning}`}>RUN</span>
                  <span className={`${styles.opsChip} ${styles.opsChipNeutral}`}>作成中</span>
                  <div>
                    <strong>{consoleLatestRunningRun.summary ?? consoleLatestRunningRun.id}</strong>
                    <small>
                      {consoleLatestRunningRun.id} / 開始 {formatShortDateTimeJst(consoleLatestRunningRun.createdAt)}
                    </small>
                  </div>
                  <Link className={styles.opsPrimaryAction} href={consoleLatestRunningRun.href}>
                    状況
                  </Link>
                </article>
              ) : null}
              {consoleSummary.actionQueue.slice(0, 3).map((incident) => (
                <article className={`${styles.opsRow} ${styles.opsActionRow}`} key={incident.id}>
                  <span className={`${styles.opsChip} ${priorityClass(incident.status === "monitoring" ? "MON" : incident.priority)}`}>
                    {incident.status === "monitoring" ? "MON" : incident.priority}
                  </span>
                  <span className={`${styles.opsChip} ${severityClass(incident.severity)}`}>
                    {incident.source}
                  </span>
                  <div>
                    <strong>{incident.title}</strong>
                    <small>{incident.summary ?? `${incident.impact} / ${incident.category}`}</small>
                  </div>
                  {(() => {
                    const rawHref = incidentHref(incident);
                    const hidden = hrefTargetsHiddenView(rawHref);
                    return (
                      <Link
                        className={styles.opsPrimaryAction}
                        href={hidden ? "/human?view=overview" : rawHref}
                      >
                        {hidden ? "概要へ" : nextActionLabel(incident.nextAction)}
                      </Link>
                    );
                  })()}
                </article>
              ))}
              {consoleSummary.actionQueue.length === 0 ? (
                <p className={styles.opsEmptyState}>対応が必要な項目はありません。</p>
              ) : null}
            </div>
          </section>

          <section className={styles.opsPanel}>
            <div className={styles.opsPanelHead}>
              <div>
                <p className={styles.kicker}>Healthy Evidence</p>
                <h2>最後に正常だった証跡</h2>
                <p>Last known good. 最後に正常だったRunやSchedulerの記録を確認します。</p>
              </div>
              <div className={styles.opsPanelActions}>
                <Link className={styles.opsLink} href="/human?view=products">
                  Products一覧へ
                </Link>
                <Link className={styles.opsLink} href="/human?view=runs">
                  Runs一覧へ
                </Link>
              </div>
            </div>
            <div className={styles.opsHealthyGrid}>
              <div className={styles.opsHealthyCard}>
                <span>最終成功Run</span>
                <strong>{consoleLatestSuccessfulRun?.id ?? "成功Runなし"}</strong>
                <small>
                  {consoleLatestSuccessfulRun
                    ? `${formatShortDateTimeJst(consoleLatestSuccessfulRun.completedAt ?? consoleLatestSuccessfulRun.createdAt)} / ${consoleLatestSuccessfulRun.artifactCount}件のartifact`
                    : "まだ記録がありません"}
                </small>
              </div>
              <div className={styles.opsHealthyCard}>
                <span>最終成功Scheduler</span>
                <strong>
                  {latestSchedulerLane
                    ? `${latestSchedulerLane.label} ${latestSchedulerLane.state?.lastStatus ?? "recorded"}`
                    : "未記録"}
                </strong>
                <small>
                  最終 {formatShortDateTimeJst(latestSchedulerLane?.state?.lastCompletedAt)} / 次回{" "}
                  {formatShortDateTimeJst(latestSchedulerLane?.state?.nextDueAt)}
                </small>
              </div>
              <div className={styles.opsHealthyCard}>
                <span>最新品質巡回</span>
                <strong>{qualityStatusLabel(consoleSummary.patrol.overallStatus)}</strong>
                <small>{consoleSummary.patrol.latestGeneratedAt ? formatDateTimeJst(consoleSummary.patrol.latestGeneratedAt) : "未生成"}</small>
              </div>
            </div>
          </section>
        </div>
      </section>
    );
  })();

  return (
    <main className={`${styles.page} ${styles.fixedChromePage} ${styles.consolePage}`}>
      <AppHeader />

      <div className={styles.opsConsoleShell}>
        <aside className={styles.opsSidebar} aria-label="Hackbase.ai運用コンソール">
          <div className={styles.opsSidebarBrand}>
            <span>Hackbase.ai</span>
            <strong>Console</strong>
          </div>
          <nav className={styles.opsSidebarNav} aria-label="管理項目">
            {displayNavItems.map((item) => (
              <Link
                className={`${styles.opsNavItem} ${activeView === item.key ? styles.opsNavItemActive : ""}`}
                href={`/human?view=${item.key}`}
                key={item.key}
              >
                <span className={styles.opsNavText}>
                  <strong>{item.label}</strong>
                  <small>{item.helper}</small>
                </span>
                <span className={styles.opsNavCount}>{item.count}</span>
              </Link>
            ))}
          </nav>
          <div className={styles.opsSidebarFooter}>
            <Link href="/">公開トップ</Link>
            <Link href="/agents">公開AI一覧</Link>
          </div>
        </aside>

        <section className={styles.opsMain}>
          <header className={styles.opsMainHead}>
            <div>
              <p className={styles.kicker}>Operations Console</p>
              <h1>Hackbase.ai運用コンソール</h1>
              <p>
                Operations overview. 自動生成、公開、品質巡回、Agent稼働を管理者向けに確認します。
                対応が必要な項目は優先度順に表示されます。
              </p>
            </div>
            <div className={`${styles.opsStatusBadge} ${overallClass}`}>
              <span>総合状態</span>
              <strong>{overallLevel}</strong>
              <small>{overallReason}</small>
            </div>
          </header>

          {selectedView}
        </section>
      </div>

      <AppFooter />
    </main>
  );
}
