import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFeedbackGuidance } from "./feedback-guidance";
import "./load-local-env";

/**
 * FL-4: feedback → signal 変換。
 *
 * Feedback Digest（latest-guidance.json）の topProjects を `sourceType:"internal_feedback"` の
 * signal へ変換し、`data/feedback/feedback-signals.json` に SignalFile 形式で書き出す。
 *
 * これを `plan-from-signals.ts --input data/feedback/feedback-signals.json` に渡すと、
 * 既存フック（`signal.sourceType === "internal_feedback"` の fit boost）に実データが流れ、
 * 「反応が集まった方向」が次のテーマ候補に反映される。改善ループの signal 側の接続点。
 *
 * Usage:
 *   tsx scripts/build-feedback-digest.ts --all        # 先に digest を更新
 *   tsx scripts/materialize-feedback-signals.ts [--limit 5] [--dry-run]
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "feedback";

async function main() {
  const dryRun = hasFlag("--dry-run");
  const limit = Number.parseInt(arg("--limit") ?? "5", 10);
  const max = Number.isFinite(limit) && limit > 0 ? limit : 5;

  const guidance = await readFeedbackGuidance();
  if (!guidance) {
    console.error(
      "latest-guidance.json が見つかりません。先に `npm run feedback:digest:all` を実行してください。",
    );
    process.exit(1);
    return;
  }

  const observedAt = guidance.generatedAt;
  const signals = guidance.topProjects
    .filter((project) => project.score > 0)
    .slice(0, max)
    .map((project) => ({
      id: `internal_feedback_${project.id}`,
      sourceType: "internal_feedback",
      sourceName: "Hackbase.ai internal feedback",
      title: project.title,
      summary: `${project.category} の作品。like ${project.likeCount} / comment ${project.commentCount} / AI反応 ${project.agentReactionCount}（反応スコア ${project.score}）。`,
      url: null,
      observedAt,
      topics: [slugify(project.category), "feedback", "workflow"],
      audience: ["operators", "builders"],
      metrics: {
        likeCount: project.likeCount,
        commentCount: project.commentCount,
        agentReactionCount: project.agentReactionCount,
        reportCount: project.reportCount,
        score: project.score,
      },
      whyItMatters: `実際の反応が集まった方向。次のテーマ候補で ${project.category} 系の切り口を優先する根拠になる。`,
      prototypeHint: `好評だった「${project.title}」の操作・切り口を別テーマへ展開する。`,
      riskNotes: "一時的な好みに引っ張られないよう、複数作品の傾向と合わせて判断する。",
      rawExcerpt: guidance.recentComments[0] ?? undefined,
    }));

  const file = {
    version: "1",
    generatedAt: guidance.generatedAt,
    source: "feedback_digest",
    signals,
  };

  if (signals.length === 0) {
    console.log("反応スコアが正の作品がないため、feedback signalは生成されませんでした。");
  }

  if (dryRun) {
    console.log(JSON.stringify(file, null, 2));
    console.log(`\n[dry-run] ${signals.length}件のfeedback signalを生成（書き込みなし）。`);
    return;
  }

  const outPath = path.join(process.cwd(), "data", "feedback", "feedback-signals.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");
  console.log(
    `Feedback signals written: ${path.relative(process.cwd(), outPath)} (${signals.length} signals)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
