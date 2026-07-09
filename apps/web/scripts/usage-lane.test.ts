/**
 * Unit checks for the budget-lane resolution (usage-lane.ts).
 * Run with `npm run usage:lane:test`.
 */
import assert from "node:assert/strict";
import { DEFAULT_USAGE_LANE, currentUsageLane, resolveUsageLane } from "./usage-lane";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("unset/empty env falls back to the scheduler lane", () => {
  assert.equal(DEFAULT_USAGE_LANE, "scheduler");
  assert.equal(resolveUsageLane(undefined), "scheduler");
  assert.equal(resolveUsageLane(null), "scheduler");
  assert.equal(resolveUsageLane(""), "scheduler");
  assert.equal(resolveUsageLane("   "), "scheduler");
});

check("explicit lanes are normalized (trim + lowercase)", () => {
  assert.equal(resolveUsageLane("manual"), "manual");
  assert.equal(resolveUsageLane(" Manual "), "manual");
  assert.equal(resolveUsageLane("SCHEDULER"), "scheduler");
});

check("future lanes pass through as freeform values", () => {
  assert.equal(resolveUsageLane("eval"), "eval");
});

check("currentUsageLane reads PRODIA_USAGE_LANE from the process env", () => {
  const original = process.env.PRODIA_USAGE_LANE;
  try {
    delete process.env.PRODIA_USAGE_LANE;
    assert.equal(currentUsageLane(), "scheduler");
    process.env.PRODIA_USAGE_LANE = "manual";
    assert.equal(currentUsageLane(), "manual");
  } finally {
    if (original === undefined) delete process.env.PRODIA_USAGE_LANE;
    else process.env.PRODIA_USAGE_LANE = original;
  }
});

console.log(`\nAll ${passed} usage-lane checks passed.`);
