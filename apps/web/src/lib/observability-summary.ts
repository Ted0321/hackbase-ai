import type { PrismaClient } from "@prisma/client";
import { isPostgresUrl } from "./prisma-factory";
import { estimateModelUsageCostUsd } from "./model-usage-cost";

const OBSERVABILITY_TABLES = [
  "UserActivityLog",
  "AdminDecision",
  "ModelUsageLog",
  "AgentRuntimeMetric",
  "ReviewCase",
  "ReviewerLearning",
] as const;

type ObservabilityTableName = (typeof OBSERVABILITY_TABLES)[number];

type CountRow = {
  count: bigint | number | string;
};

type StatusCountRow = {
  status: string | null;
  count: bigint | number | string;
};

export type ModelUsageSummaryRow = {
  id: string;
  provider: string;
  model: string;
  operation: string;
  status: string;
  runId: string | null;
  agentId: string | null;
  step: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  createdAt: Date | string;
};

export type RuntimeMetricSummaryRow = {
  id: string;
  agentId: string;
  runId: string | null;
  schedulerKey: string | null;
  eventType: string;
  status: string;
  durationMs: number | null;
  createdAt: Date | string;
};

export type AdminDecisionSummaryRow = {
  id: string;
  decisionType: string;
  status: string;
  targetType: string;
  targetId: string;
  projectId: string | null;
  runId: string | null;
  agentId: string | null;
  adminName: string | null;
  decidedAt: Date | string;
};

export type UserActivitySummaryRow = {
  id: string;
  actorType: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  runId: string | null;
  source: string | null;
  createdAt: Date | string;
};

export type ReviewCaseSummaryRow = {
  id: string;
  reviewerAgentId: string;
  runId: string | null;
  projectId: string | null;
  reviewStatus: string;
  humanDecision: string | null;
  rewriteSucceeded: boolean | null;
  learningExtracted: boolean;
  createdAt: Date | string;
};

export type ReviewerLearningSummaryRow = {
  id: string;
  reviewerAgentId: string;
  sourceCaseId: string | null;
  lessonType: string;
  lesson: string;
  promoted: boolean;
  createdAt: Date | string;
};

export type ObservabilityTableSummary<Row> = {
  tableName: ObservabilityTableName;
  exists: boolean;
  count: number;
  recent: Row[];
  statusCounts?: Array<{
    status: string;
    count: number;
  }>;
  note?: string;
};

export type ModelUsageRollup = {
  totalTokens: number;
  estimatedCostUsd: number;
  averageLatencyMs: number | null;
};

export type ObservabilitySummary = {
  missingTables: ObservabilityTableName[];
  readyTables: ObservabilityTableName[];
  modelUsage: ObservabilityTableSummary<ModelUsageSummaryRow> & {
    rollup: ModelUsageRollup;
  };
  runtimeMetrics: ObservabilityTableSummary<RuntimeMetricSummaryRow>;
  adminDecisions: ObservabilityTableSummary<AdminDecisionSummaryRow>;
  userActivity: ObservabilityTableSummary<UserActivitySummaryRow>;
  reviewCases: ObservabilityTableSummary<ReviewCaseSummaryRow>;
  reviewerLearning: ObservabilityTableSummary<ReviewerLearningSummaryRow>;
};

const emptyTableSummary = <Row>(
  tableName: ObservabilityTableName,
  note?: string,
): ObservabilityTableSummary<Row> => ({
  tableName,
  exists: false,
  count: 0,
  recent: [],
  note,
});

const toNumber = (value: bigint | number | string | null | undefined): number => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const quoteIdentifier = (identifier: ObservabilityTableName | string) =>
  `"${identifier.replace(/"/g, '""')}"`;

const listExistingTables = async (prisma: PrismaClient): Promise<Set<string>> => {
  if (isPostgresUrl()) {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    return new Set(rows.map((row) => row.name));
  }

  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
};

const countRows = async (prisma: PrismaClient, tableName: ObservabilityTableName) => {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
  );
  return toNumber(rows[0]?.count);
};

const statusCounts = async (
  prisma: PrismaClient,
  tableName: ObservabilityTableName,
  statusColumn: "status" | "reviewStatus",
) => {
  const rows = await prisma.$queryRawUnsafe<StatusCountRow[]>(
    `SELECT ${quoteIdentifier(statusColumn)} AS status, COUNT(*) AS count FROM ${quoteIdentifier(
      tableName,
    )} GROUP BY ${quoteIdentifier(statusColumn)} ORDER BY count DESC`,
  );

  return rows.map((row) => ({
    status: row.status ?? "unknown",
    count: toNumber(row.count),
  }));
};

const readRecent = async <Row>(
  prisma: PrismaClient,
  tableName: ObservabilityTableName,
  columns: string[],
  orderColumn = "createdAt",
  take = 6,
) =>
  prisma.$queryRawUnsafe<Row[]>(
    `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(
      tableName,
    )} ORDER BY ${quoteIdentifier(orderColumn)} DESC LIMIT ${take}`,
  );

const unavailableNote = (error: unknown) =>
  error instanceof Error ? `unavailable: ${error.message}` : "unavailable";

const readTableSummary = async <Row>(
  prisma: PrismaClient,
  tableName: ObservabilityTableName,
  existingTables: Set<string>,
  columns: string[],
  options: {
    orderColumn?: string;
    statusColumn?: "status" | "reviewStatus";
  } = {},
): Promise<ObservabilityTableSummary<Row>> => {
  if (!existingTables.has(tableName)) {
    return emptyTableSummary<Row>(tableName, "table missing; run db:push before data appears");
  }

  try {
    const [count, recent, countsByStatus] = await Promise.all([
      countRows(prisma, tableName),
      readRecent<Row>(prisma, tableName, columns, options.orderColumn),
      options.statusColumn
        ? statusCounts(prisma, tableName, options.statusColumn)
        : Promise.resolve(undefined),
    ]);

    return {
      tableName,
      exists: true,
      count,
      recent,
      statusCounts: countsByStatus,
    };
  } catch (error) {
    return {
      ...emptyTableSummary<Row>(tableName, unavailableNote(error)),
      exists: true,
    };
  }
};

const modelUsageRollup = (rows: ModelUsageSummaryRow[]): ModelUsageRollup => {
  const latencyRows = rows.filter((row) => typeof row.latencyMs === "number");
  const totalLatency = latencyRows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0);

  return {
    totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
    estimatedCostUsd: rows.reduce((sum, row) => sum + estimateModelUsageCostUsd(row), 0),
    averageLatencyMs: latencyRows.length === 0 ? null : Math.round(totalLatency / latencyRows.length),
  };
};

export const readObservabilitySummary = async (
  prisma: PrismaClient,
): Promise<ObservabilitySummary> => {
  let existingTables: Set<string>;
  try {
    existingTables = await listExistingTables(prisma);
  } catch (error) {
    const note = unavailableNote(error);
    const missingTables = [...OBSERVABILITY_TABLES];
    return {
      missingTables,
      readyTables: [],
      modelUsage: {
        ...emptyTableSummary<ModelUsageSummaryRow>("ModelUsageLog", note),
        rollup: { totalTokens: 0, estimatedCostUsd: 0, averageLatencyMs: null },
      },
      runtimeMetrics: emptyTableSummary<RuntimeMetricSummaryRow>("AgentRuntimeMetric", note),
      adminDecisions: emptyTableSummary<AdminDecisionSummaryRow>("AdminDecision", note),
      userActivity: emptyTableSummary<UserActivitySummaryRow>("UserActivityLog", note),
      reviewCases: emptyTableSummary<ReviewCaseSummaryRow>("ReviewCase", note),
      reviewerLearning: emptyTableSummary<ReviewerLearningSummaryRow>("ReviewerLearning", note),
    };
  }

  const [
    modelUsage,
    runtimeMetrics,
    adminDecisions,
    userActivity,
    reviewCases,
    reviewerLearning,
  ] = await Promise.all([
    readTableSummary<ModelUsageSummaryRow>(
      prisma,
      "ModelUsageLog",
      existingTables,
      [
        "id",
        "provider",
        "model",
        "operation",
        "status",
        "runId",
        "agentId",
        "step",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "estimatedCostUsd",
        "latencyMs",
        "createdAt",
      ],
      { statusColumn: "status" },
    ),
    readTableSummary<RuntimeMetricSummaryRow>(
      prisma,
      "AgentRuntimeMetric",
      existingTables,
      ["id", "agentId", "runId", "schedulerKey", "eventType", "status", "durationMs", "createdAt"],
      { statusColumn: "status" },
    ),
    readTableSummary<AdminDecisionSummaryRow>(
      prisma,
      "AdminDecision",
      existingTables,
      [
        "id",
        "decisionType",
        "status",
        "targetType",
        "targetId",
        "projectId",
        "runId",
        "agentId",
        "adminName",
        "decidedAt",
      ],
      { orderColumn: "decidedAt", statusColumn: "status" },
    ),
    readTableSummary<UserActivitySummaryRow>(
      prisma,
      "UserActivityLog",
      existingTables,
      ["id", "actorType", "action", "targetType", "targetId", "projectId", "runId", "source", "createdAt"],
    ),
    readTableSummary<ReviewCaseSummaryRow>(
      prisma,
      "ReviewCase",
      existingTables,
      [
        "id",
        "reviewerAgentId",
        "runId",
        "projectId",
        "reviewStatus",
        "humanDecision",
        "rewriteSucceeded",
        "learningExtracted",
        "createdAt",
      ],
      { statusColumn: "reviewStatus" },
    ),
    readTableSummary<ReviewerLearningSummaryRow>(
      prisma,
      "ReviewerLearning",
      existingTables,
      ["id", "reviewerAgentId", "sourceCaseId", "lessonType", "lesson", "promoted", "createdAt"],
    ),
  ]);

  const readyTables = OBSERVABILITY_TABLES.filter((tableName) => existingTables.has(tableName));
  const missingTables = OBSERVABILITY_TABLES.filter((tableName) => !existingTables.has(tableName));

  return {
    missingTables,
    readyTables,
    modelUsage: {
      ...modelUsage,
      rollup: modelUsageRollup(modelUsage.recent),
    },
    runtimeMetrics,
    adminDecisions,
    userActivity,
    reviewCases,
    reviewerLearning,
  };
};
