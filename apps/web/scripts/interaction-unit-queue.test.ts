/**
 * interaction-unit-queue.ts の単体テスト。`npm run eval:interaction-unit-queue:test` で実行。
 */
import assert from "node:assert/strict";
import {
  MAX_UNIT_ATTEMPTS,
  buildDayPlan,
  dueUnits,
  expireLeftoverUnits,
  markUnitResult,
  planSummary,
  type DayPlan,
} from "./interaction-unit-queue";
import type { PlannedUnit } from "./interaction-slot-planner";

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

const NOW = new Date("2026-07-10T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const sampleUnits: PlannedUnit[] = [
  { agentId: "agent_a", pattern: "like_only" },
  { agentId: "agent_b", pattern: "like_with_comment" },
  { agentId: "agent_c", pattern: "comment_only" },
];

check("buildDayPlan: scheduledAtは now..now+spreadHours の範囲に散布される", () => {
  const plan = buildDayPlan({ units: sampleUnits, now: NOW, spreadHours: 22, random: makeRandom(42) });
  assert.equal(plan.units.length, 3);
  assert.equal(plan.plannedAt, NOW.toISOString());
  for (const unit of plan.units) {
    const at = Date.parse(unit.scheduledAt);
    assert.ok(at >= NOW.getTime(), `scheduledAt ${unit.scheduledAt} before now`);
    assert.ok(at <= NOW.getTime() + 22 * HOUR, `scheduledAt ${unit.scheduledAt} beyond spread`);
    assert.equal(unit.status, "pending");
    assert.equal(unit.attempts, 0);
  }
  const ids = new Set(plan.units.map((unit) => unit.id));
  assert.equal(ids.size, 3, "unit ids must be unique");
});

check("buildDayPlan: immediate(force)なら全件即時=従来バースト互換", () => {
  const plan = buildDayPlan({
    units: sampleUnits,
    now: NOW,
    spreadHours: 22,
    immediate: true,
    random: makeRandom(7),
  });
  assert.ok(plan.units.every((unit) => unit.scheduledAt === NOW.toISOString()));
  // spreadHours=0 でも同じく即時。
  const zeroSpread = buildDayPlan({ units: sampleUnits, now: NOW, spreadHours: 0, random: makeRandom(7) });
  assert.ok(zeroSpread.units.every((unit) => unit.scheduledAt === NOW.toISOString()));
});

check("dueUnits: 期限到来のpendingだけをscheduledAt昇順で返す", () => {
  const plan: DayPlan = {
    plannedAt: NOW.toISOString(),
    units: [
      { id: "u_late", agentId: "a", pattern: "like_only", scheduledAt: new Date(NOW.getTime() + 5 * HOUR).toISOString(), status: "pending", attempts: 0 },
      { id: "u_due2", agentId: "b", pattern: "comment_only", scheduledAt: new Date(NOW.getTime() - 1 * HOUR).toISOString(), status: "pending", attempts: 0 },
      { id: "u_due1", agentId: "c", pattern: "like_only", scheduledAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), status: "pending", attempts: 0 },
      { id: "u_done", agentId: "d", pattern: "like_only", scheduledAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), status: "completed", attempts: 0 },
      { id: "u_spent", agentId: "e", pattern: "like_only", scheduledAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), status: "pending", attempts: MAX_UNIT_ATTEMPTS },
    ],
  };
  const due = dueUnits(plan, NOW);
  assert.deepEqual(due.map((unit) => unit.id), ["u_due1", "u_due2"]);
  assert.deepEqual(dueUnits(undefined, NOW), []);
});

check("markUnitResult: 成功はrows>0でcompleted、rows=0はskipped", () => {
  const plan = buildDayPlan({ units: sampleUnits, now: NOW, immediate: true });
  const done = markUnitResult(plan, plan.units[0].id, { outcome: "completed", rows: 2 }, NOW);
  assert.equal(done.units[0].status, "completed");
  assert.equal(done.units[0].rows, 2);
  assert.equal(done.units[0].executedAt, NOW.toISOString());
  const skipped = markUnitResult(plan, plan.units[1].id, { outcome: "completed", rows: 0 }, NOW);
  assert.equal(skipped.units[1].status, "skipped");
  // 他ユニットには影響しない。
  assert.equal(done.units[1].status, "pending");
});

check("markUnitResult: 失敗はattempts+1でpendingのまま、上限到達でfailed確定", () => {
  const plan = buildDayPlan({ units: sampleUnits, now: NOW, immediate: true });
  const unitId = plan.units[0].id;
  const once = markUnitResult(plan, unitId, { outcome: "failed", error: "boom" }, NOW);
  assert.equal(once.units[0].status, "pending");
  assert.equal(once.units[0].attempts, 1);
  assert.equal(once.units[0].lastError, "boom");
  // pendingのままなので次tickのdueUnitsに再度乗る(=自然リトライ)。
  assert.ok(dueUnits(once, NOW).some((unit) => unit.id === unitId));
  const twice = markUnitResult(once, unitId, { outcome: "failed", error: "boom again" }, NOW);
  assert.equal(twice.units[0].status, "failed");
  assert.equal(twice.units[0].attempts, MAX_UNIT_ATTEMPTS);
  assert.ok(!dueUnits(twice, NOW).some((unit) => unit.id === unitId));
});

check("expireLeftoverUnits: pendingだけをexpiredにし、件数を返す(日跨ぎ持ち越しなし)", () => {
  const plan = buildDayPlan({ units: sampleUnits, now: NOW, immediate: true });
  const executed = markUnitResult(plan, plan.units[0].id, { outcome: "completed", rows: 1 }, NOW);
  const nextDay = new Date(NOW.getTime() + 24 * HOUR);
  const { plan: expiredPlan, expired } = expireLeftoverUnits(executed, nextDay);
  assert.equal(expired, 2);
  assert.equal(expiredPlan.units[0].status, "completed");
  assert.equal(expiredPlan.units[1].status, "expired");
  assert.equal(expiredPlan.units[2].status, "expired");
  assert.deepEqual(dueUnits(expiredPlan, nextDay), []);
});

check("planSummary: 状態別件数とnextUnitAtを返す(旧state=dayPlanなしも安全)", () => {
  const plan = buildDayPlan({ units: sampleUnits, now: NOW, spreadHours: 10, random: makeRandom(21) });
  const executed = markUnitResult(plan, plan.units[0].id, { outcome: "completed", rows: 1 }, NOW);
  const summary = planSummary(executed);
  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.rows, 1);
  const pendingTimes = executed.units
    .filter((unit) => unit.status === "pending")
    .map((unit) => unit.scheduledAt)
    .sort();
  assert.equal(summary.nextUnitAt, pendingTimes[0]);
  // 旧形式state(dayPlanなし)互換: undefinedでも落ちずに空サマリ。
  const empty = planSummary(undefined);
  assert.equal(empty.total, 0);
  assert.equal(empty.pending, 0);
  assert.equal(empty.nextUnitAt, null);
});

check("一連のtickシミュレーション: 分散→順次消化→期限切れなしで完走", () => {
  const random = makeRandom(99);
  const plan0 = buildDayPlan({ units: sampleUnits, now: NOW, spreadHours: 12, random });
  let plan = plan0;
  let executedTotal = 0;
  // 毎時tickを13回まわすと全ユニットの期限が来る(spread=12h)。
  for (let hour = 0; hour <= 13; hour += 1) {
    const tickNow = new Date(NOW.getTime() + hour * HOUR);
    for (const unit of dueUnits(plan, tickNow)) {
      plan = markUnitResult(plan, unit.id, { outcome: "completed", rows: 1 }, tickNow);
      executedTotal += 1;
    }
  }
  assert.equal(executedTotal, 3);
  const summary = planSummary(plan);
  assert.equal(summary.completed, 3);
  assert.equal(summary.pending, 0);
});

console.log(`\nAll ${passed} interaction-unit-queue checks passed.`);
