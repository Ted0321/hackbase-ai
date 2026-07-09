import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipelineSteps, type PipelineRunManifest, type PipelineStep } from "./types";

export type CliArgs = Record<string, string | boolean>;

export const parseArgs = (raw = process.argv.slice(2)): CliArgs => {
  const args: CliArgs = {};

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
};

export const isPipelineStep = (value: string): value is PipelineStep =>
  (pipelineSteps as readonly string[]).includes(value);

export const requireStep = (value: unknown): PipelineStep => {
  if (typeof value !== "string" || !isPipelineStep(value)) {
    throw new Error(`--step must be one of: ${pipelineSteps.join(", ")}`);
  }
  return value;
};

export const createRunId = () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `llm_pipeline_${stamp}`;
};

export const artifactRoot = (runId: string) =>
  path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId);

export const relativeArtifactRoot = (runId: string) =>
  path.join("artifacts", "llm-pipeline-runs", runId).replaceAll("\\", "/");

export async function ensureRun(runId: string) {
  const root = artifactRoot(runId);
  await mkdir(root, { recursive: true });

  const manifestPath = path.join(root, "manifest.json");
  const existing = await readJsonOptional<PipelineRunManifest>(manifestPath);
  if (existing) return existing;

  const manifest: PipelineRunManifest = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    steps: [...pipelineSteps],
    outputRoot: relativeArtifactRoot(runId),
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

export const stepDir = (runId: string, step: PipelineStep) => path.join(artifactRoot(runId), step);

export async function ensureStepDir(runId: string, step: PipelineStep) {
  const dir = stepDir(runId, step);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readText(filePath: string) {
  return readFile(filePath, "utf8");
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readText(filePath)) as T;
}

export async function readJsonOptional<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch {
    return null;
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

// 既定は scripts/prompts。評価ハーネス（eval-prompt-refinement.ts）が変更前プロンプトで
// ベースライン実行する際だけ PRODIA_PROMPTS_DIR を一時ディレクトリに向ける。未設定時は無害。
export const promptsBaseDir = () =>
  process.env.PRODIA_PROMPTS_DIR && process.env.PRODIA_PROMPTS_DIR.trim() !== ""
    ? path.resolve(process.env.PRODIA_PROMPTS_DIR)
    : path.join(process.cwd(), "scripts", "prompts");

export const promptPathForStep = (step: PipelineStep) => {
  const fileNameByStep: Record<PipelineStep, string> = {
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
  return path.join(promptsBaseDir(), fileNameByStep[step]);
};

export const fixturePath = (fileName: string) =>
  path.join(process.cwd(), "scripts", "llm-pipeline", "fixtures", fileName);

export async function readStepResponse(runId: string, step: PipelineStep) {
  return readJsonOptional(path.join(stepDir(runId, step), "response.json"));
}

export async function readStepInput(runId: string, step: PipelineStep) {
  return readJsonOptional(path.join(stepDir(runId, step), "input.json"));
}

export const previousSteps = (step: PipelineStep) => {
  const index = pipelineSteps.indexOf(step);
  return index <= 0 ? [] : pipelineSteps.slice(0, index);
};

export async function collectPreviousResponses(runId: string, step: PipelineStep) {
  const responses: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const previous of previousSteps(step)) {
    const response = await readStepResponse(runId, previous);
    if (response) {
      responses[previous] = response;
    } else {
      missing.push(previous);
    }
  }

  return { responses, missing };
}

export function handoffMarkdown(args: {
  runId: string;
  step: PipelineStep;
  inputPath: string;
  promptPath: string;
  responsePath: string;
}) {
  return [
    `# LLM Pipeline Handoff: ${args.step}`,
    "",
    "1. Open `prompt.md`.",
    "2. Provide `input.json` as the structured input.",
    "3. Ask the LLM to return strict JSON only.",
    "4. Save the returned JSON as a local file.",
    "5. Import it with:",
    "",
    "```powershell",
    `npm run llm:pipeline:accept -- --run ${args.runId} --step ${args.step} --response <path-to-response.json>`,
    "```",
    "",
    "Files:",
    `- prompt: ${args.promptPath}`,
    `- input: ${args.inputPath}`,
    `- expected response target: ${args.responsePath}`,
  ].join("\n");
}
