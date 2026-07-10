import { createPrismaClient } from "./prisma-client";
import { generateGeminiText } from "./gemini-text";
import { publicProjectWhere } from "../src/lib/project-visibility";
import { readStoredArtifactMetadata, readStoredArtifactPath } from "../src/lib/artifact-store";
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
 * (2026-07-10 使い方タブ再設計 Phase B / 同日v2: UIレイアウト説明を廃しデータフロー構成へ)
 *
 * v2: mvpContract/interactionProofPlan 由来の「画面中央のボタンを押す」型説明をやめ、
 * 実装ソース(sample-input.ts / pipeline.ts / steps/*.ts の実プロンプト / sample-trace.ts の実出力)を
 * ground truth としてプロンプトに注入し、「①インプットの準備 → ②入れ方の注意(実在する場合のみ) →
 * ③AIの処理内容(役割・観点・出力スキーマ) → ④アウトプット(実物例)」のデータフロー手順を生成する。
 * ソースコード自体は一切変更しない(説明をソースから逆算する方針=プランA強化版)。
 * artifactRoot の metadata.json とソース抜粋(FS→GCSフォールバック)を読み、2〜5ステップを生成して
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
  productSummary?: string;
  // materialize が記録した生成ソース一覧。steps/*.ts のファイル名発見に使う。
  sourceFiles?: Array<{ relativePath?: string }>;
};

type SourceExcerpt = { path: string; body: string };

// v2 の ground truth: 入力データ・パイプライン・AIステップの実プロンプト・記録済み実出力。
// core-logic-first 契約(builder.md)の必須固定パスなので全公開作品に存在する。
const SOURCE_INPUT_PATH = "source/data/sample-input.ts";
const SOURCE_PIPELINE_PATH = "source/core/pipeline.ts";
const SOURCE_TRACE_PATH = "source/data/sample-trace.ts";
const SOURCE_STEP_PREFIX = "source/core/steps/";
const SOURCE_STEP_FILE_LIMIT = 3;
const SOURCE_EXCERPT_MAX_CHARS = 2500;

// 実装ソース抜粋を artifact store(FS→GCS)から集める。読めないファイルはスキップして劣化継続。
async function collectSourceExcerpts(
  artifactRoot: string,
  material: MetadataMaterial | null,
): Promise<{ excerpts: SourceExcerpt[]; attempted: number }> {
  const listed = (material?.sourceFiles ?? [])
    .map((file) => file?.relativePath)
    .filter((path): path is string => typeof path === "string");
  const stepPaths = listed
    .filter((path) => path.startsWith(SOURCE_STEP_PREFIX))
    .slice(0, SOURCE_STEP_FILE_LIMIT);
  const paths = [SOURCE_INPUT_PATH, SOURCE_PIPELINE_PATH, ...stepPaths, SOURCE_TRACE_PATH];
  const excerpts: SourceExcerpt[] = [];
  for (const path of paths) {
    const body = await readStoredArtifactPath(`${artifactRoot}/${path}`);
    if (!body) continue;
    excerpts.push({
      path,
      body:
        body.length > SOURCE_EXCERPT_MAX_CHARS
          ? `${body.slice(0, SOURCE_EXCERPT_MAX_CHARS)}\n…(truncated)`
          : body,
    });
  }
  return { excerpts, attempted: paths.length };
}

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

const buildPrompt = (
  row: TargetRow,
  material: MetadataMaterial | null,
  excerpts: SourceExcerpt[],
): string => {
  const payload = {
    title: row.title,
    oneLiner: row.oneLiner,
    shortTagline: row.shortTagline ?? "",
    productSummary: material?.productSummary ?? row.whatWasTried,
    mvpContract: material?.mvpContract ?? { coreInteraction: row.useCase },
    howItRuns: row.howItRuns,
  };
  const sourceSection =
    excerpts.length > 0
      ? excerpts
          .map((excerpt) => [`--- ${excerpt.path} ---`, excerpt.body].join("\n"))
          .join("\n\n")
      : "(ソース抜粋なし。入力1の情報だけで、確実に言える範囲にとどめて書くこと)";
  return [
    "あなたはプロダクト紹介文の編集者です。以下のプロダクト情報と実装ソース抜粋から、詳細ページ「使い方」タブに出す番号付き手順(usageGuide)を日本語で作成してください。",
    "",
    "# 入力1: プロダクトの既存情報",
    JSON.stringify(payload, null, 2),
    "",
    "# 入力2: 実装ソース抜粋(このプロダクトの正となる事実。手順はここに書かれている事実だけで構成すること)",
    sourceSection,
    "",
    "# 作成する usageGuide の仕様",
    `1) steps: ${USAGE_GUIDE_MIN_STEPS}〜${USAGE_GUIDE_MAX_STEPS}件。UI操作の説明ではなく「データの流れ」で構成すること:`,
    "   ① インプットの準備: ユーザーが何のデータ・材料を用意し、どう読み込ませるか(sample-input.ts が根拠。サンプル値を例として出してよい)。",
    "   ② 入れ方の注意点: 何を入れる/入れないか等の具体的な注意。ソース上に実在する制約だけ。無ければこのステップ自体を省略する(捏造は最悪の失敗)。",
    "   ③ AIの処理内容: steps/*.ts のプロンプトにある役割・観点・基準・出力スキーマを事実として書く(例:「安全分析者の役割を与え、資料を横断して危険源と作業前チェック項目を構造化データで抽出させる設計です」)。",
    "   ④ アウトプット: 画面に出てくる具体的な情報。sample-trace.ts の実物例をちょうど1つ引用する(例:「高圧ガス配管(A-17)」)。",
    `   - 各 action: その段階の見出し1文(${USAGE_ACTION_MAX_CHARS - 10}字以内、句点なし)。例:「設備IDを起点に資料を集める」。`,
    `   - 各 result: 2〜3文・合計${USAGE_RESULT_MAX_CHARS - 20}字以内。「何が起きるか / どういう観点・基準か / サンプルでの実例」の型で書く。`,
    "2) checkPoint: 1〜2文。何を見ればこの作品の核心価値を判断できるか。「デモは記録済みトレースの再生です。」という境界の明示を、checkPoint か最終ステップに必ず1回だけ入れる。",
    "3) intro(任意): どんな場面で使うプロダクトかの導入1文。不要なら省略してよい。",
    "",
    "# 禁止事項",
    "- 画面レイアウト語彙(「画面中央」「右側」「上部」「〜エリアの位置」など)。ボタン名・パネル名をラベルで呼ぶのは可。",
    "- デモがライブでAI実行しているかのような主張。AIの処理は「〜する設計です」と書く。",
    "- ソース抜粋に無い事実・操作・制約の発明。実例は sample-trace.ts にある実物のみ。",
    "- shortTagline / productSummary と同じ文の再掲、ステップ間の文重複。",
    "- 文字化け片(繧/縺/髢 等)、内部識別子、ファイルパス(「sample-trace.ts」等)を本文に露出させること。",
    "",
    "# 出力形式",
    "- 出力は JSON のみ。前後に説明文やコードフェンスを付けない。",
    '- 形式: {"intro"?: string, "steps": [{"action": string, "result": string}], "checkPoint"?: string}',
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
  let sourceMisses = 0;
  for (const row of targets) {
    try {
      // 生成時の contract(metadata.json)と実装ソース抜粋を artifact store から読む。
      // FS→GCS フォールバック。読めなければ DB のコピー欄のみで劣化継続する。
      const metadata = (await readStoredArtifactMetadata(row.artifactRoot)) as MetadataMaterial | null;
      if (metadata) metadataHits += 1;
      const { excerpts, attempted } = await collectSourceExcerpts(row.artifactRoot, metadata);
      if (excerpts.length === 0) sourceMisses += 1;
      const guide = parseGeneratedGuide(
        await generateGeminiText(buildPrompt(row, metadata, excerpts), { temperature: 0.6 }),
      );
      console.log(
        `- ${row.title} (${row.id}) metadata=${metadata ? "hit" : "miss"} sources=${excerpts.length}/${attempted}`,
      );
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
      ` ソース全滅行=${sourceMisses}` +
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
