/**
 * プロンプト前後評価ハーネス（実Gemini）。
 *
 * 同一の上流入力に対して、変更前(baseline)プロンプトと作業ツリー(candidate)プロンプトで
 * 該当ステップを実走し、決定論メトリクス（schema形状/多様性/配線presence/catalog同期）と
 * 低温 LLM-judge で品質を比較する。hard regression があれば非ゼロ終了する。
 *
 * モード:
 *   - source-level（常時・APIキー不要）: 変更前後のソースプロンプト本文を比較。catalog 同期と
 *     配線指示の presence を確認。`eval:prompt:check` はこのモードのみ。
 *   - response-level（APIキーあり・--dry-run でない時）: 実 pipeline を baseline/candidate で回す。
 *
 * 安全: 提出evidence（findy_gemini_evidence 等）へは絶対書かない。run-id は常に eval_* を使う。
 *
 * 使用例:
 *   npm run eval:prompt:check                         # 無キー: source-level のみ
 *   npm run eval:prompt -- --steps concept --agent agent_a
 *   npm run eval:prompt:full
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./load-local-env";
import { parseArgs, readJsonOptional } from "./llm-pipeline/shared";
import { pipelineSteps, type PipelineStep } from "./llm-pipeline/types";
import { generateGeminiText } from "./gemini-text";
import {
  conceptDiversity,
  conceptHardRegressions,
  judgeRegression,
  promptWiringChecks,
  publisherHardRegressions,
  reviewerHardRegressions,
  rewriterHardRegressions,
  schemaShapeForStep,
  templateCatalogSync,
  type ConceptDiversity,
  type SchemaShape,
  type StepName,
} from "./prompt-eval-metrics";

const PROMPT_FILE_BY_STEP: Record<PipelineStep, string> = {
  research: "researcher.md",
  combination: "combination-strategist.md",
  concept: "concept-strategist.md",
  "agent-router": "agent-router.md",
  requirements: "requirements.md",
  builder: "builder.md",
  reviewer: "reviewer.md",
  rewriter: "rewriter.md",
  publisher: "publisher.md",
};

const CREATOR_AGENTS = ["agent_a", "agent_b", "agent_c", "agent_d"];

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

const repoRoot = () =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).toString().trim();

const gitShow = (ref: string, repoRelPath: string): string => {
  // ローカルでは `main`、CI(PR)では shallow checkout で `main` が無く `origin/main` のことがある。
  // 両方を順に試し、どちらも取れなければ空（baseline 無し扱い）。
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      return execFileSync("git", ["show", `${candidate}:${repoRelPath}`], {
        cwd: repoRoot(),
        maxBuffer: 1024 * 1024 * 16,
      }).toString();
    } catch {
      // try next candidate
    }
  }
  return "";
};

const toSteps = (value: unknown, fallback: PipelineStep[]): PipelineStep[] => {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const steps = value.split(",").map((item) => item.trim());
  const invalid = steps.filter((step) => !pipelineSteps.includes(step as PipelineStep));
  if (invalid.length > 0) throw new Error(`Invalid --steps value: ${invalid.join(", ")}`);
  return steps as PipelineStep[];
};

const runGeminiOnce = (
  runId: string,
  step: PipelineStep,
  agentId: string,
  extraEnv: Record<string, string> = {},
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join("node_modules", "tsx", "dist", "cli.mjs"),
        path.join("scripts", "llm-pipeline", "run-gemini.ts"),
        "--run",
        runId,
        "--steps",
        step,
        "--agent",
        agentId,
      ],
      { cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: "inherit" },
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`run-gemini exited with ${code}`)),
    );
  });

// 一過性の Gemini エラー（503 UNAVAILABLE / timeout 等）を吸収するため、ステップ単位で
// リトライする。粒度をステップ単位にして、成功済みステップの再実行コストを避ける。
const runGeminiSteps = async (
  runId: string,
  steps: PipelineStep[],
  agentId: string,
  extraEnv: Record<string, string> = {},
  attempts = 3,
) => {
  for (const step of steps) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runGeminiOnce(runId, step, agentId, extraEnv);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `[eval] ${runId}/${step} attempt ${attempt}/${attempts} failed: ${(error as Error).message}; ${attempt < attempts ? "retrying" : "giving up"}`,
        );
      }
    }
    if (lastError) throw lastError;
  }
};

const stepResponsePath = (runId: string, step: PipelineStep) =>
  path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, step, "response.json");

const copyStepDir = async (fromRun: string, toRun: string, step: PipelineStep) => {
  const from = path.join(process.cwd(), "artifacts", "llm-pipeline-runs", fromRun, step);
  const to = path.join(process.cwd(), "artifacts", "llm-pipeline-runs", toRun, step);
  await cp(from, to, { recursive: true });
};

type StepMetrics = {
  step: PipelineStep;
  schema: SchemaShape;
  diversity?: ConceptDiversity;
};

const computeStepMetrics = async (runId: string, step: PipelineStep): Promise<StepMetrics> => {
  const response = await readJsonOptional(stepResponsePath(runId, step));
  const schema = schemaShapeForStep(step as StepName, response);
  const metrics: StepMetrics = { step, schema };
  if (step === "concept") metrics.diversity = conceptDiversity(response);
  return metrics;
};

const RUBRIC_DIMENSIONS = [
  "firstScreenValue",
  "antiGeneric",
  "touchability",
  "diversity",
  "agentFit",
] as const;

const judgeConcept = async (
  runId: string,
  trials: number,
): Promise<{ weightedTotal: number; perDimension: Record<string, number> } | null> => {
  const response = await readJsonOptional<Record<string, unknown>>(stepResponsePath(runId, "concept"));
  if (!response) return null;
  const selected = response.selectedConcept ?? (Array.isArray(response.candidates) ? response.candidates[0] : null);
  if (!selected) return null;

  const prompt = [
    "You are a strict hackathon judge scoring one AI-generated product concept.",
    "Score each dimension from 1 (poor) to 5 (excellent). Return STRICT JSON only:",
    `{ ${RUBRIC_DIMENSIONS.map((d) => `"${d}": <1-5>`).join(", ")} }`,
    "Dimensions:",
    "- firstScreenValue: is the value obvious in the first viewport?",
    "- antiGeneric: is it specific, not a generic AI dashboard/chatbot?",
    "- touchability: is there a concrete user-controlled interaction?",
    "- diversity: is it distinct from common templates?",
    "- agentFit: does the making agent's identity clearly shape it?",
    "Concept JSON:",
    JSON.stringify(selected, null, 2),
  ].join("\n");

  const scores: Record<string, number[]> = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, []]));
  for (let trial = 0; trial < Math.max(1, trials); trial += 1) {
    let text = "";
    try {
      text = await generateGeminiText(prompt, { temperature: 0.2 });
    } catch (error) {
      console.warn(`[eval] judge trial ${trial + 1} failed: ${(error as Error).message}`);
      continue;
    }
    const match = text.replace(/```json|```/gi, "").match(/\{[\s\S]*\}/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      for (const dimension of RUBRIC_DIMENSIONS) {
        const value = Number(parsed[dimension]);
        if (Number.isFinite(value)) scores[dimension].push(value);
      }
    } catch {
      // skip unparseable trial
    }
  }

  const perDimension: Record<string, number> = {};
  let total = 0;
  let counted = 0;
  for (const dimension of RUBRIC_DIMENSIONS) {
    const values = scores[dimension];
    if (values.length === 0) continue;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    perDimension[dimension] = Number(avg.toFixed(2));
    total += avg;
    counted += 1;
  }
  if (counted === 0) return null;
  return { weightedTotal: Number((total / counted).toFixed(2)), perDimension };
};

async function main() {
  const args = parseArgs();
  const evalSteps = toSteps(args.steps, ["concept"]);
  const base = typeof args.base === "string" ? args.base : "main";
  const judgeTrials = typeof args.trials === "string" ? Number(args.trials) : 1;
  const full = args.full === true;
  const forceDryRun = args["dry-run"] === true;
  const seedRunArg = typeof args["seed-run"] === "string" ? args["seed-run"] : undefined;
  const agents = full ? CREATOR_AGENTS : [typeof args.agent === "string" ? args.agent : "agent_a"];

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const responseMode = Boolean(apiKey) && !forceDryRun;

  const outDir = path.join(process.cwd(), "artifacts", "prompt-eval", stamp());
  await mkdir(outDir, { recursive: true });

  const catalog = await readJsonOptional<{ templatePatterns?: Array<{ id?: string }> }>(
    path.join(process.cwd(), "scripts", "templates", "product-templates.json"),
  );
  const catalogIds = (catalog?.templatePatterns ?? [])
    .map((pattern) => pattern.id)
    .filter((id): id is string => Boolean(id));

  // ---- source-level（常時・キー不要） ----
  const sourceLevel: Record<string, unknown> = {};
  const sourceHardFailures: string[] = [];

  // 用語カタログ（_shared/terminology.md）が存在すれば、templatePatternId 列が
  // product-templates.json と同期しているかを assert する（Phase2 4.0）。
  const terminologyPath = path.join(process.cwd(), "scripts", "prompts", "_shared", "terminology.md");
  const terminologyText = await readFile(terminologyPath, "utf8").catch(() => "");
  if (terminologyText) {
    const sync = templateCatalogSync(terminologyText, catalogIds);
    sourceLevel.terminologyCatalogSync = sync;
    if (!sync.ok) {
      sourceHardFailures.push(
        `_shared/terminology.md is out of sync with product-templates.json (missing: ${sync.missing.join(", ")})`,
      );
    }
  }
  for (const step of evalSteps) {
    const file = PROMPT_FILE_BY_STEP[step];
    const candidateText = await readFile(path.join(process.cwd(), "scripts", "prompts", file), "utf8");
    const baselineText = gitShow(base, `apps/web/scripts/prompts/${file}`);

    const candidateWiring = promptWiringChecks(step as StepName, candidateText);
    const baselineWiring = promptWiringChecks(step as StepName, baselineText);
    const catalogStep =
      step === "concept" || step === "builder"
        ? templateCatalogSync(candidateText, catalogIds)
        : { ok: true, missing: [], present: [] };

    if (!catalogStep.ok) {
      sourceHardFailures.push(
        `${step}: prompt is missing templatePatternId(s) from product-templates.json: ${catalogStep.missing.join(", ")}`,
      );
    }

    // 配線退行ガード: baseline で有効だった wiring 指示が candidate で消えたら hard failure。
    // baselineText が空（新規 prompt 等で git に無い）の場合は比較対象が無いのでスキップ。
    const wiringRegressions: string[] = [];
    if (baselineText) {
      for (const [key, baselineOn] of Object.entries(baselineWiring)) {
        if (baselineOn && candidateWiring[key] === false) {
          wiringRegressions.push(key);
          sourceHardFailures.push(
            `${step}: prompt wiring regressed: ${key} was present on ${base} but missing in working tree`,
          );
        }
      }
    }

    sourceLevel[step] = {
      candidateWiring,
      baselineWiring,
      wiringRegressions,
      templateCatalogSync: catalogStep,
    };
  }

  // ---- response-level（キーあり・実Gemini） ----
  let responseLevel: Record<string, unknown> | null = null;
  const hardRegressions: string[] = [...sourceHardFailures];

  if (responseMode) {
    const firstEval = pipelineSteps.find((step) => evalSteps.includes(step))!;
    const lastEvalIndex = Math.max(...evalSteps.map((step) => pipelineSteps.indexOf(step)));
    const firstIndex = pipelineSteps.indexOf(firstEval);
    const prereqSteps = pipelineSteps.slice(0, firstIndex);
    const windowSteps = pipelineSteps.slice(firstIndex, lastEvalIndex + 1);

    // baseline プロンプト一式を temp に取り出す
    const baseTmp = mkdtempSync(path.join(tmpdir(), "prodia-prompts-base-"));
    for (const [, file] of Object.entries(PROMPT_FILE_BY_STEP)) {
      const text = gitShow(base, `apps/web/scripts/prompts/${file}`);
      if (text) await writeFile(path.join(baseTmp, file), text, "utf8");
    }

    const perAgent: Record<string, unknown> = {};
    try {
      for (const agentId of agents) {
        const runStamp = `${stamp()}_${agentId}`;
        const seedRun = seedRunArg ?? `eval_seed_${runStamp}`;
        const baseRun = `eval_base_${runStamp}`;
        const candRun = `eval_cand_${runStamp}`;

        // 上流を一度だけ実走（作業ツリーのプロンプト）。両系で同一の上流を共有する。
        if (!seedRunArg && prereqSteps.length > 0) {
          console.log(`[eval] ${agentId}: running prerequisites ${prereqSteps.join(",")}`);
          await runGeminiSteps(seedRun, prereqSteps, agentId);
        }
        for (const step of prereqSteps) {
          await copyStepDir(seedRun, baseRun, step);
          await copyStepDir(seedRun, candRun, step);
        }

        console.log(`[eval] ${agentId}: baseline window ${windowSteps.join(",")}`);
        await runGeminiSteps(baseRun, windowSteps, agentId, { PRODIA_PROMPTS_DIR: baseTmp });
        console.log(`[eval] ${agentId}: candidate window ${windowSteps.join(",")}`);
        await runGeminiSteps(candRun, windowSteps, agentId);

        const agentResult: Record<string, unknown> = { baseRun, candRun };
        for (const step of evalSteps) {
          const baseM = await computeStepMetrics(baseRun, step);
          const candM = await computeStepMetrics(candRun, step);
          const stepResult: Record<string, unknown> = { base: baseM, candidate: candM };

          if (step === "concept" && baseM.diversity && candM.diversity) {
            const regressions = conceptHardRegressions(
              { schema: baseM.schema, diversity: baseM.diversity },
              { schema: candM.schema, diversity: candM.diversity },
            );
            regressions.forEach((reason) => hardRegressions.push(`${agentId}/${reason}`));

            const baseJudge = await judgeConcept(baseRun, judgeTrials);
            const candJudge = await judgeConcept(candRun, judgeTrials);
            stepResult.judge = { base: baseJudge, candidate: candJudge };
            if (baseJudge && candJudge) {
              const reason = judgeRegression(baseJudge.weightedTotal, candJudge.weightedTotal);
              if (reason) hardRegressions.push(`${agentId}/concept ${reason}`);
            }
          } else {
            if (baseM.schema.ok && !candM.schema.ok) {
              hardRegressions.push(
                `${agentId}/${step} schema-shape regressed (missing: ${candM.schema.missing.join(", ")})`,
              );
            }
            // 後段(reviewer/rewriter/publisher)の判定品質の退行を base/cand の実 response で比較。
            if (step === "reviewer" || step === "rewriter" || step === "publisher") {
              const baseResp = await readJsonOptional(stepResponsePath(baseRun, step));
              const candResp = await readJsonOptional(stepResponsePath(candRun, step));
              const lateRegressions =
                step === "reviewer"
                  ? reviewerHardRegressions(baseResp, candResp)
                  : step === "rewriter"
                    ? rewriterHardRegressions(baseResp, candResp)
                    : publisherHardRegressions(baseResp, candResp);
              lateRegressions.forEach((reason) => hardRegressions.push(`${agentId}/${reason}`));
              stepResult.lateRegressions = lateRegressions;
            }
          }
          agentResult[step] = stepResult;
        }
        perAgent[agentId] = agentResult;
      }
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
    }
    responseLevel = { base, evalSteps, prereqSteps, windowSteps, perAgent };
  }

  const summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: responseMode ? "response-level" : "source-level",
    base,
    evalSteps,
    agents,
    judgeTrials,
    sourceLevel,
    responseLevel,
    hardRegressions,
    verdict: hardRegressions.length === 0 ? "ok" : "hard_regression",
  };

  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const report = [
    `# Prompt refinement eval — ${summary.mode}`,
    "",
    `- generatedAt: ${summary.generatedAt}`,
    `- base ref: ${base}`,
    `- eval steps: ${evalSteps.join(", ")}`,
    `- agents: ${agents.join(", ")}`,
    `- verdict: **${summary.verdict}**`,
    "",
    "## Source-level (key-free)",
    ...evalSteps.map((step) => {
      const entry = sourceLevel[step] as { templateCatalogSync: { ok: boolean; missing: string[] }; candidateWiring: Record<string, boolean> };
      const wiring = Object.entries(entry.candidateWiring)
        .map(([k, v]) => `${k}=${v ? "yes" : "no"}`)
        .join(", ");
      return `- ${step}: catalogSync=${entry.templateCatalogSync.ok ? "ok" : `MISSING ${entry.templateCatalogSync.missing.join("/")}`}; wiring: ${wiring || "(n/a)"}`;
    }),
    "",
    responseMode ? "## Response-level (real Gemini)" : "## Response-level: skipped (no API key or --dry-run)",
    ...(responseMode
      ? [`See summary.json responseLevel for per-agent base/candidate metrics and judge deltas.`]
      : []),
    "",
    "## Hard regressions",
    ...(hardRegressions.length === 0
      ? ["- none"]
      : hardRegressions.map((reason) => `- ${reason}`)),
  ].join("\n");

  await writeFile(path.join(outDir, "report.md"), `${report}\n`, "utf8");

  console.log("");
  console.log(`Eval mode: ${summary.mode}`);
  console.log(`Output: ${path.relative(process.cwd(), outDir).replaceAll("\\", "/")}`);
  console.log(`Verdict: ${summary.verdict}`);
  if (hardRegressions.length > 0) {
    console.log("Hard regressions:");
    hardRegressions.forEach((reason) => console.log(`  - ${reason}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
