import { access } from "node:fs/promises";
import path from "node:path";

const pipelineSteps = (steps: string) =>
  steps
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function assertPipelineResponsesWritten(runId: string, steps: string) {
  const missing: string[] = [];
  const dryRunPrepared: string[] = [];

  for (const step of pipelineSteps(steps)) {
    const stepDir = path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, step);
    if (await pathExists(path.join(stepDir, "response.json"))) continue;
    if (await pathExists(path.join(stepDir, "gemini-dry-run.json"))) {
      dryRunPrepared.push(step);
      continue;
    }
    missing.push(step);
  }

  if (missing.length > 0 || dryRunPrepared.length > 0) {
    const details = [
      missing.length > 0 ? `missing response.json: ${missing.join(", ")}` : null,
      dryRunPrepared.length > 0 ? `dry-run artifacts only: ${dryRunPrepared.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Pipeline did not produce required response.json files for run ${runId}. ${details}. ` +
        "Check GEMINI_API_KEY or re-run with --dry-run intentionally.",
    );
  }
}
