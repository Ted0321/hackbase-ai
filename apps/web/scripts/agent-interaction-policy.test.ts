/**
 * agent-interaction-policy.ts の propensity 重み付けと反応ルール(排他グループ)の単体テスト。
 * orderTypesByPropensity は random を注入できるので決定論的に検証できる。
 * `npm run eval:propensity:test` で実行。
 */
import assert from "node:assert/strict";
import type { AgentRegistryProfile } from "./agent-registry";
import {
  agentInteractionPolicy,
  evaluateInteractionLimits,
  orderTypesByPropensity,
  personaLikeProbability,
  reactionTypeGroup,
  selectInteractionType,
  type ExistingAgentInteraction,
  type InteractionType,
} from "./agent-interaction-policy";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const agentWith = (
  canReactWith: InteractionType[],
  propensity?: Record<string, number>,
): AgentRegistryProfile =>
  ({ interactionPolicy: { canReactWith, propensity } } as unknown as AgentRegistryProfile);

const ALL: InteractionType[] = agentInteractionPolicy.typePriority;

check("constant random orders by descending propensity weight", () => {
  // canReactWith は propensity を割り当てた4型に揃える（未指定型は default 重み1 が先頭に来てしまうため）。
  const weighted: InteractionType[] = [
    "agent_critique",
    "agent_risk_flag",
    "agent_compare_note",
    "agent_like",
  ];
  const agent = agentWith(weighted, {
    agent_critique: 0.5,
    agent_risk_flag: 0.3,
    agent_compare_note: 0.15,
    agent_like: 0.05,
  });
  const order = orderTypesByPropensity(agent, ALL, () => 0.5);
  assert.deepEqual(order, weighted);
});

check("only canReactWith types are returned", () => {
  const agent = agentWith(["agent_critique", "agent_like"], {
    agent_critique: 0.5,
    agent_like: 0.5,
  });
  const order = orderTypesByPropensity(agent, ALL, () => 0.5);
  assert.deepEqual(new Set(order), new Set(["agent_critique", "agent_like"]));
});

check("missing propensity falls back to default weight 1", () => {
  const agent = agentWith(["agent_critique", "agent_like"]); // no propensity map
  const order = orderTypesByPropensity(agent, ALL, () => 0.5);
  assert.equal(order.length, 2);
});

check("seeded RNG: high-weight type leads far more often than low-weight", () => {
  // 決定論的な線形合同法 RNG
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const agent = agentWith(["agent_critique", "agent_like"], {
    agent_critique: 0.9,
    agent_like: 0.1,
  });
  let critiqueFirst = 0;
  let likeFirst = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i += 1) {
    const first = orderTypesByPropensity(agent, ALL, random)[0];
    if (first === "agent_critique") critiqueFirst += 1;
    else if (first === "agent_like") likeFirst += 1;
  }
  // 重み 0.9 vs 0.1 なら critique が圧倒的に先頭を取る
  assert.ok(
    critiqueFirst > likeFirst * 3,
    `expected critique to lead far more often, got critique=${critiqueFirst} like=${likeFirst}`,
  );
});

// ---- 反応ルール(大前提): 同一エージェント×同一作品は「いいね1回＋コメント系1回」まで ----

const interaction = (actorId: string, rating: string): ExistingAgentInteraction => ({
  actorId,
  rating,
  createdAt: new Date("2026-07-08T00:00:00Z"),
});

const limitsFor = (
  existing: ExistingAgentInteraction[],
  selectedType: InteractionType,
  force: boolean,
) =>
  evaluateInteractionLimits({
    existingProjectInteractions: existing,
    actingAgentId: "agent_x",
    selectedType,
    dailyCount: 0,
    weeklyCount: 0,
    force,
  });

check("reactionTypeGroup: like と コメント系で排他グループが分かれる", () => {
  assert.equal(reactionTypeGroup("agent_like"), "like");
  assert.equal(reactionTypeGroup("agent_critique"), "comment");
  assert.equal(reactionTypeGroup("agent_compare_note"), "comment");
});

check("いいね済みのエージェントは同じ作品にコメントを追加できる(併用可)", () => {
  const existing = [interaction("agent_x", "agent_like")];
  assert.equal(limitsFor(existing, "agent_critique", false).allowed, true);
  assert.equal(limitsFor(existing, "agent_critique", true).allowed, true);
});

check("同じ作品への重ねいいねは force でも不可(ハード)", () => {
  const existing = [interaction("agent_x", "agent_like")];
  assert.equal(limitsFor(existing, "agent_like", true).allowed, false);
  assert.equal(limitsFor(existing, "agent_like", false).allowed, false);
});

check("コメント済みのエージェントは別タイプでも2つ目のコメントを置けない(ハード)", () => {
  const existing = [interaction("agent_x", "agent_critique")];
  assert.equal(limitsFor(existing, "agent_compare_note", true).allowed, false);
  assert.equal(limitsFor(existing, "agent_remix_suggestion", false).allowed, false);
});

check("別のエージェントは同じ作品をいいねできる(per-agent化)", () => {
  const existing = [interaction("agent_other", "agent_like")];
  assert.equal(limitsFor(existing, "agent_like", false).allowed, true);
  assert.equal(limitsFor(existing, "agent_like", true).allowed, true);
});

check("同タイプ上限はコメント系のみに効く(他エージェントの同型講評はブロック)", () => {
  const existing = [interaction("agent_other", "agent_critique")];
  const result = limitsFor(existing, "agent_critique", false);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes("type limit")));
});

check("週次上限(9)の境界: weeklyCount=9でブロック、8なら許可", () => {
  const blocked = evaluateInteractionLimits({
    existingProjectInteractions: [],
    actingAgentId: "agent_x",
    selectedType: "agent_critique",
    dailyCount: 0,
    weeklyCount: 9,
    force: false,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("weekly limit")));
  const allowed = evaluateInteractionLimits({
    existingProjectInteractions: [],
    actingAgentId: "agent_x",
    selectedType: "agent_critique",
    dailyCount: 0,
    weeklyCount: 8,
    force: false,
  });
  assert.equal(allowed.allowed, true);
});

check("personaLikeProbability: canReactWithにagent_likeが無ければ0", () => {
  const agent = agentWith(["agent_critique", "agent_compare_note"]);
  assert.equal(personaLikeProbability(agent), 0);
});

check("personaLikeProbability: agent_likeしか使えないなら1", () => {
  const agent = agentWith(["agent_like"]);
  assert.equal(personaLikeProbability(agent), 1);
});

check("personaLikeProbability: いいね寄りの性格ほど値が大きくなる(単調性)", () => {
  const types: InteractionType[] = ["agent_like", "agent_critique"];
  const likeLover = agentWith(types, { agent_like: 5, agent_critique: 1 });
  const critiqueLover = agentWith(types, { agent_like: 0.2, agent_critique: 5 });
  const likeLoverProb = personaLikeProbability(likeLover);
  const critiqueLoverProb = personaLikeProbability(critiqueLover);
  assert.ok(likeLoverProb > critiqueLoverProb, `expected ${likeLoverProb} > ${critiqueLoverProb}`);
  assert.ok(likeLoverProb > 0 && likeLoverProb < 1);
  assert.ok(critiqueLoverProb > 0 && critiqueLoverProb < 1);
});

check("selectInteractionType: requestedGroup=likeでいいね以外の型が候補から除外される", () => {
  const agent = {
    agentId: "agent_x",
    interactionPolicy: { canReactWith: ["agent_like", "agent_critique", "agent_compare_note"] },
  } as unknown as AgentRegistryProfile;
  const type = selectInteractionType({
    agent,
    existingProjectInteractions: [],
    requestedGroup: "like",
    likesAlreadyPlanned: 0,
    force: false,
  });
  assert.equal(type, "agent_like");
});

check("selectInteractionType: requestedGroup=commentでいいねが候補から除外される", () => {
  const agent = {
    agentId: "agent_x",
    interactionPolicy: { canReactWith: ["agent_like", "agent_critique"] },
  } as unknown as AgentRegistryProfile;
  const type = selectInteractionType({
    agent,
    existingProjectInteractions: [],
    requestedGroup: "comment",
    likesAlreadyPlanned: 0,
    force: false,
  });
  assert.equal(type, "agent_critique");
});

check("selectInteractionType: requestedGroupに合う型が無ければnull", () => {
  const agent = {
    agentId: "agent_x",
    interactionPolicy: { canReactWith: ["agent_like"] },
  } as unknown as AgentRegistryProfile;
  const type = selectInteractionType({
    agent,
    existingProjectInteractions: [],
    requestedGroup: "comment",
    likesAlreadyPlanned: 0,
    force: false,
  });
  assert.equal(type, null);
});

check("selectInteractionType: いいね済みエージェントにはコメント系が選ばれ、両方済みなら null", () => {
  const agent = {
    agentId: "agent_x",
    interactionPolicy: { canReactWith: ["agent_like", "agent_critique"] },
  } as unknown as AgentRegistryProfile;
  const liked = [interaction("agent_x", "agent_like")];
  assert.equal(
    selectInteractionType({ agent, existingProjectInteractions: liked, likesAlreadyPlanned: 0, force: true }),
    "agent_critique",
  );
  const both = [interaction("agent_x", "agent_like"), interaction("agent_x", "agent_critique")];
  assert.equal(
    selectInteractionType({ agent, existingProjectInteractions: both, likesAlreadyPlanned: 0, force: true }),
    null,
  );
});

console.log(`\nAll ${passed} agent-interaction-policy checks passed.`);
