import path from "node:path";
import { checkAgentRuntimeReflection } from "./check-agent-runtime-reflection";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";
import { isPipelineStep, parseArgs, readJsonOptional, type CliArgs } from "./llm-pipeline/shared";
import type { PipelineStep } from "./llm-pipeline/types";
import {
  builderQuality,
  conceptQuality,
  requirementsQuality,
  schemaShapeForStep,
  type StepName,
} from "./prompt-eval-metrics";

type Check = {
  id: string;
  status: "pass" | "fail" | "warn";
  message: string;
};

export type PipelineStepQualityResult = {
  responsePath: string;
  inputPath: string | null;
  step: PipelineStep;
  result: "pass" | "fail";
  checks: Check[];
};

const resolvePaths = (args: CliArgs, step: PipelineStep) => {
  const runId = typeof args.run === "string" ? args.run : "";
  const responsePath =
    typeof args.path === "string"
      ? args.path
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, step, "response.json")
        : "";
  const inputPath =
    typeof args.input === "string"
      ? args.input
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, step, "input.json")
        : "";
  return { responsePath, inputPath };
};

const stepQualityFor = (step: PipelineStep, response: unknown) => {
  if (step === "concept") return conceptQuality(response);
  if (step === "requirements") return requirementsQuality(response);
  if (step === "builder") return builderQuality(response);
  return null;
};

const reflectionValidatedSteps = new Set<PipelineStep>(["concept", "requirements", "builder"]);

export const checkPipelineStepQuality = ({
  step,
  response,
  input,
  responsePath,
  inputPath,
}: {
  step: PipelineStep;
  response: unknown;
  input?: unknown;
  responsePath: string;
  inputPath?: string | null;
}): PipelineStepQualityResult => {
  const checks: Check[] = [];

  if (!response) {
    checks.push({ id: "response", status: "fail", message: `Could not read response JSON: ${responsePath}` });
  } else {
    const schema = schemaShapeForStep(step as StepName, response);
    checks.push({
      id: "schema",
      status: schema.ok ? "pass" : "fail",
      message: schema.ok ? "schema shape passed" : `schema missing: ${schema.missing.join(", ")}`,
    });

    const quality = stepQualityFor(step, response);
    if (quality) {
      checks.push({
        id: "step_quality",
        status: quality.ok ? "pass" : "fail",
        message: quality.ok
          ? `step quality passed (${quality.passed}/${quality.total})`
          : `step quality failed: ${quality.issues.slice(0, 8).map((issue) => `${issue.check}: ${issue.detail}`).join("; ")}`,
      });
    }

    const textIssues = findMojibakeLikeTextIssues(response, { maxIssues: 8 });
    checks.push({
      id: "text_quality",
      status: textIssues.length === 0 ? "pass" : "fail",
      message:
        textIssues.length === 0
          ? "no mojibake-like text found"
          : `mojibake-like text found: ${textIssues.map((issue) => `${issue.path}:${issue.term}`).join(", ")}`,
    });

    if (reflectionValidatedSteps.has(step) && inputPath && !input) {
      checks.push({
        id: "agent_runtime_reflection",
        status: "fail",
        message: `Could not read input JSON required for runtime reflection validation: ${inputPath}`,
      });
    } else if (input && reflectionValidatedSteps.has(step)) {
      const reflection = checkAgentRuntimeReflection({ step, response, input, path: responsePath });
      checks.push({
        id: "agent_runtime_reflection",
        status: reflection.result === "pass" ? "pass" : "fail",
        message:
          reflection.result === "pass"
            ? reflection.summary
            : reflection.checks
                .filter((check) => check.status === "fail")
                .slice(0, 8)
                .map((check) => `${check.id}: ${check.message}`)
                .join("; "),
      });
    }
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const result = {
    responsePath,
    inputPath: inputPath ?? null,
    step,
    result: failCount > 0 ? "fail" : "pass",
    checks,
  } satisfies PipelineStepQualityResult;

  return result;
};

async function main() {
  const args = parseArgs();
  const stepRaw = typeof args.step === "string" ? args.step : "";
  if (!isPipelineStep(stepRaw)) {
    console.error("Usage: tsx scripts/check-pipeline-step-quality.ts --step <step> (--run <runId> OR --path <response.json>)");
    process.exit(2);
  }

  const step = stepRaw;
  const { responsePath, inputPath } = resolvePaths(args, step);
  if (!responsePath) {
    console.error("Usage: --run <runId> OR --path <response.json>");
    process.exit(2);
  }

  const resolvedResponsePath = path.resolve(process.cwd(), responsePath);
  const resolvedInputPath = inputPath ? path.resolve(process.cwd(), inputPath) : null;
  const response = await readJsonOptional(resolvedResponsePath);
  const input = resolvedInputPath ? await readJsonOptional(resolvedInputPath) : null;
  const result = checkPipelineStepQuality({
    step,
    response,
    input,
    responsePath: resolvedResponsePath,
    inputPath: resolvedInputPath,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Result: ${result.result.toUpperCase()}`);
  if (result.result === "fail") process.exit(1);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/check-pipeline-step-quality.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
