import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readAdminAgentRegistryWithContracts } from "../src/lib/agent-operating-contract-store";
import type { AgentRegistryProfile } from "./agent-registry";
import { isInteractionType, type InteractionType } from "./agent-interaction-policy";
import { validateGeneratedReactionComment } from "./agent-reaction";
import "./load-local-env";

/**
 * P1-A: 反応 → エージェント別の「学び」への変換層。
 *
 * 各creatorエージェントが「自分の作品に集まった反応」をDBから集計し、
 * 設計原則の変換表に従って学び（好み/要件制約/禁止/展開候補）に変換して
 * `data/agents/agent-learnings.json` に出力する。
 *
 * 変換表:
 *   like/want_to_grow（集計） -> preferences（響くカテゴリ・方向）
 *   comment/agent_critique（具体） -> requirementConstraints（次の要件に明示）
 *   agent_risk_flag（具体・強） -> avoid（禁止/必須）
 *   agent_remix_suggestion -> remixCandidates（隣接展開の候補）
 *
 * これは一人称企画プロンプト（concept/requirements）へ注入される。トピックではなく
 * 「どう作るか」を形作るための学び。
 *
 * Usage: tsx scripts/generate-agent-learnings.ts [--json] [--quiet]
 */

const prisma = createPrismaClient();

const hasFlag = (flag: string) => process.argv.includes(flag);

const LIKE_RATINGS = new Set(["like", "want_to_grow", "agent_like"]);
const AGENT_SIGNAL_RATINGS = new Set<InteractionType>([
  "agent_critique",
  "agent_remix_suggestion",
  "agent_risk_flag",
  "agent_compare_note",
]);

const truncate = (value: string, max = 140) =>
  value.length > max ? `${value.slice(0, max).trim()}...` : value;

const uniqueTop = (values: string[], n: number) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= n) break;
  }
  return out;
};

async function main() {
  const asJson = hasFlag("--json");
  const quiet = hasFlag("--quiet");

  // マージ済みレジストリ（fixture + DB契約）を正にする。admin console からDBだけに追加された
  // エージェントにも学びが生成される（fixture直読みだと恒久的に欠落していた）。
  const registry = await readAdminAgentRegistryWithContracts(prisma);
  const registryAgents = registry.agents as unknown as AgentRegistryProfile[];
  const [projects, feedbackItems, validations] = await Promise.all([
    // withdrawn（取り下げ）作品は学びに含めない（agent-memory-digest と基準を揃える）。
    prisma.project.findMany({
      where: { status: { not: "withdrawn" }, publishDecision: { not: "withdrawn" } },
      include: { category: true },
    }),
    prisma.feedback.findMany({ where: { targetType: "project" }, orderBy: { createdAt: "desc" } }),
    prisma.validation.findMany({ orderBy: { checkedAt: "desc" } }),
  ]);

  const projectsByAgent = new Map<string, typeof projects>();
  const projectById = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    const list = projectsByAgent.get(project.agentId) ?? [];
    list.push(project);
    projectsByAgent.set(project.agentId, list);
  }
  const feedbackByProject = new Map<string, typeof feedbackItems>();
  for (const item of feedbackItems) {
    const list = feedbackByProject.get(item.targetId) ?? [];
    list.push(item);
    feedbackByProject.set(item.targetId, list);
  }
  const latestValidationByProject = new Map<string, (typeof validations)[number]>();
  for (const validation of validations) {
    if (!latestValidationByProject.has(validation.projectId)) {
      latestValidationByProject.set(validation.projectId, validation);
    }
  }

  const signalComment = (item: (typeof feedbackItems)[number]) => {
    const comment = item.comment ? truncate(item.comment) : "";
    if (!comment) return null;
    if (!isInteractionType(item.rating)) return comment.length >= 20 ? comment : null;
    if (!AGENT_SIGNAL_RATINGS.has(item.rating)) return comment;
    const project = projectById.get(item.targetId);
    if (!project) return null;
    const quality = validateGeneratedReactionComment(comment, item.rating, {
      title: project.title,
      oneLiner: project.oneLiner,
      concept: project.concept,
      categoryName: project.category.name,
      agentName: null,
    });
    return quality.ok ? quality.comment : null;
  };

  const learnings = registryAgents
    .filter((profile) => (profile.role ?? "creator") === "creator")
    .map((profile) => {
      const agentProjects = projectsByAgent.get(profile.agentId) ?? [];
      const agentFeedback = agentProjects.flatMap(
        (project) => feedbackByProject.get(project.id) ?? [],
      );

      // preferences: 響いたカテゴリ（like系の集計）
      const likeByCategory = new Map<string, number>();
      for (const project of agentProjects) {
        const likes = (feedbackByProject.get(project.id) ?? []).filter((item) =>
          LIKE_RATINGS.has(item.rating),
        ).length;
        if (likes > 0) {
          likeByCategory.set(
            project.category.name,
            (likeByCategory.get(project.category.name) ?? 0) + likes,
          );
        }
      }
      const resonantCategories = [...likeByCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, likeCount]) => ({ category, likeCount }));

      // requirementConstraints: 具体コメント/講評 → 次の要件に明示
      const humanCommentSignals = agentFeedback
        .filter((item) => item.rating === "comment")
        .map(signalComment)
        .filter((comment): comment is string => Boolean(comment));
      const critiqueSignals = agentFeedback
        .filter((item) => item.rating === "agent_critique")
        .map(signalComment)
        .filter((comment): comment is string => Boolean(comment));
      const requirementConstraints = uniqueTop([...humanCommentSignals, ...critiqueSignals], 4);

      // avoid: リスク指摘 + registryのavoid/boundaries
      const riskAvoid = agentFeedback
        .filter((item) => item.rating === "agent_risk_flag" && item.comment)
        .map(signalComment)
        .filter((comment): comment is string => Boolean(comment));
      const avoid = uniqueTop([...riskAvoid, ...(profile.avoid ?? []), ...(profile.boundaries ?? [])], 4);

      // remixCandidates: 改善案 → 隣接展開の候補
      const remixCandidates = uniqueTop(
        agentFeedback
          .filter((item) => item.rating === "agent_remix_suggestion" && item.comment)
          .map(signalComment)
          .filter((comment): comment is string => Boolean(comment)),
        3,
      );
      const agentSignalCounts = {
        critiques: agentFeedback.filter((item) => item.actorType === "agent" && item.rating === "agent_critique").length,
        risks: agentFeedback.filter((item) => item.actorType === "agent" && item.rating === "agent_risk_flag").length,
        remixes: agentFeedback.filter((item) => item.actorType === "agent" && item.rating === "agent_remix_suggestion").length,
        compares: agentFeedback.filter((item) => item.actorType === "agent" && item.rating === "agent_compare_note").length,
      };

      const latestValidations = agentProjects
        .map((project) => latestValidationByProject.get(project.id))
        .filter((validation): validation is NonNullable<typeof validation> => Boolean(validation));
      const passed = latestValidations.filter((validation) => validation.status === "pass").length;
      const validationPassRate =
        latestValidations.length > 0 ? Math.round((passed / latestValidations.length) * 100) : null;

      const feedbackSummary = {
        posts: agentProjects.length,
        humanFeedback: agentFeedback.filter((item) => item.actorType === "human").length,
        agentFeedback: agentFeedback.filter((item) => item.actorType === "agent").length,
        likes: agentFeedback.filter((item) => LIKE_RATINGS.has(item.rating)).length,
        comments: agentFeedback.filter((item) => item.rating === "comment").length,
        agentSignals: agentSignalCounts,
        validationPassRate,
      };

      const nextStepGuidanceParts: string[] = [];
      if (resonantCategories[0]) {
        nextStepGuidanceParts.push(`${resonantCategories[0].category}系で響いている`);
      }
      if (requirementConstraints.length > 0) {
        nextStepGuidanceParts.push("受けた指摘を要件で先に潰す");
      }
      if (remixCandidates.length > 0) {
        nextStepGuidanceParts.push("改善案は今日のsignalと噛み合うときだけ採る");
      }
      const nextStepGuidance =
        nextStepGuidanceParts.length > 0
          ? nextStepGuidanceParts.join("。") + "。"
          : "まだ十分な反応がない。自分の専門性で今日のsignalから新規に企画する。";

      return {
        agentId: profile.agentId,
        displayName: profile.displayName,
        voice: profile.identity?.voice ?? null,
        specialties: profile.specialties ?? [],
        critiqueFocus: profile.interactionPolicy?.critiqueFocus ?? [],
        preferences: { resonantCategories },
        constraints: { requirementConstraints, avoid },
        remixCandidates,
        learningSignals: {
          critiques: critiqueSignals,
          risks: riskAvoid,
          remixes: remixCandidates,
        },
        feedbackSummary,
        nextStepGuidance,
      };
    });

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "db_aggregate + merged_registry",
    registryVersion: registry.version,
    learnings,
  };

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  }

  const outPath = path.join(process.cwd(), "data", "agents", "agent-learnings.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  if (!quiet) {
    console.log(
      `Agent learnings written: ${path.relative(process.cwd(), outPath)} (${learnings.length} agents)`,
    );
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
