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
import { generateAgentReactionComment, type ReactionAgentProfile } from "./agent-reaction";
import { projectPreferenceSignals, rankByTargetPreference } from "./target-preference";
import { rankProjectsByEngagement } from "./interaction-target-ranking";
import {
  buildRowTargetSelection,
  chooseTargetProjectWithLlm,
  filterPlannableTargets,
  llmSelectCandidateLimit,
  llmSelectTimeoutMs,
  type LlmTargetCandidate,
  type RowTargetSelection,
  type TargetSelectionMeta,
} from "./interaction-target-llm";
import "./load-local-env";

type ProjectSelection =
  | "under-interacted"
  | "engagement-weighted"
  | "llm-selected"
  | "latest"
  | "featured"
  | string;

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
  // llm-selected時のみ: 対象選定の注釈(採用一致行にはLLMの選定理由が載る)。
  targetSelection?: RowTargetSelection;
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

type TargetSelectionOptions = {
  affinityPreferences?: string[];
  // llm-selected用: 単一acting agent指定時のみLLM選定を行う(候補フィルタとペルソナ注入に使う)。
  actingProfile?: AgentRegistryProfile;
  unitPattern?: UnitPattern;
};

type TargetSelectionOutcome = {
  projects: ProjectWithAgent[];
  // llm-selected時のみ: 選定結果(採用注釈は planned 行確定後に buildRowTargetSelection で付ける)。
  selectionMeta?: TargetSelectionMeta;
};

// engagement-weighted / llm-selected が共有する候補プール(直近60公開作品＋エージェント反応)。
// reactionsByProject は llm-selected の plannable フィルタ用(select列が増えるだけで集計は従来同一)。
async function loadEngagementCandidatePool() {
  const projects = await prisma.project.findMany({
    where: publicInteractionTargetWhere,
    include: { agent: true, category: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const projectIds = projects.map((project) => project.id);
  const feedback = await prisma.feedback.findMany({
    where: {
      targetType: "project",
      targetId: { in: projectIds },
      actorType: "agent",
    },
    select: { targetId: true, actorId: true, rating: true, createdAt: true },
  });
  const counts = new Map<string, number>();
  const reactionsByProject = new Map<string, ExistingAgentInteraction[]>();
  for (const item of feedback) {
    counts.set(item.targetId, (counts.get(item.targetId) ?? 0) + 1);
    const list = reactionsByProject.get(item.targetId) ?? [];
    list.push({ actorId: item.actorId, rating: item.rating, createdAt: item.createdAt });
    reactionsByProject.set(item.targetId, list);
  }
  return { projects, counts, reactionsByProject };
}

function rankPoolByEngagement(
  pool: Awaited<ReturnType<typeof loadEngagementCandidatePool>>,
  affinityPreferences?: string[],
) {
  return rankProjectsByEngagement({
    candidates: pool.projects.map((project) => ({
      project,
      createdAt: project.createdAt,
      agentReactionCount: pool.counts.get(project.id) ?? 0,
      preferenceSignals: projectPreferenceSignals(project),
    })),
    preferences: affinityPreferences,
  });
}

async function selectTargetProjects(
  selection: ProjectSelection,
  options?: TargetSelectionOptions,
): Promise<TargetSelectionOutcome> {
  if (selection === "latest") {
    const project = await prisma.project.findFirst({
      where: publicInteractionTargetWhere,
      include: { agent: true },
      orderBy: { createdAt: "desc" },
    });
    return { projects: project ? [project] : [] };
  }

  if (selection === "featured") {
    return {
      projects: await prisma.project.findMany({
        where: { ...publicInteractionTargetWhere, featured: true },
        include: { agent: true },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    };
  }

  // engagement-weighted(2026-07-11、スケジューラ既定): 人気×新着×ペルソナ親和の重み付き抽選。
  // under-interacted の均等化(反応ゼロ作品優先)を置き換える。候補は直近60公開作品。
  if (selection === "engagement-weighted") {
    const pool = await loadEngagementCandidatePool();
    return { projects: rankPoolByEngagement(pool, options?.affinityPreferences) };
  }

  // llm-selected(2026-07-11、envオプトイン): engagement-weightedの抽選順上位から
  // plannableな候補を絞り、acting agentのペルソナLLMが理由付きで1作品を選ぶ。
  // 選ばれた作品を先頭へ置くだけで残りは抽選順のまま=LLMがどう失敗しても
  // engagement-weightedと完全に同じ挙動へフォールバックする(ユニット実行は失敗させない)。
  if (selection === "llm-selected") {
    const pool = await loadEngagementCandidatePool();
    const ranked = rankPoolByEngagement(pool, options?.affinityPreferences);
    try {
      const actingProfile = options?.actingProfile;
      if (!actingProfile) {
        return {
          projects: ranked,
          selectionMeta: { mode: "llm-selected", candidateCount: 0, fallbackReason: "no_acting_agent" },
        };
      }
      const plannable = filterPlannableTargets({
        rankedProjects: ranked,
        actingAgentId: actingProfile.agentId,
        unitPattern: options?.unitPattern,
        reactionsByProject: pool.reactionsByProject,
      });
      const shortlist = plannable.slice(0, llmSelectCandidateLimit());
      if (shortlist.length === 0) {
        return {
          projects: ranked,
          selectionMeta: { mode: "llm-selected", candidateCount: 0, fallbackReason: "no_candidates" },
        };
      }
      const candidates: LlmTargetCandidate[] = shortlist.map((project) => ({
        projectId: project.id,
        title: project.title,
        oneLiner: project.oneLiner,
        categoryName: project.category?.name ?? project.categoryId,
        creatorName: project.agent?.name ?? null,
        agentReactionCount: pool.counts.get(project.id) ?? 0,
        createdAt: project.createdAt,
      }));
      const result = await chooseTargetProjectWithLlm({
        profile: actingProfile as unknown as ReactionAgentProfile,
        candidates,
        unitPattern: options?.unitPattern,
        timeoutMs: llmSelectTimeoutMs(),
      });
      const selectionMeta: TargetSelectionMeta = {
        mode: "llm-selected",
        candidateCount: candidates.length,
        ...(result.ok
          ? { llmChoice: { ...result.choice, model: result.model } }
          : { fallbackReason: result.fallbackReason }),
      };
      if (!result.ok) {
        console.warn(
          `[llm-selected] fallback to engagement order: ${result.fallbackReason}${result.detail ? ` (${result.detail})` : ""}`,
        );
        return { projects: ranked, selectionMeta };
      }
      const chosenIndex = ranked.findIndex((project) => project.id === result.choice.projectId);
      const projects =
        chosenIndex <= 0
          ? ranked
          : [ranked[chosenIndex], ...ranked.slice(0, chosenIndex), ...ranked.slice(chosenIndex + 1)];
      return { projects, selectionMeta };
    } catch (error) {
      // 二重防御: 分岐内のどんな想定外例外でも抽選順のまま続行する(既存挙動を壊さない)。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[llm-selected] unexpected error, fallback to engagement order: ${message}`);
      return {
        projects: ranked,
        selectionMeta: { mode: "llm-selected", candidateCount: 0, fallbackReason: "generation_error" },
      };
    }
  }

  if (selection !== "under-interacted") {
    const project = await prisma.project.findFirst({
      where: { ...publicInteractionTargetWhere, id: selection },
      include: { agent: true },
    });
    return { projects: project ? [project] : [] };
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

  return {
    projects: projects.sort((left, right) => {
      const diff = (counts.get(left.id) ?? 0) - (counts.get(right.id) ?? 0);
      return diff !== 0 ? diff : right.createdAt.getTime() - left.createdAt.getTime();
    }),
  };
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

  const actingProfile = args.agentId
    ? agents.find((agent) => agent.agentId === args.agentId)
    : undefined;
  const { projects: selectedProjects, selectionMeta } = await selectTargetProjects(args.project, {
    affinityPreferences: actingProfile?.interactionPolicy?.targetPreference,
    actingProfile,
    unitPattern: args.unit,
  });

  // 単一 acting agent 指定時は、その agent の interactionPolicy.targetPreference で
  // 候補プロジェクトを再ランクする（一致が多いものを先頭へ）。複数 agent の一括バッチでは
  // 共有順を変えない＝既存の dry-run 出力・dedup・レート制限を保つ。
  // engagement-weighted は親和を重み内で織り込み済み、llm-selected はLLMが置いた先頭を
  // 尊重する必要があるため、どちらも再ランクしない(ハード再ソートすると選定が上書きされる)。
  const projects =
    actingProfile && args.project !== "engagement-weighted" && args.project !== "llm-selected"
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

  // llm-selected時のみ: 各行に選定注釈を付ける。LLMの選択と一致した行にだけ理由が載り、
  // plannerがフォールバックで別作品を採った行は llm_choice_not_adopted になる。
  if (selectionMeta) {
    for (const row of planned) {
      row.targetSelection = buildRowTargetSelection(selectionMeta, row.projectId);
    }
  }

  const output = {
    dryRun: args.dryRun,
    batchId,
    selector: args.project,
    unit: args.unit,
    force: args.force,
    limit: args.limit,
    // llm-selected時のみ: 選定結果(dry-run/本実行のstdout=Cloud Loggingで観察できる)。
    ...(selectionMeta ? { targetSelection: selectionMeta } : {}),
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
            // llm-selected時のみ(既定のengagement-weightedではキー自体を書かない=従来と同一)。
            ...(interaction.targetSelection ? { targetSelection: interaction.targetSelection } : {}),
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
