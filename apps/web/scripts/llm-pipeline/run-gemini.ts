import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../load-local-env";
import {
  createRunId,
  ensureRun,
  parseArgs,
  readJson,
  readText,
  stepDir,
  type CliArgs,
  writeJson,
} from "./shared";
import { pipelineSteps, type PipelineStep } from "./types";
import { errorMessageOf, extractGeminiTokenUsage, logModelUsage } from "../observability";
import {
  builderQuality,
  clampResearchOutput,
  conceptQuality,
  requirementsQuality,
  researchQuality,
  RESEARCH_MAX_COMBINATION_HINTS,
  RESEARCH_MAX_SOURCE_PRODUCT_CARDS,
  schemaShapeForStep,
  type StepName,
} from "../prompt-eval-metrics";
import { enforceGeminiBudget } from "./rate-guard";
import { findVerbatimClone, type PublishedProduct } from "./antidup-steering";
import { checkAgentRuntimeReflection } from "../check-agent-runtime-reflection";
import { findMojibakeLikeTextIssues } from "../llm-response-quality";
import {
  decideAfterReview,
  decideAfterRewrite,
  statusValue,
  type ReviewLoopOutcome,
} from "./review-loop-policy";
import {
  parseGeminiResponseJson,
  type GeminiResponse,
} from "./gemini-response-parser";

type Args = {
  runId: string;
  model: string;
  conceptModel: string;
  builderModel: string;
  apiKey: string | undefined;
  steps: PipelineStep[];
  dryRun: boolean;
  agentId: string | undefined;
  reviewLoop: boolean;
  maxRewrites: number;
};

const defaultSteps: PipelineStep[] = [...pipelineSteps];

const isTruthyArg = (value: string | boolean | undefined) => value === true || value === "true";

export const resolveGeminiDryRunMode = (args: CliArgs, apiKey: string | undefined) => {
  const dryRun = isTruthyArg(args["dry-run"]);
  if (!dryRun && !apiKey) {
    throw new Error(
      "GEMINI_API_KEY or GOOGLE_API_KEY is required. Use --dry-run only when intentionally preparing prompts without calling Gemini.",
    );
  }
  return dryRun;
};

const toPipelineSteps = (value: string | boolean | undefined): PipelineStep[] => {
  if (typeof value !== "string" || value.trim() === "") {
    return defaultSteps;
  }

  const steps = value.split(",").map((item) => item.trim());
  const invalid = steps.filter(
    (step): step is string => !pipelineSteps.includes(step as PipelineStep),
  );
  if (invalid.length > 0) {
    throw new Error(`Invalid --steps value: ${invalid.join(", ")}`);
  }

  return steps as PipelineStep[];
};

const parseRunArgs = (): Args => {
  const args = parseArgs();
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const runId = typeof args.run === "string" ? args.run : createRunId();
  const model =
    typeof args.model === "string" ? args.model : process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const conceptModel =
    typeof args["concept-model"] === "string"
      ? args["concept-model"]
      : process.env.GEMINI_CONCEPT_MODEL ?? "gemini-2.5-pro";
  // builder は自分の interactionProofPlan と生成ソースの静的一致（proofSelector/visibleEvidence）
  // を自己整合させる最難関ステップ。flash は再現性の低さで品質ゲートに落ちやすいため既定を pro に。
  const builderModel =
    typeof args["builder-model"] === "string"
      ? args["builder-model"]
      : process.env.GEMINI_BUILDER_MODEL ?? "gemini-2.5-pro";
  const dryRun = resolveGeminiDryRunMode(args, apiKey);
  const maxRewritesRaw =
    typeof args["max-rewrites"] === "string" ? Number(args["max-rewrites"]) : 2;

  return {
    runId,
    model,
    conceptModel,
    builderModel,
    apiKey,
    steps: toPipelineSteps(args.steps),
    dryRun,
    agentId: typeof args.agent === "string" ? args.agent : undefined,
    reviewLoop: args["review-loop"] === true || args["review-loop"] === "true",
    maxRewrites: Number.isFinite(maxRewritesRaw) && maxRewritesRaw >= 0 ? maxRewritesRaw : 2,
  };
};

const modelForStep = (step: PipelineStep, args: Args) =>
  step === "concept" ? args.conceptModel : step === "builder" ? args.builderModel : args.model;

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} exited with ${code}`));
      }
    });
  });

const prepareStep = async (runId: string, step: PipelineStep, agentId?: string) => {
  await runTsx(path.join("scripts", "llm-pipeline", "prepare-step.ts"), [
    "--run",
    runId,
    "--step",
    step,
    ...(agentId ? ["--agent", agentId] : []),
  ]);
};

const buildGeminiRequest = (prompt: string, input: unknown) => ({
  systemInstruction: {
    parts: [
      {
        text: [
          "You are executing one step of Prodia's LLM pipeline.",
          "Follow the provided step prompt exactly.",
          "Return strict JSON only. Do not include Markdown or commentary.",
        ].join("\n"),
      },
    ],
  },
  contents: [
    {
      role: "user",
      parts: [
        {
          text: JSON.stringify(
            {
              stepPrompt: prompt,
              structuredInput: input,
            },
            null,
            2,
          ),
        },
      ],
    },
  ],
  generationConfig: {
    responseMimeType: "application/json",
    // builderは複数のソースファイル全文をJSONで返すため、既定の出力トークン上限だと
    // 途中で打ち切られ不正JSONになる。gemini-2.5-flashの上限まで引き上げる。
    maxOutputTokens: 65536,
    // thinkingトークンはmaxOutputTokensの枠を消費する(2026-07-08実測: research失敗runで
    // candidates 57,829 + thoughts 7,691 ≈ 65,520 でJSONが切断)。無制限のthinkingが
    // 出力枠を食い潰さないよう予算を固定し、本文用に約57kトークンを常に確保する。
    thinkingConfig: { thinkingBudget: 8192 },
  },
});

// 一時的なHTTP失敗はバックオフ付きで再試行する。researchは1コールで数十万トークンを送るため、
// 連続run(手動バッチ/毎時スケジューラー)がGoogle側のTPM(トークン/分)制限に当たって429を返す
// ことがある(2026-07-08実測: バッチ後半2runが429 RESOURCE_EXHAUSTEDで即死)。429/500/503は
// 数十秒待てば回復する性質なので、即throwでrun全損にせずここで吸収する。
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 503]);
const HTTP_RETRY_DELAYS_MS = [20_000, 40_000, 80_000];

const callGemini = async (apiKey: string, model: string, prompt: string, input: unknown) => {
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;
  const request = buildGeminiRequest(prompt, input);
  for (let httpAttempt = 0; ; httpAttempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (response.ok) {
      return (await response.json()) as GeminiResponse;
    }

    const body = await response.text();
    if (httpAttempt >= HTTP_RETRY_DELAYS_MS.length || !RETRYABLE_HTTP_STATUS.has(response.status)) {
      throw new Error(`Gemini generateContent failed: ${response.status} ${body}`);
    }
    // Retry-After(秒)がある場合はそちらを優先。ジッターで同時リトライの再衝突を避ける。
    const retryAfterMs = (Number(response.headers.get("retry-after")) || 0) * 1000;
    const delayMs = Math.max(retryAfterMs, HTTP_RETRY_DELAYS_MS[httpAttempt]) + Math.floor(Math.random() * 5_000);
    console.warn(
      `[run-gemini] HTTP ${response.status} from Gemini, backing off ${Math.round(delayMs / 1000)}s ` +
        `(retry ${httpAttempt + 1}/${HTTP_RETRY_DELAYS_MS.length})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
};

// candidates[0].finishReason を取り出す（MAX_TOKENS なら出力途中打ち切り＝不正JSONの主因）。
const extractFinishReason = (response: unknown): string | null => {
  if (!response || typeof response !== "object") return null;
  const candidates = (response as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!first || typeof first !== "object") return null;
  const reason = (first as Record<string, unknown>).finishReason;
  return typeof reason === "string" ? reason : null;
};

// B-4: 本番run時のスキーマ検証。eval専用だった schemaShapeForStep をパイプライン実行でも適用し、
// 必須フィールドを欠く壊れた出力を response.json 書き込み前に弾く（パース失敗と同様にリトライ対象）。
// 想定外の過剰ブロック時は PRODIA_RUNTIME_SCHEMA_VALIDATION=off で無効化できる。
const schemaValidationEnabled = process.env.PRODIA_RUNTIME_SCHEMA_VALIDATION !== "off";

const assertResponseSchema = (step: PipelineStep, parsed: unknown): void => {
  if (!schemaValidationEnabled) return;
  const shape = schemaShapeForStep(step as StepName, parsed);
  if (!shape.ok) {
    throw new Error(
      `Response schema validation failed for step '${step}': missing ${shape.missing.join(", ")}`,
    );
  }
};

const reflectionValidatedSteps = new Set<PipelineStep>(["concept", "requirements", "builder"]);

const assertAgentRuntimeReflection = (step: PipelineStep, parsed: unknown, input: unknown): void => {
  if (!schemaValidationEnabled || !reflectionValidatedSteps.has(step)) return;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !(input as { agentRuntimeContext?: unknown }).agentRuntimeContext
  ) {
    return;
  }
  const result = checkAgentRuntimeReflection({ step, response: parsed, input });
  if (result.result === "fail") {
    const failed = result.checks
      .filter((check) => check.status === "fail")
      .slice(0, 8)
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(
      `Agent runtime reflection validation failed for step '${step}': ${failed || result.summary}`,
    );
  }
};

const assertResponseTextQuality = (step: PipelineStep, parsed: unknown): void => {
  if (!schemaValidationEnabled) return;
  const issues = findMojibakeLikeTextIssues(parsed, { maxIssues: 6 });
  if (issues.length === 0) return;

  const summary = issues
    .map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`)
    .join("; ");
  throw new Error(`Response text quality validation failed for step '${step}': mojibake-like text found: ${summary}`);
};

const assertStepQuality = (step: PipelineStep, parsed: unknown): void => {
  if (!schemaValidationEnabled) return;
  const quality =
    step === "research"
      ? researchQuality(parsed)
      : step === "concept"
        ? conceptQuality(parsed)
        : step === "requirements"
          ? requirementsQuality(parsed)
          : step === "builder"
            ? builderQuality(parsed)
            : null;
  if (!quality || quality.ok) return;

  const failed = quality.issues
    .slice(0, 10)
    .map((issue) => `${issue.check}: ${issue.detail}`)
    .join("; ");
  throw new Error(
    `Response quality validation failed for step '${step}': ${failed || `${quality.passed}/${quality.total} checks passed`}`,
  );
};

// Deterministic anti-duplication backstop (see antidup-steering.ts). Prompt steering alone was
// observed to make the model anchor on a listed published product and copy it verbatim; throwing
// here feeds the guided retry so the model re-rolls the concept within the same run. Only active
// when the caller (run-agent-self-directed) provides PRODIA_PUBLISHED_PRODUCTS_FILE.
let publishedProductsCache: PublishedProduct[] | null | undefined;
const loadPublishedProducts = (): PublishedProduct[] | null => {
  if (publishedProductsCache !== undefined) return publishedProductsCache;
  const file = process.env.PRODIA_PUBLISHED_PRODUCTS_FILE;
  if (!file) {
    publishedProductsCache = null;
    return publishedProductsCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PublishedProduct[];
    publishedProductsCache = Array.isArray(parsed) ? parsed : null;
  } catch {
    publishedProductsCache = null;
  }
  return publishedProductsCache;
};

const assertConceptNotDuplicate = (step: PipelineStep, parsed: unknown): void => {
  if (step !== "concept") return;
  const products = loadPublishedProducts();
  if (!products) return;
  const clone = findVerbatimClone(parsed, products);
  if (!clone) return;
  throw new Error(
    `Concept duplication check failed for step '${step}': selectedConcept "${clone.selectedTitle}" is a verbatim copy of the already-published product "${clone.matchedTitle}". ` +
      `Select a concept whose title, oneLiner, and 題材×インタラクション all differ from every entry in the 公開済みプロダクト一覧; prefer an unused subject domain.`,
  );
};

const summarizeStep = (step: PipelineStep, response: unknown) => {
  if (!response || typeof response !== "object") {
    return "non-object response";
  }
  const record = response as Record<string, unknown>;

  if (step === "research") {
    const cards = Array.isArray(record.sourceProductCards) ? record.sourceProductCards.length : 0;
    const reports = Array.isArray(record.researchReports) ? record.researchReports.length : 0;
    return `sourceProductCards=${cards}, researchReports=${reports}`;
  }

  if (step === "combination") {
    const selected = Array.isArray(record.selectedRemixes)
      ? record.selectedRemixes.length
      : Array.isArray(record.selectedCombinations)
        ? record.selectedCombinations.length
        : 0;
    const evaluated = Array.isArray(record.evaluatedRemixes)
      ? record.evaluatedRemixes.length
      : Array.isArray(record.evaluatedCombinations)
        ? record.evaluatedCombinations.length
        : 0;
    return `selected=${selected}, evaluated=${evaluated}`;
  }

  if (step === "concept") {
    const candidates = Array.isArray(record.candidates) ? record.candidates.length : 0;
    const selectedConcept = record.selectedConcept;
    const selectedId =
      selectedConcept && typeof selectedConcept === "object"
        ? (selectedConcept as Record<string, unknown>).id
        : undefined;
    return `candidates=${candidates}, selected=${String(selectedId ?? "unknown")}`;
  }

  return `keys=${Object.keys(record).join(",")}`;
};

const classifyStepFailure = (error: unknown): string => {
  const message = errorMessageOf(error);
  if (message.includes("not parseable as JSON") || message.includes("did not contain output text")) {
    return "json_parse";
  }
  if (message.includes("Response schema validation failed")) return "schema";
  if (message.includes("Agent runtime reflection validation failed")) return "runtime_reflection";
  if (message.includes("Response text quality validation failed")) return "text_quality";
  if (message.includes("Response quality validation failed")) return "quality";
  return "unknown";
};

type StepRunOptions = {
  runId: string;
  model: string;
  apiKey: string | undefined;
  dryRun: boolean;
  agentId: string | undefined;
};

// 単一ステップの実行（prepare -> gemini-request 保存 -> dry-run か実呼び出し -> response.json）。
// 旧 main のループ本体をそのまま関数化したもの（挙動は不変）。review/rewrite ループからも再利用する。
async function runSinglePipelineStep(
  step: PipelineStep,
  opts: StepRunOptions,
): Promise<{ parsed: unknown | null; dryRun: boolean }> {
  await prepareStep(opts.runId, step, opts.agentId);
  const dir = stepDir(opts.runId, step);
  const prompt = await readText(path.join(dir, "prompt.md"));
  const input = await readJson(path.join(dir, "input.json"));
  const request = buildGeminiRequest(prompt, input);

  await writeJson(path.join(dir, "gemini-request.json"), {
    version: 1,
    provider: "google-gemini",
    runId: opts.runId,
    step,
    model: opts.model,
    generatedAt: new Date().toISOString(),
    request,
  });

  if (opts.dryRun) {
    await writeJson(path.join(dir, "gemini-dry-run.json"), {
      version: 1,
      provider: "google-gemini",
      runId: opts.runId,
      step,
      model: opts.model,
      generatedAt: new Date().toISOString(),
      status: "prompt_ready",
      summary:
        "--dry-run was specified, so this step was prepared but not sent to Gemini.",
    });
    console.log(`Gemini dry run prepared: ${step}`);
    return { parsed: null, dryRun: true };
  }

  if (!opts.apiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required unless --dry-run is specified.");
  }

  // 散発的な不正JSON（途中打ち切り・地の文混入・builderのJSON-in-JSON二重エスケープ崩れ）を
  // リトライで吸収して自走ループを安定させる。各試行は独立した再生成なので、builder のように
  // 単発成功率が ~50-70% のステップでも 4 試行で実用十分な成功率になる（失敗時のみ追加コスト）。
  // 生レスポンスはパース前に必ず保存し、失敗時もデバッグできるようにする（旧コードは保存が
  // パースの後にあり、失敗すると何も残らなかった）。
  const MAX_ATTEMPTS = 4;
  let parsedResponse: unknown = null;
  let lastError: unknown = null;
  // 盲目的な再抽選だと、独立した違反癖が2つ以上あるとき4試行でも全滅しうる（実測: builder が
  // 「非推奨モデルID」と「entry の core import」を別々の試行で繰り返した）。前試行の機械チェック
  // 失敗理由をプロンプト末尾に付けて再生成させ、抽選をガイド付き修正に変える。
  let retryFeedback: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const attemptPrompt = retryFeedback
      ? `${prompt}\n\n## Retry feedback (machine-checked; fix ALL of these)\nYour previous response failed these automated checks. Regenerate the FULL response JSON, keeping everything that was valid and changing what is needed to satisfy every check below:\n${retryFeedback}`
      : prompt;
    let rawResponse: GeminiResponse;
    try {
      // B-1: 実コール前に当日のGemini使用量を確認し、上限超過なら中断（暴走防止）。
      await enforceGeminiBudget({
        operation: "llm-pipeline:run-gemini",
        runId: opts.runId,
        step,
        agentId: opts.agentId,
      });
      rawResponse = await callGemini(opts.apiKey, opts.model, attemptPrompt, input);
    } catch (error) {
      await logModelUsage({
        provider: "google-gemini",
        model: opts.model,
        operation: "llm-pipeline:run-gemini",
        runId: opts.runId,
        step,
        agentId: opts.agentId,
        status: "error",
        latencyMs: Date.now() - startedAt,
        errorMessage: errorMessageOf(error),
        metadata: { attempt },
      });
      throw error;
    }
    const rawResponsePath = path.join(dir, "gemini-response.raw.json");
    const attemptRawResponsePath = path.join(dir, `gemini-response.attempt-${attempt}.raw.json`);
    await writeJson(attemptRawResponsePath, rawResponse);
    await writeJson(rawResponsePath, rawResponse);
    try {
      parsedResponse = parseGeminiResponseJson(rawResponse);
      assertResponseSchema(step, parsedResponse);
      assertAgentRuntimeReflection(step, parsedResponse, input);
      assertResponseTextQuality(step, parsedResponse);
      if (step === "research") {
        // ゲート手前で決定論的にキャップ内へ縮小する。件数超過/重複IDでguided retryが全滅し
        // 生成が止まる事故(2026-07-09)への恒久対策。縮小が起きたら可視化のためwarnを出す。
        const clamp = clampResearchOutput(parsedResponse);
        if (clamp.cardsOverCap || clamp.hintsOverCap || clamp.dupesRemoved) {
          console.warn(
            `[run-gemini] research: clamped output to caps (${RESEARCH_MAX_SOURCE_PRODUCT_CARDS} cards / ` +
              `${RESEARCH_MAX_COMBINATION_HINTS} hints) — dropped ${clamp.cardsOverCap} card(s) over cap, ` +
              `${clamp.dupesRemoved} duplicate id(s), ${clamp.hintsOverCap} hint(s) over cap.`,
          );
          parsedResponse = clamp.value;
        }
      }
      assertStepQuality(step, parsedResponse);
      assertConceptNotDuplicate(step, parsedResponse);
      await logModelUsage({
        provider: "google-gemini",
        model: opts.model,
        operation: "llm-pipeline:run-gemini",
        runId: opts.runId,
        step,
        agentId: opts.agentId,
        status: "success",
        latencyMs: Date.now() - startedAt,
        ...extractGeminiTokenUsage(rawResponse),
        metadata: { attempt, finishReason: extractFinishReason(rawResponse) },
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const reason = extractFinishReason(rawResponse);
      const failureKind = classifyStepFailure(error);
      // 次試行のプロンプトに付ける機械チェック失敗理由（長すぎる場合は切り詰め）。
      // MAX_TOKENS切断だけは汎用の「JSONが壊れている」フィードバックでは直らない — モデルが
      // 同じ分量で書き直して再び切断される(2026-07-08実測: researchで4試行全てMAX_TOKENS)。
      // 「出力を減らせ」と明示して同一run内で収束させる。
      retryFeedback =
        reason === "MAX_TOKENS"
          ? "Your previous output was TRUNCATED at the output token limit (finishReason=MAX_TOKENS). " +
            "Regenerate a SMALLER complete JSON response: cap list/array fields (e.g. sourceProductCards) " +
            "to the 12 strongest items and keep every string field to one concise sentence. " +
            "Do not drop required fields — a complete, smaller JSON beats a truncated, larger one."
          : errorMessageOf(error).slice(0, 2000);
      await logModelUsage({
        provider: "google-gemini",
        model: opts.model,
        operation: "llm-pipeline:run-gemini",
        runId: opts.runId,
        step,
        agentId: opts.agentId,
        status: "error",
        latencyMs: Date.now() - startedAt,
        errorMessage: errorMessageOf(error),
        ...extractGeminiTokenUsage(rawResponse),
        metadata: { attempt, finishReason: reason, failureKind },
      });
      console.warn(
        `[run-gemini] ${step}: ${failureKind} failure on attempt ${attempt}/${MAX_ATTEMPTS}` +
          `${reason ? ` (finishReason=${reason})` : ""}. ` +
          `${attempt < MAX_ATTEMPTS ? "retrying" : "giving up"}. ` +
          `raw saved at ${attemptRawResponsePath}`,
      );
    }
  }
  if (lastError) {
    throw lastError;
  }

  await writeJson(path.join(dir, "response.json"), parsedResponse);
  console.log(`Completed ${step}: ${summarizeStep(step, parsedResponse)}`);
  return { parsed: parsedResponse, dryRun: false };
}

// reviewer -> (needs_revision なら rewriter -> reviewer 再評価) を最大 maxRewrites 回。
// pass で publish へ進ませ、block / rewriter blocked|needs_human / 上限超過は hold（publish しない）。
// reviewer 再評価は prepare-step が rewriteResult を渡すため、rewrite 反映後の状態として評価される。
async function runReviewRewriteLoop(
  opts: StepRunOptions,
  maxRewrites: number,
): Promise<ReviewLoopOutcome> {
  const finish = async (outcome: ReviewLoopOutcome) => {
    await writeJson(path.join("artifacts", "llm-pipeline-runs", opts.runId, "review-loop.json"), {
      version: 1,
      runId: opts.runId,
      generatedAt: new Date().toISOString(),
      maxRewrites,
      ...outcome,
    });
    return outcome;
  };

  let review = await runSinglePipelineStep("reviewer", opts);

  if (opts.dryRun) {
    // dry-run は判定せず、rewriter も prepare して配線だけ確認する。
    await runSinglePipelineStep("rewriter", opts);
    return finish({
      result: "dry_run_prepared",
      hold: false,
      reason: "dry_run",
      attempts: 0,
      reviewerStatus: null,
      rewriterStatus: null,
    });
  }

  let attempts = 0;
  for (;;) {
    const reviewerStatus = statusValue(review.parsed);
    const reviewDecision = decideAfterReview(reviewerStatus, attempts, maxRewrites);
    if (reviewDecision.action === "finish") return finish(reviewDecision.outcome);

    attempts += 1;
    const rewrite = await runSinglePipelineStep("rewriter", opts);
    const rewriterStatus = statusValue(rewrite.parsed);
    const rewriteDecision = decideAfterRewrite(reviewerStatus, rewriterStatus, attempts);
    if (rewriteDecision.action === "finish") return finish(rewriteDecision.outcome);

    // revised → 再 review（reviewer 入力に rewriteResult が反映される）
    review = await runSinglePipelineStep("reviewer", opts);
  }
}

async function main() {
  const args = parseRunArgs();
  await ensureRun(args.runId);
  const opts: StepRunOptions = {
    runId: args.runId,
    model: args.model,
    apiKey: args.apiKey,
    dryRun: args.dryRun,
    agentId: args.agentId,
  };

  if (args.reviewLoop) {
    const outcome = await runReviewRewriteLoop(opts, args.maxRewrites);
    console.log("");
    console.log(
      `Review/rewrite loop: ${outcome.result} (reason=${outcome.reason}, attempts=${outcome.attempts})`,
    );
    console.log(`Run: ${args.runId}`);
    if (outcome.hold) {
      // hold は異常終了(1)と区別するため exit 3。呼び出し側(self-directed)が publish せず held で扱う。
      process.exit(3);
    }
    return;
  }

  for (const step of args.steps) {
    await runSinglePipelineStep(step, { ...opts, model: modelForStep(step, args) });
  }

  console.log("");
  console.log(args.dryRun ? "Gemini pipeline dry run prepared." : "Gemini pipeline run completed.");
  console.log(`Run: ${args.runId}`);
  console.log(`Root: artifacts/llm-pipeline-runs/${args.runId}`);
  console.log(`Model: ${args.model}`);
  console.log(`Concept model: ${args.conceptModel}`);
  console.log(`Builder model: ${args.builderModel}`);
}

const isMainModule = () => {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
