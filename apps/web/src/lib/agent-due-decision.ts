import type { AdminAgentProfile, AgentCadence } from "./admin-agent-registry";

export type AgentDueRunState = {
  lastCompletedAt?: string | null;
  lastStartedAt?: string | null;
  lastSkippedAt?: string | null;
  nextDueAt?: string | null;
  runsToday?: number;
  lastRunId?: string | null;
  lastStatus?: "completed" | "failed" | "skipped" | null;
  lastError?: string | null;
  lastSkipReason?: string | null;
};

export type AgentDueDecision = {
  agent: AdminAgentProfile;
  decision: "due" | "skip";
  reason: string;
  nextDueAt?: string | null;
  runId?: string;
};

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const runStamp = (now: Date) =>
  `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;

export const cadenceHours = (cadence: AgentCadence | string | undefined) => {
  switch (cadence) {
    case "daily":
      return 24;
    case "every_other_day":
    case "every_2_days":
      return 48;
    case "every_3_days":
      return 72;
    case "weekly":
      return 168;
    default:
      return null;
  }
};

export const addHours = (iso: string, hours: number) =>
  new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();

export const sameUtcDay = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

export const runsToday = (entry: AgentDueRunState, now: Date) => {
  if (!entry.lastCompletedAt) return 0;
  return sameUtcDay(new Date(entry.lastCompletedAt), now) ? entry.runsToday ?? 1 : 0;
};

export const nextPreferredHour = (now: Date, preferredHours: number[] | undefined) => {
  if (!preferredHours || preferredHours.length === 0) return null;
  const sorted = [...preferredHours].sort((a, b) => a - b);
  const currentHour = now.getUTCHours();
  const nextToday = sorted.find((hour) => hour > currentHour);
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  if (nextToday !== undefined) {
    next.setUTCHours(nextToday);
    return next.toISOString();
  }
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(sorted[0]);
  return next.toISOString();
};

export function decideAgentDue(
  agent: AdminAgentProfile,
  entry: AgentDueRunState,
  now: Date,
  force: boolean,
  runId: string,
): AgentDueDecision {
  const policy = agent.schedulingPolicy ?? {};
  const cadence = policy.cadence ?? "daily";

  if ((agent.role ?? "creator") !== "creator") {
    return { agent, decision: "skip", reason: `role=${agent.role ?? "creator"}` };
  }
  if ((agent.status ?? "active") !== "active") {
    return { agent, decision: "skip", reason: `status=${agent.status ?? "active"}` };
  }
  if (policy.enabled === false) {
    return { agent, decision: "skip", reason: "scheduling disabled" };
  }
  if (cadence === "on_demand" && !force) {
    return { agent, decision: "skip", reason: "on_demand", nextDueAt: null };
  }

  const maxRunsPerDay = policy.maxRunsPerDay ?? 1;
  if (!force && runsToday(entry, now) >= maxRunsPerDay) {
    return {
      agent,
      decision: "skip",
      reason: "maxRunsPerDay reached",
      nextDueAt: nextPreferredHour(now, policy.preferredHours),
    };
  }

  const preferredHours = policy.preferredHours ?? [];
  if (!force && preferredHours.length > 0 && !preferredHours.includes(now.getUTCHours())) {
    return {
      agent,
      decision: "skip",
      reason: `preferred hour not matched (${now.getUTCHours()} not in ${preferredHours.join(",")})`,
      nextDueAt: nextPreferredHour(now, preferredHours),
    };
  }

  if (!force && entry.lastCompletedAt && policy.cooldownHours) {
    const elapsedHours = (now.getTime() - Date.parse(entry.lastCompletedAt)) / (60 * 60 * 1000);
    if (elapsedHours < policy.cooldownHours) {
      return {
        agent,
        decision: "skip",
        reason: `cooldown (${elapsedHours.toFixed(1)}h < ${policy.cooldownHours}h)`,
        nextDueAt: addHours(entry.lastCompletedAt, policy.cooldownHours),
      };
    }
  }

  const hours = cadenceHours(cadence);
  if (!force && hours !== null && entry.lastCompletedAt) {
    const elapsedHours = (now.getTime() - Date.parse(entry.lastCompletedAt)) / (60 * 60 * 1000);
    if (elapsedHours < hours) {
      return {
        agent,
        decision: "skip",
        reason: `cadence not elapsed (${elapsedHours.toFixed(1)}h < ${hours}h)`,
        nextDueAt: addHours(entry.lastCompletedAt, hours),
      };
    }
  }

  return {
    agent,
    decision: "due",
    reason: force ? "forced" : entry.lastCompletedAt ? "cadence elapsed" : "first run",
    runId,
  };
}
