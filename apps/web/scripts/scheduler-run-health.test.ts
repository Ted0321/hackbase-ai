/**
 * Unit checks for the scheduler failure classification (src/lib/scheduler-run-health.ts).
 * Run with `npm run eval:scheduler-run-health:test`.
 */
import assert from "node:assert/strict";
import {
  classifySchedulerFailures,
  isBudgetCapFailure,
  type FailedSchedulerRunLike,
} from "../src/lib/scheduler-run-health";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const at = (iso: string) => new Date(iso);
const failure = (over: Partial<FailedSchedulerRunLike> = {}): FailedSchedulerRunLike => ({
  scheduleName: "agent-creation-daily",
  startedAt: at("2026-07-09T10:00:00Z"),
  errorMessage: "agent_o: scripts/run-agent-self-directed.ts exited 1",
  ...over,
});

check("budget cap failures are detected from rate-guard messages", () => {
  assert.equal(
    isBudgetCapFailure(
      "agent_o: scripts/run-agent-self-directed.ts exited 1: Error: Gemini daily cost cap reached ($10.00/$10.00) [lane=scheduler op=llm-pipeline:run-gemini]. Halting to prevent runaway spend.",
    ),
    true,
  );
  assert.equal(isBudgetCapFailure("Gemini daily request cap reached (120/120) [lane=scheduler]"), true);
  assert.equal(isBudgetCapFailure("agent_o: scripts/run-agent-self-directed.ts exited 1"), false);
  assert.equal(isBudgetCapFailure(null), false);
  assert.equal(isBudgetCapFailure(undefined), false);
});

check("a failure followed by a completed run of the same schedule is recovered", () => {
  const result = classifySchedulerFailures(
    [failure()],
    [{ scheduleName: "agent-creation-daily", startedAt: at("2026-07-09T11:00:00Z") }],
  );
  assert.equal(result.recovered.length, 1);
  assert.equal(result.active.length, 0);
  assert.equal(result.budgetCapped.length, 0);
});

check("a failure with no later success stays active", () => {
  const result = classifySchedulerFailures(
    [failure()],
    [{ scheduleName: "agent-creation-daily", startedAt: at("2026-07-09T09:00:00Z") }],
  );
  assert.equal(result.active.length, 1);
  assert.equal(result.recovered.length, 0);
});

check("completed runs of other schedules do not recover the failure", () => {
  const result = classifySchedulerFailures(
    [failure()],
    [{ scheduleName: "agent-interactions-daily", startedAt: at("2026-07-09T11:00:00Z") }],
  );
  assert.equal(result.active.length, 1);
  assert.equal(result.recovered.length, 0);
});

check("an unrecovered budget-cap failure is budgetCapped; recovery takes precedence", () => {
  const capped = failure({
    errorMessage: "agent_o: exited 1: Gemini daily cost cap reached ($10.00/$10.00) [lane=scheduler]",
  });
  const unrecovered = classifySchedulerFailures([capped], []);
  assert.equal(unrecovered.budgetCapped.length, 1);
  assert.equal(unrecovered.active.length, 0);

  const recovered = classifySchedulerFailures(
    [capped],
    [{ scheduleName: "agent-creation-daily", startedAt: at("2026-07-10T01:00:00Z") }],
  );
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.budgetCapped.length, 0);
});

check("classification keeps the input order within each bucket", () => {
  const a = failure({ startedAt: at("2026-07-09T12:00:00Z"), errorMessage: "agent_a: exited 1" });
  const b = failure({ startedAt: at("2026-07-09T08:00:00Z"), errorMessage: "agent_b: exited 1" });
  const result = classifySchedulerFailures(
    [a, b],
    [{ scheduleName: "agent-creation-daily", startedAt: at("2026-07-09T10:00:00Z") }],
  );
  // aは10:00の成功より後の失敗=active、bはそれより前=recovered。
  assert.deepEqual(result.active, [a]);
  assert.deepEqual(result.recovered, [b]);
});

console.log(`scheduler-run-health checks passed: ${passed}`);
