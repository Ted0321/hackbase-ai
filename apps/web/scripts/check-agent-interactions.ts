import { createPrismaClient, listExistingTables } from "./prisma-client";
import {
  agentInteractionPolicy,
  dayWindowStart,
  reactionTypeGroup,
  weekWindowStart,
  type InteractionType,
} from "./agent-interaction-policy";
import "./load-local-env";

const prisma = createPrismaClient();

async function missingTables(requiredTables: string[]) {
  const existingTables = await listExistingTables(prisma);
  return requiredTables.filter((table) => !existingTables.has(table));
}

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    batchId: values.get("batch-id") ? String(values.get("batch-id")) : undefined,
  };
};

function parseMetadata(metadataJson: string | null) {
  if (!metadataJson) return null;

  try {
    return JSON.parse(metadataJson) as {
      batchId?: string;
      feedbackId?: string;
      comment?: string;
      commentSource?: string;
    };
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const missingRequiredTables = await missingTables(["RunEvent", "Feedback"]);

  if (missingRequiredTables.length > 0) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          schemaReady: false,
          batchId: args.batchId ?? null,
          checkedRunEvents: 0,
          checkedFeedback: 0,
          checkedProjects: 0,
          checkedAgents: 0,
          failures: [],
          warnings: [
            `Skipped DB-backed interaction checks because the local database schema is not initialized. Missing table(s): ${missingRequiredTables.join(", ")}`,
          ],
        },
        null,
        2,
      ),
    );
    return;
  }

  const events = await prisma.runEvent.findMany({
    where: {
      actorType: "agent",
      type: { in: agentInteractionPolicy.typePriority },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const matchingEvents = events.filter((event) => {
    const metadata = parseMetadata(event.metadataJson);
    return args.batchId ? metadata?.batchId === args.batchId : Boolean(metadata?.feedbackId);
  });
  const feedbackIds = matchingEvents
    .map((event) => parseMetadata(event.metadataJson)?.feedbackId)
    .filter((feedbackId): feedbackId is string => Boolean(feedbackId));
  const feedback = await prisma.feedback.findMany({
    where: { id: { in: feedbackIds } },
  });
  const feedbackById = new Map(feedback.map((item) => [item.id, item]));
  const projectIds = [...new Set(feedback.map((item) => item.targetId))];
  const agentIds = [...new Set(feedback.map((item) => item.actorId).filter((actorId): actorId is string => Boolean(actorId)))];
  const allProjectAgentFeedback = await prisma.feedback.findMany({
    where: {
      targetType: "project",
      targetId: { in: projectIds },
      actorType: "agent",
    },
  });
  const [dailyFeedback, weeklyFeedback] = await Promise.all([
    prisma.feedback.findMany({
      where: {
        actorType: "agent",
        actorId: { in: agentIds },
        createdAt: { gte: dayWindowStart() },
      },
    }),
    prisma.feedback.findMany({
      where: {
        actorType: "agent",
        actorId: { in: agentIds },
        createdAt: { gte: weekWindowStart() },
      },
    }),
  ]);
  const failures: string[] = [];

  if (args.batchId && matchingEvents.length === 0) {
    failures.push(`batch not found: ${args.batchId}`);
  }

  for (const event of matchingEvents) {
    const metadata = parseMetadata(event.metadataJson);
    const linkedFeedback = metadata?.feedbackId ? feedbackById.get(metadata.feedbackId) : null;

    if (!metadata?.feedbackId) {
      failures.push(`${event.id}: missing metadata.feedbackId`);
      continue;
    }
    if (!linkedFeedback) {
      failures.push(`${event.id}: linked Feedback not found (${metadata.feedbackId})`);
      continue;
    }
    if (event.actorType !== "agent" || linkedFeedback.actorType !== "agent") {
      failures.push(`${event.id}: actorType must be agent on both RunEvent and Feedback`);
    }
    if (event.actorId !== linkedFeedback.actorId) {
      failures.push(`${event.id}: actorId mismatch with Feedback ${linkedFeedback.id}`);
    }
    if (event.projectId !== linkedFeedback.targetId) {
      failures.push(`${event.id}: projectId mismatch with Feedback ${linkedFeedback.id}`);
    }
    if (event.type !== linkedFeedback.rating) {
      failures.push(`${event.id}: type/rating mismatch with Feedback ${linkedFeedback.id}`);
    }
  }

  for (const projectId of projectIds) {
    const projectFeedback = allProjectAgentFeedback.filter((item) => item.targetId === projectId);
    if (projectFeedback.length > agentInteractionPolicy.maxInteractionsPerProject) {
      failures.push(
        `${projectId}: project interaction limit exceeded (${projectFeedback.length}/${agentInteractionPolicy.maxInteractionsPerProject})`,
      );
    }

    // 大前提ルール: 同一エージェント×同一作品は「いいね1回＋コメント系1回」まで(排他グループ別に各1)。
    const byAgentGroup = new Map<string, number>();
    const byType = new Map<InteractionType | string, number>();
    for (const item of projectFeedback) {
      if (item.actorId) {
        const key = `${item.actorId}:${reactionTypeGroup(item.rating)}`;
        byAgentGroup.set(key, (byAgentGroup.get(key) ?? 0) + 1);
      }
      byType.set(item.rating, (byType.get(item.rating) ?? 0) + 1);
    }

    for (const [key, count] of byAgentGroup) {
      if (count > 1) {
        const [agentId, group] = key.split(":");
        failures.push(`${projectId}: ${agentId} used the ${group} slot ${count} times on one project`);
      }
    }
    // 同タイプ上限はコメント系のみ(いいねはper-agent制で、複数体分が同じ作品に並んでよい)。
    for (const [type, count] of byType) {
      if (type !== "agent_like" && count > agentInteractionPolicy.maxSameTypePerProject) {
        failures.push(`${projectId}: type limit exceeded for ${type} (${count}/${agentInteractionPolicy.maxSameTypePerProject})`);
      }
    }
  }

  for (const agentId of agentIds) {
    const dailyCount = dailyFeedback.filter((item) => item.actorId === agentId).length;
    const weeklyCount = weeklyFeedback.filter((item) => item.actorId === agentId).length;
    if (dailyCount > agentInteractionPolicy.maxDailyInteractionsPerAgent) {
      failures.push(
        `${agentId}: daily limit exceeded (${dailyCount}/${agentInteractionPolicy.maxDailyInteractionsPerAgent})`,
      );
    }
    if (weeklyCount > agentInteractionPolicy.maxWeeklyInteractionsPerAgent) {
      failures.push(
        `${agentId}: weekly limit exceeded (${weeklyCount}/${agentInteractionPolicy.maxWeeklyInteractionsPerAgent})`,
      );
    }
  }

  // コメント生成元の分布を集計する。template はローカル/--no-llm 実行では正当だが、本番では
  // 「作品名+定型文」の無機質コメントとして公開フィードに露出した実績がある(2026-07-08分析)
  // ため、直近7日に template があれば警告として可視化する(失敗にはしない: ローカルCIを壊さない)。
  const warnings: string[] = [];
  const commentSourceTally: Record<string, number> = {};
  let recentTemplateCount = 0;
  for (const event of matchingEvents) {
    const source = parseMetadata(event.metadataJson)?.commentSource ?? "(unknown)";
    commentSourceTally[source] = (commentSourceTally[source] ?? 0) + 1;
    if (source === "template" && event.createdAt >= weekWindowStart()) {
      recentTemplateCount += 1;
    }
  }
  if (recentTemplateCount > 0) {
    warnings.push(
      `${recentTemplateCount} interaction(s) in the last 7 days used template comments. ` +
        "本番でこれが出る場合はLLM生成が無効(--no-llm/旧--llm省略)の可能性が高い。",
    );
  }

  const output = {
    ok: failures.length === 0,
    batchId: args.batchId ?? null,
    checkedRunEvents: matchingEvents.length,
    checkedFeedback: feedback.length,
    checkedProjects: projectIds.length,
    checkedAgents: agentIds.length,
    commentSourceTally,
    failures,
    warnings,
  };

  console.log(JSON.stringify(output, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
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
