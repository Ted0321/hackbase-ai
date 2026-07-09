import { createPrismaClient } from "./prisma-client";
import { generateGeminiText } from "./gemini-text";
import { isProductCategoryId, PRODUCT_CATEGORIES } from "./product-categories";
import { normalizeShortTagline } from "./product-copy";
import { publicProjectWhere } from "../src/lib/project-visibility";
import "./load-local-env";

/**
 * 公開済みプロダクトのコピー(shortTagline / 説明)を再生成するバックフィルスクリプト。
 * (2026-07-09 UI調整: プロダクト名直下=超短い役割タグ / タブ上ボックス=2〜3文説明 / 何が面白いか=新規性)
 * (2026-07-10 再定義: shortTagline を「6〜16字の役割タグ」から「12〜28字の一文キャッチコピー」へ変更。
 *  旧定義で生成済みのタグは単語羅列になりがちで品質不良のため、全件 --apply での再生成を想定)
 *
 * 背景: 従来パイプラインは concept と whatWasTried をどちらも同一の新規性テキスト
 * (interestingness)から作っていたため、詳細ページの「説明ボックス」と「何が面白いか」が
 * ほぼ重複していた。新パイプラインでは shortTagline / productSummary / interestingness の
 * 3スロットに役割分離済み。Gemini で {shortTagline, productSummary, categoryId} を1回で生成して
 * shortTagline と whatWasTried(=説明)を埋め直す。concept(新規性)は温存する。
 *
 * categoryId 再分類(2026-07-10 追加): 旧 publish がカテゴリーを cat_operations に固定していたため、
 * 公開済み全作品が「運用支援」に偏っている。同じ Gemini 呼び出しで 11 カテゴリーから再分類する。
 * 生成された categoryId が不正な場合はカテゴリーのみ据え置き(コピーは更新する部分成功)。
 *
 * 対象: publicProjectWhere(auto_published / published かつ withdrawn でない)= 公開フィード掲載作品。
 *
 * Usage:
 *   tsx scripts/backfill-product-copy.ts                 # dry-run(対象一覧と現在値のみ、Gemini非課金)
 *   tsx scripts/backfill-product-copy.ts --preview       # Gemini生成して before/after を表示(書き込みなし)
 *   tsx scripts/backfill-product-copy.ts --apply         # Gemini生成して書き込み
 *   tsx scripts/backfill-product-copy.ts --id <projectId> --apply   # 単一プロダクトのみ(ScoreSense先行検証など)
 *   tsx scripts/backfill-product-copy.ts --limit 5       # 対象を先頭N件に絞る(検証用)
 *   tsx scripts/backfill-product-copy.ts --only-missing --apply     # shortTagline 未設定の行だけ(再実行の冪等化)
 *
 * 注意:
 * - 本番 Cloud SQL に対して実行する場合は既存の prod DB 接続手順(postgres provider generate + DATABASE_URL)に従う。
 * - --preview と --apply は別々に Gemini を呼ぶため文面は一致しない(preview は品質確認用)。
 * - shortTagline は新規カラム。--apply 前に schema を本番へ反映(db:push)済みであること。
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
  concept: string | null;
  useCase: string;
  shortTagline: string | null;
  whatWasTried: string;
  categoryId: string;
};

type GeneratedCopy = {
  shortTagline: string;
  productSummary: string;
  // 不正な id が生成された場合は null(カテゴリーのみ据え置きの部分成功)。
  categoryId: string | null;
};

const truncate = (value: string, max = 90): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

async function collectTargets(): Promise<TargetRow[]> {
  const projects = await prisma.project.findMany({
    where: {
      ...publicProjectWhere,
      ...(targetId ? { id: targetId } : {}),
      ...(onlyMissing ? { shortTagline: null } : {}),
    },
    orderBy: { publishedAt: "asc" },
    select: {
      id: true,
      title: true,
      oneLiner: true,
      concept: true,
      useCase: true,
      shortTagline: true,
      whatWasTried: true,
      categoryId: true,
    },
  });
  const limited = typeof limit === "number" && limit > 0 ? projects.slice(0, limit) : projects;
  return limited;
}

const buildPrompt = (row: TargetRow): string => {
  const payload = {
    title: row.title,
    oneLiner: row.oneLiner,
    concept: row.concept ?? "",
    useCase: row.useCase,
  };
  const categoryCatalog = PRODUCT_CATEGORIES.map(
    (category) => `   - ${category.id} (${category.jaLabel}): ${category.pickWhen}`,
  );
  return [
    "あなたはプロダクト紹介文の編集者です。以下のプロダクト情報から、公開ページ用の2つのコピーと1つの分類を日本語で作成してください。",
    "",
    "# 入力(このプロダクトの既存情報)",
    JSON.stringify(payload, null, 2),
    "",
    "# 生成する2つのコピー(役割を厳密に分離すること)",
    "1) shortTagline: プロダクト名の直下(トップページのフィードカードと詳細ページ)に出す『一文キャッチコピー』。",
    "   Product Huntのtaglineのように、初見の人がこの一行だけで何のプロダクトか分かること。",
    "   日本語で目安12〜28文字(上限40文字)。『何を』＋『どうする/どうなる』を助詞でつないだ読める句にする。",
    "   良い例:「長い議事録を3行の決定メモに変える」「楽譜の弾きにくさをAIが採点して教える」「配色の迷いをワンクリックで解消する」。",
    "   禁止: 単語の羅列や名詞断片(「ネットフロー」「AI」のような一言)、句点(。)で終わること、引用符や鉤括弧で囲むこと、カテゴリ名の丸写し。",
    "2) productSummary: タブ上のボックスに出す『2〜3文のプロダクト説明』。",
    "   何をするものか(入力→ユーザーの操作→得られる結果)を端的な事実説明として2〜3文で書く。",
    "   新規性・差別化の主張はここに書かない(それは別欄 concept が担う)。concept と同じ文を繰り返さない。",
    "",
    "# 生成する1つの分類",
    "3) categoryId: 以下のカタログからちょうど1つ選ぶ。ユーザーが得る主価値で判断すること。",
    "   管理画面風のUIかどうか・内部の仕組みではなく『使う人が何を得るか』で選ぶ。",
    "   これまで cat_operations(運用支援)に偏って付与されてきた経緯があるため、運用作業そのものが",
    "   製品の本質でない限り cat_operations を選ばないこと。",
    ...categoryCatalog,
    "",
    "# 制約",
    "- 出力は JSON のみ。前後に説明文やコードフェンスを付けない。",
    "- 形式: {\"shortTagline\": string, \"productSummary\": string, \"categoryId\": string}",
    "- 読みやすい自然な日本語。文字化け片(繧/縺/髢 等)や内部識別子を含めない。",
  ].join("\n");
};

const parseGeneratedCopy = (text: string): GeneratedCopy => {
  // コードフェンスや前後テキストが混ざっても最初の JSON オブジェクトを拾う。
  const fenced = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Gemini応答からJSONを抽出できませんでした: ${truncate(text, 200)}`);
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as Partial<GeneratedCopy>;
  // 生成タグは決定論正規化を通す(囲み記号除去/第1文抽出/末尾句点除去/40字超は棄却)。
  const shortTagline = normalizeShortTagline(parsed.shortTagline);
  const productSummary = (parsed.productSummary ?? "").trim();
  if (!shortTagline || !productSummary) {
    throw new Error(`生成結果に空/不正フィールドがあります: ${JSON.stringify(parsed)}`);
  }
  // categoryId はカタログ whitelist を通ったものだけ採用。不正なら null(カテゴリーのみ据え置きの部分成功)。
  const categoryId = isProductCategoryId(parsed.categoryId) ? parsed.categoryId : null;
  return { shortTagline, productSummary, categoryId };
};

async function main() {
  const mode = apply ? "APPLY(書き込み)" : preview ? "PREVIEW(生成のみ)" : "DRY-RUN(一覧のみ)";
  const targets = await collectTargets();
  console.log(`[backfill-product-copy] mode=${mode} 対象=${targets.length}件` +
    `${targetId ? ` id=${targetId}` : ""}${onlyMissing ? " only-missing" : ""}`);
  console.log("");

  if (!apply && !preview) {
    // Gemini を呼ばずに現状を一覧表示するだけ。
    for (const row of targets) {
      console.log(`- ${row.title} (${row.id})`);
      console.log(`    shortTagline(現) : ${row.shortTagline ?? "(未設定)"}`);
      console.log(`    categoryId(現)   : ${row.categoryId}`);
      console.log(`    whatWasTried(現) : ${truncate(row.whatWasTried)}`);
      console.log(`    concept(新規性)  : ${truncate(row.concept ?? "(なし)")}`);
    }
    console.log("");
    console.log("Gemを呼んで生成を確認するには --preview、書き込むには --apply を付けてください。");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const row of targets) {
    try {
      const generated = parseGeneratedCopy(await generateGeminiText(buildPrompt(row), { temperature: 0.6 }));
      console.log(`- ${row.title} (${row.id})`);
      console.log(`    shortTagline : ${row.shortTagline ?? "(未設定)"}  ->  ${generated.shortTagline}`);
      console.log(`    categoryId   : ${row.categoryId}  ->  ${generated.categoryId ?? `(不正な生成値のため据え置き: ${row.categoryId})`}`);
      console.log(`    説明(box)    : ${truncate(row.whatWasTried)}`);
      console.log(`               ->  ${truncate(generated.productSummary)}`);
      if (apply) {
        await prisma.project.update({
          where: { id: row.id },
          data: {
            shortTagline: generated.shortTagline,
            // 説明ボックスのソース。concept(新規性)は温存し、whatWasTried のみ説明へ差し替える。
            whatWasTried: generated.productSummary,
            // 再分類。生成 categoryId が whitelist を通らなかった行は現状維持(部分成功)。
            ...(generated.categoryId ? { categoryId: generated.categoryId } : {}),
          },
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
  console.log(`[backfill-product-copy] 完了: 成功=${ok} 失敗=${failed}${apply ? "" : " (PREVIEW: 書き込みなし)"}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
