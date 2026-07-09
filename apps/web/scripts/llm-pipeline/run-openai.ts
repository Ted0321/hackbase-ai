import { spawn } from "node:child_process";
import path from "node:path";
import "../load-local-env";
import {
  createRunId,
  ensureRun,
  parseArgs,
  readJson,
  readText,
  stepDir,
  writeJson,
} from "./shared";
import { pipelineSteps, type PipelineStep } from "./types";

type OpenAiResponse = Record<string, unknown>;

type Args = {
  runId: string;
  model: string;
  steps: PipelineStep[];
  dryRun: boolean;
};

const defaultSteps: PipelineStep[] = ["research", "combination", "concept"];

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
  const runId = typeof args.run === "string" ? args.run : createRunId();
  const model =
    typeof args.model === "string" ? args.model : process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const dryRun =
    args["dry-run"] === true || args["dry-run"] === "true" || !process.env.OPENAI_API_KEY;

  return {
    runId,
    model,
    steps: toPipelineSteps(args.steps),
    dryRun,
  };
};

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, ...args], {
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

const prepareStep = async (runId: string, step: PipelineStep) => {
  await runTsx(path.join("scripts", "llm-pipeline", "prepare-step.ts"), [
    "--run",
    runId,
    "--step",
    step,
  ]);
};

const callOpenAI = async (model: string, prompt: string, input: unknown) => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            "You are executing one step of Hackbase.ai's LLM pipeline.",
            "Follow the provided step prompt exactly.",
            "Return strict JSON only. Do not include Markdown or commentary.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              stepPrompt: prompt,
              structuredInput: input,
            },
            null,
            2,
          ),
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as OpenAiResponse;
};

const extractResponseText = (response: unknown): string => {
  if (typeof response === "string") {
    return response;
  }

  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const text = (contentItem as Record<string, unknown>).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
};

const parseResponseJson = (response: unknown) => {
  const text = extractResponseText(response);
  if (!text) {
    throw new Error("OpenAI response did not contain output text.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("OpenAI output was not parseable as JSON.");
    }
    return JSON.parse(match[0]) as unknown;
  }
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

async function main() {
  const args = parseRunArgs();
  await ensureRun(args.runId);

  for (const step of args.steps) {
    await prepareStep(args.runId, step);
    const dir = stepDir(args.runId, step);
    const prompt = await readText(path.join(dir, "prompt.md"));
    const input = await readJson(path.join(dir, "input.json"));
    const rawResponsePath = path.join(dir, "openai-response.raw.json");
    const parsedResponsePath = path.join(dir, "response.json");

    if (args.dryRun) {
      await writeJson(path.join(dir, "openai-dry-run.json"), {
        version: 1,
        runId: args.runId,
        step,
        model: args.model,
        generatedAt: new Date().toISOString(),
        status: "prompt_ready",
        summary:
          "OPENAI_API_KEY is missing or --dry-run was specified, so this step was prepared but not sent to OpenAI.",
      });
      console.log(`Dry run prepared: ${step}`);
      continue;
    }

    const rawResponse = await callOpenAI(args.model, prompt, input);
    const parsedResponse = parseResponseJson(rawResponse);
    await writeJson(rawResponsePath, rawResponse);
    await writeJson(parsedResponsePath, parsedResponse);

    console.log(`Completed ${step}: ${summarizeStep(step, parsedResponse)}`);
  }

  console.log("");
  console.log(args.dryRun ? "LLM pipeline dry run prepared." : "LLM pipeline OpenAI run completed.");
  console.log(`Run: ${args.runId}`);
  console.log(`Root: artifacts/llm-pipeline-runs/${args.runId}`);
  console.log(`Model: ${args.model}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
