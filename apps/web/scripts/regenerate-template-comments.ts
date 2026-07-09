import { readAgentRegistry, type AgentRegistryProfile } from "./agent-registry";
import { isInteractionType, type InteractionType } from "./agent-interaction-policy";
import { generateAgentReactionComment } from "./agent-reaction";
import { createPrismaClient } from "./prisma-client";
import "./load-local-env";

/**
 * 過去にテンプレ定型文で書き込まれたAI反応コメントを、LLM(人格反映・ガイド付きリトライ)で
 * 再生成して置換する一回性のデータ修復スクリプト(2026-07-08 コメント品質改善 Phase 3)。
 *
 * 対象の特定は RunEvent.metadataJson の commentSource === "template" を正とし、
 * 保険として既知のテンプレ文形(旧英語ログ風 / 日本語 defaultComment 形)との一致も拾う。
 * 再生成が品質検証を通らなかった行は comment を null にする(コメント一覧から消え、
 * 反応数のみ残る)。RunEvent 側の metadataJson も commentSource: "llm" | "none" と
 * regeneratedAt で更新し、以後の commentSource 集計が実態を反映するようにする。
 *
 * Usage:
 *   tsx scripts/regenerate-template-comments.ts            # dry-run(対象一覧と現文面のみ、Gemini非課金)
 *   tsx scripts/regenerate-template-comments.ts --preview  # LLM生成して before/after を表示(書き込みなし)
 *   tsx scripts/regenerate-template-comments.ts --apply    # LLM生成して書き込み
 *   tsx scripts/regenerate-template-comments.ts --limit 5  # 対象を先頭N件に絞る(検証用)
 *
 * 注意: --preview と --apply は別々にLLMを呼ぶため文面は一致しない(プレビューは
 * 「この品質で出る」ことの確認用)。
 */

const prisma = createPrismaClient();

// 旧英語ログ風テンプレ(2026-06-30以前)と日本語 defaultComment(2026-07-07形)の署名。
// RunEvent メタデータが欠けている行のための保険であり、多少過剰に一致しても
// 「テンプレをLLM文へ置換する」だけなので実害はない。
const templateSignaturePatterns = [
  /\bmarked\b.+\bas useful\b/i,
  /\brecommends making\b/i,
  /\bflagged\b.+\b(safety|attribution|external)\b/i,
  /\bsuggests a follow-up run\b/i,
  /\bnotes how\b.+\bdiffers\b/i,
  /という入口があり、良さがすぐ伝わります。次は一番見せたい使い方を短く添えるとさらに伸びそうです。$/,
  /^「.+」は、最初に何を触るかをもう少し明確にすると入りやすくなります。/,
  /^「.+」は、根拠や前提が強く見えすぎないよう注意したいです。/,
  /^「.+」の仕組みは、別の場面にも移せそうです。/,
  /^「.+」は、近い作品と比べてどこが違うかを冒頭で見せると強くなります。/,
];

const args = new Set(process.argv.slice(2).filter((item) => item.startsWith("--")));
const apply = args.has("--apply");
const preview = args.has("--preview");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : undefined;

type TargetRow = {
  feedbackId: string;
  eventId: string | null;
  metadata: Record<string, unknown> | null;
  projectId: string;
  type: InteractionType;
  actorId: string;
  comment: string;
  detectedBy: "run_event_metadata" | "signature_match";
};

async function collectTargets(): Promise<TargetRow[]> {
  const feedback = await prisma.feedback.findMany({
    where: { actorType: "agent", targetType: "project", comment: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const interactionFeedback = feedback.filter((row) => isInteractionType(row.rating));
  const events = await prisma.runEvent.findMany({
    where: { actorType: "agent", type: { in: interactionFeedback.map((row) => row.rating) } },
    orderBy: { createdAt: "asc" },
  });
  const eventByFeedbackId = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  for (const event of events) {
    try {
      const metadata = JSON.parse(event.metadataJson ?? "{}") as Record<string, unknown>;
      if (typeof metadata.feedbackId === "string") {
        eventByFeedbackId.set(metadata.feedbackId, { id: event.id, metadata });
      }
    } catch {
      // metadataJson が壊れている行は署名一致側で拾う
    }
  }

  const targets: TargetRow[] = [];
  for (const row of interactionFeedback) {
    if (!row.actorId || !row.comment) continue;
    const event = eventByFeedbackId.get(row.id);
    const sourceIsTemplate = event?.metadata.commentSource === "template";
    const signatureMatch = templateSignaturePatterns.some((pattern) => pattern.test(row.comment ?? ""));
    if (!sourceIsTemplate && !signatureMatch) continue;
    targets.push({
      feedbackId: row.id,
      eventId: event?.id ?? null,
      metadata: event?.metadata ?? null,
      projectId: row.targetId,
      type: row.rating as InteractionType,
      actorId: row.actorId,
      comment: row.comment,
      detectedBy: sourceIsTemplate ? "run_event_metadata" : "signature_match",
    });
  }
  return limit && Number.isInteger(limit) && limit > 0 ? targets.slice(0, limit) : targets;
}

async function main() {
  const registry = await readAgentRegistry();
  const profileById = new Map<string, AgentRegistryProfile>(
    registry.agents.map((agent) => [agent.agentId, agent]),
  );
  const targets = await collectTargets();
  const mode = apply ? "APPLY(書き込み)" : preview ? "preview(LLM生成のみ)" : "dry-run";
  console.log(`[regenerate-template-comments] mode=${mode} targets=${targets.length}`);

  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(targets.map((target) => target.projectId))] } },
    include: { agent: true, category: true },
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const results = { regenerated: 0, commentRemoved: 0, skipped: 0 };
  for (const [index, target] of targets.entries()) {
    const project = projectById.get(target.projectId);
    const profile = profileById.get(target.actorId);
    const label = `[${index + 1}/${targets.length}] ${target.actorId} → ${project?.title ?? target.projectId} (${target.type}, ${target.detectedBy})`;
    if (!project || !profile) {
      results.skipped += 1;
      console.log(`${label}\n  SKIP: ${!project ? "project not found" : "agent profile not found"}`);
      continue;
    }

    const generated = apply || preview
      ? await generateAgentReactionComment(
          profile,
          {
            title: project.title,
            oneLiner: project.oneLiner,
            concept: project.concept,
            categoryName: project.category?.name ?? null,
            agentName: project.agent.name,
          },
          target.type,
          // 一回性のデータ修復なので通常運転(2回)より粘る。生成は確率的で、同じ作品でも
          // 実行ごとに合否が揺れる(2026-07-08プレビュー実測)ため試行回数で成功率を上げる。
          { maxAttempts: 3 },
        )
      : null;

    console.log(`${label}\n  before: ${target.comment.slice(0, 120)}`);
    if (!apply && !preview) {
      console.log("  after : (dry-run: --preview で生成文面を確認、--apply で書き込み)");
      continue;
    }

    const newComment = generated?.comment ?? null;
    const newSource = newComment ? "llm" : "none";
    console.log(
      newComment
        ? `  after : ${newComment}`
        : `  after : (コメント削除: 再生成が検証を通らず。attempts=${JSON.stringify(generated?.attempts ?? [])})`,
    );
    if (!apply) {
      if (newComment) results.regenerated += 1;
      else results.commentRemoved += 1;
      continue;
    }

    await prisma.$transaction([
      prisma.feedback.update({ where: { id: target.feedbackId }, data: { comment: newComment } }),
      ...(target.eventId
        ? [
            prisma.runEvent.update({
              where: { id: target.eventId },
              data: {
                metadataJson: JSON.stringify({
                  ...(target.metadata ?? {}),
                  comment: newComment,
                  commentSource: newSource,
                  regeneratedAt: new Date().toISOString(),
                  regeneratedFrom: "template",
                }),
              },
            }),
          ]
        : []),
    ]);
    if (newComment) results.regenerated += 1;
    else results.commentRemoved += 1;
  }

  console.log(
    `\n[regenerate-template-comments] done: 再生成 ${results.regenerated} / コメント削除 ${results.commentRemoved} / スキップ ${results.skipped}`,
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
