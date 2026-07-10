import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readSchedulerStateRecord, writeSchedulerStateRecord } from "../src/lib/scheduler-state";
import { readAgentRegistry } from "./agent-registry";
import { agentInteractionPolicy, personaLikeProbability } from "./agent-interaction-policy";
import { drawDailyCount, drawSlotGroup } from "./interaction-slot-planner";
import { durationMs, errorMessageOf, logAgentRuntimeMetric, stderrTailSummary } from "./observability";
import "./load-local-env";

const SCHEDULER_STATE_KEY = "agent-interactions-daily";
const SCHEDULER_STATE_SCOPE = "interactions";
const prisma = createPrismaClient();

/**
 * A-4 (Lane 3): コミュニケーションの日次スケジューラ。
 *
 * 各active creatorが「1日数回（既定は1回程度）」、上限内でランダムに他作品へ反応する。
 * いいね/コメントは「日次目標いいねN・コメントM」を独立プールとして管理し、各反応スロットを
 * 残数比の重み付き抽選でどちらのプールから引くか決める(自己補正: 片方が枯渇したら残り全部を
 * もう片方に強制する)。2026-07-08以前は単一の合計上限のみで、実際のタイプ選択は性格重み
 * (LIKE_PROPENSITY_WEIGHT≈1.8→like比率約35%)任せだったため、目標比率(例:6/6=50%)から
 * systematicにズレていた。ここでの重み付き抽選プールが「日次目標」を担保する。
 * 暴走防止の上限は agent-interaction-policy（日次/週次/プロジェクト単位）で担保(不変)。
 *
 * 1日1回 due-gate（state: data/scheduler/agent-interactions-daily.json）。
 * 実体は run-agent-interactions.ts を agent単位・グループ単位(--group like|comment)で呼ぶ
 * （--project under-interacted）。
 *
 * Usage: tsx scripts/run-agent-interactions-scheduler.ts [--force] [--dry-run] [--llm]
 *          [--like-limit N] [--comment-limit N]
 *
 * 日次目標は --like-limit/--comment-limit、または env PRODIA_DAILY_LIKE_LIMIT/
 * PRODIA_DAILY_COMMENT_LIMIT（既定 6/6）。PRODIA_DAILY_INTERACTION_LIMIT（既定なし=無制限）は
 * 合計の安全上限として残し、目標の合計がそれを超える場合のみ按分で縮める。
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

type State = {
  lastStatus?: "completed" | "failed";
  lastCompletedAt?: string;
  nextDueAt?: string;
  history?: Array<{ at: string; planned: number; plannedLikes?: number; plannedComments?: number }>;
};

const readState = async (): Promise<State | null> =>
  readSchedulerStateRecord<State>(prisma, SCHEDULER_STATE_KEY);

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
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
  const force = hasFlag("--force");
  const dryRun = hasFlag("--dry-run");
  const llm = hasFlag("--llm");
  let likeLimit = parsePositiveInt(arg("--like-limit") ?? process.env.PRODIA_DAILY_LIKE_LIMIT, 6);
  let commentLimit = parsePositiveInt(arg("--comment-limit") ?? process.env.PRODIA_DAILY_COMMENT_LIMIT, 6);
  // 合計の安全上限(未設定なら無制限)。目標いいね+コメントがこれを超える場合のみ按分で縮める。
  const overallCeiling = Number.parseInt(arg("--limit") ?? process.env.PRODIA_DAILY_INTERACTION_LIMIT ?? "", 10);
  if (Number.isFinite(overallCeiling) && overallCeiling > 0 && likeLimit + commentLimit > overallCeiling) {
    const ratio = overallCeiling / (likeLimit + commentLimit);
    likeLimit = Math.max(0, Math.floor(likeLimit * ratio));
    commentLimit = Math.max(0, overallCeiling - likeLimit);
  }
  const now = new Date();

  const state = await readState();
  const due = force || !state?.nextDueAt || now.getTime() >= Date.parse(state.nextDueAt);
  // Lane1(run-research-cache-scheduler.ts)と同じ流儀でSchedulerRun行を残す(dry-runでは書かない)。
  const schedulerRunId = `sched_interactions_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  if (!due) {
    console.log(`[interactions-scheduler] not due. next=${state?.nextDueAt}`);
    if (!dryRun) {
      await prisma.schedulerRun.create({
        data: {
          id: schedulerRunId,
          scheduleName: SCHEDULER_STATE_KEY,
          status: "skipped",
          source: "interactions",
          planner: "daily-slot-pool",
          limit: likeLimit + commentLimit,
          intervalHours: 24,
          forced: false,
          dryRun: false,
          reason: `Not due until ${state?.nextDueAt}`,
          startedAt: now,
          completedAt: now,
          nextDueAt: state?.nextDueAt ? new Date(state.nextDueAt) : undefined,
        },
      });
    }
    return;
  }

  const registry = await readAgentRegistry();
  const creators = registry.agents.filter(
    (a) => (a.role ?? "creator") === "creator" && (a.status ?? "active") === "active",
  );

  // 各エージェントの合計スロット数(0..maxDaily)は従来どおり抽選。各スロットがlike/commentの
  // どちらかは、日次プールの残数比とそのエージェント自身の性格(いいね好き/講評好き)をブレンド
  // して決める(POOL_BALANCE_WEIGHTで比率調整、片方が枯渇したら残りは全部もう片方へ強制)。
  // よって最終合計は必ず(likeLimit, commentLimit)通りになる(対象が十分にある限り)。
  let remainingLike = likeLimit;
  let remainingComment = commentLimit;
  const plan = creators.map((agent) => {
    const drawn = drawDailyCount(agentInteractionPolicy.maxDailyInteractionsPerAgent);
    const persona = personaLikeProbability(agent);
    let likeCount = 0;
    let commentCount = 0;
    for (let i = 0; i < drawn; i += 1) {
      const group = drawSlotGroup({ remainingLike, remainingComment, personaLikeProbability: persona });
      if (!group) break;
      if (group === "like") {
        likeCount += 1;
        remainingLike -= 1;
      } else {
        commentCount += 1;
        remainingComment -= 1;
      }
    }
    return { agentId: agent.agentId, likeCount, commentCount };
  });

  console.log(
    `[interactions-scheduler] now=${now.toISOString()} force=${force} dryRun=${dryRun} llm=${llm} ` +
      `likeLimit=${likeLimit} commentLimit=${commentLimit}`,
  );
  for (const entry of plan) {
    if (entry.likeCount === 0 && entry.commentCount === 0) continue;
    console.log(`  - ${entry.agentId}: like=${entry.likeCount} comment=${entry.commentCount}`);
  }

  const totalPlannedLikes = plan.reduce((s, p) => s + p.likeCount, 0);
  const totalPlannedComments = plan.reduce((s, p) => s + p.commentCount, 0);

  if (dryRun) {
    console.log(
      `[interactions-scheduler] dry-run: would plan ${totalPlannedLikes} like(s) + ${totalPlannedComments} comment(s).`,
    );
    return;
  }

  await prisma.schedulerRun.create({
    data: {
      id: schedulerRunId,
      scheduleName: SCHEDULER_STATE_KEY,
      status: "running",
      source: "interactions",
      planner: "daily-slot-pool",
      limit: likeLimit + commentLimit,
      intervalHours: 24,
      forced: force,
      dryRun: false,
      reason: `plan like=${totalPlannedLikes} comment=${totalPlannedComments}`,
      startedAt: now,
    },
  });

  let plannedLikes = 0;
  let plannedComments = 0;
  const failures: string[] = [];
  for (const entry of plan) {
    for (const group of ["like", "comment"] as const) {
      const count = group === "like" ? entry.likeCount : entry.commentCount;
      if (count <= 0) continue;
      const startedAt = new Date();
      const runId = `run_interactions_${entry.agentId}_${group}_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
      try {
        await runTsx("scripts/run-agent-interactions.ts", [
          "--agent",
          entry.agentId,
          "--project",
          "under-interacted",
          "--group",
          group,
          "--limit",
          String(count),
          ...(llm ? ["--llm"] : []),
        ]);
        if (group === "like") plannedLikes += count;
        else plannedComments += count;
        const completedAt = new Date();
        await logAgentRuntimeMetric({
          agentId: entry.agentId,
          runId,
          schedulerKey: SCHEDULER_STATE_KEY,
          eventType: "agent_interactions_scheduler_run",
          status: "completed",
          startedAt,
          completedAt,
          durationMs: durationMs(startedAt, completedAt),
          metadata: { group, planned: count, llm },
        });
      } catch (error) {
        failures.push(`${entry.agentId}(${group}): ${errorMessageOf(error)}`);
        const failedAt = new Date();
        await logAgentRuntimeMetric({
          agentId: entry.agentId,
          runId,
          schedulerKey: SCHEDULER_STATE_KEY,
          eventType: "agent_interactions_scheduler_run",
          status: "failed",
          startedAt,
          completedAt: failedAt,
          durationMs: durationMs(startedAt, failedAt),
          metadata: { group, planned: count, llm, errorMessage: errorMessageOf(error) },
        });
        console.error(`[interactions-scheduler] ${entry.agentId} (${group}) failed (continuing):`, error);
      }
    }
  }

  const planned = plannedLikes + plannedComments;
  const completedAt = new Date();
  const nextDueAtDate = new Date(completedAt.getTime() + 24 * 60 * 60 * 1000);
  const nextState: State = {
    lastStatus: failures.length > 0 ? "failed" : "completed",
    lastCompletedAt: completedAt.toISOString(),
    nextDueAt: nextDueAtDate.toISOString(),
    history: [
      { at: completedAt.toISOString(), planned, plannedLikes, plannedComments },
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
        nextDueAt: nextDueAtDate,
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
  console.log(`[interactions-scheduler] done. planned=${planned} (like=${plannedLikes} comment=${plannedComments})`);
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
