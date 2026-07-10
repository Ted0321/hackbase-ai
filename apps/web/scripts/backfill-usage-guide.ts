import { createPrismaClient } from "./prisma-client";
import { generateGeminiText } from "./gemini-text";
import { publicProjectWhere } from "../src/lib/project-visibility";
import { readStoredArtifactMetadata } from "../src/lib/artifact-store";
import {
  normalizeUsageGuide,
  serializeUsageGuide,
  USAGE_ACTION_MAX_CHARS,
  USAGE_GUIDE_MAX_STEPS,
  USAGE_GUIDE_MIN_STEPS,
  USAGE_RESULT_MAX_CHARS,
  type UsageGuide,
} from "../src/lib/usage-guide";
import "./load-local-env";

/**
 * 公開済みプロダクトの usageGuide(使い方タブの番号付き手順)を生成するバックフィルスクリプト。
 * (2026-07-10 使い方タブ再設計 Phase B: builder が新規生成分に usageGuide を第一級で出すのに合わせ、
 *  既公開作品にも同品質の手順を Gemini で補充する)
 *
 * 背景: 旧・使い方タブは全作品共通のハードコード見出しに別用途コピーを流用しており、
 * 同一文の重複と「何を操作すればいいか分からない」問題があった。Phase A で表示側は
 * howItRuns からの決定論導出に置き換え済みだが、operation の解像度(実UI要素名・確認ポイント)は
 * 生成時の mvpContract / interactionProofPlan を使った LLM 生成が最も高い。
 * artifactRoot の metadata.json(FS→GCSフォールバック)から素材を読み、2〜4ステップを生成して
 * Project.usageGuide(JSON文字列)へ保存する。表示はDB値優先→導出→モックの順にフォールバックする。
 *
 * 対象: publicProjectWhere(auto_published / published かつ withdrawn でない)= 公開フィード掲載作品。
 *
 * Usage:
 *   tsx scripts/backfill-usage-guide.ts                 # dry-run(対象一覧と現在値のみ、Gemini非課金)
 *   tsx scripts/backfill-usage-guide.ts --preview       # Gemini生成して before/after を表示(書き込みなし)
 *   tsx scripts/backfill-usage-guide.ts --apply         # Gemini生成して書き込み
 *   tsx scripts/backfill-usage-guide.ts --id <projectId> --apply   # 単一プロダクトのみ(先行検証用)
 *   tsx scripts/backfill-usage-guide.ts --limit 5       # 対象を先頭N件に絞る(検証用)
 *   tsx scripts/backfill-usage-guide.ts --only-missing --apply     # usageGuide 未設定の行だけ(再実行の冪等化)
 *
 * 注意:
 * - 本番 Cloud SQL に対して実行する場合は既存の prod DB 接続手順(postgres provider generate + DATABASE_URL)に従い、
 *   PRODIA_USAGE_LANE=manual と ARTIFACT_BUCKET(GCSのmetadata.json読み取りに必須)を設定すること。
 * - usageGuide は新規カラム。--apply 前に schema を本番へ反映(db:push)済みであること。
 * - metadata.json が読めない行は DB のコピー欄のみで生成を続行する(ログに metadata=miss と出る。
 *   全行 miss の場合は ARTIFACT_BUCKET 未設定を疑うこと)。
 */

const prisma = createPrismaClient();

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((item) => item.startsWith("--")));
const apply = flags.has("--apply");
const preview = flags.has("--preview");
const onlyMissing = flags.has("--only-missing");
const valueAfter = (name: string): string | undefined => {
  const index = rawArgs.indexOf(name);
  return index >= 0 ? rawArgs[index + 1] : undefined;
};
const targetId = valueAfter("--id");
const limitRaw = valueAfter("--limit");
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

type TargetRow = {
  id: string;
  title: string;
  oneLiner: string;
  shortTagline: string | null;
  useCase: string;
  whatWasTried: string;
  howItRuns: string;
  usageGuide: string | null;
  artifactRoot: string;
};

// metadata.json から使う素材だけを構造的に拾う(型はローカル最小限)。
type MetadataMaterial = {
  mvpContract?: {
    firstScreenValue?: string;
    coreInteraction?: string;
    stateChange?: string;
    inspectableOutput?: string;
  };
  interactionProofPlan?: {
    primaryAction?: string;
    initialState?: string;
    expectedState?: string;
    visibleEvidence?: string[];
  };
  productSummary?: string;
};

const truncate = (value: string, max = 90): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

async function collectTargets(): Promise<TargetRow[]> {
  const projects = await prisma.project.findMany({
    where: {
      ...publicProjectWhere,
      ...(targetId ? { id: targetId } : {}),
      ...(onlyMissing ? { usageGuide: null } : {}),
    },
    orderBy: { publishedAt: "asc" },
    select: {
      id: true,
      title: true,
      oneLiner: true,
      shortTagline: true,
      useCase: true,
      whatWasTried: true,
      howItRuns: true,
      usageGuide: true,
      artifactRoot: true,
    },
  });
  const limited = typeof limit === "number" && limit > 0 ? projects.slice(0, limit) : projects;
  return limited;
}

const buildPrompt = (row: TargetRow, material: MetadataMaterial | null): string => {
  const payload = {
    title: row.title,
    oneLiner: row.oneLiner,
    shortTagline: row.shortTagline ?? "",
    productSummary: material?.productSummary ?? row.whatWasTried,
    // 生成時の対話契約(最重要素材): 何を押すと何が変わり、どこで確認するか。
    mvpContract: material?.mvpContract ?? { coreInteraction: row.useCase },
    interactionProofPlan: material?.interactionProofPlan ?? null,
    howItRuns: row.howItRuns,
  };
  return [
    "あなたはプロダクト紹介文の編集者です。以下のプロダクト情報から、詳細ページ「使い方」タブに出す番号付き手順(usageGuide)を日本語で作成してください。",
    "",
    "# 入力(このプロダクトの既存情報)",
    JSON.stringify(payload, null, 2),
    "",
    "# 作成する usageGuide の仕様",
    `1) steps: ${USAGE_GUIDE_MIN_STEPS}〜${USAGE_GUIDE_MAX_STEPS}件の手順。デモの実際の流れ(最初の画面 → 主操作 → 結果の読み方)に沿うこと。`,
    `   - 各 action: ユーザーが行う操作を命令形の日本語1文で(目安${USAGE_ACTION_MAX_CHARS - 10}字以内)。`,
    "     interactionProofPlan.primaryAction や mvpContract.coreInteraction にある実際のボタン名・UI要素名をそのまま使ってよい。",
    "     「入力と目的を確認する」のような曖昧な見出しは禁止。step 1 は最初の画面でそのまま実行できる操作にすること。",
    `   - 各 result: その操作で画面に起きることを1文で(目安${USAGE_RESULT_MAX_CHARS - 20}字以内)。mvpContract.stateChange が最良の素材。`,
    "2) checkPoint: 画面のどこを見ればこの作品の核心価値を判断できるかを1文で。mvpContract.inspectableOutput が最良の素材。",
    "3) intro(任意): どんな場面で使うプロダクトかの導入1文。不要なら省略してよい。",
    "",
    "# 制約",
    "- 出力は JSON のみ。前後に説明文やコードフェンスを付けない。",
    '- 形式: {"intro"?: string, "steps": [{"action": string, "result": string}], "checkPoint"?: string}',
    "- shortTagline / productSummary と同じ文を再掲しない。ステップ間で文を重複させない。",
    "- 読みやすい自然な日本語。文字化け片(繧/縺/髢 等)や内部識別子・ファイルパスを含めない。",
    "- デモに存在しない操作(ログイン、ファイルアップロード等)を発明しない。入力情報にある操作だけを使う。",
  ].join("\n");
};

const parseGeneratedGuide = (text: string): UsageGuide => {
  // コードフェンスや前後テキストが混ざっても最初の JSON オブジェクトを拾う。
  const fenced = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Gemini応答からJSONを抽出できませんでした: ${truncate(text, 200)}`);
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
  // 生成値は決定論正規化を通す(重複文除去/2〜4件/文長上限。builder経路と同一契約)。
  const guide = normalizeUsageGuide(parsed);
  if (!guide) {
    throw new Error(`生成結果が正規化で棄却されました(使えるステップ2件未満): ${truncate(JSON.stringify(parsed), 200)}`);
  }
  return guide;
};

const formatGuide = (guide: UsageGuide): string[] => {
  const lines: string[] = [];
  if (guide.intro) lines.push(`      intro: ${guide.intro}`);
  guide.steps.forEach((step, index) => {
    lines.push(`      ${index + 1}. ${step.action} → ${truncate(step.result)}`);
  });
  if (guide.checkPoint) lines.push(`      確認ポイント: ${guide.checkPoint}`);
  return lines;
};

async function main() {
  const mode = apply ? "APPLY(書き込み)" : preview ? "PREVIEW(生成のみ)" : "DRY-RUN(一覧のみ)";
  const targets = await collectTargets();
  console.log(`[backfill-usage-guide] mode=${mode} 対象=${targets.length}件` +
    `${targetId ? ` id=${targetId}` : ""}${onlyMissing ? " only-missing" : ""}`);
  console.log("");

  if (!apply && !preview) {
    // Gemini を呼ばずに現状を一覧表示するだけ。
    for (const row of targets) {
      console.log(`- ${row.title} (${row.id})`);
      console.log(`    usageGuide(現) : ${row.usageGuide ? truncate(row.usageGuide) : "(未設定)"}`);
      console.log(`    howItRuns(現)  : ${truncate(row.howItRuns)}`);
    }
    console.log("");
    console.log("Geminiを呼んで生成を確認するには --preview、書き込むには --apply を付けてください。");
    return;
  }

  let ok = 0;
  let failed = 0;
  let metadataHits = 0;
  for (const row of targets) {
    try {
      // 生成時の対話契約(mvpContract/interactionProofPlan)を artifact store から読む。
      // FS→GCS フォールバック。読めなければ DB のコピー欄のみで劣化継続する。
      const metadata = (await readStoredArtifactMetadata(row.artifactRoot)) as MetadataMaterial | null;
      if (metadata) metadataHits += 1;
      const guide = parseGeneratedGuide(
        await generateGeminiText(buildPrompt(row, metadata), { temperature: 0.6 }),
      );
      console.log(`- ${row.title} (${row.id}) metadata=${metadata ? "hit" : "miss"}`);
      console.log(`    usageGuide(現) : ${row.usageGuide ? truncate(row.usageGuide) : "(未設定)"}`);
      console.log("    生成結果:");
      for (const line of formatGuide(guide)) console.log(line);
      if (apply) {
        await prisma.project.update({
          where: { id: row.id },
          data: { usageGuide: serializeUsageGuide(guide) },
        });
        console.log("    => 書き込み完了");
      }
      ok += 1;
    } catch (error) {
      failed += 1;
      console.error(`    !! 生成/更新に失敗: ${row.title} (${row.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("");
  console.log(
    `[backfill-usage-guide] 完了: 成功=${ok} 失敗=${failed} metadata取得=${metadataHits}/${targets.length}` +
      `${apply ? "" : " (PREVIEW: 書き込みなし)"}`,
  );
  if (metadataHits === 0 && targets.length > 0) {
    console.warn("!! 全行で metadata.json が読めていません。ARTIFACT_BUCKET の設定を確認してください。");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
