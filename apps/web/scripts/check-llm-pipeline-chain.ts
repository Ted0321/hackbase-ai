import path from "node:path";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { pipelineSteps, type PipelineStep } from "./llm-pipeline/types";
import { artifactRoot, parseArgs, stepDir } from "./llm-pipeline/shared";

type Issue = {
  level: "error" | "warning";
  step?: PipelineStep;
  message: string;
};

const requiredPreparedFiles = ["input.json", "prompt.md", "gemini-request.json"] as const;
const defaultCheckSteps: PipelineStep[] = ["research", "combination", "concept", "agent-router"];

const directDependencies: Record<PipelineStep, PipelineStep[]> = {
  research: [],
  combination: ["research"],
  concept: ["research", "combination"],
  "agent-router": ["concept"],
  requirements: ["concept", "agent-router"],
  builder: ["concept", "agent-router", "requirements"],
  reviewer: ["concept", "requirements", "builder"],
  rewriter: ["concept", "requirements", "builder", "reviewer"],
  publisher: ["concept", "agent-router", "requirements", "builder", "reviewer"],
};

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonOptional = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const stepsFromArgs = (value: string | boolean | undefined): PipelineStep[] => {
  if (value === true || value === undefined) {
    return defaultCheckSteps;
  }
  if (value === false) {
    return defaultCheckSteps;
  }
  if (value === "all") {
    return [...pipelineSteps];
  }

  const steps = value.split(",").map((item: string) => item.trim());
  const invalid = steps.filter((step: string): step is string => !pipelineSteps.includes(step as PipelineStep));
  if (invalid.length > 0) {
    throw new Error(`Invalid --steps value: ${invalid.join(", ")}`);
  }
  return steps as PipelineStep[];
};

const inputHasMissingRequiredResponses = (
  input: unknown,
  step: PipelineStep,
): string[] => {
  if (!input || typeof input !== "object") return directDependencies[step];
  const record = input as Record<string, unknown>;
  const status = record.previousResponseStatus;
  if (status && typeof status === "object") {
    const missing = (status as Record<string, unknown>).missingRequiredPreviousResponses;
    return Array.isArray(missing)
      ? missing.filter((item): item is string => typeof item === "string")
      : [];
  }
  const missing = record.missingPreviousResponses;
  return Array.isArray(missing)
    ? directDependencies[step].filter((dependency) => missing.includes(dependency))
    : [];
};

const runTsxCheck = (script: string, args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
};

async function main() {
  const args = parseArgs();
  const runId = typeof args.run === "string" ? args.run : "";
  const checkSteps = stepsFromArgs(args.steps);
  const requireResponses = args["require-responses"] === true || args["require-responses"] === "true";
  const requireSourceProvenance =
    args["require-source-provenance"] === true || args["require-source-provenance"] === "true";
  const issues: Issue[] = [];

  if (!runId) {
    throw new Error("--run is required");
  }

  const manifestPath = path.join(artifactRoot(runId), "manifest.json");
  if (!(await exists(manifestPath))) {
    issues.push({ level: "error", message: `Missing manifest.json for run ${runId}` });
  }

  for (const step of checkSteps) {
    const dir = stepDir(runId, step);
    for (const fileName of requiredPreparedFiles) {
      const filePath = path.join(dir, fileName);
      if (!(await exists(filePath))) {
        issues.push({ level: "error", step, message: `Missing ${fileName}` });
      }
    }

    const inputPath = path.join(dir, "input.json");
    const input = await readJsonOptional<unknown>(inputPath);
    if (input === null) {
      issues.push({ level: "error", step, message: "input.json is missing or invalid JSON" });
    } else {
      const missingRequired = inputHasMissingRequiredResponses(input, step);
      if (missingRequired.length > 0) {
        issues.push({
          level: requireResponses ? "error" : "warning",
          step,
          message: `Prepared without required upstream response.json: ${missingRequired.join(", ")}`,
        });
      }
    }

    const responsePath = path.join(dir, "response.json");
    if (requireResponses && !(await exists(responsePath))) {
      issues.push({ level: "error", step, message: "Missing response.json" });
    }
  }

  if (requireSourceProvenance) {
    const result = runTsxCheck("scripts/check-source-provenance-contract.ts", ["--run", runId]);
    if (!result.ok) {
      issues.push({
        level: "error",
        message: `Source provenance contract failed${result.output ? `\n${result.output}` : ""}`,
      });
    }
  }

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");

  for (const issue of issues) {
    const prefix = issue.step ? `${issue.level.toUpperCase()} ${issue.step}:` : `${issue.level.toUpperCase()}:`;
    console.log(`${prefix} ${issue.message}`);
  }

  console.log(
    `LLM pipeline chain check: ${errors.length} error(s), ${warnings.length} warning(s) for ${runId}`,
  );
  console.log(`Checked steps: ${checkSteps.join(" -> ")}`);

  if (runId === "findy_gemini_evidence") {
    const reportPath = path.join(artifactRoot(runId), "block-a-chain-check.md");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      [
        "# Findy Block A LLM Chain Check",
        "",
        `Run: ${runId}`,
        `Checked steps: ${checkSteps.join(" -> ")}`,
        `Result: ${errors.length === 0 ? "pass" : "fail"}`,
        `Errors: ${errors.length}`,
        `Warnings: ${warnings.length}`,
        "",
        "Issues:",
        issues.length > 0
          ? issues.map((issue) => `- ${issue.level}${issue.step ? ` ${issue.step}` : ""}: ${issue.message}`).join("\n")
          : "- none",
        "",
      ].join("\n"),
      "utf8",
    );
    console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
