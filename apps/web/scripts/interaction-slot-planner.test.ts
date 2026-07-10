/**
 * interaction-slot-planner.ts の単体テスト。`npm run eval:interaction-slot-planner:test` で実行。
 */
import assert from "node:assert/strict";
import {
  DEFAULT_UNIT_PATTERN_WEIGHTS,
  drawDailyCount,
  drawUnitPattern,
  parseUnitPatternWeights,
  personaUnitWeights,
  planDailyUnits,
  unitRowCost,
  type UnitPattern,
} from "./interaction-slot-planner";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

// 決定論的な線形合同法 RNG（テスト間で再現可能にするため new Date()/Math.random は使わない）。
const makeRandom = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
};

const approxEqual = (actual: number, expected: number, tolerance: number, label: string) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual.toFixed(4)} expected≈${expected} (±${tolerance})`,
  );
};

check("parseUnitPatternWeights: 未指定・形式不正・負数・合計0は既定値に落ちる", () => {
  assert.deepEqual(parseUnitPatternWeights(undefined), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(parseUnitPatternWeights(""), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(parseUnitPatternWeights("0.5,0.5"), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(parseUnitPatternWeights("a,b,c"), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(parseUnitPatternWeights("0.5,-0.2,0.7"), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(parseUnitPatternWeights("0,0,0"), DEFAULT_UNIT_PATTERN_WEIGHTS);
});

check("parseUnitPatternWeights: 合計1に正規化される", () => {
  const weights = parseUnitPatternWeights("55,30,15");
  approxEqual(weights.like_only, 0.55, 1e-9, "like_only");
  approxEqual(weights.like_with_comment, 0.3, 1e-9, "like_with_comment");
  approxEqual(weights.comment_only, 0.15, 1e-9, "comment_only");
});

check("unitRowCost: ②のみ2行、①③は1行", () => {
  assert.equal(unitRowCost("like_only"), 1);
  assert.equal(unitRowCost("like_with_comment"), 2);
  assert.equal(unitRowCost("comment_only"), 1);
});

check("personaUnitWeights: p=0.5（中立）なら基準重みへ厳密一致する", () => {
  const weights = personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, 0.5);
  approxEqual(weights.like_only, 0.55, 1e-9, "like_only");
  approxEqual(weights.like_with_comment, 0.3, 1e-9, "like_with_comment");
  approxEqual(weights.comment_only, 0.15, 1e-9, "comment_only");
});

check("personaUnitWeights: p未指定なら基準重みのまま", () => {
  assert.deepEqual(personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, null), DEFAULT_UNIT_PATTERN_WEIGHTS);
  assert.deepEqual(
    personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, undefined),
    DEFAULT_UNIT_PATTERN_WEIGHTS,
  );
});

check("personaUnitWeights: personaWeight=1.0でp=1なら③が0、p=0なら①が0になる", () => {
  const likeLover = personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, 1, 1.0);
  assert.equal(likeLover.comment_only, 0);
  assert.ok(likeLover.like_only > DEFAULT_UNIT_PATTERN_WEIGHTS.like_only);
  const critic = personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, 0, 1.0);
  assert.equal(critic.like_only, 0);
  assert.ok(critic.comment_only > DEFAULT_UNIT_PATTERN_WEIGHTS.comment_only);
});

check("personaUnitWeights: 既定ブレンド(0.5)ではいいね寄り性格が①を増やし③を減らす(方向性)", () => {
  const weights = personaUnitWeights(DEFAULT_UNIT_PATTERN_WEIGHTS, 0.9);
  assert.ok(weights.like_only > DEFAULT_UNIT_PATTERN_WEIGHTS.like_only);
  assert.ok(weights.comment_only < DEFAULT_UNIT_PATTERN_WEIGHTS.comment_only);
});

check("drawUnitPattern: 5000試行の頻度が既定重み(55/30/15)に近づく", () => {
  const random = makeRandom(42);
  const counts: Record<UnitPattern, number> = {
    like_only: 0,
    like_with_comment: 0,
    comment_only: 0,
  };
  const trials = 5000;
  for (let i = 0; i < trials; i += 1) {
    const pattern = drawUnitPattern({ random });
    assert.ok(pattern, "pattern should not be null without budget constraint");
    counts[pattern] += 1;
  }
  approxEqual(counts.like_only / trials, 0.55, 0.03, "like_only ratio");
  approxEqual(counts.like_with_comment / trials, 0.3, 0.03, "like_with_comment ratio");
  approxEqual(counts.comment_only / trials, 0.15, 0.03, "comment_only ratio");
});

check("drawUnitPattern: 行予算が2未満なら②は選ばれず、0以下ならnull", () => {
  const random = makeRandom(7);
  for (let i = 0; i < 500; i += 1) {
    const pattern = drawUnitPattern({ rowBudget: 1, random });
    assert.notEqual(pattern, "like_with_comment");
  }
  assert.equal(drawUnitPattern({ rowBudget: 0, random }), null);
});

check("drawUnitPattern: いいね寄り性格(p=0.9)は①比率が基準より上がる", () => {
  const trials = 5000;
  let neutralLikes = 0;
  let loverLikes = 0;
  const neutralRandom = makeRandom(11);
  const loverRandom = makeRandom(11);
  for (let i = 0; i < trials; i += 1) {
    if (drawUnitPattern({ random: neutralRandom }) === "like_only") neutralLikes += 1;
    if (drawUnitPattern({ personaLikeProbability: 0.9, random: loverRandom }) === "like_only") {
      loverLikes += 1;
    }
  }
  assert.ok(
    loverLikes > neutralLikes,
    `persona 0.9 should draw more like_only (persona=${loverLikes} neutral=${neutralLikes})`,
  );
});

check("planDailyUnits: 合計ユニット数はmin(unitLimit, 需要)を超えない", () => {
  const random = makeRandom(21);
  const agents = Array.from({ length: 20 }, (_, i) => ({ agentId: `agent_${i}` }));
  for (let i = 0; i < 50; i += 1) {
    const plan = planDailyUnits({
      agents,
      unitLimit: 6,
      maxUnitsPerAgent: 2,
      maxRowsPerAgent: 2,
      rowCeiling: 12,
      random,
    });
    assert.ok(plan.length <= 6, `plan.length=${plan.length} exceeds unitLimit`);
    const rows = plan.reduce((sum, unit) => sum + unitRowCost(unit.pattern), 0);
    assert.ok(rows <= 12, `rows=${rows} exceeds ceiling`);
  }
});

check("planDailyUnits: per-agentの行数上限(2行)を守る=②を引いたagentは2ユニット目なし", () => {
  const random = makeRandom(33);
  const agents = Array.from({ length: 20 }, (_, i) => ({ agentId: `agent_${i}` }));
  for (let i = 0; i < 50; i += 1) {
    const plan = planDailyUnits({
      agents,
      unitLimit: 20,
      maxUnitsPerAgent: 2,
      maxRowsPerAgent: 2,
      rowCeiling: 100,
      random,
    });
    const rowsByAgent = new Map<string, number>();
    for (const unit of plan) {
      rowsByAgent.set(unit.agentId, (rowsByAgent.get(unit.agentId) ?? 0) + unitRowCost(unit.pattern));
    }
    for (const [agentId, rows] of rowsByAgent) {
      assert.ok(rows <= 2, `${agentId} rows=${rows} exceeds maxRowsPerAgent`);
    }
  }
});

check("planDailyUnits: グローバル行ceiling残1のとき②は計画されない", () => {
  const random = makeRandom(55);
  for (let i = 0; i < 200; i += 1) {
    const plan = planDailyUnits({
      agents: [{ agentId: "agent_a" }, { agentId: "agent_b" }],
      unitLimit: 6,
      maxUnitsPerAgent: 2,
      maxRowsPerAgent: 2,
      rowCeiling: 1,
      random,
    });
    const rows = plan.reduce((sum, unit) => sum + unitRowCost(unit.pattern), 0);
    assert.ok(rows <= 1, `rows=${rows} exceeds ceiling=1`);
    assert.ok(plan.every((unit) => unit.pattern !== "like_with_comment"));
  }
});

check("planDailyUnits: シャッフル配布のため先頭固定でない(シード違いで当選集合が変わる)", () => {
  const agents = Array.from({ length: 20 }, (_, i) => ({ agentId: `agent_${i}` }));
  const winners = new Set<string>();
  for (let seed = 1; seed <= 30; seed += 1) {
    const plan = planDailyUnits({
      agents,
      unitLimit: 6,
      maxUnitsPerAgent: 2,
      maxRowsPerAgent: 2,
      rowCeiling: 12,
      random: makeRandom(seed),
    });
    for (const unit of plan) winners.add(unit.agentId);
  }
  // registry順先着ならagent_0..agent_7程度に固定される。シャッフル配布なら広く分散するはず。
  assert.ok(
    winners.size > 10,
    `winners should spread across agents, got ${winners.size}: ${[...winners].join(",")}`,
  );
});

check("drawDailyCount: 0..maxDailyの範囲に収まる", () => {
  const random = makeRandom(7);
  for (let i = 0; i < 200; i += 1) {
    const count = drawDailyCount(2, random);
    assert.ok(count >= 0 && count <= 2, `count=${count} out of range`);
  }
});

check("drawDailyCount: maxDaily=0なら常に0", () => {
  assert.equal(drawDailyCount(0, () => 0.99), 0);
});

console.log(`\nAll ${passed} interaction-slot-planner checks passed.`);
