import { randomUUID } from "node:crypto";
import { createPrismaClient, listExistingTables } from "./prisma-client";
import { readAgentRegistry, type AgentRegistryProfile } from "./agent-registry";
import {
  agentInteractionPolicy,
  dayWindowStart,
  defaultComment,
  evaluateInteractionLimits,
  isInteractionType,
  selectInteractionType,
  usedReactionGroups,
  weekWindowStart,
  type ExistingAgentInteraction,
  type InteractionType,
} from "./agent-interaction-policy";
import { isUnitPattern, type UnitPattern } from "./interaction-slot-planner";
import { generateAgentReactionComment } from "./agent-reaction";
import { projectPreferenceSignals, rankByTargetPreference } from "./target-preference";
import "./load-local-env";

type ProjectSelection = "under-interacted" | "latest" | "featured" | string;

type Args = {
  project: ProjectSelection;
  agentId?: string;
  type?: InteractionType;
  group?: "like" | "comment";
  // 行動ユニット(①like_only/②like_with_comment/③comment_only)。指定時、--limitはユニット数。
  unit?: UnitPattern;
  limit: number;
  dryRun: boolean;
  force: boolean;
  llm: boolean;
};

type ProjectWithAgent = NonNullable<
  Awaited<ReturnType<typeof prisma.project.findFirst<{ include: { agent: true } }>>>
>;

type PlannedInteraction = {
  feedbackId: string;
  eventId: string;
  runId: string;
  projectId: string;
  projectTitle: string;
  targetAgentId: string;
  targetAgentName: string;
  actingAgentId: string;
  actingAgentName: string;
  type: InteractionType;
  // comment: null は「コメント無しのいいね」。ユニット経路(--unit)のいいね行は常に本文なし
  // (公開フィードで全いいねにコメントが付いて見える不自然さを避ける。2026-07-10仕様変更)。
  // 旧経路では LLM 生成が通らなかった agent_like のみ。
  comment: string | null;
  commentSource: "template" | "llm" | "none";
  llmAttempts?: Array<{ ok: boolean; reason?: string }>;
  // 行動ユニット情報(--unit 経路のみ)。②のペア2行は同じ unitId を共有する。
  unitId?: string;
  unitPattern?: UnitPattern;
  // ②のコメント行が上限/LLM却下で落ち、いいね行だけ残って①へ降格したとき true。
  unitDegraded?: boolean;
};

const prisma = createPrismaClient();
const publicInteractionTargetWhere = {
  status: { in: ["auto_published", "published"] },
  NOT: { publishDecision: "withdrawn" },
};

async function missingTables(requiredTables: string[]) {
  const existingTables = await listExistingTables(prisma);
  return requiredTables.filter((table) => !existingTables.has(table));
}

function parseArgs(): Args {
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

  const rawType = values.get("type");
  const type = rawType ? String(rawType) : undefined;
  if (type && !isInteractionType(type)) {
    throw new Error(`--type must be one of: ${agentInteractionPolicy.typePriority.join(", ")}`);
  }

  const rawGroup = values.get("group");
  const group = rawGroup ? String(rawGroup) : undefined;
  if (group && group !== "like" && group !== "comment") {
    throw new Error('--group must be "like" or "comment"');
  }

  const rawUnit = values.get("unit");
  const unit = rawUnit ? String(rawUnit) : undefined;
  if (unit && !isUnitPattern(unit)) {
    throw new Error('--unit must be "like_only", "like_with_comment", or "comment_only"');
  }
  if (unit && (type || group)) {
    throw new Error("--unit cannot be combined with --type or --group");
  }

  const rawLimit = Number(values.get("limit") ?? agentInteractionPolicy.defaultBatchLimit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  return {
    project: String(values.get("project") ?? "under-interacted"),
    agentId: values.get("agent") ? String(values.get("agent")) : undefined,
    type: type as InteractionType | undefined,
    group: group as "like" | "comment" | undefined,
    unit: unit as UnitPattern | undefined,
    limit: Math.min(rawLimit, agentInteractionPolicy.maxBatchLimit),
    dryRun: values.has("dry-run") || values.has("dryRun"),
    force: values.has("force"),
    llm: values.has("llm"),
  };
}

async function selectTargetProjects(selection: ProjectSelection) {
  if (selection === "latest") {
    const project = await prisma.project.findFirst({
      where: publicInteractionTargetWhere,
      include: { agent: true },
      orderBy: { createdAt: "desc" },
    });
    return project ? [project] : [];
  }

  if (selection === "featured") {
    return prisma.project.findMany({
      where: { ...publicInteractionTargetWhere, featured: true },
      include: { agent: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
  }

  if (selection !== "under-interacted") {
    const project = await prisma.project.findFirst({
      where: { ...publicInteractionTargetWhere, id: selection },
      include: { agent: true },
    });
    return project ? [project] : [];
  }

  const projects = await prisma.project.findMany({
    where: publicInteractionTargetWhere,
    include: { agent: true },
    orderBy: { createdAt: "desc" },
    take: 24,
  });
  const projectIds = projects.map((project) => project.id);
  const feedback = await prisma.feedback.findMany({
    where: {
      targetType: "project",
      targetId: { in: projectIds },
      actorType: "agent",
    },
    select: { targetId: true },
  });
  const counts = new Map<string, number>();
  for (const item of feedback) {
    counts.set(item.targetId, (counts.get(item.targetId) ?? 0) + 1);
  }

  return projects.sort((left, right) => {
    const diff = (counts.get(left.id) ?? 0) - (counts.get(right.id) ?? 0);
    return diff !== 0 ? diff : right.createdAt.getTime() - left.createdAt.getTime();
  });
}

function activeInteractionAgents(registryAgents: AgentRegistryProfile[], requestedAgentId?: string) {
  const agents = registryAgents.filter((agent) => {
    if ((agent.status ?? "active") !== "active") return false;
    if (!agent.interactionPolicy?.canReactWith.length) return false;
    if (!requestedAgentId && (agent.role ?? "creator") !== "creator") return false;
    return requestedAgentId ? agent.agentId === requestedAgentId : true;
  });

  if (requestedAgentId && agents.length === 0) {
    throw new Error(`Unknown or inactive registry agent: ${requestedAgentId}`);
  }

  return agents;
}

async function loadExistingInteractions(projectIds: string[]) {
  const rows = await prisma.feedback.findMany({
    where: {
      targetType: "project",
      targetId: { in: projectIds },
      actorType: "agent",
    },
    select: {
      targetId: true,
      actorId: true,
      rating: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const byProject = new Map<string, ExistingAgentInteraction[]>();

  for (const row of rows) {
    const list = byProject.get(row.targetId) ?? [];
    list.push({ actorId: row.actorId, rating: row.rating, createdAt: row.createdAt });
    byProject.set(row.targetId, list);
  }

  return byProject;
}

async function loadAgentWindowCounts(agentIds: string[]) {
  const [dailyRows, weeklyRows] = await Promise.all([
    prisma.feedback.findMany({
      where: {
        actorType: "agent",
        actorId: { in: agentIds },
        createdAt: { gte: dayWindowStart() },
      },
      select: { actorId: true },
    }),
    prisma.feedback.findMany({
      where: {
        actorType: "agent",
        actorId: { in: agentIds },
        createdAt: { gte: weekWindowStart() },
      },
      select: { actorId: true },
    }),
  ]);
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();

  for (const row of dailyRows) {
    if (!row.actorId) continue;
    daily.set(row.actorId, (daily.get(row.actorId) ?? 0) + 1);
  }
  for (const row of weeklyRows) {
    if (!row.actorId) continue;
    weekly.set(row.actorId, (weekly.get(row.actorId) ?? 0) + 1);
  }

  return { daily, weekly };
}

function planInteractions(args: {
  projects: ProjectWithAgent[];
  agents: AgentRegistryProfile[];
  requestedType?: InteractionType;
  requestedGroup?: "like" | "comment";
  // 行動ユニット指定時、limit はユニット数(②のペア2行で1ユニット)。
  requestedUnit?: UnitPattern;
  limit: number;
  force: boolean;
  existingByProject: Map<string, ExistingAgentInteraction[]>;
  dailyCounts: Map<string, number>;
  weeklyCounts: Map<string, number>;
}) {
  const planned: PlannedInteraction[] = [];
  const skipped: Array<{ projectId: string; agentId?: string; reasons: string[] }> = [];
  let likesAlreadyPlanned = 0;
  let unitsPlanned = 0;
  const reachedLimit = () =>
    args.requestedUnit ? unitsPlanned >= args.limit : planned.length >= args.limit;

  // 1行分を上限評価して計画に積む共通処理。②の2行目は、直前に積んだいいね行が
  // dailyCounts/weeklyCounts へ反映済みの状態で評価される(セットで日次2行を消費)。
  const planRow = (
    project: ProjectWithAgent,
    agent: AgentRegistryProfile,
    selectedType: InteractionType,
    projectInteractions: ExistingAgentInteraction[],
    options?: { unitId?: string; unitPattern?: UnitPattern; commentless?: boolean },
  ): boolean => {
    const limitCheck = evaluateInteractionLimits({
      existingProjectInteractions: projectInteractions,
      actingAgentId: agent.agentId,
      selectedType,
      dailyCount: args.dailyCounts.get(agent.agentId) ?? 0,
      weeklyCount: args.weeklyCounts.get(agent.agentId) ?? 0,
      force: args.force,
    });
    if (!limitCheck.allowed) {
      skipped.push({ projectId: project.id, agentId: agent.agentId, reasons: limitCheck.reasons });
      return false;
    }

    const feedbackId = randomUUID();
    planned.push({
      feedbackId,
      eventId: `event_${selectedType}_${feedbackId}`,
      runId: project.runId,
      projectId: project.id,
      projectTitle: project.title,
      targetAgentId: project.agentId,
      targetAgentName: project.agent.name,
      actingAgentId: agent.agentId,
      actingAgentName: agent.displayName,
      type: selectedType,
      // ユニット経路のいいね行は本文なしで確定。それ以外は従来どおりテンプレ→(--llm時)LLM置換。
      comment: options?.commentless
        ? null
        : defaultComment(selectedType, agent.displayName, project.title, project.oneLiner),
      commentSource: options?.commentless ? "none" : "template",
      unitId: options?.unitId,
      unitPattern: options?.unitPattern,
    });

    projectInteractions.push({ actorId: agent.agentId, rating: selectedType, createdAt: new Date() });
    args.existingByProject.set(project.id, projectInteractions);
    args.dailyCounts.set(agent.agentId, (args.dailyCounts.get(agent.agentId) ?? 0) + 1);
    args.weeklyCounts.set(agent.agentId, (args.weeklyCounts.get(agent.agentId) ?? 0) + 1);
    if (selectedType === "agent_like") likesAlreadyPlanned += 1;
    return true;
  };

  for (const project of args.projects) {
    if (reachedLimit()) break;
    const projectInteractions = args.existingByProject.get(project.id) ?? [];

    for (const agent of args.agents) {
      if (reachedLimit()) break;
      if (agent.agentId === project.agentId) {
        skipped.push({ projectId: project.id, agentId: agent.agentId, reasons: ["acting agent owns this project"] });
        continue;
      }

      if (args.requestedUnit) {
        // ユニット経路はユニット数でlimit管理するため、混在バッチ用のいいね上限
        // (maxLikesPerBatch)は適用しない(likesAlreadyPlanned: 0 を渡す)。
        const pattern = args.requestedUnit;
        const unitId = `unit_${randomUUID().slice(0, 8)}`;

        if (pattern === "like_only" || pattern === "comment_only") {
          const selectedType = selectInteractionType({
            agent,
            existingProjectInteractions: projectInteractions,
            requestedGroup: pattern === "like_only" ? "like" : "comment",
            likesAlreadyPlanned: 0,
            force: args.force,
          });
          if (!selectedType) {
            skipped.push({ projectId: project.id, agentId: agent.agentId, reasons: ["no allowed interaction type"] });
            continue;
          }
          if (
            planRow(project, agent, selectedType, projectInteractions, {
              unitId,
              unitPattern: pattern,
              commentless: pattern === "like_only",
            })
          ) {
            unitsPlanned += 1;
          }
          continue;
        }

        // like_with_comment: 同一作品で like/comment 両グループが空いているエージェント×作品のみ。
        // (どちらかを既に使っていたら別作品で改めてセットにする — 部分的なセットは作らない)
        if (usedReactionGroups(projectInteractions, agent.agentId).size > 0) {
          skipped.push({
            projectId: project.id,
            agentId: agent.agentId,
            reasons: ["unit requires both like and comment slots free on this project"],
          });
          continue;
        }
        const likeType = selectInteractionType({
          agent,
          existingProjectInteractions: projectInteractions,
          requestedGroup: "like",
          likesAlreadyPlanned: 0,
          force: args.force,
        });
        const commentType = selectInteractionType({
          agent,
          existingProjectInteractions: projectInteractions,
          requestedGroup: "comment",
          likesAlreadyPlanned: 0,
          force: args.force,
        });
        if (!likeType || !commentType) {
          skipped.push({ projectId: project.id, agentId: agent.agentId, reasons: ["no allowed interaction type"] });
          continue;
        }
        if (!planRow(project, agent, likeType, projectInteractions, { unitId, unitPattern: pattern, commentless: true })) {
          continue;
        }
        if (!planRow(project, agent, commentType, projectInteractions, { unitId, unitPattern: pattern })) {
          // コメント行だけ上限で落ちた(例: rolling 24h窓の日次残が1行)。いいね行は成立している
          // ので、ユニットを①へ降格して継続する。
          const likeRow = planned[planned.length - 1];
          likeRow.unitPattern = "like_only";
          likeRow.unitDegraded = true;
        }
        unitsPlanned += 1;
        continue;
      }

      // 従来経路(--type/--group/混在バッチ)。手動レーンはこちらを使う。
      const selectedType = selectInteractionType({
        agent,
        existingProjectInteractions: projectInteractions,
        requestedType: args.requestedType,
        requestedGroup: args.requestedGroup,
        likesAlreadyPlanned,
        force: args.force,
      });

      if (!selectedType) {
        skipped.push({ projectId: project.id, agentId: agent.agentId, reasons: ["no allowed interaction type"] });
        continue;
      }

      planRow(project, agent, selectedType, projectInteractions);
    }
  }

  return { planned, skipped };
}

async function main() {
  const args = parseArgs();
  const registry = await readAgentRegistry();
  const agents = activeInteractionAgents(registry.agents, args.agentId);
  const missingRequiredTables = await missingTables(["Project", "Feedback"]);

  if (missingRequiredTables.length > 0 && args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          schemaReady: false,
          skippedReason: `Local database schema is not initialized. Missing table(s): ${missingRequiredTables.join(", ")}`,
          selector: args.project,
          force: args.force,
          limit: args.limit,
          policy: agentInteractionPolicy,
          targetProjects: [],
          planned: [],
          skipped: [],
          checkedAgents: agents.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  const selectedProjects = await selectTargetProjects(args.project);

  // 単一 acting agent 指定時は、その agent の interactionPolicy.targetPreference で
  // 候補プロジェクトを再ランクする（一致が多いものを先頭へ）。複数 agent の一括バッチでは
  // 共有順を変えない＝既存の dry-run 出力・dedup・レート制限を保つ。
  const actingProfile = args.agentId
    ? agents.find((agent) => agent.agentId === args.agentId)
    : undefined;
  const projects = actingProfile
    ? rankByTargetPreference(actingProfile.interactionPolicy?.targetPreference, selectedProjects, (project) =>
        projectPreferenceSignals(project),
      )
    : selectedProjects;

  if (projects.length === 0) {
    throw new Error(`No target project found for --project ${args.project}`);
  }

  const projectIds = projects.map((project) => project.id);
  const existingByProject = await loadExistingInteractions(projectIds);
  const originalProjectCounts = new Map(
    projectIds.map((projectId) => [projectId, existingByProject.get(projectId)?.length ?? 0]),
  );
  const { daily, weekly } = await loadAgentWindowCounts(agents.map((agent) => agent.agentId));
  const batchId = `agent_interaction_batch_${new Date().toISOString()}`;
  const { planned, skipped } = planInteractions({
    projects,
    agents,
    requestedType: args.type,
    requestedGroup: args.group,
    requestedUnit: args.unit,
    limit: args.limit,
    force: args.force,
    existingByProject,
    dailyCounts: daily,
    weeklyCounts: weekly,
  });

  const output = {
    dryRun: args.dryRun,
    batchId,
    selector: args.project,
    unit: args.unit,
    force: args.force,
    limit: args.limit,
    policy: agentInteractionPolicy,
    targetProjects: projects.map((project) => ({
      projectId: project.id,
      title: project.title,
      agentId: project.agentId,
      existingAgentInteractions: originalProjectCounts.get(project.id) ?? 0,
    })),
    planned,
    skipped: skipped.slice(0, 20),
  };

  if (args.dryRun) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (planned.length === 0) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // FL-5: --llm 指定時は、作品内容+人格から Gemini で反応コメントを生成する。
  // 生成が品質検証を通らなかった場合、以前はテンプレ定型文を投稿していたが、それが
  // 「作品名+定型文」の無機質コメントとして公開フィードに残る主因だった(2026-07-08分析)。
  // 現在はテンプレへ落とさず、agent_like のみコメント無しいいねとして成立させ、
  // それ以外の反応タイプはスキップする(数より質を優先)。
  let finalPlanned = planned;
  let degradedToLikeOnly = 0;
  if (args.llm) {
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const agentMap = new Map(agents.map((agent) => [agent.agentId, agent]));
    const kept: PlannedInteraction[] = [];
    const degradedUnitIds = new Set<string>();
    for (const interaction of planned) {
      // ユニット経路の本文なしいいね行は生成対象外(Gemini呼び出しも発生しない)。
      if (interaction.commentSource === "none") {
        kept.push(interaction);
        continue;
      }
      const project = projectMap.get(interaction.projectId);
      const profile = agentMap.get(interaction.actingAgentId);
      if (!project || !profile) continue;
      const result = await generateAgentReactionComment(
        profile,
        {
          title: project.title,
          oneLiner: project.oneLiner,
          concept: project.concept,
          categoryName: null,
          agentName: project.agent.name,
        },
        interaction.type,
      );
      interaction.llmAttempts = result.attempts;
      if (result.comment) {
        interaction.comment = result.comment;
        interaction.commentSource = "llm";
        kept.push(interaction);
      } else if (interaction.type === "agent_like") {
        interaction.comment = null;
        interaction.commentSource = "none";
        kept.push(interaction);
      } else if (interaction.unitPattern === "like_with_comment" && interaction.unitId) {
        // ②のコメント行が品質検証を通らなかった → コメント行を落とし、ユニットを①へ降格
        // (いいね行は残す。テンプレ文へ落とすくらいなら投稿しない、の既存方針と同じ)。
        degradedUnitIds.add(interaction.unitId);
        const lastReason = result.attempts.at(-1)?.reason ?? "unknown";
        skipped.push({
          projectId: interaction.projectId,
          agentId: interaction.actingAgentId,
          reasons: [`llm_comment_rejected: ${lastReason} (unit degraded to like_only)`],
        });
      } else {
        const lastReason = result.attempts.at(-1)?.reason ?? "unknown";
        skipped.push({
          projectId: interaction.projectId,
          agentId: interaction.actingAgentId,
          reasons: [`llm_comment_rejected: ${lastReason}`],
        });
      }
    }
    for (const interaction of kept) {
      if (interaction.unitId && degradedUnitIds.has(interaction.unitId) && interaction.type === "agent_like") {
        interaction.unitPattern = "like_only";
        interaction.unitDegraded = true;
      }
    }
    degradedToLikeOnly = degradedUnitIds.size;
    finalPlanned = kept;
    if (finalPlanned.length === 0) {
      console.log(JSON.stringify({ ...output, planned: [], skipped: skipped.slice(0, 20), created: 0 }, null, 2));
      return;
    }
  }

  await prisma.$transaction(
    finalPlanned.flatMap((interaction) => [
      prisma.feedback.create({
        data: {
          id: interaction.feedbackId,
          targetType: "project",
          targetId: interaction.projectId,
          rating: interaction.type,
          comment: interaction.comment,
          actorType: "agent",
          actorId: interaction.actingAgentId,
          actorName: interaction.actingAgentName,
          reviewerName: interaction.actingAgentName,
        },
      }),
      prisma.runEvent.create({
        data: {
          id: interaction.eventId,
          runId: interaction.runId,
          projectId: interaction.projectId,
          agentId: interaction.actingAgentId,
          type: interaction.type,
          actorType: "agent",
          actorId: interaction.actingAgentId,
          actorName: interaction.actingAgentName,
          summary: `${interaction.actingAgentName} added ${interaction.type} to ${interaction.projectTitle}.`,
          metadataJson: JSON.stringify({
            batchId,
            feedbackId: interaction.feedbackId,
            targetAgentId: interaction.targetAgentId,
            targetAgentName: interaction.targetAgentName,
            comment: interaction.comment,
            commentSource: interaction.commentSource,
            ...(interaction.unitId
              ? {
                  unitId: interaction.unitId,
                  unitPattern: interaction.unitPattern,
                  ...(interaction.unitDegraded ? { unitDegraded: true } : {}),
                }
              : {}),
            ...(interaction.llmAttempts ? { llmAttempts: interaction.llmAttempts } : {}),
            policy: agentInteractionPolicy,
          }),
        },
      }),
    ]),
  );

  const llmSummary = args.llm
    ? {
        llmAccepted: finalPlanned.filter((item) => item.commentSource === "llm").length,
        llmRetried: finalPlanned.filter((item) => (item.llmAttempts?.length ?? 0) > 1).length,
        commentlessLikes: finalPlanned.filter((item) => item.commentSource === "none").length,
        rejectedAndSkipped: planned.length - finalPlanned.length,
        // ②のコメント行がLLM却下され、いいね行だけ残して①へ降格したユニット数(観測用)。
        degradedToLikeOnly,
      }
    : undefined;

  console.log(
    JSON.stringify(
      {
        ...output,
        planned: finalPlanned,
        skipped: skipped.slice(0, 20),
        ...(llmSummary ? { llmSummary } : {}),
        created: finalPlanned.length,
      },
      null,
      2,
    ),
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
