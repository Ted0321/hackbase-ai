import type { PrismaClient } from "@prisma/client";
import { getConsoleLogEpoch, gteWithEpoch, hideStaleSchedulerState } from "./console-epoch";
import { estimateModelUsageCostUsd, type ModelUsageCostInput } from "./model-usage-cost";
import { readObservabilitySummary } from "./observability-summary";
import { activeProjectWhere, HOLD_PUBLISH_DECISIONS, PUBLIC_PROJECT_STATUSES } from "./project-visibility";
import { readSchedulerStateRecord } from "./scheduler-state";

type SchedulerState = {
  lastCompletedAt?: string;
  lastRunId?: string;
  lastStatus?: string;
  nextDueAt?: string;
};

// SchedulerStateのvalueはレーンごとに形が違う(v1形はlastRunAtのみでlastStatusを持たない)
// ため、生JSONから安全に拾うための緩い型。normalizeSchedulerStateで表示用の共通形へ吸収する。
type SchedulerStateRaw = {
  lastCompletedAt?: string | null;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  lastStatus?: string | null;
  nextDueAt?: string | null;
};

const normalizeSchedulerState = (state: SchedulerStateRaw | null): SchedulerState | null => {
  if (!state) return null;
  return {
    lastCompletedAt: state.lastCompletedAt ?? state.lastRunAt ?? undefined,
    lastRunId: state.lastRunId ?? undefined,
    // v1形(agent-creation等)はlastStatus無しでlastRunAtだけ書くため、実行記録があれば"recorded"扱い。
    lastStatus: state.lastStatus ?? (state.lastRunAt ? "recorded" : undefined),
    nextDueAt: state.nextDueAt ?? undefined,
  };
};

export type ConsoleOverallStatus = "healthy" | "warning" | "critical";

export type ConsoleActionItem = {
  id: string;
  title: string;
  summary: string | null;
  severity: string;
  priority: string;
  status: string;
  source: string;
  impact: string;
  category: string;
  nextAction: string | null;
  href: string;
  runId: string | null;
  projectId: string | null;
  agentId: string | null;
  lastSeenAt: Date;
};

export type ConsoleSummary = {
  generatedAt: Date;
  overall: {
    status: ConsoleOverallStatus;
    reason: string;
    p0IncidentCount: number;
    p1IncidentCount: number;
    monitoringIncidentCount: number;
    actionCount: number;
  };
  actionQueue: ConsoleActionItem[];
  patrol: {
    latestReportId: string | null;
    latestGeneratedAt: Date | null;
    overallStatus: string | null;
    summary: string | null;
    findingCount: number;
    highFindingCount: number;
    openFindingCount: number;
    href: string;
  };
  runs: {
    totalCount: number;
    latest: ConsoleRunItem | null;
    latestSuccessful: ConsoleRunItem | null;
    latestRunning: ConsoleRunItem | null;
    failedSchedulerRunCount: number;
  };
  projects: {
    displayedCount: number;
    totalActiveCount: number;
    attentionCount: number;
    pendingPublishCount: number;
    heldForReviewCount: number;
    validationFailureCount: number;
    createdLast24hCount: number;
    updatedOnlyLast24hCount: number;
    activityLast24hCount: number;
    autoPublishedCount: number;
    oldestHeldCreatedAt: Date | null;
  };
  agents: {
    totalCount: number;
    activeCount: number;
    inactiveCount: number;
    runtimeErrorCount: number;
    latestRuntimeAt: Date | null;
    activeCreatorCount24h: number;
  };
  usage: {
    todayTokens: number;
    todayCostUsd: number;
    todayRequestCount: number;
    sevenDayTokens: number;
    sevenDayCostUsd: number;
    sevenDayRequestCount: number;
    dailyCostCapUsd: number;
    warning: boolean;
    critical: boolean;
  };
  observability: {
    readyTableCount: number;
    missingTables: string[];
  };
  scheduler: {
    researchCache: SchedulerState | null;
    agentCreation: SchedulerState | null;
    agentInteractions: SchedulerState | null;
    steward: SchedulerState | null;
  };
  links: {
    incidents: string;
    runs: string;
    products: string;
    quality: string;
    agents: string;
    usage: string;
    external: string;
  };
};

type ConsoleRunItem = {
  id: string;
  status: string;
  triggerType: string;
  summary: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  projectCount: number;
  artifactCount: number;
  validationCheckCount: number;
  href: string;
};

const startOfUtcDay = (value: Date) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

const VALIDATION_FAILURE_STATUSES = ["failed", "error", "blocked", "fail"];
// /human productsビューの取得窓(take:24)。displayedCountはこの窓に載る件数。
const PROJECT_DISPLAY_WINDOW = 24;

const incidentPriorityRank = (priority?: string | null) => {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
};

export const consoleIncidentHref = (incident: {
  nextAction?: string | null;
  runId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
}) => {
  if (incident.nextAction === "review_usage") return "/human?view=usage";
  if (incident.nextAction === "review_quality_project" || incident.nextAction === "review_quality_report") {
    return incident.projectId ? `/human/projects/${incident.projectId}` : "/human?view=quality";
  }
  if (incident.nextAction === "open_run_trace" && incident.runId) return `/human/runs/${incident.runId}`;
  if (incident.nextAction === "check_scheduler_run") {
    return incident.runId ? `/human/runs/${incident.runId}` : "/human?view=incidents";
  }
  if (incident.nextAction === "review_validation") {
    if (incident.projectId) return `/human/projects/${incident.projectId}`;
    if (incident.runId) return `/human/runs/${incident.runId}`;
    return "/human?view=quality";
  }
  if (incident.agentId) return `/human/agents/${incident.agentId}`;
  if (incident.runId) return `/human/runs/${incident.runId}`;
  if (incident.projectId) return `/human/projects/${incident.projectId}`;
  return "/human?view=incidents";
};

const rollupUsage = (rows: ModelUsageCostInput[]) => ({
  tokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
  cost: rows.reduce((sum, row) => sum + estimateModelUsageCostUsd(row), 0),
});

const runItemSelect = {
  id: true,
  status: true,
  triggerType: true,
  summary: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  _count: {
    select: {
      projects: true,
      artifacts: true,
      validationChecks: true,
    },
  },
} as const;

const toRunItem = (run: {
  id: string;
  status: string;
  triggerType: string;
  summary: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  _count: {
    projects: number;
    artifacts: number;
    validationChecks: number;
  };
}): ConsoleRunItem => ({
  id: run.id,
  status: run.status,
  triggerType: run.triggerType,
  summary: run.summary,
  errorMessage: run.errorMessage,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  projectCount: run._count.projects,
  artifactCount: run._count.artifacts,
  validationCheckCount: run._count.validationChecks,
  href: `/human/runs/${run.id}`,
});

export const readConsoleSummary = async (
  prisma: PrismaClient,
  options: {
    now?: Date;
    dailyCostCapUsd?: number;
  } = {},
): Promise<ConsoleSummary> => {
  const now = options.now ?? new Date();
  const todayStart = startOfUtcDay(now);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // 監視しきい値。遮断用の GEMINI_DAILY_MAX_COST_USD(レーン別)とは別枠で、全レーン合算の
  // 当日コストに対する「注意/超過」判定に使う。既定70 = scheduler10 + manual50 + 余裕。
  const dailyCostCapUsd = options.dailyCostCapUsd ?? Number(process.env.PRODIA_CONSOLE_DAILY_COST_ALERT_USD ?? 70);
  const logEpoch = getConsoleLogEpoch();
  const epochWhere = logEpoch ? { createdAt: { gte: logEpoch } } : {};

  // 非公開のまま検証が失敗しているプロダクトのみ警告対象にする
  // (公開承認済み作品の旧failを警告に数え続けないため status notIn 公開集合)。
  const validationFailureProjectWhere = {
    validationStatus: { in: VALIDATION_FAILURE_STATUSES },
    status: { notIn: PUBLIC_PROJECT_STATUSES },
  };

  const [
    recentRuns,
    runTotalCount,
    latestSuccessfulRunRow,
    openIncidents,
    latestQualityReport,
    todayUsageRows,
    sevenDayUsageRows,
    todayRequestCount,
    sevenDayRequestCount,
    agents,
    runtimeMetrics,
    activeCreatorGroups,
    failedSchedulerRunCount,
    observabilitySummary,
    projectTotalActiveCount,
    projectHeldForReviewCount,
    projectPendingPublishCount,
    projectValidationFailureCount,
    projectAttentionCount,
    projectCreatedLast24hCount,
    projectUpdatedOnlyLast24hCount,
    projectActivityLast24hCount,
    projectAutoPublishedCount,
    oldestHeldProject,
    researchCacheState,
    agentCreationState,
    agentInteractionsState,
    stewardState,
  ] = await Promise.all([
    prisma.run.findMany({
      where: epochWhere,
      select: runItemSelect,
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.run.count({ where: epochWhere }),
    prisma.run.findFirst({
      where: { status: "completed", ...epochWhere },
      select: runItemSelect,
      orderBy: { createdAt: "desc" },
    }),
    prisma.incident.findMany({
      where: {
        status: { notIn: ["resolved", "ignored"] },
        ...(logEpoch ? { lastSeenAt: { gte: logEpoch } } : {}),
      },
      orderBy: [{ lastSeenAt: "desc" }],
      take: 20,
    }),
    prisma.qualityReport.findFirst({
      where: logEpoch ? { generatedAt: { gte: logEpoch } } : {},
      select: {
        id: true,
        generatedAt: true,
        overallStatus: true,
        summary: true,
        findings: {
          select: {
            severity: true,
            status: true,
          },
        },
      },
      orderBy: { generatedAt: "desc" },
    }),
    prisma.modelUsageLog.findMany({
      where: { createdAt: { gte: gteWithEpoch(todayStart) } },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.modelUsageLog.findMany({
      where: { createdAt: { gte: gteWithEpoch(sevenDaysAgo) } },
      orderBy: { createdAt: "desc" },
      take: 3000,
    }),
    prisma.modelUsageLog.count({
      where: { createdAt: { gte: gteWithEpoch(todayStart) } },
    }),
    prisma.modelUsageLog.count({
      where: { createdAt: { gte: gteWithEpoch(sevenDaysAgo) } },
    }),
    prisma.agent.findMany({
      select: {
        id: true,
        active: true,
      },
    }),
    // 生成実行(self_directed_run)のみ。いいねcron等のcompletedが生成失敗をマスクしないようにする。
    prisma.agentRuntimeMetric.findMany({
      where: { eventType: "self_directed_run", ...epochWhere },
      select: {
        agentId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 160,
    }),
    prisma.agentRuntimeMetric.groupBy({
      by: ["agentId"],
      where: { eventType: "self_directed_run", createdAt: { gte: gteWithEpoch(last24Hours) } },
    }),
    prisma.schedulerRun.count({
      where: { status: "failed", ...(logEpoch ? { startedAt: { gte: logEpoch } } : {}) },
    }),
    readObservabilitySummary(prisma),
    prisma.project.count({ where: activeProjectWhere }),
    prisma.project.count({ where: { ...activeProjectWhere, status: "held_for_review" } }),
    prisma.project.count({
      where: { ...activeProjectWhere, publishDecision: { in: HOLD_PUBLISH_DECISIONS } },
    }),
    prisma.project.count({ where: { ...activeProjectWhere, ...validationFailureProjectWhere } }),
    prisma.project.count({
      where: {
        ...activeProjectWhere,
        OR: [
          { status: "held_for_review" },
          { publishDecision: { in: HOLD_PUBLISH_DECISIONS } },
          validationFailureProjectWhere,
        ],
      },
    }),
    prisma.project.count({
      where: { ...activeProjectWhere, createdAt: { gte: last24Hours } },
    }),
    prisma.project.count({
      where: { ...activeProjectWhere, updatedAt: { gte: last24Hours }, createdAt: { lt: last24Hours } },
    }),
    prisma.project.count({
      where: {
        ...activeProjectWhere,
        OR: [{ createdAt: { gte: last24Hours } }, { updatedAt: { gte: last24Hours } }],
      },
    }),
    prisma.project.count({ where: { ...activeProjectWhere, status: "auto_published" } }),
    prisma.project.findFirst({
      where: { ...activeProjectWhere, status: "held_for_review" },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    readSchedulerStateRecord<SchedulerStateRaw>(prisma, "research-cache-daily"),
    readSchedulerStateRecord<SchedulerStateRaw>(prisma, "agent-creation-daily"),
    readSchedulerStateRecord<SchedulerStateRaw>(prisma, "agent-interactions-daily"),
    readSchedulerStateRecord<SchedulerStateRaw>(prisma, "steward-daily"),
  ]);

  const p0IncidentCount = openIncidents.filter((incident) => incident.priority === "P0" && incident.status !== "monitoring").length;
  const p1IncidentCount = openIncidents.filter((incident) => incident.priority === "P1" && incident.status !== "monitoring").length;
  const monitoringIncidentCount = openIncidents.filter((incident) => incident.status === "monitoring").length;
  const actionQueue = [...openIncidents]
    .filter((incident) => ["P0", "P1"].includes(incident.priority) || incident.status === "monitoring")
    .sort((a, b) => {
      const aRank = a.status === "monitoring" ? 2 : incidentPriorityRank(a.priority);
      const bRank = b.status === "monitoring" ? 2 : incidentPriorityRank(b.priority);
      if (aRank !== bRank) return aRank - bRank;
      return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
    })
    .map((incident) => ({
      id: incident.id,
      title: incident.title,
      summary: incident.summary,
      severity: incident.severity,
      priority: incident.priority,
      status: incident.status,
      source: incident.source,
      impact: incident.impact,
      category: incident.category,
      nextAction: incident.nextAction,
      href: consoleIncidentHref(incident),
      runId: incident.runId,
      projectId: incident.projectId,
      agentId: incident.agentId,
      lastSeenAt: incident.lastSeenAt,
    }));

  const todayUsage = rollupUsage(todayUsageRows);
  const sevenDayUsage = rollupUsage(sevenDayUsageRows);
  const usageWarning =
    Number.isFinite(dailyCostCapUsd) && dailyCostCapUsd > 0 && todayUsage.cost >= dailyCostCapUsd * 0.7;
  const usageCritical =
    Number.isFinite(dailyCostCapUsd) && dailyCostCapUsd > 0 && todayUsage.cost >= dailyCostCapUsd;

  const overallStatus: ConsoleOverallStatus =
    p0IncidentCount > 0 || usageCritical
      ? "critical"
      : p1IncidentCount > 0 || monitoringIncidentCount > 0 || usageWarning
        ? "warning"
        : "healthy";
  const overallReason =
    overallStatus === "critical"
      ? p0IncidentCount > 0
        ? `${p0IncidentCount} P0 incident(s) need review.`
        : "Daily LLM cost cap exceeded (日次上限超過)."
      : overallStatus === "warning"
        ? `${p1IncidentCount} P1, ${monitoringIncidentCount} monitoring, usageWarning=${usageWarning}.`
        : "No urgent console action is required.";

  const latestRun = recentRuns[0] ? toRunItem(recentRuns[0]) : null;
  const latestRunningRun = recentRuns.find((run) => run.status === "running");

  const latestRuntimeByAgent = new Map<string, (typeof runtimeMetrics)[number]>();
  for (const metric of runtimeMetrics) {
    if (!latestRuntimeByAgent.has(metric.agentId)) {
      latestRuntimeByAgent.set(metric.agentId, metric);
    }
  }
  const runtimeErrorCount = [...latestRuntimeByAgent.values()].filter((metric) =>
    ["failed", "error"].includes(metric.status),
  ).length;

  return {
    generatedAt: now,
    overall: {
      status: overallStatus,
      reason: overallReason,
      p0IncidentCount,
      p1IncidentCount,
      monitoringIncidentCount,
      actionCount: actionQueue.length,
    },
    actionQueue,
    patrol: {
      latestReportId: latestQualityReport?.id ?? null,
      latestGeneratedAt: latestQualityReport?.generatedAt ?? null,
      overallStatus: latestQualityReport?.overallStatus ?? null,
      summary: latestQualityReport?.summary ?? null,
      findingCount: latestQualityReport?.findings.length ?? 0,
      highFindingCount:
        latestQualityReport?.findings.filter((finding) => ["critical", "blocker", "high"].includes(finding.severity)).length ?? 0,
      openFindingCount: latestQualityReport?.findings.filter((finding) => finding.status === "open").length ?? 0,
      href: "/human?view=quality",
    },
    runs: {
      totalCount: runTotalCount,
      latest: latestRun,
      latestSuccessful: latestSuccessfulRunRow ? toRunItem(latestSuccessfulRunRow) : null,
      latestRunning: latestRunningRun ? toRunItem(latestRunningRun) : null,
      failedSchedulerRunCount,
    },
    projects: {
      displayedCount: Math.min(PROJECT_DISPLAY_WINDOW, projectTotalActiveCount),
      totalActiveCount: projectTotalActiveCount,
      attentionCount: projectAttentionCount,
      pendingPublishCount: projectPendingPublishCount,
      heldForReviewCount: projectHeldForReviewCount,
      validationFailureCount: projectValidationFailureCount,
      createdLast24hCount: projectCreatedLast24hCount,
      updatedOnlyLast24hCount: projectUpdatedOnlyLast24hCount,
      activityLast24hCount: projectActivityLast24hCount,
      autoPublishedCount: projectAutoPublishedCount,
      oldestHeldCreatedAt: oldestHeldProject?.createdAt ?? null,
    },
    agents: {
      totalCount: agents.length,
      activeCount: agents.filter((agent) => agent.active).length,
      inactiveCount: agents.filter((agent) => !agent.active).length,
      runtimeErrorCount,
      latestRuntimeAt: runtimeMetrics[0]?.createdAt ?? null,
      activeCreatorCount24h: activeCreatorGroups.length,
    },
    usage: {
      todayTokens: todayUsage.tokens,
      todayCostUsd: todayUsage.cost,
      todayRequestCount,
      sevenDayTokens: sevenDayUsage.tokens,
      sevenDayCostUsd: sevenDayUsage.cost,
      sevenDayRequestCount,
      dailyCostCapUsd,
      warning: usageWarning,
      critical: usageCritical,
    },
    observability: {
      readyTableCount: observabilitySummary.readyTables.length,
      missingTables: observabilitySummary.missingTables,
    },
    scheduler: {
      researchCache: hideStaleSchedulerState(normalizeSchedulerState(researchCacheState)),
      agentCreation: hideStaleSchedulerState(normalizeSchedulerState(agentCreationState)),
      agentInteractions: hideStaleSchedulerState(normalizeSchedulerState(agentInteractionsState)),
      steward: hideStaleSchedulerState(normalizeSchedulerState(stewardState)),
    },
    links: {
      incidents: "/human?view=incidents",
      runs: "/human?view=runs",
      products: "/human?view=products",
      quality: "/human?view=quality",
      agents: "/human?view=agents",
      usage: "/human?view=usage",
      external: "/human?view=external",
    },
  };
};
