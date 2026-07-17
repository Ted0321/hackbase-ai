/**
 * high-riskトピックゲートのLLM二次判定(adjudication、2026-07-17導入)。
 *
 * publish段のregexゲート(HIGH_RISK_TOPIC_PATTERNS)は「トピック語の出現」しか見ないため、
 * 静的モックのデモ説明文(「自宅の住所と家族構成を登録すると…」)や免責文がfalse positiveで
 * held(ops_review)に落ちる。regexヒット時のみこのadjudicatorを呼び、「実際にリスク行為を
 * 行う作品か、単にトピックに言及しているだけか」を文脈判定させる。
 *
 * 安全契約(最重要): adjudicateHighRiskEvidence は絶対に throw しない。ただし
 * interaction-target-llm.ts と逆向きで、フォールバックは常に「hold維持」側に倒す:
 * 予算超過・タイムアウト・パース不能・env無効は全て ok:false に畳み、呼び出し側は
 * 現行どおり held(ops_review) にする。benign_mention の明示判定が出たときだけ素通しする。
 * uncertain は actual_risk と同じ扱い(hold)。false negativeは増えない。
 *
 * 無効化は env PRODIA_HIGH_RISK_LLM_ADJUDICATION=0 (既定は有効)。
 * タイムアウト=PRODIA_HIGH_RISK_LLM_TIMEOUT_MS(既定20000)。
 */
import {
  collectHighRiskMatchExcerpts,
  detectHighRiskTopicCategories,
  type HighRiskTopicCategory,
} from "./prompt-eval-metrics";
import { generateGeminiText } from "./gemini-text";

export type HighRiskAdjudicationVerdict = "benign_mention" | "actual_risk" | "uncertain";

export type HighRiskAdjudicationFallbackReason =
  | "disabled"
  | "no_categories"
  | "budget_exhausted"
  | "timeout"
  | "generation_error"
  | "parse_error";

export type HighRiskAdjudicationResult =
  | { ok: true; verdict: HighRiskAdjudicationVerdict; reasoning: string; model: string }
  | { ok: false; fallbackReason: HighRiskAdjudicationFallbackReason; detail?: string };

export const DEFAULT_HIGH_RISK_ADJUDICATION_TIMEOUT_MS = 20_000;
export const MAX_ADJUDICATION_REASONING_LENGTH = 300;

export const highRiskAdjudicationEnabled = (): boolean => {
  const raw = (process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION ?? "").trim().toLowerCase();
  return !["0", "false", "off"].includes(raw);
};

export const highRiskAdjudicationTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.PRODIA_HIGH_RISK_LLM_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HIGH_RISK_ADJUDICATION_TIMEOUT_MS;
};

// プロンプトは意図的にモジュール内定数にする。scripts/prompts/ 配下に置くと
// antidup steering の prompts ディレクトリ丸コピー経路や eval:prompt:check の対象に
// 巻き込まれるため、判定器はコードと同一PRでレビュー・固定する。
const ADJUDICATION_PROMPT_HEADER = `You are a safety adjudicator for an automated product-publishing pipeline.
A deterministic keyword filter flagged the demo product below for high-risk topics.
All products on this platform are self-contained demo artifacts: static sample data only,
no external network access (enforced by the platform contract). Judge the CONCEPT, not the
platform guarantees.

Answer "actual_risk" only if the product's core purpose is one of:
- transmitting or sharing real users' personal data with third parties, or profiling real people
- giving medical diagnosis or treatment advice that a user is meant to act on
- giving legal, financial, or investment advice that a user is meant to act on
- targeted political persuasion of voters

Answer "benign_mention" if the flagged words only appear as:
- feature copy of a planning/visualization tool where a user enters their own info locally
  to get a personalized plan (e.g. disaster-prep or heat-safety schedules)
- descriptions of mock/static/demo behavior that handles no real data
- disclaimers or safety boundaries that DENY the risky behavior
- topic references without advising or collecting anything

If you cannot clearly decide, answer "uncertain" (it is treated as actual_risk).

Return ONLY a JSON object: {"verdict": "benign_mention" | "actual_risk" | "uncertain", "reasoning": "<1-3 sentences>"}`;

const clip = (value: unknown, maxLength: number): string => {
  const text =
    typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

export const buildHighRiskAdjudicationPrompt = (args: {
  categories: HighRiskTopicCategory[];
  title: unknown;
  oneLiner: unknown;
  concept: unknown;
  knownRisks: unknown;
  excerpts: Array<{ category: HighRiskTopicCategory; match: string; excerpt: string }>;
}): string => {
  const excerptBlocks = args.excerpts.map(
    (item, index) =>
      `${index + 1}. [${item.category}] matched "${item.match}"\n   …${item.excerpt.replace(/\s+/g, " ").trim()}…`,
  );
  return [
    ADJUDICATION_PROMPT_HEADER,
    "",
    "## Product under review",
    `- flagged categories: ${args.categories.join(", ")}`,
    `- title: ${clip(args.title, 200)}`,
    `- oneLiner: ${clip(args.oneLiner, 400)}`,
    `- concept: ${clip(args.concept, 600)}`,
    `- knownRisks (self-reported): ${clip(args.knownRisks, 600)}`,
    "",
    "## Matched keyword excerpts",
    excerptBlocks.join("\n"),
    "",
    "## Output",
    "Return the JSON object now.",
  ].join("\n");
};

export const parseAdjudicationResponse = (
  raw: string,
):
  | { ok: true; verdict: HighRiskAdjudicationVerdict; reasoning: string }
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
  if (verdict !== "benign_mention" && verdict !== "actual_risk" && verdict !== "uncertain") {
    return { ok: false, fallbackReason: "parse_error" };
  }
  const reasoningRaw = (parsed as { reasoning?: unknown }).reasoning;
  const reasoning =
    typeof reasoningRaw === "string" ? reasoningRaw.replace(/\s+/g, " ").trim() : "";
  return {
    ok: true,
    verdict,
    reasoning:
      reasoning.length > MAX_ADJUDICATION_REASONING_LENGTH
        ? `${reasoning.slice(0, MAX_ADJUDICATION_REASONING_LENGTH - 1)}…`
        : reasoning || "(no reasoning provided)",
  };
};

/**
 * regexゲートにヒットした riskEvidence をLLMで文脈判定する。絶対に throw しない
 * (冒頭のdocコメント参照)。generateText 注入でテストを決定論化できる。既定は
 * generateGeminiText (operation="high-risk-adjudication" でModelUsageLog分離集計、
 * temperature 0、timeoutMsでfetch中断)。
 */
export const adjudicateHighRiskEvidence = async (args: {
  evidence: unknown;
  title?: unknown;
  oneLiner?: unknown;
  concept?: unknown;
  knownRisks?: unknown;
  timeoutMs?: number;
  generateText?: (
    prompt: string,
    options: { temperature: number; timeoutMs: number; operation: string },
  ) => Promise<string>;
}): Promise<HighRiskAdjudicationResult> => {
  try {
    if (!highRiskAdjudicationEnabled()) {
      return { ok: false, fallbackReason: "disabled" };
    }
    const categories = detectHighRiskTopicCategories(args.evidence);
    if (categories.length === 0) {
      return { ok: false, fallbackReason: "no_categories" };
    }
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const timeoutMs = args.timeoutMs ?? highRiskAdjudicationTimeoutMs();
    const prompt = buildHighRiskAdjudicationPrompt({
      categories,
      title: args.title ?? "",
      oneLiner: args.oneLiner ?? "",
      concept: args.concept ?? "",
      knownRisks: args.knownRisks ?? [],
      excerpts: collectHighRiskMatchExcerpts(args.evidence),
    });
    const generateText =
      args.generateText ??
      ((text: string, options: { temperature: number; timeoutMs: number; operation: string }) =>
        generateGeminiText(text, options));
    const raw = await generateText(prompt, {
      temperature: 0,
      timeoutMs,
      operation: "high-risk-adjudication",
    });
    const parsed = parseAdjudicationResponse(raw);
    if (!parsed.ok) return { ok: false, fallbackReason: parsed.fallbackReason };
    return { ok: true, verdict: parsed.verdict, reasoning: parsed.reasoning, model };
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
};
