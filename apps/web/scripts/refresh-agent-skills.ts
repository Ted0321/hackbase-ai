import { createPrismaClient } from "./prisma-client";
import "./load-local-env";
import {
  type ReceivedFeedback,
  agentSkillTableMissing,
  readAllAgentSkills,
  updateSkillFeedback,
} from "./agent-skills";

/**
 * フェーズ3（段階2）: 公開後に集まった反応をスキルへ書き戻し、promotedを判定する。
 *
 * archive-agent-skill.ts はMVP pass直後（公開前＝反応ゼロ）にスキルを作る。本スクリプトは
 * 後から定期実行され、そのスキルに対応する公開プロジェクトのフィードバックをDBから集計して
 * AgentSkill 行へ書き戻す（generate-agent-learnings.ts と同じ「定期DB集計」パターン）。
 *
 * 方針:
 *   - 人のコメントを主、AI講評(agent_critique等)を補助として保存。
 *   - promoted=true は「人の反応（コメント/いいね/want_to_grow）」が付いた時だけ。AI講評は
 *     receivedFeedback に保存するが昇格には効かせない。相互作用運用ではAIコメントがほぼ全作品に
 *     付くため、AIコメントで昇格させると全スキルが promoted 飽和し promoted優先ソートが無意味化する。
 *     閾値は agent-definition-v2 の promotionPolicy.minHumanPositiveSignals と一致させる。
 *   - AIコメントは鵜呑み禁止。保存はするが、注入プロンプト側で「妥当性を吟味して参照」と明示する。
 *
 * Usage: tsx scripts/refresh-agent-skills.ts [--quiet]
 */

const prisma = createPrismaClient();
const hasFlag = (flag: string) => process.argv.includes(flag);

const LIKE_RATINGS = new Set(["like", "want_to_grow", "agent_like"]);
// 昇格の根拠にする「人のいいね」種別（agent_like は含めない）。
const HUMAN_LIKE_RATINGS = new Set(["like", "want_to_grow"]);
// 昇格閾値。agent-definition-v2 の promotionPolicy.minHumanPositiveSignals と一致させること。
const MIN_HUMAN_POSITIVE_SIGNALS = 1;
// スキルに保存するAIコメント種別（実質的な講評・改善提案）。agent_likeは数として別集計。
const AI_COMMENT_RATINGS = new Set(["agent_critique", "agent_risk_flag", "agent_remix_suggestion"]);

const truncate = (value: string, max = 200) =>
  value.length > max ? `${value.slice(0, max).trim()}...` : value;

async function main() {
  const quiet = hasFlag("--quiet");

  if (await agentSkillTableMissing(prisma)) {
    if (!quiet) console.log("[refresh-agent-skills] AgentSkill table missing; nothing to refresh.");
    return;
  }

  const skills = await readAllAgentSkills(prisma);
  if (skills.length === 0) {
    if (!quiet) console.log("[refresh-agent-skills] no skills; nothing to refresh.");
    return;
  }

  // 公開プロジェクトと反応を一括取得（generate-agent-learnings と同じ集計スタイル）。
  const [projects, feedbackItems] = await Promise.all([
    // withdrawn（取り下げ）作品は昇格判定に含めない（agent-memory-digest と基準を揃える）。
    prisma.project.findMany({
      where: { status: { not: "withdrawn" }, publishDecision: { not: "withdrawn" } },
      select: { id: true, runId: true, agentId: true },
    }),
    prisma.feedback.findMany({
      where: { targetType: "project" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const feedbackByProject = new Map<string, typeof feedbackItems>();
  for (const item of feedbackItems) {
    const list = feedbackByProject.get(item.targetId) ?? [];
    list.push(item);
    feedbackByProject.set(item.targetId, list);
  }

  let promotedCount = 0;

  for (const skill of skills) {
    // skill ↔ project の対応付け: runId + agentId 一致（self-directedは通常1run=1project）。
    const matched = projects.filter((p) => p.runId === skill.runId && p.agentId === skill.agentId);
    const fb = matched.flatMap((p) => feedbackByProject.get(p.id) ?? []);

    const likeCount = fb.filter((i) => LIKE_RATINGS.has(i.rating)).length;
    const wantToGrowCount = fb.filter((i) => i.rating === "want_to_grow").length;
    const humanComments = fb
      .filter((i) => i.actorType === "human" && i.rating === "comment" && i.comment)
      .map((i) => ({ text: truncate(i.comment ?? ""), actorName: i.actorName ?? null, rating: i.rating }));
    const aiComments = fb
      .filter((i) => i.actorType === "agent" && AI_COMMENT_RATINGS.has(i.rating) && i.comment)
      .map((i) => ({ text: truncate(i.comment ?? ""), actorName: i.actorName ?? null, rating: i.rating }));

    // 昇格は人の反応のみを条件にする（AIコメントは保存するが昇格には効かせない）。
    const humanLikeCount = fb.filter(
      (i) => i.actorType === "human" && HUMAN_LIKE_RATINGS.has(i.rating),
    ).length;
    const humanPositiveSignals = humanComments.length + humanLikeCount;
    const promoted = humanPositiveSignals >= MIN_HUMAN_POSITIVE_SIGNALS;
    const received: ReceivedFeedback = {
      refreshedAt: new Date().toISOString(),
      likeCount,
      wantToGrowCount,
      humanComments,
      aiComments,
    };

    await updateSkillFeedback(prisma, skill.skillId, promoted, received);
    if (promoted) promotedCount += 1;
  }

  if (!quiet) {
    console.log(
      `[refresh-agent-skills] refreshed ${skills.length} skill(s), ${promotedCount} promoted.`,
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
