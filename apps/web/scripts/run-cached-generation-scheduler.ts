import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createPrismaClient } from "./prisma-client";
import {
  readSchedulerStateRecord,
  schedulerStateKeyFromArg,
  writeSchedulerStateRecord,
} from "../src/lib/scheduler-state";
import { defaultResearchCachePath, readResearchCache } from "./research-cache";
import "./load-local-env";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const prisma = createPrismaClient();

const SCHEDULER_STATE_SCOPE = "pipeline";

type PackageJson = {
  scripts?: Record<string, string>;
};

type SchedulerHistory = {
  startedAt: string;
  completedAt?: string;
  status: "completed" | "failed" | "skipped";
  script: string;
  cachePath: string;
  reason?: string;
  runId?: string;
  errorMessage?: string;
};

type SchedulerState = {
  version: string;
  scheduleName: string;
  intervalHours: number;
  script: string;
  cachePath: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastStatus?: "completed" | "failed" | "skipped";
  lastRunId?: string;
  nextDueAt?: string;
  history: SchedulerHistory[];
  notifications?: Array<{
    createdAt: string;
    level: "info" | "warning" | "error";
    message: string;
    runId?: string;
  }>;
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

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
    state: values.get("state") ?? "data/scheduler/cached-product-generation.json",
    cachePath: values.get("cache") ?? defaultResearchCachePath,
    script: values.get("script") ?? "demo:generate",
    intervalHours: values.has("interval-hours")
      ? Number.parseInt(values.get("interval-hours") ?? "12", 10)
      : 12,
    force: flags.has("force") || values.get("force") === "true",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
    allowMissingScript: flags.has("allow-missing-script") || values.get("allow-missing-script") === "true",
  };
};

const defaultState = (cachePath: string, script: string, intervalHours: number): SchedulerState => ({
  version: "cached-product-generation.v1",
  scheduleName: "cached-product-generation",
  intervalHours,
  script,
  cachePath,
  history: [],
  notifications: [],
});

const readState = async (
  stateKey: string,
  cachePath: string,
  script: string,
  intervalHours: number,
) => {
  const state = await readSchedulerStateRecord<SchedulerState>(prisma, stateKey);

  if (!state) {
    return defaultState(cachePath, script, intervalHours);
  }

  return {
    ...state,
    intervalHours: Number.isFinite(intervalHours) ? intervalHours : state.intervalHours ?? 12,
    script: script ?? state.script ?? "demo:generate",
    cachePath: cachePath ?? state.cachePath ?? defaultResearchCachePath,
    history: state.history ?? [],
    notifications: state.notifications ?? [],
  };
};

const nextDueAt = (lastCompletedAt: string | undefined, intervalHours: number) =>
  lastCompletedAt ? new Date(new Date(lastCompletedAt).getTime() + intervalHours * 60 * 60 * 1000) : new Date(0);

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
    { createdAt: new Date().toISOString(), level, message, runId },
    ...(state.notifications ?? []),
  ].slice(0, 20);
};

const readPackageJson = async () =>
  JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as PackageJson;

const hasPackageScript = async (script: string) => Boolean((await readPackageJson()).scripts?.[script]);

const assertFreshCache = async (cachePath: string) => {
  const cache = await readResearchCache(cachePath);
  if (!cache) throw new Error(`Research cache not found: ${cachePath}`);

  const maxAgeHours = cache.cachePolicy?.maxAgeHours ?? 36;
  const ageHours = (Date.now() - Date.parse(cache.lastRefreshedAt)) / (1000 * 60 * 60);
  if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
    throw new Error(`Research cache is stale: ageHours=${ageHours.toFixed(2)} maxAgeHours=${maxAgeHours}`);
  }

  return cache;
};

const runNpmScript = async (script: string) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const args = process.platform === "win32" ? ["/d", "/c", `${npmCommand} run ${script}`] : ["run", script];
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stderr.trim()) console.error(stderr.trim());
  if (stdout.trim()) console.log(stdout.trim());

  return stdout.match(/(?:Demo run|Pipeline run|Generated run|Run):\s*(run_[^\s]+)/)?.[1];
};

async function main() {
  const args = parseArgs();
  const stateKey = schedulerStateKeyFromArg(args.state);
  const state = await readState(stateKey, args.cachePath, args.script, args.intervalHours);
  const intervalHours = Number.isFinite(state.intervalHours) ? Math.max(1, state.intervalHours) : 12;
  const now = new Date();
  const dueAt = nextDueAt(state.lastCompletedAt, intervalHours);
  const isDue = args.force || now >= dueAt;
  const schedulerRunId = `sched_generate_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;

  state.nextDueAt = isDue ? now.toISOString() : dueAt.toISOString();

  if (args.dryRun) {
    console.log(
      isDue
        ? `Cached generation scheduler dry run: would run npm script ${state.script}`
        : `Cached generation scheduler dry run: would skip. Next due at ${dueAt.toISOString()}`,
    );
    console.log(`State: ${args.state}`);
    return;
  }

  const createSkippedRun = async (reason: string, nextDue: Date) => {
    const historyItem: SchedulerHistory = {
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      status: "skipped",
      script: state.script,
      cachePath: state.cachePath,
      reason,
    };
    await prisma.schedulerRun.create({
      data: {
        id: schedulerRunId,
        scheduleName: state.scheduleName,
        status: "skipped",
        source: "research-cache",
        planner: state.script,
        limit: 1,
        intervalHours,
        forced: args.force,
        dryRun: false,
        reason,
        startedAt: now,
        completedAt: now,
        nextDueAt: nextDue,
      },
    });
    state.lastStatus = "skipped";
    state.history = [historyItem, ...state.history].slice(0, 30);
    await writeState(stateKey, state);
    console.log(`Cached generation scheduler skipped. ${reason}`);
  };

  if (!isDue) {
    await createSkippedRun(`Not due until ${dueAt.toISOString()}`, dueAt);
    return;
  }

  if (!(await hasPackageScript(state.script))) {
    const reason = `npm script ${state.script} is not available yet. Waiting for the cached generation implementation.`;
    if (!args.allowMissingScript) {
      await createSkippedRun(reason, now);
      return;
    }
    throw new Error(reason);
  }

  const historyItem: SchedulerHistory = {
    startedAt: now.toISOString(),
    status: "completed",
    script: state.script,
    cachePath: state.cachePath,
    reason: args.force ? "Forced by operator" : "Due by interval",
  };
  state.lastStartedAt = historyItem.startedAt;

  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: state.scheduleName,
      status: "running",
      source: "research-cache",
      planner: state.script,
      limit: 1,
      intervalHours,
      forced: args.force,
      dryRun: false,
      reason: historyItem.reason,
      startedAt: now,
      nextDueAt: now,
    },
  });

  try {
    await assertFreshCache(state.cachePath);
    const runId = await runNpmScript(state.script);
    const completedAt = new Date().toISOString();

    historyItem.completedAt = completedAt;
    historyItem.runId = runId;
    historyItem.status = "completed";
    state.lastCompletedAt = completedAt;
    state.lastRunId = runId;
    state.lastStatus = "completed";
    state.nextDueAt = nextDueAt(completedAt, intervalHours).toISOString();
    addNotification(state, "info", `Cached generation completed with ${state.script}.`, runId);
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

    console.log(`Cached generation scheduler completed. Run: ${runId ?? "unknown"}`);
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
    addNotification(state, "error", `Cached generation failed: ${message.slice(0, 240)}`);
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
