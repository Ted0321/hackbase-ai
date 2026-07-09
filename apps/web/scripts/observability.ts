import { randomUUID } from "node:crypto";
import { createPrismaClient } from "./prisma-client";
import { currentUsageLane, resolveUsageLane } from "./usage-lane";

type CreateDelegate = {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
};

type ObservabilityClient = {
  modelUsageLog?: CreateDelegate;
  agentRuntimeMetric?: CreateDelegate;
  $disconnect(): Promise<void>;
};

export type ModelUsageInput = {
  provider: string;
  model: string;
  operation: string;
  /** 予算レーン。未指定なら env PRODIA_USAGE_LANE（さらに未設定なら "scheduler"）。 */
  lane?: string;
  runId?: string;
  step?: string;
  agentId?: string;
  requestId?: string;
  status: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeInput = {
  agentId: string;
  runId?: string;
  schedulerKey?: string;
  eventType: string;
  status: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const durationMs = (startedAt: Date, completedAt: Date): number =>
  Math.max(0, completedAt.getTime() - startedAt.getTime());

export const extractGeminiTokenUsage = (response: unknown): TokenUsage => {
  if (!response || typeof response !== "object") return {};
  const usage = (response as Record<string, unknown>).usageMetadata;
  if (!usage || typeof usage !== "object") return {};
  const record = usage as Record<string, unknown>;
  return {
    promptTokens: asNumber(record.promptTokenCount),
    completionTokens: asNumber(record.candidatesTokenCount),
    totalTokens: asNumber(record.totalTokenCount),
  };
};

const safeStringify = (value: Record<string, unknown> | undefined): string | undefined => {
  if (!value) return undefined;
  return JSON.stringify(value);
};

const warnWriteFailure = (target: string, error: unknown) => {
  console.warn(`[observability] skipped ${target} write: ${errorMessageOf(error)}`);
};

export async function logModelUsage(input: ModelUsageInput): Promise<void> {
  let prisma: ObservabilityClient | null = null;
  try {
    prisma = createPrismaClient() as unknown as ObservabilityClient;
    if (!prisma.modelUsageLog) {
      console.warn("[observability] skipped modelUsageLog write: Prisma client delegate is unavailable.");
      return;
    }

    await prisma.modelUsageLog.create({
      data: {
        id: randomUUID(),
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        lane: input.lane !== undefined ? resolveUsageLane(input.lane) : currentUsageLane(),
        runId: input.runId,
        step: input.step,
        agentId: input.agentId,
        requestId: input.requestId,
        status: input.status,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        estimatedCostUsd: input.estimatedCostUsd,
        latencyMs: input.latencyMs,
        errorMessage: input.errorMessage,
        metadataJson: safeStringify(input.metadata),
      },
    });
  } catch (error) {
    warnWriteFailure("modelUsageLog", error);
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

export async function logAgentRuntimeMetric(input: AgentRuntimeInput): Promise<void> {
  let prisma: ObservabilityClient | null = null;
  try {
    prisma = createPrismaClient() as unknown as ObservabilityClient;
    if (!prisma.agentRuntimeMetric) {
      console.warn("[observability] skipped agentRuntimeMetric write: Prisma client delegate is unavailable.");
      return;
    }

    await prisma.agentRuntimeMetric.create({
      data: {
        id: randomUUID(),
        agentId: input.agentId,
        runId: input.runId,
        schedulerKey: input.schedulerKey,
        eventType: input.eventType,
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
        metadataJson: safeStringify(input.metadata),
      },
    });
  } catch (error) {
    warnWriteFailure("agentRuntimeMetric", error);
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}
