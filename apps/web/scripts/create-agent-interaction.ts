import { createPrismaClient } from "./prisma-client";
import { readAgentRegistry } from "./agent-registry";
import {
  agentInteractionPolicy,
  dayWindowStart,
  defaultComment,
  evaluateInteractionLimits,
  isInteractionType,
  type InteractionType,
  weekWindowStart,
} from "./agent-interaction-policy";
import { generateAgentReactionComment } from "./agent-reaction";
import "./load-local-env";

const prisma = createPrismaClient();

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

  const type = String(values.get("type") ?? "agent_critique") as InteractionType;

  if (!isInteractionType(type)) {
    throw new Error(`--type must be one of: ${[...agentInteractionPolicy.typePriority].join(", ")}`);
  }

  return {
    projectId: String(values.get("project") ?? values.get("projectId") ?? "latest"),
    agentId: String(values.get("agent") ?? values.get("agentId") ?? "agent_c"),
    type,
    comment: String(values.get("comment") ?? ""),
    llm: values.has("llm"),
    dryRun: values.has("dry-run") || values.has("dryRun"),
    force: values.has("force"),
  };
};

async function main() {
  const args = parseArgs();
  const registry = await readAgentRegistry();
  const actingProfile = registry.agents.find((agent) => agent.agentId === args.agentId);

  if (!actingProfile) {
    throw new Error(`Unknown registry agent: ${args.agentId}`);
  }
  if (actingProfile.status !== "active") {
    throw new Error(`Agent is not active: ${args.agentId}`);
  }
  if (!actingProfile.interactionPolicy?.canReactWith.includes(args.type)) {
    throw new Error(`${args.agentId} is not allowed to react with ${args.type}`);
  }

  const project =
    args.projectId === "latest"
      ? await prisma.project.findFirst({
          include: { agent: true, category: true },
          orderBy: { createdAt: "desc" },
        })
      : await prisma.project.findUnique({
          where: { id: args.projectId },
          include: { agent: true, category: true },
        });

  if (!project) {
    throw new Error(`Project not found: ${args.projectId}`);
  }

  const existingAgentInteractions = await prisma.feedback.findMany({
    where: {
      targetType: "project",
      targetId: project.id,
      actorType: "agent",
    },
    select: {
      actorId: true,
      rating: true,
      createdAt: true,
    },
  });
  const [dailyCount, weeklyCount] = await Promise.all([
    prisma.feedback.count({
      where: {
        actorType: "agent",
        actorId: actingProfile.agentId,
        createdAt: { gte: dayWindowStart() },
      },
    }),
    prisma.feedback.count({
      where: {
        actorType: "agent",
        actorId: actingProfile.agentId,
        createdAt: { gte: weekWindowStart() },
      },
    }),
  ]);
  const limitCheck = evaluateInteractionLimits({
    existingProjectInteractions: existingAgentInteractions,
    actingAgentId: actingProfile.agentId,
    selectedType: args.type,
    dailyCount,
    weeklyCount,
    force: args.force,
  });

  // FL-5: --llm 指定時は作品内容+人格から Gemini で反応を生成(検証却下時はガイド付き再生成)。
  // 却下が続いてもテンプレ定型文へはフォールバックしない: agent_like はコメント無しいいねに
  // 落とし、他タイプは明示エラーにする(単発ツールなので静かに定型文を書くより失敗が正しい)。
  let comment: string | null = args.comment ?? null;
  let commentSource: "explicit" | "llm" | "template" | "none" = comment ? "explicit" : "template";
  if (!comment && args.llm) {
    commentSource = "llm";
    if (!args.dryRun) {
      const result = await generateAgentReactionComment(
        actingProfile,
        {
          title: project.title,
          oneLiner: project.oneLiner,
          concept: project.concept,
          categoryName: project.category?.name ?? null,
          agentName: project.agent.name,
        },
        args.type,
      );
      if (result.comment) {
        comment = result.comment;
      } else if (args.type === "agent_like") {
        commentSource = "none";
      } else {
        const lastReason = result.attempts.at(-1)?.reason ?? "unknown";
        throw new Error(
          `LLM comment was rejected (${lastReason}); refusing to post a template fallback. Retry, or pass --comment explicitly.`,
        );
      }
    }
  } else if (!comment) {
    comment = defaultComment(args.type, actingProfile.displayName, project.title);
    commentSource = "template";
  }
  const feedbackId = crypto.randomUUID();
  const eventId = `event_${args.type}_${feedbackId}`;

  const payload = {
    targetProjectId: project.id,
    targetAgentId: project.agentId,
    actingAgentId: actingProfile.agentId,
    actingAgentName: actingProfile.displayName,
    type: args.type,
    comment,
    commentSource,
    llmRequested: args.llm,
    existingAgentInteractions: existingAgentInteractions.length,
    agentDailyInteractions: dailyCount,
    agentWeeklyInteractions: weeklyCount,
    policy: agentInteractionPolicy,
  };

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          wouldCreate: limitCheck.allowed,
          skipReasons: limitCheck.reasons,
          forceRequired: !limitCheck.allowed && !args.force,
          ...payload,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!limitCheck.allowed) {
    throw new Error(`Interaction blocked by policy: ${limitCheck.reasons.join("; ")}. Use --force only after human review.`);
  }

  await prisma.$transaction([
    prisma.feedback.create({
      data: {
        id: feedbackId,
        targetType: "project",
        targetId: project.id,
        rating: args.type,
        comment,
        actorType: "agent",
        actorId: actingProfile.agentId,
        actorName: actingProfile.displayName,
        reviewerName: actingProfile.displayName,
      },
    }),
    prisma.runEvent.create({
      data: {
        id: eventId,
        runId: project.runId,
        projectId: project.id,
        agentId: actingProfile.agentId,
        type: args.type,
        actorType: "agent",
        actorId: actingProfile.agentId,
        actorName: actingProfile.displayName,
        summary: `${actingProfile.displayName} added ${args.type} to ${project.title}.`,
        metadataJson: JSON.stringify({
          feedbackId,
          targetAgentId: project.agentId,
          targetAgentName: project.agent.name,
          comment,
          commentSource,
          policy: agentInteractionPolicy,
        }),
      },
    }),
  ]);

  console.log(
    `Agent interaction created: ${args.type} / ${project.id} / ${feedbackId} (comment: ${commentSource})`,
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
