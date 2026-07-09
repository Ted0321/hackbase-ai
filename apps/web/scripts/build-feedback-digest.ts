import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { writeFeedbackGuidanceRecord } from "./feedback-store";
import "./load-local-env";

/**
 * FL-1: Feedback Digest（裏方artifact）を生成する。
 *
 * Feedback(human+agent) + Project + Category + Validation を集計し、DOC-25 のスキーマ
 * （positivePatterns / weakPatterns / agentLessons / sourceLessons / nextRunGuidance / avoidNext）
 * で `data/feedback/latest-guidance.json` を出力する。
 *
 * これは UI ページではなく、次の生成（theme選定・concept prompt）へ短い guidance として
 * 注入するための裏方データ。データの正はアプリDB(Prisma)。
 *
 * Usage:
 *   tsx scripts/build-feedback-digest.ts [--days 14 | --all] [--project <projectId>] [--json] [--quiet]
 */

const prisma = createPrismaClient();

const HUMAN_LIKE = new Set(["like", "want_to_grow"]);
const AGENT_RATINGS = new Set([
  "agent_like",
  "agent_critique",
  "agent_remix_suggestion",
  "agent_risk_flag",
  "agent_compare_note",
]);

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const top = <T>(items: T[], n: number) => items.slice(0, n);

const truncate = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max).trim()}...` : value;

async function main() {
  const useAll = hasFlag("--all");
  const days = Number.parseInt(arg("--days") ?? "14", 10);
  const windowDays = Number.isFinite(days) && days > 0 ? days : 14;
  const focusProjectId = arg("--project");
  const asJson = hasFlag("--json");
  const quiet = hasFlag("--quiet");

  const since = useAll ? null : new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [projects, feedbackItems, validations, checks] = await Promise.all([
    prisma.project.findMany({
      include: { agent: true, category: true },
    }),
    prisma.feedback.findMany({
      where: {
        targetType: "project",
        ...(focusProjectId ? { targetId: focusProjectId } : {}),
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.validation.findMany({ orderBy: { checkedAt: "desc" } }),
    prisma.validationCheck.findMany(),
  ]);

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const latestValidationByProject = new Map<string, (typeof validations)[number]>();
  for (const validation of validations) {
    if (!latestValidationByProject.has(validation.projectId)) {
      latestValidationByProject.set(validation.projectId, validation);
    }
  }
  const checksByProject = new Map<string, typeof checks>();
  for (const check of checks) {
    const list = checksByProject.get(check.projectId) ?? [];
    list.push(check);
    checksByProject.set(check.projectId, list);
  }

  // ---- per-project aggregation ----
  type ProjectScore = {
    id: string;
    title: string;
    category: string;
    agentId: string;
    agentName: string;
    likeCount: number;
    commentCount: number;
    reportCount: number;
    agentReactionCount: number;
    comments: string[];
    score: number;
  };
  const scores = new Map<string, ProjectScore>();
  const ensure = (projectId: string): ProjectScore | null => {
    const existing = scores.get(projectId);
    if (existing) return existing;
    const project = projectById.get(projectId);
    if (!project) return null;
    const created: ProjectScore = {
      id: project.id,
      title: project.title,
      category: project.category.name,
      agentId: project.agentId,
      agentName: project.agent.name,
      likeCount: 0,
      commentCount: 0,
      reportCount: 0,
      agentReactionCount: 0,
      comments: [],
      score: 0,
    };
    scores.set(projectId, created);
    return created;
  };

  const totals = {
    feedback: feedbackItems.length,
    like: 0,
    want_to_grow: 0,
    comment: 0,
    report: 0,
    agentReactions: 0,
  };

  for (const item of feedbackItems) {
    const score = ensure(item.targetId);
    if (!score) continue;
    if (HUMAN_LIKE.has(item.rating)) {
      score.likeCount += 1;
      if (item.rating === "like") totals.like += 1;
      if (item.rating === "want_to_grow") totals.want_to_grow += 1;
    }
    if (item.rating === "comment") {
      score.commentCount += 1;
      totals.comment += 1;
    }
    if (["report", "bug_report"].includes(item.rating)) {
      score.reportCount += 1;
      totals.report += 1;
    }
    if (AGENT_RATINGS.has(item.rating)) {
      score.agentReactionCount += 1;
      totals.agentReactions += 1;
    }
    if (item.comment) {
      score.comments.push(truncate(item.comment));
    }
  }
  for (const score of scores.values()) {
    score.score = score.likeCount * 2 + score.commentCount + score.agentReactionCount - score.reportCount * 2;
  }

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);

  // ---- category aggregation ----
  const categoryAgg = new Map<string, { likes: number; comments: number; reports: number; posts: number }>();
  for (const score of scores.values()) {
    const current = categoryAgg.get(score.category) ?? { likes: 0, comments: 0, reports: 0, posts: 0 };
    current.likes += score.likeCount;
    current.comments += score.commentCount;
    current.reports += score.reportCount;
    current.posts += 1;
    categoryAgg.set(score.category, current);
  }
  const categoriesByLikes = [...categoryAgg.entries()].sort((a, b) => b[1].likes - a[1].likes);

  // ---- agent critique focus aggregation (what other AIs flagged) ----
  const agentCritiqueByTargetAgent = new Map<string, { critiques: number; risks: number; remixes: number }>();
  for (const item of feedbackItems) {
    if (!AGENT_RATINGS.has(item.rating)) continue;
    const project = projectById.get(item.targetId);
    if (!project) continue;
    const current = agentCritiqueByTargetAgent.get(project.agentId) ?? {
      critiques: 0,
      risks: 0,
      remixes: 0,
    };
    if (item.rating === "agent_critique") current.critiques += 1;
    if (item.rating === "agent_risk_flag") current.risks += 1;
    if (item.rating === "agent_remix_suggestion") current.remixes += 1;
    agentCritiqueByTargetAgent.set(project.agentId, current);
  }

  // ---- derive structured guidance ----
  const positivePatterns: string[] = [];
  for (const [category, agg] of top(categoriesByLikes, 3)) {
    if (agg.likes > 0) {
      positivePatterns.push(
        `${category} の作品が好評（like ${agg.likes}件 / ${agg.posts}投稿）。同系統の切り口を継続候補にする。`,
      );
    }
  }
  for (const score of top(ranked, 3)) {
    if (score.score > 0) {
      positivePatterns.push(
        `「${score.title}」(${score.category} / ${score.agentName}) が高評価（like ${score.likeCount}, comment ${score.commentCount}, AI反応 ${score.agentReactionCount}）。`,
      );
    }
  }

  const weakPatterns: string[] = [];
  const reported = ranked.filter((score) => score.reportCount > 0);
  for (const score of top(reported, 3)) {
    weakPatterns.push(
      `「${score.title}」(${score.category}) は通報/不具合報告 ${score.reportCount}件。原因を見てから類似生成を避ける。`,
    );
  }
  const lowValidation = projects.filter((project) => {
    const validation = latestValidationByProject.get(project.id);
    return validation && validation.status !== "pass";
  });
  if (lowValidation.length > 0) {
    weakPatterns.push(
      `直近 ${lowValidation.length}件の作品が validation 非pass。生成時にMVP契約（静的データで動く・1操作で表示変化）を厳守する。`,
    );
  }

  const agentLessons: Array<{ agentId: string; lesson: string }> = [];
  for (const [agentId, agg] of agentCritiqueByTargetAgent.entries()) {
    const project = projects.find((item) => item.agentId === agentId);
    const name = project?.agent.name ?? agentId;
    const parts: string[] = [];
    if (agg.critiques > 0) parts.push(`講評 ${agg.critiques}件`);
    if (agg.risks > 0) parts.push(`リスク指摘 ${agg.risks}件`);
    if (agg.remixes > 0) parts.push(`改善案 ${agg.remixes}件`);
    if (parts.length > 0) {
      agentLessons.push({
        agentId,
        lesson: `${name} の作品は他AIから ${parts.join(" / ")} を受けている。次回は指摘点（操作の明確さ・安全・重複回避）を先に潰す。`,
      });
    }
  }

  const sourceLessons: string[] = [];
  // 人気カテゴリ = 採用を増やしたいsource方向の代理シグナル
  if (categoriesByLikes.length > 0 && categoriesByLikes[0][1].likes > 0) {
    sourceLessons.push(
      `反応が集まりやすいのは ${categoriesByLikes[0][0]} 系。signal選定でこの方向の素材を優先候補にする。`,
    );
  }

  const recentComments = feedbackItems
    .filter((item) => item.rating === "comment" && item.comment)
    .slice(0, 5)
    .map((item) => truncate(item.comment ?? ""));

  const nextRunGuidance: string[] = [];
  if (positivePatterns.length > 0) {
    nextRunGuidance.push(
      "好評だった方向（上記 positivePatterns）の切り口を1つ取り入れつつ、直近と同じテンプレ型は避ける。",
    );
  }
  nextRunGuidance.push(
    "各作品は最初の1画面で価値が分かり、1つの主要操作で表示が変わること（first screen value + core interaction）。",
  );
  if (recentComments.length > 0) {
    nextRunGuidance.push(
      `最近のコメントの要望を反映する: ${recentComments.map((comment) => `「${comment}」`).join(" / ")}`,
    );
  }

  const avoidNext: string[] = [];
  for (const score of top(reported, 3)) {
    avoidNext.push(`${score.category} で通報を受けた構成（「${score.title}」型）の再生産を避ける。`);
  }
  if (avoidNext.length === 0) {
    avoidNext.push("クリックしても出力が変わらない静的ダッシュボード型は避ける。");
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    window: useAll ? "all" : `last ${windowDays} days`,
    focusProjectId: focusProjectId ?? null,
    totals,
    positivePatterns,
    weakPatterns,
    agentLessons,
    sourceLessons,
    nextRunGuidance,
    avoidNext,
    topProjects: top(ranked, 5).map((score) => ({
      id: score.id,
      title: score.title,
      category: score.category,
      agentId: score.agentId,
      agentName: score.agentName,
      likeCount: score.likeCount,
      commentCount: score.commentCount,
      agentReactionCount: score.agentReactionCount,
      reportCount: score.reportCount,
      score: score.score,
    })),
    recentComments,
  };

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  }

  const outPath = path.join(process.cwd(), "data", "feedback", "latest-guidance.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  // FS（互換・同一Job内の後続読取用）に加え、DBを正本として永続化（Cloud Run FS揮発対策, B-3）。
  await writeFeedbackGuidanceRecord(prisma, output);

  if (!quiet) {
    console.log(
      `Feedback digest written: ${path.relative(process.cwd(), outPath)} ` +
        `(window=${output.window}, feedback=${totals.feedback}, positive=${positivePatterns.length}, guidance=${nextRunGuidance.length})`,
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
