/**
 * Lane3 反応対象の「人気×新着×ペルソナ親和」重み付き抽選(engagement-weighted、2026-07-11導入)。
 *
 * 旧 under-interacted(反応が少ない作品優先)は「反応ゼロの弱い作品が最優先・人気作が後回し」
 * という均等化バイアスがあり、「人気作に反応が集まり、なぜ評価されるかを観察する」方向と
 * 逆だったため置き換えた(作品側上限の撤廃とセット)。スケジューラの既定はこのモード。
 * ロールバックは env PRODIA_TARGET_SELECTION=under-interacted(コード変更不要)。
 *
 * 重み = 人気(反応数の対数; 人気が人気を呼ぶが独占はしない)
 *      × 新着ブースト(半減期7日; 反応ゼロの新作にも初速の露出を与えるコールドスタート対策)
 *      × ペルソナ親和(agentのtargetPreferenceとカテゴリー等の一致; 個体ごとの好みが出る)
 * を Efraimidis-Spirakis 重み付きシャッフル(orderTypesByPropensityと同じ手法)で抽選順に
 * 並べる。決定論の純関数(random注入可)なので interaction-target-ranking.test.ts で検証する。
 */
import { preferenceScore } from "./target-preference";

export type EngagementRankCandidate<T> = {
  project: T;
  createdAt: Date;
  /** この作品に既に付いているエージェント反応(いいね＋コメント)の行数。 */
  agentReactionCount: number;
  /** projectPreferenceSignals(project) で作る照合トークン(categoryId等)。 */
  preferenceSignals: string[];
};

/** 新着ブーストの倍率(公開直後 ≈ 1+RECENCY_BOOST 倍)。 */
export const RECENCY_BOOST = 1.5;
/** 新着ブーストの半減期(日)。7日で半減、1ヶ月でほぼ消える。 */
export const RECENCY_HALF_LIFE_DAYS = 7;
/** targetPreference 一致1件あたりの親和ブースト。 */
export const AFFINITY_BOOST_PER_MATCH = 0.6;
/** 親和ブーストとして数える一致数の上限(過剰支配を防ぐ)。 */
export const AFFINITY_MATCH_CAP = 2;

export function engagementWeight(args: {
  agentReactionCount: number;
  createdAt: Date;
  preferenceSignals: string[];
  preferences?: string[];
  now: Date;
}): number {
  // 対数減衰: 反応0→1.0 / 3→3.0 / 7→4.0 / 15→5.0。人気作ほど選ばれやすいが1強独占にはならない。
  const popularity = 1 + Math.log2(1 + Math.max(0, args.agentReactionCount));
  const ageDays = Math.max(0, (args.now.getTime() - args.createdAt.getTime()) / 86_400_000);
  const recency = 1 + RECENCY_BOOST * Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
  const matches = args.preferences?.length
    ? Math.min(preferenceScore(args.preferences, args.preferenceSignals), AFFINITY_MATCH_CAP)
    : 0;
  const affinity = 1 + AFFINITY_BOOST_PER_MATCH * matches;
  return popularity * recency * affinity;
}

/**
 * 候補を重み付き抽選順に並べ替えて project 配列を返す。先頭ほど選ばれやすい
 * (呼び出し側 planInteractions は先頭から「そのagentがまだ反応できる作品」を採る)。
 * 重み付きシャッフル: key = random()^(1/weight) の降順(Efraimidis-Spirakis)。
 */
export function rankProjectsByEngagement<T>(args: {
  candidates: EngagementRankCandidate<T>[];
  preferences?: string[];
  now?: Date;
  random?: () => number;
}): T[] {
  const now = args.now ?? new Date();
  const random = args.random ?? Math.random;
  return args.candidates
    .map((candidate) => {
      const weight = engagementWeight({
        agentReactionCount: candidate.agentReactionCount,
        createdAt: candidate.createdAt,
        preferenceSignals: candidate.preferenceSignals,
        preferences: args.preferences,
        now,
      });
      return { project: candidate.project, key: Math.pow(random(), 1 / weight) };
    })
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.project);
}
