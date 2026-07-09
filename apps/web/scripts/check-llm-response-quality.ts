import path from "node:path";
import { isPipelineStep, parseArgs, readJsonOptional, type CliArgs } from "./llm-pipeline/shared";
import { pipelineSteps, type PipelineStep } from "./llm-pipeline/types";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

const resolveResponsePaths = (args: CliArgs) => {
  const explicitPath = typeof args.path === "string" ? String(args.path) : "";
  if (explicitPath) return [explicitPath];

  const runId = typeof args.run === "string" ? String(args.run) : "";
  if (!runId) {
    console.error("Usage: tsx scripts/check-llm-response-quality.ts (--run <runId> [--step <step>] OR --path <response.json>)");
    process.exit(1);
  }

  const stepRaw = typeof args.step === "string" ? String(args.step) : "";
  const steps: PipelineStep[] = stepRaw
    ? isPipelineStep(stepRaw)
      ? [stepRaw]
      : (() => {
          throw new Error(`Invalid --step value: ${stepRaw}`);
        })()
    : [...pipelineSteps];

  return steps.map((step) => path.join("artifacts", "llm-pipeline-runs", runId, step, "response.json"));
};

async function main() {
  const args = parseArgs();
  const paths = resolveResponsePaths(args);
  const results = [];

  for (const responsePath of paths) {
    const absolutePath = path.resolve(process.cwd(), responsePath);
    const response = await readJsonOptional(absolutePath);
    if (!response) continue;
    const issues = findMojibakeLikeTextIssues(response, { maxIssues: 20 });
    results.push({
      path: absolutePath,
      result: issues.length > 0 ? "fail" : "pass",
      issues,
    });
  }

  const failCount = results.filter((result) => result.result === "fail").length;
  console.log(JSON.stringify({ checked: results.length, failCount, results }, null, 2));
  console.log("");
  console.log(failCount > 0 ? `Result: FAIL - ${failCount} response file(s) failed` : "Result: PASS");

  if (failCount > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
