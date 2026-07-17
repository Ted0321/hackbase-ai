import assert from "node:assert/strict";
import { cadenceHours, decideAgentDue, runStamp, runsToday } from "../src/lib/agent-due-decision";
import { sameJstDay } from "../src/lib/jst-day";
import {
  DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC,
  buildDraftAdminAgent,
  preferredHourForAgentId,
  type AdminAgentProfile,
} from "../src/lib/admin-agent-registry";

function baseAgent(overrides: Partial<AdminAgentProfile> = {}): AdminAgentProfile {
  return {
    agentId: "agent_test",
    displayName: "Test Agent",
    role: "creator",
    status: "active",
    schedulingPolicy: {
      cadence: "daily",
      enabled: true,
      maxRunsPerDay: 1,
      preferredHours: [18],
      cooldownHours: 0,
    },
    ...overrides,
  };
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const now = new Date("2026-06-29T18:00:00.000Z");
const runId = `run_selfdirected_agent_test_${runStamp(now)}`;

run("runStamp uses UTC compact timestamp", () => {
  assert.equal(runStamp(now), "20260629T180000");
});

run("cadenceHours maps supported cadences", () => {
  assert.equal(cadenceHours("daily"), 24);
  assert.equal(cadenceHours("every_other_day"), 48);
  assert.equal(cadenceHours("every_3_days"), 72);
  assert.equal(cadenceHours("weekly"), 168);
  assert.equal(cadenceHours("on_demand"), null);
});

run("runsToday counts by JST day, aligned with the daily cap", () => {
  // now = 2026-06-29T18:00Z = JST 06-30 03:00 → JST day 2026-06-30。
  // 同一UTC日(06-29)だが別JST日(06-29) → 0(旧UTC基準では1だった)。
  assert.equal(runsToday({ lastCompletedAt: "2026-06-29T05:00:00.000Z", runsToday: 1 }, now), 0);
  // 別UTC日(06-29)だが同一JST日(06-30) → 1(旧UTC基準では0だった)。
  assert.equal(
    runsToday(
      { lastCompletedAt: "2026-06-29T15:30:00.000Z", runsToday: 1 },
      new Date("2026-06-30T02:00:00.000Z"),
    ),
    1,
  );
  // lastCompletedAt 無しは常に 0。
  assert.equal(runsToday({}, now), 0);
});

run("sameJstDay treats the JST calendar day as the boundary", () => {
  // 同一UTC日でも JST 15:00(=UTC日境界)をまたぐと別 JST 日。
  assert.equal(sameJstDay(new Date("2026-06-29T05:00:00.000Z"), new Date("2026-06-29T18:00:00.000Z")), false);
  // UTC日は異なるが同一 JST 日。
  assert.equal(sameJstDay(new Date("2026-06-29T15:30:00.000Z"), new Date("2026-06-30T02:00:00.000Z")), true);
});

run("creator is due at preferred hour on first run", () => {
  const decision = decideAgentDue(baseAgent(), {}, now, false, runId);
  assert.equal(decision.decision, "due");
  assert.equal(decision.reason, "first run");
  assert.equal(decision.runId, runId);
});

run("creator skips before preferred hour window opens", () => {
  const decision = decideAgentDue(baseAgent(), {}, new Date("2026-06-29T00:00:00.000Z"), false, runId);
  assert.equal(decision.decision, "skip");
  assert.match(decision.reason, /preferred hour not reached/);
  assert.equal(decision.nextDueAt, "2026-06-29T18:00:00.000Z");
});

run("creator is due at or after preferred hour (soft window)", () => {
  // 20:00 は preferredHours [18] を過ぎている。厳密一致だと永久スキップになっていたが、
  // ソフトゲートでは「以降なら due」なので、遅れて起動しても当日中に作成できる。
  const decision = decideAgentDue(
    baseAgent(),
    {},
    new Date("2026-06-29T20:00:00.000Z"),
    false,
    runId,
  );
  assert.equal(decision.decision, "due");
});

run("non-creator roles are skipped", () => {
  const decision = decideAgentDue(baseAgent({ role: "reviewer" }), {}, now, false, runId);
  assert.deepEqual(
    { decision: decision.decision, reason: decision.reason },
    { decision: "skip", reason: "role=reviewer" },
  );
});

run("maxRunsPerDay blocks repeat runs", () => {
  const decision = decideAgentDue(
    baseAgent(),
    { lastCompletedAt: "2026-06-29T17:00:00.000Z", runsToday: 1 },
    now,
    false,
    runId,
  );
  assert.equal(decision.decision, "skip");
  assert.equal(decision.reason, "maxRunsPerDay reached");
});

run("force bypasses on-demand cadence", () => {
  const agent = baseAgent({ schedulingPolicy: { cadence: "on_demand", enabled: true, preferredHours: [18] } });
  assert.equal(decideAgentDue(agent, {}, now, false, runId).decision, "skip");
  assert.equal(decideAgentDue(agent, {}, now, true, runId).decision, "due");
});

run("preferredHourForAgentId assigns a stable distributed UTC slot", () => {
  const hour = preferredHourForAgentId("agent_new_writer");
  assert.equal(preferredHourForAgentId("agent_new_writer"), hour);
  assert.ok(DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC.includes(hour as never));
});

run("draft agents receive a preferred hour slot without schema changes", () => {
  const draft = buildDraftAdminAgent({
    agentId: "agent_new_writer",
    displayName: "New Writer",
    oneLiner: "Creates small writing tools.",
    motivation: "Make repeated writing work easier to inspect.",
    mission: "Create focused writing aids with safe local data.",
    initialRunMode: "review_then_schedule",
    materialTaste: ["writing friction"],
    signatureScreenTypes: ["rewrite board"],
    forbiddenDomains: ["credential_collection"],
  });
  assert.deepEqual(draft.schedulingPolicy?.preferredHours, [preferredHourForAgentId("agent_new_writer")]);
});

console.log("All agent-due-decision checks passed.");
