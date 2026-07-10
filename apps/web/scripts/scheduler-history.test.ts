import assert from "node:assert/strict";
import { HISTORY_LIMIT, jstDateKey, pruneHistory, type SchedulerHistoryItem } from "./scheduler-history";

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const skipEntry = (at: string, index: number): SchedulerHistoryItem => ({
  at,
  agentId: `agent_skip_${index}`,
  decision: "skipped",
  reason: "preferred hour not matched",
});

const completedEntry = (at: string, runId: string): SchedulerHistoryItem => ({
  at,
  agentId: "agent_done",
  decision: "completed",
  reason: "self-directed run completed",
  runId,
});

run("keeps at most HISTORY_LIMIT entries when nothing needs preserving", () => {
  const now = new Date("2026-07-10T04:00:00Z");
  const history = Array.from({ length: 80 }, (_, i) => skipEntry("2026-07-10T03:00:00Z", i));
  const pruned = pruneHistory(history, now);
  assert.equal(pruned.length, HISTORY_LIMIT);
});

run("same-JST-day completed entries survive beyond the limit (2026-07-10 incident shape)", () => {
  const now = new Date("2026-07-10T04:00:00Z"); // JST 13:00
  // 実障害の形: completed(00:14Z, 02:13Z) の上に毎時~20件のskipが積まれ、単純slice(0,50)
  // では両方またはどちらかが枠外へ落ちる。
  const completedOld = completedEntry("2026-07-10T00:14:53Z", "run_a"); // JST 09:14 = 当日
  const completedNew = completedEntry("2026-07-10T02:13:18Z", "run_b"); // JST 11:13 = 当日
  const skips = Array.from({ length: 60 }, (_, i) => skipEntry("2026-07-10T03:00:00Z", i));
  const history = [...skips, completedNew, completedOld]; // 新しい順(unshift相当)
  const pruned = pruneHistory(history, now);
  const completedKept = pruned.filter((item) => item.decision === "completed");
  assert.equal(completedKept.length, 2);
  assert.deepEqual(
    completedKept.map((item) => item.runId).sort(),
    ["run_a", "run_b"],
  );
});

run("previous-JST-day completed entries beyond the limit are dropped", () => {
  const now = new Date("2026-07-10T04:00:00Z");
  const yesterday = completedEntry("2026-07-09T10:00:00Z", "run_old"); // JST 7/9 = 前日
  const skips = Array.from({ length: 60 }, (_, i) => skipEntry("2026-07-10T03:00:00Z", i));
  const pruned = pruneHistory([...skips, yesterday], now);
  assert.equal(pruned.some((item) => item.runId === "run_old"), false);
  assert.equal(pruned.length, HISTORY_LIMIT);
});

run("jstDateKey shifts the UTC date into JST", () => {
  assert.equal(jstDateKey(new Date("2026-07-09T15:00:00Z")), "2026-07-10"); // JST 0:00
  assert.equal(jstDateKey(new Date("2026-07-09T14:59:59Z")), "2026-07-09");
});

console.log("All scheduler-history checks passed.");
