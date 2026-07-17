// Anti-duplication steering for the concept step.
//
// The research step remixes a frozen local corpus (data/*-signals.json + data/research-exploration/),
// so as the public feed grows the concept strategist starts reproducing concepts that are already
// live (observed 2026-07-07: one run produced 3/3 near-duplicate candidates; another selected a
// verbatim copy of a published product). Two layers, both fed from the live Project table:
//
// 1. Prompt steering: build a runtime prompts dir (copy of scripts/prompts) whose
//    concept-strategist.md ends with an exclusion list of published products plus hard rules.
//    The pipeline picks it up via PRODIA_PROMPTS_DIR (promptsBaseDir() in shared.ts).
// 2. Deterministic backstop: findVerbatimClone() lets run-gemini reject a selected concept whose
//    title/oneLiner equals a published product, feeding the guided retry so the model re-rolls
//    the concept inside the same run. Prompt steering alone is NOT sufficient — a bare list was
//    observed (2026-07-08) to make the model anchor on a listed item and copy it verbatim.
//
// The rules come BEFORE the list and the list is framed strictly as an exclusion set, paired
// with a positive redirect toward unused domains — the combination that held up in practice.

import { cp, mkdir, appendFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateGeminiText } from "../gemini-text";

export type PublishedProduct = { title: string; oneLiner: string };

type PrismaLikeClient = {
  project: {
    findMany: (args: {
      where: { status: { in: string[] } };
      select: { title: true; oneLiner: true };
      orderBy: { createdAt: "asc" };
    }) => Promise<Array<{ title: string | null; oneLiner: string | null }>>;
  };
};

// Public feed = manually approved ("published") + scheduler auto-publishes ("auto_published").
export const PUBLIC_FEED_STATUSES = ["published", "auto_published"];

// The exclusion list also covers held_for_review: held items are mostly semantic clones that a
// human refused to publish, so steering only on the public feed lets the concept step keep
// regenerating the same held theme (observed 2026-07-08: a 4th disaster-prep concept arrived
// while two earlier ones sat in held_for_review).
export const ANTIDUP_EXCLUSION_STATUSES = [...PUBLIC_FEED_STATUSES, "held_for_review"];

export async function fetchPublishedProducts(prisma: PrismaLikeClient): Promise<PublishedProduct[]> {
  const rows = await prisma.project.findMany({
    where: { status: { in: ANTIDUP_EXCLUSION_STATUSES } },
    // held rows have publishedAt=null, so order by the always-present createdAt instead.
    select: { title: true, oneLiner: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ title: String(row.title ?? ""), oneLiner: String(row.oneLiner ?? "") }));
}

export function renderAntiDupSection(products: PublishedProduct[]): string {
  const lines = products.map((product) => `- ${product.title} — ${product.oneLiner}`);
  return [
    "",
    "---",
    "",
    "## 【自動注入・実行時に毎回更新・絶対厳守】アンチ重複ルール",
    "",
    "この後に「すでに本番フィードに公開済み、または審査保留(held)中のプロダクト一覧」を載せる。これは**除外リスト**であり、発想の見本・参考例ではない。次を絶対に守ること:",
    "",
    "1. **一覧にあるタイトル・oneLinerと同一またはほぼ同一の候補を出すことは失格。** 一覧の項目をそのまま、または言い換えただけで候補・selectedConceptにしてはならない。",
    "2. 一覧と「題材×インタラクション」が同型・近縁のコンセプトも候補に入れない・選ばない。同じ価値提案の別ドメイン移植だけの案も不可。",
    "3. **一覧でまだ使われていない題材領域から発想すること。ただし、専門知識がなくても一般の人がすぐ分かる題材を選ぶこと**(未使用領域に振るために専門的・ニッチになりすぎない — domainOpacityの高い候補はconceptゲートで失格する)。例: 身近な生き物や自然現象のしくみ、歴史上の出来事、体・食・ものの由来、音・色・ことばの不思議、まちの仕組み、数や図形の面白さ、など未使用で身近な領域は広く残っている。",
    "4. 各候補の `whyDifferentFromRecentArtifacts` では、一覧の中で最も近い既存作を1つ名指しし、題材とインタラクションの両方でどう違うかを具体的に書くこと。",
    "",
    `### 公開済み・審査保留プロダクト一覧(${products.length}件) — これらは作ってはいけない`,
    "",
    ...lines,
    "",
  ].join("\n");
}

// Conservative on purpose: normalized equality of title or oneLiner catches verbatim copies
// deterministically without false-killing legitimate same-genre concepts. Semantic near-dups
// remain the reviewer's call (and the prompt steering's job).
const normalizeForCloneCheck = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[。、．，.,!?！？:：;；'"“”‘’()（）\-–—_]/g, "");

// concept応答から selectedConcept.id に対応する candidates エントリを引く。
// findVerbatimClone と judgeSemanticDuplicateWithLlm の共通前処理(挙動不変の抽出リファクタ)。
export function selectedConceptOf(conceptResponse: unknown): Record<string, unknown> | null {
  if (!conceptResponse || typeof conceptResponse !== "object") return null;
  const record = conceptResponse as Record<string, unknown>;
  const selectedId =
    record.selectedConcept && typeof record.selectedConcept === "object"
      ? String((record.selectedConcept as Record<string, unknown>).id ?? "")
      : "";
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const selected = candidates.find(
    (candidate) =>
      candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).id ?? "") === selectedId,
  ) as Record<string, unknown> | undefined;
  return selected ?? null;
}

export function findVerbatimClone(
  conceptResponse: unknown,
  products: PublishedProduct[],
): { selectedTitle: string; matchedTitle: string } | null {
  if (products.length === 0) return null;
  const selected = selectedConceptOf(conceptResponse);
  if (!selected) return null;

  const title = normalizeForCloneCheck(selected.title);
  const oneLiner = normalizeForCloneCheck(selected.oneLiner);
  for (const product of products) {
    if (
      (title && title === normalizeForCloneCheck(product.title)) ||
      (oneLiner && oneLiner === normalizeForCloneCheck(product.oneLiner))
    ) {
      return { selectedTitle: String(selected.title ?? ""), matchedTitle: product.title };
    }
  }
  return null;
}

export type AntidupSteeringResult = {
  promptsDir: string;
  productsFile: string;
  publishedCount: number;
};

// Per-run dir: the hourly scheduler and a manual run may overlap, and each should see the feed
// as of its own start.
export async function buildAntidupSteering(
  products: PublishedProduct[],
  runId: string,
): Promise<AntidupSteeringResult> {
  const sourcePromptsDir = path.join(process.cwd(), "scripts", "prompts");
  const promptsDir = path.join(os.tmpdir(), `prodia-antidup-prompts-${runId}`);
  await rm(promptsDir, { recursive: true, force: true });
  await mkdir(promptsDir, { recursive: true });
  await cp(sourcePromptsDir, promptsDir, { recursive: true });
  await appendFile(path.join(promptsDir, "concept-strategist.md"), renderAntiDupSection(products), "utf8");

  const productsFile = path.join(promptsDir, "published-products.json");
  await writeFile(productsFile, `${JSON.stringify(products, null, 2)}\n`, "utf8");

  return { promptsDir, productsFile, publishedCount: products.length };
}

// ---------------------------------------------------------------------------
// 意味的重複のLLM近傍判定(semantic dup gate、2026-07-17導入)
//
// findVerbatimClone は正規化後の完全一致しか検出しないため、タイトルを変えただけの
// 準クローン(実例: 「猛暑レスキューシート」= 3日前公開の「HeatShield Route」と
// 入力・出力・価値提案が同型)がプロンプトステアリングを無視して素通りした。
// concept選定後にLLMへ「最も近い既存作と重複度」を判定させ、duplicate のときだけ
// run-gemini の guided retry へ投げて同一run内でコンセプトを振り直す。
//
// 安全契約: judgeSemanticDuplicateWithLlm は絶対に throw しない。ただしこれは
// 品質ゲートであり安全ゲートではないので、フォールバックの向きは high-risk
// adjudication と逆で「pass(=従来挙動)」に倒す: LLM不調で生成が止まらないことを
// 優先する(steering+逐語ゲート+reviewerの多層は残る)。
// 3値verdictにするのは過剰block抑制のため: related(同ジャンル別体験)は通す。
//
// 無効化は env PRODIA_SEMANTIC_DUP_GATE=off (既定は有効)。
// タイムアウト=PRODIA_SEMANTIC_DUP_TIMEOUT_MS(既定20000)。
// ---------------------------------------------------------------------------

export type SemanticDupVerdict = "duplicate" | "related" | "distinct";

export type SemanticDupFallbackReason =
  | "disabled"
  | "no_selected_concept"
  | "no_products"
  | "budget_exhausted"
  | "timeout"
  | "generation_error"
  | "parse_error";

export type SemanticDupResult =
  | {
      ok: true;
      verdict: SemanticDupVerdict;
      closestExistingTitle: string;
      reason: string;
      selectedTitle: string;
      model: string;
    }
  | { ok: false; fallbackReason: SemanticDupFallbackReason; detail?: string };

export const DEFAULT_SEMANTIC_DUP_TIMEOUT_MS = 20_000;
export const MAX_SEMANTIC_DUP_REASON_LENGTH = 200;

export const semanticDupGateEnabled = (): boolean => {
  const raw = (process.env.PRODIA_SEMANTIC_DUP_GATE ?? "").trim().toLowerCase();
  return !["0", "false", "off"].includes(raw);
};

export const semanticDupTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.PRODIA_SEMANTIC_DUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SEMANTIC_DUP_TIMEOUT_MS;
};

const clipText = (value: unknown, maxLength: number): string => {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

// プロンプトはモジュール内定数(scripts/prompts/ に置くと steering の丸コピー経路や
// eval:prompt:check に巻き込まれるため、判定器はコードと同一PRでレビュー・固定する)。
const SEMANTIC_DUP_PROMPT_HEADER = `You are a duplication judge for an AI product showcase feed.
A concept strategist has just selected a new product concept. Compare it against the list of
already-published products and decide how close it is to the NEAREST existing product.

Verdict definitions:
- "duplicate": a retitled clone — 題材(subject)・入力(what the user provides)・出力(what the
  product produces)・価値提案(the promise to the user) are all essentially the same as one
  existing product. Renaming, narrowing the audience (e.g. "for elderly people"), or changing
  the output's file format alone does NOT make it different.
- "related": same theme or genre as an existing product, but the core experience (interaction
  or output) is clearly different. Same-genre products are allowed on this feed.
- "distinct": no meaningfully close existing product.

Judge strictly on 題材×入力×出力×価値提案. Do not punish shared broad topics alone.

Return ONLY a JSON object:
{"verdict": "duplicate" | "related" | "distinct", "closestExistingTitle": "<title from the list or empty>", "reason": "<1-2 sentences>"}`;

export const buildSemanticDupPrompt = (args: {
  selected: { title: string; oneLiner: string; whyDifferent?: string };
  products: PublishedProduct[];
}): string => {
  const productLines = args.products.map(
    (product) => `- ${clipText(product.title, 120)} — ${clipText(product.oneLiner, 200)}`,
  );
  return [
    SEMANTIC_DUP_PROMPT_HEADER,
    "",
    "## New concept under review",
    `- title: ${clipText(args.selected.title, 200)}`,
    `- oneLiner: ${clipText(args.selected.oneLiner, 400)}`,
    args.selected.whyDifferent
      ? `- claimed difference from recent artifacts: ${clipText(args.selected.whyDifferent, 400)}`
      : "- claimed difference from recent artifacts: (not provided)",
    "",
    `## Already-published products (${args.products.length})`,
    ...productLines,
    "",
    "## Output",
    "Return the JSON object now.",
  ].join("\n");
};

export const parseSemanticDupResponse = (
  raw: string,
):
  | { ok: true; verdict: SemanticDupVerdict; closestExistingTitle: string; reason: string }
  | { ok: false; fallbackReason: "parse_error" } => {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, fallbackReason: "parse_error" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return { ok: false, fallbackReason: "parse_error" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, fallbackReason: "parse_error" };
  }
  const verdict = (parsed as { verdict?: unknown }).verdict;
  if (verdict !== "duplicate" && verdict !== "related" && verdict !== "distinct") {
    return { ok: false, fallbackReason: "parse_error" };
  }
  const closestRaw = (parsed as { closestExistingTitle?: unknown }).closestExistingTitle;
  const reasonRaw = (parsed as { reason?: unknown }).reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim() : "";
  return {
    ok: true,
    verdict,
    closestExistingTitle: typeof closestRaw === "string" ? closestRaw.trim() : "",
    reason:
      reason.length > MAX_SEMANTIC_DUP_REASON_LENGTH
        ? `${reason.slice(0, MAX_SEMANTIC_DUP_REASON_LENGTH - 1)}…`
        : reason,
  };
};

/**
 * 選定コンセプトと公開フィード一覧をLLMに渡し、最近傍の既存作と重複度を判定させる。
 * 絶対に throw しない(冒頭コメント参照)。generateText 注入でテストを決定論化できる。
 * 既定は generateGeminiText (operation="semantic-dup-check" でModelUsageLog分離集計、
 * temperature 0、timeoutMsでfetch中断)。
 */
export async function judgeSemanticDuplicateWithLlm(args: {
  conceptResponse: unknown;
  products: PublishedProduct[];
  timeoutMs?: number;
  generateText?: (
    prompt: string,
    options: { temperature: number; timeoutMs: number; operation: string },
  ) => Promise<string>;
}): Promise<SemanticDupResult> {
  try {
    if (!semanticDupGateEnabled()) {
      return { ok: false, fallbackReason: "disabled" };
    }
    if (args.products.length === 0) {
      return { ok: false, fallbackReason: "no_products" };
    }
    const selected = selectedConceptOf(args.conceptResponse);
    if (!selected) {
      return { ok: false, fallbackReason: "no_selected_concept" };
    }
    const selectedTitle = String(selected.title ?? "");
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const timeoutMs = args.timeoutMs ?? semanticDupTimeoutMs();
    const prompt = buildSemanticDupPrompt({
      selected: {
        title: selectedTitle,
        oneLiner: String(selected.oneLiner ?? ""),
        whyDifferent:
          typeof selected.whyDifferentFromRecentArtifacts === "string"
            ? selected.whyDifferentFromRecentArtifacts
            : undefined,
      },
      products: args.products,
    });
    const generateText =
      args.generateText ??
      ((text: string, options: { temperature: number; timeoutMs: number; operation: string }) =>
        generateGeminiText(text, options));
    const raw = await generateText(prompt, {
      temperature: 0,
      timeoutMs,
      operation: "semantic-dup-check",
    });
    const parsed = parseSemanticDupResponse(raw);
    if (!parsed.ok) return { ok: false, fallbackReason: parsed.fallbackReason };
    return {
      ok: true,
      verdict: parsed.verdict,
      closestExistingTitle: parsed.closestExistingTitle,
      reason: parsed.reason,
      selectedTitle,
      model,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (/cap reached/i.test(message)) {
      return { ok: false, fallbackReason: "budget_exhausted", detail: message.slice(0, 200) };
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, fallbackReason: "timeout" };
    }
    return { ok: false, fallbackReason: "generation_error", detail: message.slice(0, 200) };
  }
}
