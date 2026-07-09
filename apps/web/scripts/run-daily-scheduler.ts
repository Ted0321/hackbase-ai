import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createPrismaClient } from "./prisma-client";
import {
  readSchedulerStateRecord,
  schedulerStateKeyFromArg,
  writeSchedulerStateRecord,
} from "../src/lib/scheduler-state";
import "./load-local-env";

const execFileAsync = promisify(execFile);
const prisma = createPrismaClient();

const SCHEDULER_STATE_SCOPE = "pipeline";

type SchedulerHistory = {
  startedAt: string;
  completedAt?: string;
  status: "completed" | "failed" | "skipped";
  runId?: string;
  source: string;
  planner: string;
  reason?: string;
  errorMessage?: string;
};

type SchedulerState = {
  version: string;
  scheduleName: string;
  intervalHours: number;
  source: string;
  configuredSource?: string;
  planner: string;
  limit: number;
  rotationSources: string[];
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastRunId?: string;
  lastStatus?: "completed" | "failed" | "skipped";
  nextDueAt?: string;
  history: SchedulerHistory[];
  notifications?: Array<{
    createdAt: string;
    level: "info" | "warning" | "error";
    message: string;
    runId?: string;
  }>;
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!item.startsWith("--")) {
      continue;
    }

    const key = item.slice(2);
    const next = raw[index + 1];

    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return {
    source: values.get("source"),
    planner: values.get("planner"),
    limit: values.has("limit") ? Number.parseInt(values.get("limit") ?? "8", 10) : undefined,
    intervalHours: values.has("interval-hours")
      ? Number.parseInt(values.get("interval-hours") ?? "24", 10)
      : undefined,
    rotation: values.has("rotation")
      ? (values.get("rotation") ?? "")
          .split(",")
          .map((source) => source.trim())
          .filter(Boolean)
      : undefined,
    state: values.get("state") ?? "data/scheduler/daily-signal-pipeline.json",
    force: flags.has("force") || values.get("force") === "true",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
    retryLastFailed: flags.has("retry-last-failed") || values.get("retry-last-failed") === "true",
  };
};

const defaultState = (
  source: string,
  planner: string,
  limit: number,
  intervalHours: number,
  rotationSources: string[],
): SchedulerState => ({
  version: "daily-signal-pipeline.v1",
  scheduleName: "daily-signal-pipeline",
  intervalHours,
  source,
  configuredSource: source,
  planner,
  limit,
  rotationSources,
  history: [],
  notifications: [],
});

const readState = async (
  stateKey: string,
  source: string | undefined,
  planner: string | undefined,
  limit: number | undefined,
  intervalHours: number | undefined,
  rotationSources: string[] | undefined,
) => {
  const state = await readSchedulerStateRecord<SchedulerState>(prisma, stateKey);

  if (!state) {
    return defaultState(
      source ?? "auto",
      planner ?? "deterministic",
      limit ?? 8,
      intervalHours ?? 24,
      rotationSources ?? ["openai", "github", "google", "hn"],
    );
  }

  return {
    ...state,
    intervalHours: intervalHours ?? state.intervalHours ?? 24,
    configuredSource: source ?? state.configuredSource ?? "auto",
    planner: planner ?? state.planner ?? "deterministic",
    limit: limit ?? state.limit ?? 8,
    rotationSources: rotationSources ?? state.rotationSources ?? ["openai", "github", "google", "hn"],
    history: state.history ?? [],
    notifications: state.notifications ?? [],
  };
};

const nextDueAt = (lastCompletedAt: string | undefined, intervalHours: number) => {
  if (!lastCompletedAt) {
    return new Date(0);
  }

  return new Date(new Date(lastCompletedAt).getTime() + intervalHours * 60 * 60 * 1000);
};

const writeState = async (stateKey: string, state: SchedulerState) => {
  await writeSchedulerStateRecord(prisma, stateKey, SCHEDULER_STATE_SCOPE, state);
};

const addNotification = (
  state: SchedulerState,
  level: "info" | "warning" | "error",
  message: string,
  runId?: string,
) => {
  state.notifications = [
    {
      createdAt: new Date().toISOString(),
      level,
      message,
      runId,
    },
    ...(state.notifications ?? []),
  ].slice(0, 20);
};

const resolveSource = (state: SchedulerState, requestedSource: string, retryLastFailed: boolean) => {
  if (retryLastFailed) {
    const failed = state.history.find((item) => item.status === "failed");
    return failed?.source ?? requestedSource;
  }

  if (requestedSource !== "auto") {
    return requestedSource;
  }

  const rotation = state.rotationSources.length > 0 ? state.rotationSources : ["openai", "github", "google", "hn"];
  const completedCount = state.history.filter((item) => item.status === "completed").length;

  return rotation[completedCount % rotation.length];
};

const runPipeline = async (source: string, planner: string, limit: number) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/c",
          `${npmCommand} run pipeline:signals -- --source ${source} --planner ${planner} --limit ${limit} --generate true`,
        ]
      : [
          "run",
          "pipeline:signals",
          "--",
          "--source",
          source,
          "--planner",
          planner,
          "--limit",
          String(limit),
          "--generate",
          "true",
        ];
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  return stdout.match(/Pipeline run: (run_[^\s]+)/)?.[1];
};

async function main() {
  const args = parseArgs();
  const stateKey = schedulerStateKeyFromArg(args.state);
  const state = await readState(
    stateKey,
    args.source,
    args.planner,
    args.limit,
    args.intervalHours,
    args.rotation,
  );
  const intervalHours = Number.isFinite(state.intervalHours) ? Math.max(1, state.intervalHours) : 24;
  const limit = Number.isFinite(state.limit) ? Math.max(1, Math.min(state.limit, 20)) : 8;
  const planner = state.planner ?? "deterministic";
  const requestedSource = state.configuredSource ?? "auto";
  const source = resolveSource(state, requestedSource, args.retryLastFailed);
  const now = new Date();
  const dueAt = nextDueAt(state.lastCompletedAt, intervalHours);
  const isDue = args.force || args.retryLastFailed || now >= dueAt;
  const schedulerRunId = `sched_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;

  state.nextDueAt = isDue
    ? now.toISOString()
    : dueAt.toISOString();

  if (args.dryRun) {
    console.log(
      isDue
        ? `Daily scheduler dry run: would execute source=${source} planner=${planner} limit=${limit}`
        : `Daily scheduler dry run: would skip. Next due at ${dueAt.toISOString()}`,
    );
    console.log(`State: ${args.state}`);
    return;
  }

  if (!isDue) {
    const historyItem: SchedulerHistory = {
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      status: "skipped",
      source,
      planner,
      reason: `Not due until ${dueAt.toISOString()}`,
    };
    await prisma.schedulerRun.create({
      data: {
        id: schedulerRunId,
        scheduleName: state.scheduleName,
        status: "skipped",
        source,
        planner,
        limit,
        intervalHours,
        forced: false,
        dryRun: false,
        reason: historyItem.reason,
        startedAt: now,
        completedAt: now,
        nextDueAt: dueAt,
      },
    });
    state.lastStatus = "skipped";
    state.history = [historyItem, ...state.history].slice(0, 30);
    await writeState(stateKey, state);
    console.log(`Daily scheduler skipped. Next due at ${dueAt.toISOString()}`);
    return;
  }

  const historyItem: SchedulerHistory = {
    startedAt: now.toISOString(),
    status: "completed",
    source,
    planner,
    reason: args.retryLastFailed ? "Retrying last failed scheduler run" : args.force ? "Forced by operator" : "Due by interval",
  };
  state.lastStartedAt = historyItem.startedAt;
  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: state.scheduleName,
      status: "running",
      source,
      planner,
      limit,
      intervalHours,
      forced: args.force || args.retryLastFailed,
      dryRun: false,
      reason: historyItem.reason,
      startedAt: now,
      nextDueAt: now,
    },
  });

  try {
    const runId = await runPipeline(source, planner, limit);
    const completedAt = new Date().toISOString();

    historyItem.completedAt = completedAt;
    historyItem.runId = runId;
    historyItem.status = "completed";
    state.lastCompletedAt = completedAt;
    state.lastRunId = runId;
    state.lastStatus = "completed";
    state.nextDueAt = nextDueAt(completedAt, intervalHours).toISOString();
    state.source = source;
    state.configuredSource = requestedSource;
    addNotification(state, "info", `Daily scheduler completed with ${source}.`, runId);
    state.history = [historyItem, ...state.history].slice(0, 30);
    await prisma.schedulerRun.update({
      where: { id: schedulerRunId },
      data: {
        status: "completed",
        runId,
        completedAt: new Date(completedAt),
        nextDueAt: new Date(state.nextDueAt),
      },
    });
    await writeState(stateKey, state);

    console.log(`Daily scheduler completed. Run: ${runId ?? "unknown"}`);
    console.log(`Next due at ${state.nextDueAt}`);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);

    historyItem.completedAt = completedAt;
    historyItem.status = "failed";
    historyItem.errorMessage = message;
    state.lastCompletedAt = completedAt;
    state.lastStatus = "failed";
    state.nextDueAt = now.toISOString();
    state.source = source;
    state.configuredSource = requestedSource;
    addNotification(state, "error", `Daily scheduler failed for ${source}: ${message.slice(0, 240)}`);
    state.history = [historyItem, ...state.history].slice(0, 30);
    await prisma.schedulerRun.update({
      where: { id: schedulerRunId },
      data: {
        status: "failed",
        errorMessage: message,
        completedAt: new Date(completedAt),
        nextDueAt: now,
      },
    });
    await writeState(stateKey, state);
    throw error;
  }
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
