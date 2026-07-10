import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readSchedulerStateRecord, writeSchedulerStateRecord } from "../src/lib/scheduler-state";
import { readAgentRegistry } from "./agent-registry";
import { agentInteractionPolicy, personaLikeProbability } from "./agent-interaction-policy";
import {
  parseUnitPatternWeights,
  planDailyUnits,
  type PlannedUnit,
  type UnitPattern,
} from "./interaction-slot-planner";
import {
  DEFAULT_UNIT_SPREAD_HOURS,
  buildDayPlan,
  dueUnits,
  expireLeftoverUnits,
  markUnitResult,
  planSummary,
  type DayPlan,
} from "./interaction-unit-queue";
import { durationMs, errorMessageOf, logAgentRuntimeMetric, stderrTailSummary } from "./observability";
import "./load-local-env";

const SCHEDULER_STATE_KEY = "agent-interactions-daily";
const SCHEDULER_STATE_SCOPE = "interactions";
const prisma = createPrismaClient();

/**
 * A-4 (Lane 3): コミュニケーションの日次スケジューラ(日次プラン＋毎時キュー消化)。
 *
 * 反応は「行動ユニット」単位で計画する(2026-07-10、旧like/comment独立プール方式から変更):
 *   ① like_only         いいねのみ(本文なし)           … 既定55%
 *   ② like_with_comment いいね＋コメント(同一作品セット) … 既定30%
 *   ③ comment_only      コメントのみ                    … 既定15%
 *
 * Stage 2(時間分散): 24時間ごとのプラン更新時に、その日の PRODIA_DAILY_UNIT_LIMIT(既定6)
 * ユニットへ PRODIA_UNIT_SPREAD_HOURS(既定22h)内のランダム実行予定時刻を割り当てて
 * SchedulerState(dayPlan)に保存し、毎時tick(Cloud Scheduler既存トリガー)で期限到来分のみ
 * 実行する。従来は due-gate が開いた1回のtickで全ユニットを一括バースト実行しており、
 * 全反応が同時刻に固まって見えた。--force は「プラン再構築＋全件即時実行」(従来バースト互換)。
 *
 * SchedulerRunの記録粒度(コンソールの失敗分類と整合させるための約束):
 *   - due前・実行ユニットなし → skipped ("Not due: next unit at ...")
 *   - プラン構築のみ/実行あり・全成功 → completed
 *   - 実行あり・1件でも失敗 → failed
 *   実行なしtickをcompletedにしないこと — classifySchedulerFailures はcompletedを回復マーカー
 *   として使うため、空のcompletedを毎時積むと実際には直っていない失敗が自動クローズされる。
 *
 * ユニット実行の失敗は attempts=2 まで自然リトライ(scheduledAt超過のpendingが次tickで再実行)。
 * プラン更新時に残っていたpendingは expired(日跨ぎ持ち越しなし)。
 *
 * Usage: tsx scripts/run-agent-interactions-scheduler.ts [--force] [--dry-run] [--llm]
 *          [--unit-limit N] [--pattern-weights "0.55,0.30,0.15"] [--limit N] [--spread-hours H]
 *
 * 日次ユニット数は --unit-limit または env PRODIA_DAILY_UNIT_LIMIT（既定6）。
 * パターン重みは --pattern-weights または env PRODIA_UNIT_PATTERN_WEIGHTS（順序=①,②,③）。
 * PRODIA_DAILY_INTERACTION_LIMIT（--limit、既定なし=無制限）はFeedback行数の安全上限で、
 * ②が2行消費するため 2×ユニット数 まで見込むこと(本番は12を想定)。
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);
const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const parseNonNegativeFloat = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

type State = {
  lastStatus?: "completed" | "failed";
  lastCompletedAt?: string;
  // 「次のプラン更新時刻」(24h周期)。旧バースト方式から意味を変えていないため、
  // console-summary.ts など既存の読者はそのまま動く。
  nextDueAt?: string;
  // Stage 2 で追加した当日実行キュー。旧形式state(dayPlanなし)は「nextDueAtのみのdue-gate」
  // として扱われ、次のプラン更新で自然にこの形式へ合流する(ロールバック時も旧コードは
  // nextDueAtしか読まないため安全)。
  dayPlan?: DayPlan;
  history?: Array<{
    at: string;
    planned: number;
    plannedUnits?: number;
    executedUnits?: number;
    expiredUnits?: number;
    patterns?: Partial<Record<UnitPattern, number>>;
    plannedLikes?: number;
    plannedComments?: number;
  }>;
};

const readState = async (): Promise<State | null> =>
  readSchedulerStateRecord<State>(prisma, SCHEDULER_STATE_KEY);

// 子プロセスのstdoutをteeしつつ捕捉し、runner出力の "created": N をユニットの実行行数として
// 読み取る(手動レーン parseOutcome と同流儀)。stderrは失敗理由の要約用に末尾を保持する。
const runTsx = (script: string, args: string[]) =>
  new Promise<{ createdRows: number }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
    let stdoutTail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-8000);
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        const matches = [...stdoutTail.matchAll(/"created":\s*(\d+)/g)];
        const createdRows = matches.length > 0 ? Number.parseInt(matches[matches.length - 1][1], 10) : 0;
        return resolve({ createdRows });
      }
      const detail = stderrTailSummary(stderrTail);
      reject(new Error(`${script} exited ${code}${detail ? `: ${detail}` : ""}`));
    });
  });

const patternCounts = (units: readonly PlannedUnit[]): Record<UnitPattern, number> => ({
  like_only: units.filter((unit) => unit.pattern === "like_only").length,
  like_with_comment: units.filter((unit) => unit.pattern === "like_with_comment").length,
  comment_only: units.filter((unit) => unit.pattern === "comment_only").length,
});

const formatPatternCounts = (counts: Record<UnitPattern, number>) =>
  `like_only=${counts.like_only} like_with_comment=${counts.like_with_comment} comment_only=${counts.comment_only}`;

async function main() {
  const force = hasFlag("--force");
  const dryRun = hasFlag("--dry-run");
  const llm = hasFlag("--llm");
  const unitLimit = parsePositiveInt(arg("--unit-limit") ?? process.env.PRODIA_DAILY_UNIT_LIMIT, 6);
  const weights = parseUnitPatternWeights(
    arg("--pattern-weights") ?? process.env.PRODIA_UNIT_PATTERN_WEIGHTS,
  );
  const spreadHours = parseNonNegativeFloat(
    arg("--spread-hours") ?? process.env.PRODIA_UNIT_SPREAD_HOURS,
    DEFAULT_UNIT_SPREAD_HOURS,
  );
  // Feedback行数の安全上限(未設定なら無制限)。②は1ユニットで2行消費する。
  const rowCeilingRaw = Number.parseInt(
    arg("--limit") ?? process.env.PRODIA_DAILY_INTERACTION_LIMIT ?? "",
    10,
  );
  const rowCeiling = Number.isFinite(rowCeilingRaw) && rowCeilingRaw > 0 ? rowCeilingRaw : undefined;
  const now = new Date();

  const state = await readState();
  const planDue = force || !state?.nextDueAt || now.getTime() >= Date.parse(state.nextDueAt);
  const schedulerRunId = `sched_interactions_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;

  let dayPlan: DayPlan | undefined = state?.dayPlan;
  let nextDueAt = state?.nextDueAt ? new Date(state.nextDueAt) : new Date(now.getTime() + 24 * 60 * 60 * 1000);
  let expiredUnits = 0;
  let planBuilt = false;

  if (planDue) {
    if (dayPlan) {
      const expiry = expireLeftoverUnits(dayPlan, now);
      expiredUnits = expiry.expired;
    }
    const registry = await readAgentRegistry();
    const creators = registry.agents.filter(
      (a) => (a.role ?? "creator") === "creator" && (a.status ?? "active") === "active",
    );
    const plannedUnits = planDailyUnits({
      agents: creators.map((agent) => ({
        agentId: agent.agentId,
        personaLikeProbability: personaLikeProbability(agent),
      })),
      unitLimit,
      maxUnitsPerAgent: agentInteractionPolicy.maxDailyInteractionsPerAgent,
      maxRowsPerAgent: agentInteractionPolicy.maxDailyInteractionsPerAgent,
      rowCeiling,
      weights,
    });
    dayPlan = buildDayPlan({
      units: plannedUnits,
      now,
      spreadHours,
      // --force は従来バースト互換(全件即時)。運用Runbookの意味論を維持する。
      immediate: force,
      idSuffixes: plannedUnits.map(() => randomUUID().slice(0, 8)),
    });
    planBuilt = true;
    nextDueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  const due = dueUnits(dayPlan, now);
  const summaryBefore = planSummary(dayPlan);

  console.log(
    `[interactions-scheduler] now=${now.toISOString()} force=${force} dryRun=${dryRun} llm=${llm} ` +
      `unitLimit=${unitLimit} rowCeiling=${rowCeiling ?? "none"} spreadHours=${spreadHours} ` +
      `weights=${weights.like_only.toFixed(2)}/${weights.like_with_comment.toFixed(2)}/${weights.comment_only.toFixed(2)}`,
  );
  if (planBuilt && dayPlan) {
    console.log(
      `[interactions-scheduler] ${force ? "(force) " : ""}new day plan: ${dayPlan.units.length} unit(s) ` +
        `(${formatPatternCounts(patternCounts(dayPlan.units))}), expired leftover=${expiredUnits}`,
    );
    for (const unit of dayPlan.units) {
      console.log(`  - ${unit.agentId}: ${unit.pattern} at ${unit.scheduledAt}`);
    }
  } else {
    console.log(
      `[interactions-scheduler] queue: pending=${summaryBefore.pending} next=${summaryBefore.nextUnitAt ?? "none"} planRenews=${nextDueAt.toISOString()}`,
    );
  }
  console.log(`[interactions-scheduler] due this tick: ${due.length} unit(s)`);

  if (dryRun) {
    // 書き込みなし。planDue時のサンプルプランは実行時に別乱数で引き直されることに注意。
    console.log(
      `[interactions-scheduler] dry-run: ${
        planBuilt
          ? `would build a new plan (sample above; the real run redraws) and execute ${due.length} unit(s) now.`
          : `would execute ${due.length} of ${summaryBefore.pending} pending unit(s).`
      }`,
    );
    return;
  }

  // due前・実行ユニットなし: skippedのみ記録して終了(stateは無変化なので書かない)。
  // completedにしないこと(ヘッダコメントの記録粒度の約束)。
  if (!planBuilt && due.length === 0) {
    console.log(`[interactions-scheduler] not due. next unit=${summaryBefore.nextUnitAt ?? "none"}`);
    await prisma.schedulerRun.create({
      data: {
        id: schedulerRunId,
        scheduleName: SCHEDULER_STATE_KEY,
        status: "skipped",
        source: "interactions",
        planner: "daily-unit-queue",
        limit: unitLimit,
        intervalHours: 24,
        forced: false,
        dryRun: false,
        reason: `Not due: next unit at ${summaryBefore.nextUnitAt ?? "none"} / plan renews ${nextDueAt.toISOString()}`,
        startedAt: now,
        completedAt: now,
        nextDueAt: summaryBefore.nextUnitAt ? new Date(summaryBefore.nextUnitAt) : nextDueAt,
      },
    });
    return;
  }

  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: SCHEDULER_STATE_KEY,
      status: "running",
      source: "interactions",
      planner: "daily-unit-queue",
      limit: unitLimit,
      intervalHours: 24,
      forced: force,
      dryRun: false,
      reason: planBuilt
        ? `planned ${dayPlan?.units.length ?? 0} unit(s) (${formatPatternCounts(patternCounts(dayPlan?.units ?? []))}), executing ${due.length} now`
        : `executing ${due.length} unit(s), pending ${summaryBefore.pending}`,
      startedAt: now,
    },
  });

  let executedUnits = 0;
  const executedCounts: Record<UnitPattern, number> = {
    like_only: 0,
    like_with_comment: 0,
    comment_only: 0,
  };
  const failures: string[] = [];
  let currentPlan = dayPlan as DayPlan;
  for (const unit of due) {
    const startedAt = new Date();
    const runId = `run_interactions_${unit.agentId}_${unit.id}_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    try {
      const { createdRows } = await runTsx("scripts/run-agent-interactions.ts", [
        "--agent",
        unit.agentId,
        "--project",
        "under-interacted",
        "--unit",
        unit.pattern,
        "--limit",
        "1",
        ...(llm ? ["--llm"] : []),
      ]);
      currentPlan = markUnitResult(currentPlan, unit.id, { outcome: "completed", rows: createdRows }, new Date());
      executedUnits += 1;
      executedCounts[unit.pattern] += 1;
      const completedAt = new Date();
      await logAgentRuntimeMetric({
        agentId: unit.agentId,
        runId,
        schedulerKey: SCHEDULER_STATE_KEY,
        eventType: "agent_interactions_scheduler_run",
        status: "completed",
        startedAt,
        completedAt,
        durationMs: durationMs(startedAt, completedAt),
        metadata: { unitId: unit.id, pattern: unit.pattern, rows: createdRows, llm },
      });
    } catch (error) {
      failures.push(`${unit.agentId}(${unit.pattern}): ${errorMessageOf(error)}`);
      currentPlan = markUnitResult(
        currentPlan,
        unit.id,
        { outcome: "failed", error: errorMessageOf(error) },
        new Date(),
      );
      const failedAt = new Date();
      await logAgentRuntimeMetric({
        agentId: unit.agentId,
        runId,
        schedulerKey: SCHEDULER_STATE_KEY,
        eventType: "agent_interactions_scheduler_run",
        status: "failed",
        startedAt,
        completedAt: failedAt,
        durationMs: durationMs(startedAt, failedAt),
        metadata: { unitId: unit.id, pattern: unit.pattern, llm, errorMessage: errorMessageOf(error) },
      });
      console.error(`[interactions-scheduler] ${unit.agentId} (${unit.pattern}) failed (continuing):`, error);
    }
  }

  const completedAt = new Date();
  const summaryAfter = planSummary(currentPlan);
  const nextState: State = {
    lastStatus: failures.length > 0 ? "failed" : "completed",
    lastCompletedAt: completedAt.toISOString(),
    nextDueAt: nextDueAt.toISOString(),
    dayPlan: currentPlan,
    history: [
      {
        at: completedAt.toISOString(),
        planned: executedUnits,
        ...(planBuilt ? { plannedUnits: currentPlan.units.length } : {}),
        executedUnits,
        ...(expiredUnits > 0 ? { expiredUnits } : {}),
        patterns: executedCounts,
      },
      ...((state?.history ?? []).slice(0, 29)),
    ],
  };
  // per-agent失敗はレーンとしては継続する(soft failure)が、SchedulerRunはfailedに
  // することでコンソールの「失敗Scheduler」に載せる。state書き込みやupdate自体がthrow
  // した場合でも、running行を残置せずfailedに落とす(orphaned running防止)。
  try {
    await writeSchedulerStateRecord(prisma, SCHEDULER_STATE_KEY, SCHEDULER_STATE_SCOPE, nextState);
    await prisma.schedulerRun.update({
      where: { id: schedulerRunId },
      data: {
        status: failures.length > 0 ? "failed" : "completed",
        errorMessage: failures.length > 0 ? failures.join(" / ").slice(0, 1000) : undefined,
        completedAt,
        nextDueAt: summaryAfter.nextUnitAt ? new Date(summaryAfter.nextUnitAt) : nextDueAt,
      },
    });
  } catch (error) {
    await prisma.schedulerRun
      .update({
        where: { id: schedulerRunId },
        data: { status: "failed", errorMessage: errorMessageOf(error).slice(0, 1000), completedAt: new Date() },
      })
      .catch(() => {});
    throw error;
  }
  console.log(
    `[interactions-scheduler] tick done. executed=${executedUnits}/${due.length} ` +
      `(${formatPatternCounts(executedCounts)}) pending=${summaryAfter.pending} next=${summaryAfter.nextUnitAt ?? "none"}`,
  );
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
