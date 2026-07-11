import type { AgentRegistryProfile } from "./agent-registry";

export type InteractionType =
  | "agent_critique"
  | "agent_remix_suggestion"
  | "agent_risk_flag"
  | "agent_compare_note"
  | "agent_like";

export type ExistingAgentInteraction = {
  actorId: string | null;
  rating: string;
  createdAt: Date;
};

export type AgentInteractionPolicy = {
  defaultBatchLimit: number;
  maxBatchLimit: number;
  maxDailyInteractionsPerAgent: number;
  maxWeeklyInteractionsPerAgent: number;
  maxLikesPerBatch: number;
  typePriority: InteractionType[];
};

export const agentInteractionPolicy: AgentInteractionPolicy = {
  // 作品側の上限(1作品あたりの総反応数=旧6・同タイプコメント数=旧1)は2026-07-11に撤廃。
  // 反応の集中は「その作品がなぜ人気か」のシグナルとして観察したいため、作品側では絞らない。
  // 不自然さの防止は「同一エージェント×同一作品はいいね1回＋コメント系1回まで」のハードルール
  // (reactionTypeGroup / usedReactionGroups)だけで担保する。
  defaultBatchLimit: 3,
  maxBatchLimit: 10,
  maxDailyInteractionsPerAgent: 2,
  // 行動ユニット化(2026-07-10)で期待行数が約6→7.8行/日に増え、②(いいね＋コメント)が
  // 1ユニットで2行消費するため、週次だけが先に詰まらないよう 6→9 に引き上げ。
  maxWeeklyInteractionsPerAgent: 9,
  maxLikesPerBatch: 1,
  typePriority: [
    "agent_critique",
    "agent_remix_suggestion",
    "agent_risk_flag",
    "agent_compare_note",
    "agent_like",
  ],
};

export const interactionTypes = new Set<InteractionType>(agentInteractionPolicy.typePriority);

export function isInteractionType(value: string): value is InteractionType {
  return interactionTypes.has(value as InteractionType);
}

/**
 * 反応タイプの排他グループ。大前提ルール「同一エージェント×同一作品は、いいね1回＋コメント系
 * (講評/リスク/リミックス/比較)1回まで」の判定単位。rating は Feedback.rating の生文字列を受ける。
 */
export function reactionTypeGroup(rating: string): "like" | "comment" {
  return rating === "agent_like" ? "like" : "comment";
}

/** 同一エージェントがこの作品で既に使った排他グループの集合。 */
export function usedReactionGroups(
  interactions: ExistingAgentInteraction[],
  actingAgentId: string,
): Set<"like" | "comment"> {
  return new Set(
    interactions
      .filter((interaction) => interaction.actorId === actingAgentId)
      .map((interaction) => reactionTypeGroup(interaction.rating)),
  );
}

export function dayWindowStart(now = new Date()) {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export function weekWindowStart(now = new Date()) {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

const shortProjectHint = (oneLiner?: string | null) => {
  const text = oneLiner?.trim();
  if (!text) return null;
  return text.length > 30 ? `${text.slice(0, 30).trim()}...` : text;
};

export function defaultComment(
  type: InteractionType,
  _agentName: string,
  projectTitle: string,
  projectOneLiner?: string | null,
) {
  const hint = shortProjectHint(projectOneLiner);
  const target = `「${projectTitle}」`;
  const entry = hint ? `${hint}という入口があり、` : "";

  switch (type) {
    case "agent_like":
      return `${target}は、${entry}良さがすぐ伝わります。次は一番見せたい使い方を短く添えるとさらに伸びそうです。`;
    case "agent_critique":
      return `${target}は、最初に何を触るかをもう少し明確にすると入りやすくなります。入力例か最初の一手を1つ置くと、価値が早く伝わりそうです。`;
    case "agent_risk_flag":
      return `${target}は、根拠や前提が強く見えすぎないよう注意したいです。判断材料と未確認の境界を見せると、安心して使える形になります。`;
    case "agent_remix_suggestion":
      return `${target}の仕組みは、別の場面にも移せそうです。同じ見せ方で「次の一手」を選ぶ用途に展開すると、派生案として自然に伸びます。`;
    case "agent_compare_note":
      return `${target}は、近い作品と比べてどこが違うかを冒頭で見せると強くなります。判断軸や出力の差が見えると、位置づけが伝わりやすいです。`;
  }
}

export function canAgentUseType(agent: AgentRegistryProfile, type: InteractionType) {
  return Boolean(agent.interactionPolicy?.canReactWith.includes(type));
}

// 全エージェント一律で agent_like（ただの称賛）の選ばれやすさをこの倍率で調整する。
// FB・改善系（講評/リスク/比較/リミックス）が多すぎても違和感があるため、like をやや増やして
// FB/改善系を約65%に寄せる狙い。重み付き抽選(下記ES)の先頭確率は重みに比例するので、
// like の重みを ×1.8 すると設計上の like 比率が約24%→約35%（FB/改善系 約76%→約65%）へ動く。
// <1 で like を減らし FB を増やす、>1 で like を増やし FB を減らす。各エージェントの性格差
// （相対バランス）は保つ。割合を調整したいときはこの1点を変える。
const LIKE_PROPENSITY_WEIGHT = 1.8;

// A-4: agentの性格(propensity)で反応タイプの「選ばれやすさ」を変える。
// canReactWith に含まれる型を、propensity重みで重み付きシャッフルして順序を返す。
// propensity未設定の型は既定重み(1)。これで「いいね多用型/講評型」など性格差が行動に出る。
export function orderTypesByPropensity(
  agent: AgentRegistryProfile,
  types: InteractionType[],
  random: () => number = Math.random,
): InteractionType[] {
  const propensity = agent.interactionPolicy?.propensity ?? {};
  const usable = types.filter((type) => canAgentUseType(agent, type));
  // 重み付きシャッフル: 各要素に key = random()^(1/weight) を割り当てて降順（Efraimidis-Spirakis）。
  return usable
    .map((type) => {
      const rawWeight = Math.max(0.0001, propensity[type] ?? 1);
      const weight = type === "agent_like" ? rawWeight * LIKE_PROPENSITY_WEIGHT : rawWeight;
      const key = Math.pow(random(), 1 / weight);
      return { type, key };
    })
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.type);
}

// そのエージェントの性格(propensity)だけから見た「いいねを選ぶ確率」(0..1)。
// orderTypesByPropensity と同じ重み(LIKE_PROPENSITY_WEIGHT込み)を使い、like vs コメント系4種の
// 重みの比から単純化した近似値を出す(重み付きシャッフルの厳密な先頭確率とは完全一致しないが、
// 「このエージェントはいいね寄りか講評寄りか」を表す指標としては十分)。
// 日次いいね/コメント目標プールとブレンドして使う(run-agent-interactions-scheduler.ts)。
export function personaLikeProbability(
  agent: AgentRegistryProfile,
  policy: AgentInteractionPolicy = agentInteractionPolicy,
): number {
  const propensity = agent.interactionPolicy?.propensity ?? {};
  const usable = policy.typePriority.filter((type) => canAgentUseType(agent, type));
  if (!usable.includes("agent_like")) return 0;
  const commentTypes = usable.filter((type) => type !== "agent_like");
  if (commentTypes.length === 0) return 1;

  const likeWeight = Math.max(0.0001, propensity.agent_like ?? 1) * LIKE_PROPENSITY_WEIGHT;
  const commentWeightSum = commentTypes.reduce(
    (sum, type) => sum + Math.max(0.0001, propensity[type] ?? 1),
    0,
  );
  return likeWeight / (likeWeight + commentWeightSum);
}

export function selectInteractionType(args: {
  agent: AgentRegistryProfile;
  existingProjectInteractions: ExistingAgentInteraction[];
  requestedType?: InteractionType;
  // like/comment のどちらかに絞る(いいね/コメントの日次配分を厳守するためのスケジューラ用)。
  // requestedType(厳密1タイプ指定)と併用時はrequestedTypeが優先。
  requestedGroup?: "like" | "comment";
  likesAlreadyPlanned: number;
  force?: boolean;
  policy?: AgentInteractionPolicy;
}) {
  const policy = args.policy ?? agentInteractionPolicy;

  // 性格(propensity)重みでcanReactWith内を並べ替え。requestedType指定時はそれのみ。
  // requestedGroup指定時は、propensity順を保ったままそのグループ(like/コメント系)だけに絞る。
  const ordered = args.requestedType
    ? [args.requestedType]
    : orderTypesByPropensity(args.agent, policy.typePriority);
  const candidates = args.requestedGroup
    ? ordered.filter((type) => reactionTypeGroup(type) === args.requestedGroup)
    : ordered;

  // 大前提(ハード): 同一エージェント×同一作品は、いいね1回＋コメント系1回まで。
  const groupsUsedByAgent = args.agent.agentId
    ? usedReactionGroups(args.existingProjectInteractions, args.agent.agentId)
    : new Set<"like" | "comment">();

  for (const type of candidates) {
    if (!canAgentUseType(args.agent, type)) continue;
    if (!args.force && type === "agent_like" && args.likesAlreadyPlanned >= policy.maxLikesPerBatch) continue;
    if (groupsUsedByAgent.has(reactionTypeGroup(type))) continue;
    return type;
  }

  return null;
}

export function evaluateInteractionLimits(args: {
  existingProjectInteractions: ExistingAgentInteraction[];
  actingAgentId: string;
  selectedType: InteractionType;
  dailyCount: number;
  weeklyCount: number;
  force?: boolean;
  policy?: AgentInteractionPolicy;
}) {
  const policy = args.policy ?? agentInteractionPolicy;
  const reasons: string[] = [];

  // 大前提(ハード、--forceでも不変): 同一エージェント×同一作品は「いいね1回＋コメント系1回」まで。
  // 同じ作品への重ねいいね・重ねコメントはどの経路からも作れない。
  const selectedGroup = reactionTypeGroup(args.selectedType);
  const agentUsedGroup = usedReactionGroups(args.existingProjectInteractions, args.actingAgentId).has(
    selectedGroup,
  );

  if (args.force) {
    const hardReasons: string[] = [];
    if (agentUsedGroup) {
      hardReasons.push(`same agent already used the ${selectedGroup} slot on this project`);
    }
    return { allowed: hardReasons.length === 0, reasons: hardReasons };
  }

  if (args.dailyCount >= policy.maxDailyInteractionsPerAgent) {
    reasons.push(`agent daily limit reached (${args.dailyCount}/${policy.maxDailyInteractionsPerAgent})`);
  }

  if (args.weeklyCount >= policy.maxWeeklyInteractionsPerAgent) {
    reasons.push(`agent weekly limit reached (${args.weeklyCount}/${policy.maxWeeklyInteractionsPerAgent})`);
  }

  if (agentUsedGroup) {
    reasons.push(`same agent already used the ${selectedGroup} slot on this project`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
