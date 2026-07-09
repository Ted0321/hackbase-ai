import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

type SchedulerHistory = {
  startedAt: string;
  completedAt?: string;
  status: "completed" | "failed" | "skipped";
  cachePath: string;
  reason?: string;
  errorMessage?: string;
  signalCount?: number;
  loadedSourceCount?: number;
  sourceProductEntryCount?: number;
  preparedSourceDraft?: string;
};

type SchedulerState = {
  version: string;
  scheduleName: string;
  intervalHours: number;
  cachePath: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastStatus?: "completed" | "failed" | "skipped";
  nextDueAt?: string;
  history: SchedulerHistory[];
  notifications?: Array<{
    createdAt: string;
    level: "info" | "warning" | "error";
    message: string;
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
    state: values.get("state") ?? "data/scheduler/research-cache-daily.json",
    cachePath: values.get("cache") ?? defaultResearchCachePath,
    intervalHours: values.has("interval-hours")
      ? Number.parseInt(values.get("interval-hours") ?? "24", 10)
      : 24,
    limit: values.get("limit") ?? "8",
    force: flags.has("force") || values.get("force") === "true",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
    fetch: flags.has("fetch") || values.get("fetch") === "true",
    prepareSources: flags.has("prepare-sources") || values.get("prepare-sources") === "true",
    // A-2 (Lane 1B): prepare後に research:index:update まで実行し、収集した新プロダクトをindex+TSVへ反映する
    updateIndex: flags.has("update-index") || values.get("update-index") === "true",
    perSource: values.get("per-source") ?? "3",
  };
};

const defaultState = (cachePath: string, intervalHours: number): SchedulerState => ({
  version: "research-cache-daily.v1",
  scheduleName: "research-cache-daily",
  intervalHours,
  cachePath,
  history: [],
  notifications: [],
});

const readState = async (stateKey: string, cachePath: string, intervalHours: number) => {
  const state = await readSchedulerStateRecord<SchedulerState>(prisma, stateKey);

  if (!state) {
    return defaultState(cachePath, intervalHours);
  }

  return {
    ...state,
    intervalHours: Number.isFinite(intervalHours) ? intervalHours : state.intervalHours ?? 24,
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

const addNotification = (state: SchedulerState, level: "info" | "warning" | "error", message: string) => {
  state.notifications = [
    { createdAt: new Date().toISOString(), level, message },
    ...(state.notifications ?? []),
  ].slice(0, 20);
};

const runNpm = async (args: string[]) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const commandArgs = process.platform === "win32" ? ["/d", "/c", [npmCommand, ...args].join(" ")] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stderr.trim()) console.error(stderr.trim());
  if (stdout.trim()) console.log(stdout.trim());
  return stdout;
};

const runProductSourcePrepare = async (perSource: string) => {
  const stdout = await runNpm(["run", "research:product-index:prepare", "--", "--per-source", perSource]);
  return stdout.match(/Prepared product source refresh draft: (.+)/)?.[1]?.trim();
};

const runRefreshAndCheck = async (cachePath: string, fetch: boolean, limit: string) => {
  const refreshArgs = ["run", "research:cache:refresh", "--", "--output", cachePath, "--limit", limit];
  if (fetch) refreshArgs.push("--fetch");
  await runNpm(refreshArgs);
  await runNpm(["run", "research:cache:check", "--", "--path", cachePath]);
  return readResearchCache(cachePath);
};

async function main() {
  const args = parseArgs();
  const stateKey = schedulerStateKeyFromArg(args.state);
  const state = await readState(stateKey, args.cachePath, args.intervalHours);
  const intervalHours = Number.isFinite(state.intervalHours) ? Math.max(1, state.intervalHours) : 24;
  const now = new Date();
  const dueAt = nextDueAt(state.lastCompletedAt, intervalHours);
  const isDue = args.force || now >= dueAt;
  const schedulerRunId = `sched_research_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  const reason = args.force ? "Forced by operator" : "Due by interval";

  state.nextDueAt = isDue ? now.toISOString() : dueAt.toISOString();

  if (args.dryRun) {
    console.log(
      isDue
        ? `Research cache scheduler dry run: would refresh ${state.cachePath}${args.prepareSources ? " and prepare source-product candidates" : ""}`
        : `Research cache scheduler dry run: would skip. Next due at ${dueAt.toISOString()}`,
    );
    console.log(`State: ${args.state}`);
    return;
  }

  if (!isDue) {
    const historyItem: SchedulerHistory = {
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      status: "skipped",
      cachePath: state.cachePath,
      reason: `Not due until ${dueAt.toISOString()}`,
    };
    await prisma.schedulerRun.create({
      data: {
        id: schedulerRunId,
        scheduleName: state.scheduleName,
        status: "skipped",
        source: "research-cache",
        planner: "daily-refresh",
        limit: 0,
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
    console.log(`Research cache scheduler skipped. Next due at ${dueAt.toISOString()}`);
    return;
  }

  const historyItem: SchedulerHistory = {
    startedAt: now.toISOString(),
    status: "completed",
    cachePath: state.cachePath,
    reason,
  };
  state.lastStartedAt = historyItem.startedAt;

  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: state.scheduleName,
      status: "running",
      source: "research-cache",
      planner: args.fetch ? "live-fetch-daily-refresh" : "local-cache-daily-refresh",
      limit: 0,
      intervalHours,
      forced: args.force,
      dryRun: false,
      reason,
      startedAt: now,
      nextDueAt: now,
    },
  });

  try {
    const cache = await runRefreshAndCheck(state.cachePath, args.fetch, args.limit);
    const preparedSourceDraft = args.prepareSources ? await runProductSourcePrepare(args.perSource) : undefined;
    // A-2 (Lane 1B): その日に収集したドラフト(response.json)だけを source-product-index + TSV へマージ。
    // 全 exploration ディレクトリを一括スキャンすると過去ドラフトと重複キー衝突で落ちるため、
    // 当日の prepared draft ディレクトリに限定する。
    if (args.updateIndex && preparedSourceDraft) {
      await runNpm(["run", "research:index:update", "--", "--exploration-dir", preparedSourceDraft]);
    } else if (args.updateIndex) {
      console.warn("update-index requested but no prepared draft was produced; skipping index update.");
    }
    const completedAt = new Date().toISOString();
    const loadedSourceCount = cache?.sources.filter((source) => source.status === "loaded").length ?? 0;

    historyItem.completedAt = completedAt;
    historyItem.status = "completed";
    historyItem.signalCount = cache?.signals.length ?? 0;
    historyItem.loadedSourceCount = loadedSourceCount;
    historyItem.sourceProductEntryCount = cache?.sourceProductIndex.entryCount ?? 0;
    historyItem.preparedSourceDraft = preparedSourceDraft;
    state.lastCompletedAt = completedAt;
    state.lastStatus = "completed";
    state.nextDueAt = nextDueAt(completedAt, intervalHours).toISOString();
    addNotification(
      state,
      "info",
      `Research cache refreshed: signals=${historyItem.signalCount} sources=${loadedSourceCount}${
        preparedSourceDraft ? ` sourceDraft=${preparedSourceDraft}` : ""
      }.`,
    );
    state.history = [historyItem, ...state.history].slice(0, 30);
    await prisma.schedulerRun.update({
      where: { id: schedulerRunId },
      data: {
        status: "completed",
        completedAt: new Date(completedAt),
        nextDueAt: new Date(state.nextDueAt),
      },
    });
    await writeState(stateKey, state);

    console.log(`Research cache scheduler completed. Cache: ${state.cachePath}`);
    if (preparedSourceDraft) console.log(`Prepared source-product draft: ${preparedSourceDraft}`);
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
    addNotification(state, "error", `Research cache refresh failed: ${message.slice(0, 240)}`);
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
