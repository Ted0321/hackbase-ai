// run-agent-interactions-scheduler.ts (Lane3) の日次配分ロジックのうち、副作用のない純粋関数だけを
// 独立させたモジュール。スケジューラー本体はimport時にmain()を即実行するため、テストからは
// 直接importできない — この分離により各関数を単体テストできる。
//
// 2026-07-10: 「いいね/コメント独立プール」から「行動ユニット」方式へ変更。
// 反応の1単位は ①いいねのみ / ②いいね＋コメント(同一作品セット) / ③コメントのみ のいずれかで、
// どれになるかは重み付き抽選(既定 55/30/15)。旧方式は「いいねに必ずLLM一言が本文添付」だったため
// 公開フィード上で全いいねにコメントが付いて見える不自然さがあった(ユーザー指摘)。
// パターン別の残数プール(自己補正)は持たない — 55/30/15は日次目標値ではなく期待値であり、
// 6ユニットに対する整数プールでは表現できないため。守るのは行数予算(グローバルceilingと
// per-agent日次行数)のみ。

// 1日あたりの反応ユニット数を、上限内でランダムに決める（0..maxDaily、~1に偏らせる）。
export const drawDailyCount = (maxDaily: number, random: () => number = Math.random): number => {
  const r = random();
  const count = r < 0.15 ? 0 : r < 0.75 ? 1 : 2;
  return Math.min(count, Math.max(0, maxDaily));
};

/** 行動ユニットの種別。①いいねのみ / ②いいね＋コメント / ③コメントのみ。 */
export type UnitPattern = "like_only" | "like_with_comment" | "comment_only";

export const UNIT_PATTERNS: readonly UnitPattern[] = [
  "like_only",
  "like_with_comment",
  "comment_only",
];

export function isUnitPattern(value: string): value is UnitPattern {
  return (UNIT_PATTERNS as readonly string[]).includes(value);
}

export type UnitPatternWeights = Record<UnitPattern, number>;

/** パターン抽選の基準重み。①55% / ②30% / ③15%（2026-07-10 ユーザー決定）。 */
export const DEFAULT_UNIT_PATTERN_WEIGHTS: UnitPatternWeights = {
  like_only: 0.55,
  like_with_comment: 0.3,
  comment_only: 0.15,
};

/**
 * env PRODIA_UNIT_PATTERN_WEIGHTS（例: "0.55,0.30,0.15"、順序は ①,②,③）をパースする。
 * 形式不正・負数・合計0は黙って既定値に落とす（スケジューラを止めるほどの設定ではないため）。
 */
export const parseUnitPatternWeights = (raw: string | undefined | null): UnitPatternWeights => {
  if (!raw?.trim()) return DEFAULT_UNIT_PATTERN_WEIGHTS;
  const parts = raw.split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return DEFAULT_UNIT_PATTERN_WEIGHTS;
  }
  const total = parts[0] + parts[1] + parts[2];
  if (total <= 0) return DEFAULT_UNIT_PATTERN_WEIGHTS;
  return {
    like_only: parts[0] / total,
    like_with_comment: parts[1] / total,
    comment_only: parts[2] / total,
  };
};

/** ユニットが消費するFeedback行数。②のみ2行(いいね行＋コメント行)。 */
export const unitRowCost = (pattern: UnitPattern): number =>
  pattern === "like_with_comment" ? 2 : 1;

// エージェントの性格(personaLikeProbability)をパターン抽選へ反映するブレンド比。
// 1.0なら性格補正のみ、0.0なら基準重みのみ。旧 POOL_BALANCE_WEIGHT と同じ調整ノブの思想。
export const PERSONA_PATTERN_WEIGHT = 0.5;

const normalizeWeights = (weights: UnitPatternWeights): UnitPatternWeights | null => {
  const total = weights.like_only + weights.like_with_comment + weights.comment_only;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    like_only: weights.like_only / total,
    like_with_comment: weights.like_with_comment / total,
    comment_only: weights.comment_only / total,
  };
};

/**
 * 基準重みをエージェントの性格でパターン方向へ傾ける。
 * personaLikeProbability p（policyの personaLikeProbability()、いいね寄り=1）で
 * ①×2p / ③×2(1-p)（②は不変）に補正→正規化し、基準重みと personaWeight で線形ブレンドする。
 * p=0.5（中立）なら補正が恒等になり、ブレンド比に関わらず基準重みへ厳密一致する。
 */
export function personaUnitWeights(
  base: UnitPatternWeights,
  personaLikeProbability: number | null | undefined,
  personaWeight: number = PERSONA_PATTERN_WEIGHT,
): UnitPatternWeights {
  const baseNormalized = normalizeWeights(base) ?? DEFAULT_UNIT_PATTERN_WEIGHTS;
  if (personaLikeProbability === null || personaLikeProbability === undefined) {
    return baseNormalized;
  }
  const p = Math.min(1, Math.max(0, personaLikeProbability));
  const adjusted = normalizeWeights({
    like_only: baseNormalized.like_only * 2 * p,
    like_with_comment: baseNormalized.like_with_comment,
    comment_only: baseNormalized.comment_only * 2 * (1 - p),
  });
  if (!adjusted) return baseNormalized;
  const blend = Math.min(1, Math.max(0, personaWeight));
  return {
    like_only: (1 - blend) * baseNormalized.like_only + blend * adjusted.like_only,
    like_with_comment:
      (1 - blend) * baseNormalized.like_with_comment + blend * adjusted.like_with_comment,
    comment_only: (1 - blend) * baseNormalized.comment_only + blend * adjusted.comment_only,
  };
}

/**
 * 次の1ユニットのパターンを重み付き抽選で決める。
 * rowBudget（残り行予算）が2未満のときは②を抽選対象から外して再正規化し、0以下ならnull。
 */
export const drawUnitPattern = (args: {
  weights?: UnitPatternWeights;
  personaLikeProbability?: number | null;
  rowBudget?: number;
  random?: () => number;
}): UnitPattern | null => {
  const rowBudget = args.rowBudget ?? Number.POSITIVE_INFINITY;
  if (rowBudget <= 0) return null;
  const weights = personaUnitWeights(
    args.weights ?? DEFAULT_UNIT_PATTERN_WEIGHTS,
    args.personaLikeProbability ?? null,
  );
  const candidates = UNIT_PATTERNS.filter((pattern) => unitRowCost(pattern) <= rowBudget).map(
    (pattern) => ({ pattern, weight: weights[pattern] }),
  );
  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  const random = args.random ?? Math.random;
  let cursor = random() * total;
  for (const entry of candidates) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.pattern;
  }
  return candidates[candidates.length - 1]?.pattern ?? null;
};

export type UnitPlanAgent = {
  agentId: string;
  // policyの personaLikeProbability() の値。未指定なら性格補正なし（基準重みのまま）。
  personaLikeProbability?: number | null;
};

export type PlannedUnit = {
  agentId: string;
  pattern: UnitPattern;
};

// Fisher–Yatesシャッフル（RNG注入）。registry順の先着バイアスを消すために使う。
// DOC-111のactivity導入時は、ここを activity 重みの Efraimidis–Spirakis 抽選
// (key = random()^(1/activity) 降順) に置き換える — 差し替え点をこの1箇所に閉じ込めている。
const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

/**
 * その日の行動ユニット一覧を計画する。
 *
 * 1. 各エージェントの需要（0..maxUnitsPerAgent ユニット）を drawDailyCount で抽選
 * 2. エージェント列をシャッフルし、ラウンドロビン（1周目=各1ユニット、残需要があれば2周目）で
 *    unitLimit ユニットを配布 — registry順の先着バイアスを避ける
 * 3. 各ユニットのパターンは drawUnitPattern（性格補正込み）。per-agent行数（maxRowsPerAgent）と
 *    グローバル行数（rowCeiling）の残りが2未満なら②は選ばれない
 */
export function planDailyUnits(args: {
  agents: readonly UnitPlanAgent[];
  unitLimit: number;
  maxUnitsPerAgent: number;
  maxRowsPerAgent: number;
  rowCeiling?: number;
  weights?: UnitPatternWeights;
  random?: () => number;
}): PlannedUnit[] {
  const random = args.random ?? Math.random;
  const weights = args.weights ?? DEFAULT_UNIT_PATTERN_WEIGHTS;
  let globalRowsLeft = args.rowCeiling ?? Number.POSITIVE_INFINITY;
  let unitsLeft = Math.max(0, args.unitLimit);

  const demands = args.agents
    .map((agent) => ({
      agent,
      demand: drawDailyCount(args.maxUnitsPerAgent, random),
      rowsLeft: Math.max(0, args.maxRowsPerAgent),
    }))
    .filter((entry) => entry.demand > 0);
  const order = shuffle(demands, random);

  const planned: PlannedUnit[] = [];
  for (let pass = 0; pass < args.maxUnitsPerAgent; pass += 1) {
    for (const entry of order) {
      if (unitsLeft <= 0 || globalRowsLeft <= 0) return planned;
      if (entry.demand <= pass) continue;
      const pattern = drawUnitPattern({
        weights,
        personaLikeProbability: entry.agent.personaLikeProbability ?? null,
        rowBudget: Math.min(entry.rowsLeft, globalRowsLeft),
        random,
      });
      if (!pattern) continue;
      planned.push({ agentId: entry.agent.agentId, pattern });
      const cost = unitRowCost(pattern);
      entry.rowsLeft -= cost;
      globalRowsLeft -= cost;
      unitsLeft -= 1;
    }
  }
  return planned;
}
