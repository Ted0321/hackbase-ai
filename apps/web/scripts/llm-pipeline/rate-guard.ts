import { estimateModelUsageCostUsd } from "../../src/lib/model-usage-cost";
import { createPrismaClient } from "../prisma-client";
import { currentUsageLane } from "../usage-lane";

/**
 * B-1: Gemini 呼び出しのコスト/リクエスト暴走ガード（無人運用の安全化）。
 *
 * run-gemini.ts（パイプライン）と gemini-text.ts（AI反応等の短文生成）の両経路から、
 * 実APIコール直前に呼ぶ。当日(UTC)の ModelUsageLog 集計（provider=google-gemini、
 * かつ自プロセスと同じ lane）を読み、段階式に判定する:
 *   - しきい値の 70% 到達 → console.warn（無人運用のログ/アラートで拾える）
 *   - 100% 到達       → throw（当該 run を中断＝ループ暴走を確実に止める）
 *
 * しきい値は env で調整（控えめ既定）:
 *   GEMINI_DAILY_MAX_REQUESTS（既定 500、<=0 で無制限）
 *   GEMINI_DAILY_MAX_COST_USD（既定 10、<=0 で無制限）
 *   PRODIA_USAGE_LANE（既定 "scheduler"。手動スキルは buildProdEnv が "manual" を注入）
 *
 * レーン分離の背景（2026-07-08 障害）: かつて母数が UTC 日次の全行共有プールで、
 * 手動生成スキル（$50/2000req）が先に走った日は本番 Job（$3/120req）が開始即
 * "cap reached (389/120)" で全滅した。lane 列で母数を分け、各レーンの上限は
 * 各レーンの使用量にだけ効くようにした（usage-lane.ts 参照）。
 *
 * 主目的はコストではなくループ暴走の停止。リクエスト数が実用的なストッパで、
 * コストは flash の token 単価からの概算。ガードの READ 失敗（DB未初期化等）は
 * fail-open（ガード不全でパイプラインは止めない）。
 */

type ModelUsageRow = {
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
};

type RateGuardPrisma = {
  modelUsageLog?: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
    }) => Promise<ModelUsageRow[]>;
  };
  $disconnect: () => Promise<void>;
};

// コスト概算は表示側(console)と同じ src/lib/model-usage-cost の estimateModelUsageCostUsd に
// 一本化する。これで PRICING表の重複を排し、thinkingトークン(totalから逆算)と画像の
// estimatedCostUsd の扱いが表示・遮断で一致する（旧 estimateRowCostUsd はこれらを取りこぼしていた）。

const numFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type GeminiBudgetContext = {
  operation: string;
  runId?: string;
  step?: string;
  agentId?: string;
};

export type GeminiUsageToday = { requestCount: number; costUsd: number };

/** 当日(UTC)・自レーンの Gemini 使用量を集計。READ失敗時は fail-open で {0,0}。 */
export const readGeminiUsageToday = async (
  now: Date = new Date(),
  lane: string = currentUsageLane(),
): Promise<GeminiUsageToday> => {
  let prisma: RateGuardPrisma | null = null;
  try {
    prisma = createPrismaClient() as unknown as RateGuardPrisma;
    if (!prisma.modelUsageLog) return { requestCount: 0, costUsd: 0 };
    const rows = await prisma.modelUsageLog.findMany({
      where: { provider: "google-gemini", lane, createdAt: { gte: startOfUtcDay(now) } },
      select: { model: true, promptTokens: true, completionTokens: true, totalTokens: true, estimatedCostUsd: true },
    });
    const costUsd = rows.reduce((sum, row) => sum + estimateModelUsageCostUsd(row), 0);
    return { requestCount: rows.length, costUsd };
  } catch (error) {
    console.warn(
      `[gemini-budget] usage read failed (fail-open, guard skipped this call): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { requestCount: 0, costUsd: 0 };
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
};

export type GeminiRunBudgetPrecheck = {
  skip: boolean;
  reason: string | null;
  requestCount: number;
  costUsd: number;
  maxRequests: number;
  maxCostUsd: number;
};

/**
 * 生成 run の「開始前」ヘッドルーム判定。enforceGeminiBudget が上限到達後の実コールを
 * 止めるのに対し、こちらは「残枠が 1 run 分に満たないまま開始して途中でキャップ死する」
 * 無駄焼きを防ぐ（2026-07-13 実測: research〜concept で $2.09 消費後に requirements で
 * キャップ停止し run 全損）。しきい値は env（<=0 で当該チェック無効）:
 *   PRODIA_MIN_RUN_BUDGET_HEADROOM_USD（既定 2 — 概ねフル run 1 本ぶん）
 *   PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS（既定 12 — 1 run ≈ 10 calls + 余裕）
 * READ 失敗は readGeminiUsageToday の fail-open（{0,0}）に乗るため skip しない。
 */
export const precheckGeminiRunBudget = async (
  options: {
    now?: Date;
    lane?: string;
    readUsage?: (now: Date, lane: string) => Promise<GeminiUsageToday>;
  } = {},
): Promise<GeminiRunBudgetPrecheck> => {
  const now = options.now ?? new Date();
  const lane = options.lane ?? currentUsageLane();
  const maxRequests = numFromEnv("GEMINI_DAILY_MAX_REQUESTS", 500);
  const maxCostUsd = numFromEnv("GEMINI_DAILY_MAX_COST_USD", 10);
  const minCostHeadroomUsd = numFromEnv("PRODIA_MIN_RUN_BUDGET_HEADROOM_USD", 2);
  const minRequestHeadroom = numFromEnv("PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS", 12);

  const costCheckEnabled = maxCostUsd > 0 && minCostHeadroomUsd > 0;
  const requestCheckEnabled = maxRequests > 0 && minRequestHeadroom > 0;
  if (!costCheckEnabled && !requestCheckEnabled) {
    return { skip: false, reason: null, requestCount: 0, costUsd: 0, maxRequests, maxCostUsd };
  }

  const { requestCount, costUsd } = await (options.readUsage ?? readGeminiUsageToday)(now, lane);
  const reasons: string[] = [];
  if (costCheckEnabled && maxCostUsd - costUsd < minCostHeadroomUsd) {
    reasons.push(
      `cost headroom $${(maxCostUsd - costUsd).toFixed(2)} < $${minCostHeadroomUsd} (used $${costUsd.toFixed(2)}/$${maxCostUsd})`,
    );
  }
  if (requestCheckEnabled && maxRequests - requestCount < minRequestHeadroom) {
    reasons.push(
      `request headroom ${maxRequests - requestCount} < ${minRequestHeadroom} (used ${requestCount}/${maxRequests})`,
    );
  }
  if (reasons.length === 0) {
    return { skip: false, reason: null, requestCount, costUsd, maxRequests, maxCostUsd };
  }
  return {
    skip: true,
    reason: `Gemini budget headroom too low to start a run [lane=${lane}]: ${reasons.join("; ")}`,
    requestCount,
    costUsd,
    maxRequests,
    maxCostUsd,
  };
};

const WARN_RATIO = 0.7;

/**
 * 実Geminiコール直前に呼ぶ。100%でthrow（暴走停止）、70%でwarn。
 * 両しきい値とも <=0 なら無制限（ガード無効・DB読取もしない）。
 */
export const enforceGeminiBudget = async (ctx: GeminiBudgetContext): Promise<void> => {
  const maxRequests = numFromEnv("GEMINI_DAILY_MAX_REQUESTS", 500);
  const maxCostUsd = numFromEnv("GEMINI_DAILY_MAX_COST_USD", 10);
  const requestsLimited = maxRequests > 0;
  const costLimited = maxCostUsd > 0;
  if (!requestsLimited && !costLimited) return;

  const lane = currentUsageLane();
  const { requestCount, costUsd } = await readGeminiUsageToday(new Date(), lane);
  const where = `lane=${lane} op=${ctx.operation}${ctx.runId ? ` run=${ctx.runId}` : ""}${
    ctx.step ? ` step=${ctx.step}` : ""
  }`;

  if (requestsLimited && requestCount >= maxRequests) {
    throw Object.assign(
      new Error(
        `Gemini daily request cap reached (${requestCount}/${maxRequests}) [${where}]. ` +
          `Halting to prevent runaway loop. Raise GEMINI_DAILY_MAX_REQUESTS to continue.`,
      ),
      { budgetCapped: true },
    );
  }
  if (costLimited && costUsd >= maxCostUsd) {
    throw Object.assign(
      new Error(
        `Gemini daily cost cap reached ($${costUsd.toFixed(2)}/$${maxCostUsd.toFixed(2)}) [${where}]. ` +
          `Halting to prevent runaway spend. Raise GEMINI_DAILY_MAX_COST_USD to continue.`,
      ),
      { budgetCapped: true },
    );
  }
  if (requestsLimited && requestCount >= maxRequests * WARN_RATIO) {
    console.warn(`[gemini-budget] WARNING requests ${requestCount}/${maxRequests} (>=70%) [${where}].`);
  }
  if (costLimited && costUsd >= maxCostUsd * WARN_RATIO) {
    console.warn(
      `[gemini-budget] WARNING cost $${costUsd.toFixed(2)}/$${maxCostUsd.toFixed(2)} (>=70%) [${where}].`,
    );
  }
};
