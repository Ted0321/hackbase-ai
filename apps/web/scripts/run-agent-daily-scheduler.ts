import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readSchedulerStateRecord, writeSchedulerStateRecord } from "../src/lib/scheduler-state";
import { readAdminAgentRegistryWithContracts } from "../src/lib/agent-operating-contract-store";
import {
  addHours,
  cadenceHours,
  decideAgentDue,
  runStamp,
  runsToday,
  type AgentDueDecision,
  type AgentDueRunState,
} from "../src/lib/agent-due-decision";
import { durationMs, errorMessageOf, logAgentRuntimeMetric, stderrTailSummary } from "./observability";
import { jstDateKey, pruneHistory } from "./scheduler-history";
import "./load-local-env";

const SCHEDULER_STATE_KEY = "agent-creation-daily";
const SCHEDULER_STATE_SCOPE = "agent-due";
const prisma = createPrismaClient();

/**
 * Agent due scheduler.
 *
 * The scheduler does not randomly choose creators. It checks each creator
 * agent's schedulingPolicy and persisted state, then wakes only due agents.
 *
 * Usage:
 *   tsx scripts/run-agent-daily-scheduler.ts [--limit N] [--count N] [--agent <id>] [--force] [--dry-run] [--now <iso>]
 */

type AgentRunState = AgentDueRunState;

type SchedulerHistoryItem = {
  at: string;
  agentId: string;
  decision: "due" | "skipped" | "failed" | "completed";
  reason: string;
  runId?: string;
};

type SchedulerState = {
  version: "agent-due-scheduler.v1";
  updatedAt: string;
  lastRunAt?: string | null;
  // コンソール読み取り側が期待する正規化フィールド（他schedulerのstateと共通形）。
  lastStatus?: "completed" | "failed" | "skipped" | null;
  lastCompletedAt?: string | null;
  nextDueAt?: string | null;
  agents: Record<string, AgentRunState>;
  history: SchedulerHistoryItem[];
};

type LegacyState = {
  lastCompletedAt?: string;
  nextDueAt?: string;
  history?: Array<{ at: string; agents: string[] }>;
};

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);
const STANDARD_ROTATION_START_MS = Date.UTC(2026, 6, 10);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const utcDayStartMs = (date: Date) =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const completedRunsOnJstDay = (state: SchedulerState, now: Date) => {
  const key = jstDateKey(now);
  return state.history.filter((item) => {
    if (item.decision !== "completed") return false;
    const at = new Date(item.at);
    return !Number.isNaN(at.getTime()) && jstDateKey(at) === key;
  }).length;
};

const rotateDueAgents = (
  dueCandidates: AgentDueDecision[],
  limit: number,
  now: Date,
  rotate: boolean,
) => {
  if (limit <= 0) return [];
  if (!rotate || dueCandidates.length <= limit) return dueCandidates.slice(0, limit);

  const dayOffset = Math.floor((utcDayStartMs(now) - STANDARD_ROTATION_START_MS) / ONE_DAY_MS);
  const cohortCount = Math.max(1, Math.ceil(dueCandidates.length / limit));
  const cohortIndex = ((dayOffset % cohortCount) + cohortCount) % cohortCount;
  const start = (cohortIndex * limit) % dueCandidates.length;
  return [...dueCandidates.slice(start), ...dueCandidates.slice(0, start)].slice(0, limit);
};

const emptyState = (): SchedulerState => ({
  version: "agent-due-scheduler.v1",
  updatedAt: new Date().toISOString(),
  lastRunAt: null,
  lastStatus: null,
  lastCompletedAt: null,
  nextDueAt: null,
  agents: {},
  history: [],
});

const normalizeState = (raw: unknown): SchedulerState => {
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === "agent-due-scheduler.v1") {
    const state = raw as SchedulerState;
    return {
      version: "agent-due-scheduler.v1",
      updatedAt: state.updatedAt ?? new Date().toISOString(),
      lastRunAt: state.lastRunAt ?? null,
      lastStatus: state.lastStatus ?? null,
      lastCompletedAt: state.lastCompletedAt ?? null,
      nextDueAt: state.nextDueAt ?? null,
      agents: state.agents ?? {},
      history: state.history ?? [],
    };
  }

  const legacy = (raw ?? {}) as LegacyState;
  return {
    version: "agent-due-scheduler.v1",
    updatedAt: new Date().toISOString(),
    lastRunAt: legacy.lastCompletedAt ?? null,
    lastStatus: null,
    lastCompletedAt: legacy.lastCompletedAt ?? null,
    nextDueAt: legacy.nextDueAt ?? null,
    agents: {},
    history: (legacy.history ?? []).flatMap((item) =>
      item.agents.map((agentId) => ({
        at: item.at,
        agentId,
        decision: "completed" as const,
        reason: "legacy scheduler state",
      })),
    ),
  };
};

const readState = async (): Promise<SchedulerState> => {
  // DBから読んだ生JSON（legacy形含む）を normalizeState にそのまま通す。3段フォールバックは
  // ヘルパー側（DB→FS→null）。null のときだけ emptyState() を返す。
  const raw = await readSchedulerStateRecord<unknown>(prisma, SCHEDULER_STATE_KEY);
  if (raw === null) {
    return emptyState();
  }
  return normalizeState(raw);
};

const writeState = async (state: SchedulerState) => {
  await writeSchedulerStateRecord(prisma, SCHEDULER_STATE_KEY, SCHEDULER_STATE_SCOPE, state);
};

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Mark downstream self-directed runs as scheduler-originated so agentRuntimeContext is
          // labeled system_scheduled instead of the default human_requested (trigger attribution).
          PRODIA_TRIGGER_TYPE: process.env.PRODIA_TRIGGER_TYPE ?? "schedule",
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
        },
        // stderrだけpipeし、失敗理由をSchedulerRun.errorMessageへ残せるようにする
        // ("exited 1"だけでは予算上限遮断か実障害かを後段が分類できない)。出力自体は転送する。
        stdio: ["inherit", "inherit", "pipe"],
      },
    );
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      const detail = stderrTailSummary(stderrTail);
      reject(new Error(`${script} exited ${code}${detail ? `: ${detail}` : ""}`));
    });
  });

async function main() {
  const onlyAgent = arg("--agent");
  const limitRaw = Number.parseInt(arg("--limit") ?? arg("--count") ?? "1", 10);
  const dailyLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 1;
  const perRunLimitRaw = Number.parseInt(arg("--per-run-limit") ?? process.env.PRODIA_CREATION_PER_RUN_LIMIT ?? "", 10);
  const perRunLimit = Number.isFinite(perRunLimitRaw) && perRunLimitRaw > 0 ? perRunLimitRaw : dailyLimit;
  const force = hasFlag("--force");
  const dryRun = hasFlag("--dry-run");
  const nowArg = arg("--now");
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("--now must be a valid ISO timestamp");
  }

  const state = await readState();
  const registry = await readAdminAgentRegistryWithContracts(prisma);
  const stamp = runStamp(now);
  const candidates = registry.agents.filter((agent) => !onlyAgent || agent.agentId === onlyAgent);
  const decisions = candidates.map((agent) => {
    const runId = `run_selfdirected_${agent.agentId}_${stamp}`;
    return decideAgentDue(agent, state.agents[agent.agentId] ?? {}, now, force, runId);
  });
  const dueCandidates = decisions.filter((decision) => decision.decision === "due");
  const completedToday = completedRunsOnJstDay(state, now);
  const remainingDaily = Math.max(0, dailyLimit - completedToday);
  const effectiveLimit = Math.min(perRunLimit, remainingDaily);
  const due = rotateDueAgents(dueCandidates, effectiveLimit, now, !onlyAgent);

  console.log(
    `[agent-due-scheduler] now=${now.toISOString()} dailyLimit=${dailyLimit} perRunLimit=${perRunLimit} completedToday=${completedToday} effectiveLimit=${effectiveLimit} force=${force} dryRun=${dryRun}`,
  );
  console.log(
    `[agent-due-scheduler] contractSource db=${registry.contractSourceSummary.db} registry=${registry.contractSourceSummary.registry}`,
  );
  for (const decision of decisions) {
    const label = `${decision.agent.agentId} ${decision.agent.displayName}`;
    if (decision.decision === "due") {
      console.log(`${label}: due`);
      console.log(`  reason: ${decision.reason}`);
      console.log(`  next: ${decision.runId}`);
    } else {
      console.log(`${label}: skip ${decision.reason}`);
      if (decision.nextDueAt) console.log(`  nextDueAt: ${decision.nextDueAt}`);
    }
  }
  if (dueCandidates.length > due.length) {
    console.log(
      `[agent-due-scheduler] selected ${due.length}/${dueCandidates.length} due agent(s): ${
        due.map((item) => item.agent.agentId).join(", ") || "(none)"
      }`,
    );
  }
  if (remainingDaily <= 0) {
    console.log(`[agent-due-scheduler] daily aggregate cap reached for JST day ${jstDateKey(now)}.`);
  }

  if (dryRun) {
    console.log(`[agent-due-scheduler] dry-run: ${due.length} due agent(s) would create.`);
    return;
  }

  // Lane1(run-research-cache-scheduler.ts)と同じ流儀でSchedulerRun行を残す。
  // per-agent失敗はレーンとしては継続する(soft failure)が、SchedulerRunはfailedに
  // することでコンソールの「失敗Scheduler」に載せる。dry-runでは書かない。
  const schedulerRunId = `sched_agentdue_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: SCHEDULER_STATE_KEY,
      status: due.length === 0 ? "skipped" : "running",
      source: "agent-due",
      planner: "due-gate-rotation",
      limit: dailyLimit,
      intervalHours: 24,
      forced: force,
      dryRun: false,
      reason:
        due.length === 0
          ? remainingDaily <= 0
            ? `daily aggregate cap reached (completedToday=${completedToday}/${dailyLimit})`
            : "no due agents"
          : `due=${due.length}/${dueCandidates.length} effectiveLimit=${effectiveLimit}`,
      startedAt: now,
      completedAt: due.length === 0 ? now : undefined,
    },
  });

  const nextState: SchedulerState = {
    ...state,
    updatedAt: now.toISOString(),
    lastRunAt: now.toISOString(),
    agents: { ...state.agents },
    history: [...state.history],
  };

  for (const decision of decisions.filter((item) => item.decision === "skip")) {
    nextState.agents[decision.agent.agentId] = {
      ...(nextState.agents[decision.agent.agentId] ?? {}),
      lastSkippedAt: now.toISOString(),
      lastSkipReason: decision.reason,
      lastStatus: "skipped",
      nextDueAt: decision.nextDueAt ?? null,
    };
    nextState.history.unshift({
      at: now.toISOString(),
      agentId: decision.agent.agentId,
      decision: "skipped",
      reason: decision.reason,
    });
  }

  const failedAgents: Array<{ agentId: string; message: string }> = [];
  for (const decision of due) {
    const agentId = decision.agent.agentId;
    const runId = decision.runId ?? `run_selfdirected_${agentId}_${stamp}`;
    const startedAt = new Date();
    nextState.agents[agentId] = {
      ...(nextState.agents[agentId] ?? {}),
      lastStartedAt: now.toISOString(),
      lastRunId: runId,
      lastStatus: null,
      lastError: null,
    };
    try {
      await runTsx("scripts/run-agent-self-directed.ts", ["--agent", agentId, "--run", runId, "--publish"]);
      const completedAt = new Date().toISOString();
      const completedEntry = nextState.agents[agentId] ?? {};
      nextState.agents[agentId] = {
        ...completedEntry,
        lastCompletedAt: completedAt,
        lastRunId: runId,
        lastStatus: "completed",
        runsToday: runsToday(completedEntry, now) + 1,
        nextDueAt: addHours(completedAt, cadenceHours(decision.agent.schedulingPolicy?.cadence ?? "daily") ?? 24),
      };
      nextState.history.unshift({ at: completedAt, agentId, decision: "completed", reason: "self-directed run completed", runId });
      await logAgentRuntimeMetric({
        agentId,
        runId,
        schedulerKey: SCHEDULER_STATE_KEY,
        eventType: "agent_due_scheduler_run",
        status: "completed",
        startedAt,
        completedAt: new Date(completedAt),
        durationMs: durationMs(startedAt, new Date(completedAt)),
        metadata: { reason: decision.reason },
      });
      console.log(`[agent-due-scheduler] ${agentId} completed: ${runId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedAgents.push({ agentId, message });
      nextState.agents[agentId] = {
        ...(nextState.agents[agentId] ?? {}),
        lastStatus: "failed",
        lastError: message,
        nextDueAt: addHours(now.toISOString(), 6),
      };
      nextState.history.unshift({ at: new Date().toISOString(), agentId, decision: "failed", reason: message, runId });
      const failedAt = new Date();
      await logAgentRuntimeMetric({
        agentId,
        runId,
        schedulerKey: SCHEDULER_STATE_KEY,
        eventType: "agent_due_scheduler_run",
        status: "failed",
        startedAt,
        completedAt: failedAt,
        durationMs: durationMs(startedAt, failedAt),
        metadata: { errorMessage: errorMessageOf(error), reason: decision.reason },
      });
      console.error(`[agent-due-scheduler] ${agentId} failed (continuing):`, error);
    }
  }

  // 毎時実行が積むskipエントリ(~20件/回)で50件枠からcompletedが押し出されると、
  // completedRunsOnJstDayが過小になり日次生成上限が実質効かなくなる(2026-07-10に
  // completedToday=1(実完了2)として顕在化)。当日JSTのcompletedは枠外でも保持する。
  nextState.history = pruneHistory(nextState.history, now);
  const finishedAt = new Date();
  nextState.lastStatus = due.length === 0 ? "skipped" : failedAgents.length > 0 ? "failed" : "completed";
  if (due.length > 0) {
    nextState.lastCompletedAt = finishedAt.toISOString();
  }
  // レーン全体のnextDueAt = 各agentの次回dueのうち最も早いもの。
  const agentNextDues = Object.values(nextState.agents)
    .map((agent) => agent.nextDueAt)
    .filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)))
    .sort();
  nextState.nextDueAt = agentNextDues[0] ?? null;
  // state書き込みやupdate自体がthrowしても、running行(due>0で起票)を残置せず
  // failedに落とす(orphaned running防止)。due===0はskippedで起票済みなので対象外。
  try {
    await writeState(nextState);
    if (due.length > 0) {
      await prisma.schedulerRun.update({
        where: { id: schedulerRunId },
        data: {
          status: failedAgents.length > 0 ? "failed" : "completed",
          errorMessage:
            failedAgents.length > 0
              ? failedAgents.map((item) => `${item.agentId}: ${item.message}`).join(" / ").slice(0, 1000)
              : undefined,
          completedAt: finishedAt,
          nextDueAt: nextState.nextDueAt ? new Date(nextState.nextDueAt) : undefined,
        },
      });
    }
  } catch (error) {
    if (due.length > 0) {
      await prisma.schedulerRun
        .update({
          where: { id: schedulerRunId },
          data: { status: "failed", errorMessage: errorMessageOf(error).slice(0, 1000), completedAt: new Date() },
        })
        .catch(() => {});
    }
    throw error;
  }
  console.log(`[agent-due-scheduler] done. due agents run: ${due.map((item) => item.agent.agentId).join(", ") || "(none)"}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
