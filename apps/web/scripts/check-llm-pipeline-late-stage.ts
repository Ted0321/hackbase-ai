import path from "node:path";
import { spawnSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import type { BuildPlan, PipelineStep, PublishDecision, ReviewResult } from "./llm-pipeline/types";
import { artifactRoot, parseArgs, readJsonOptional, stepDir } from "./llm-pipeline/shared";

type Issue = {
  level: "error" | "warning";
  step?: PipelineStep | "materialized";
  message: string;
};

/**
 * Late-stage chain check (DOC-54 Step3 / Lane V).
 *
 * Verifies that the back half of the pipeline
 * (requirements -> builder -> reviewer -> rewriter -> publisher)
 * is wired together under a single runId:
 *  - required step files exist under the same runId
 *  - the builder mvpContract matches the materialized artifact
 *  - the publisher decision does not contradict the validation result
 */
const baseLateStageSteps: PipelineStep[] = ["requirements", "builder", "reviewer", "publisher"];

// Files every accepted late-stage step is expected to carry.
const requiredStepFiles = ["prompt.md", "input.json", "response.json", "accepted.json", "metadata.json"] as const;

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = async (dirPath: string) => {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
};

/** Collect every file path under root, returned relative to root with forward slashes. */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  await walk(root, "");
  return out;
}

const accepted = (decision: ReviewResult["status"]) => decision === "pass";

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
  const requireRequirementContract =
    args["require-requirement-contract"] === true || args["require-requirement-contract"] === "true";
  const requireLateStageContracts =
    args["require-late-stage-contracts"] === true || args["require-late-stage-contracts"] === "true";
  const requireRewriter = args["require-rewriter"] === true || args["require-rewriter"] === "true";
  const issues: Issue[] = [];

  if (!runId) {
    throw new Error("--run is required");
  }

  const root = artifactRoot(runId);
  const lateStageSteps: PipelineStep[] = requireRewriter
    ? ["requirements", "builder", "reviewer", "rewriter", "publisher"]
    : baseLateStageSteps;
  if (!(await isDirectory(root))) {
    issues.push({ level: "error", message: `Missing run directory for ${runId}` });
  }

  // 1. Required files for every late-stage step under the same runId.
  for (const step of lateStageSteps) {
    const dir = stepDir(runId, step);
    if (!(await isDirectory(dir))) {
      issues.push({ level: "error", step, message: "Missing step directory" });
      continue;
    }
    for (const fileName of requiredStepFiles) {
      if (!(await exists(path.join(dir, fileName)))) {
        issues.push({ level: "error", step, message: `Missing ${fileName}` });
      }
    }
  }

  // 2. builder mvpContract <-> materialized artifact consistency.
  const buildPlan = await readJsonOptional<BuildPlan>(path.join(stepDir(runId, "builder"), "response.json"));
  if (buildPlan === null) {
    issues.push({ level: "error", step: "builder", message: "response.json is missing or invalid JSON" });
  } else if (!buildPlan.mvpContract) {
    issues.push({ level: "error", step: "builder", message: "response.json has no mvpContract" });
  } else {
    const requiredFiles = buildPlan.mvpContract.requiredFiles ?? [];
    if (requiredFiles.length === 0) {
      issues.push({ level: "error", step: "builder", message: "mvpContract.requiredFiles is empty" });
    }

    const materializedRoot = path.join(root, "materialized");
    if (!(await isDirectory(materializedRoot))) {
      issues.push({
        level: "error",
        step: "materialized",
        message: "Missing materialized/ directory for builder mvpContract",
      });
    } else {
      const artifactDirs = (await readdir(materializedRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      if (artifactDirs.length === 0) {
        issues.push({ level: "error", step: "materialized", message: "No materialized artifact directory found" });
      }

      for (const artifactDir of artifactDirs) {
        const artifactRootDir = path.join(materializedRoot, artifactDir);
        const materializedFiles = new Set(await listFilesRecursive(artifactRootDir));
        // requiredFiles are relative to the artifact source root; the materializer nests them under source/.
        for (const required of requiredFiles) {
          const candidates = [required, `source/${required}`];
          const found = candidates.some((candidate) => materializedFiles.has(candidate));
          if (!found) {
            issues.push({
              level: "error",
              step: "materialized",
              message: `mvpContract.requiredFiles entry not materialized in ${artifactDir}: ${required}`,
            });
          }
        }
      }
    }
  }

  if (requireRequirementContract) {
    const result = runTsxCheck("scripts/check-requirement-spec.ts", ["--run", runId]);
    if (!result.ok) {
      issues.push({
        level: "error",
        step: "requirements",
        message: `RequirementSpec contract failed${result.output ? `\n${result.output}` : ""}`,
      });
    }
  }

  if (requireLateStageContracts) {
    const result = runTsxCheck("scripts/check-late-stage-contracts.ts", [
      "--run",
      runId,
      ...(requireRewriter ? ["--include-rewriter"] : []),
    ]);
    if (!result.ok) {
      issues.push({
        level: "error",
        step: "publisher",
        message: `Late-stage response contract failed${result.output ? `\n${result.output}` : ""}`,
      });
    }
  }

  // 3. publisher decision <-> validation / review contradictions.
  const publishDecision = await readJsonOptional<PublishDecision>(
    path.join(stepDir(runId, "publisher"), "response.json"),
  );
  const reviewResult = await readJsonOptional<ReviewResult>(path.join(stepDir(runId, "reviewer"), "response.json"));

  if (publishDecision === null) {
    issues.push({ level: "error", step: "publisher", message: "response.json is missing or invalid JSON" });
  } else {
    if (publishDecision.status === "publish") {
      if (publishDecision.validationPass === false) {
        issues.push({
          level: "error",
          step: "publisher",
          message: "status=publish but validationPass=false",
        });
      }
      if (publishDecision.reviewPass === false) {
        issues.push({
          level: "error",
          step: "publisher",
          message: "status=publish but reviewPass=false",
        });
      }
      if (publishDecision.requiredArtifactsPresent === false) {
        issues.push({
          level: "error",
          step: "publisher",
          message: "status=publish but requiredArtifactsPresent=false",
        });
      }
      if (publishDecision.mvpContractPass === false) {
        issues.push({
          level: "error",
          step: "publisher",
          message: "status=publish but mvpContractPass=false",
        });
      }
      if (publishDecision.safetyBlockers && publishDecision.safetyBlockers.length > 0) {
        issues.push({
          level: "error",
          step: "publisher",
          message: `status=publish but ${publishDecision.safetyBlockers.length} safetyBlocker(s) present`,
        });
      }
    }

    // Cross-check the publisher's reviewPass claim against the reviewer's own verdict.
    if (reviewResult && publishDecision.reviewPass === true && !accepted(reviewResult.status)) {
      issues.push({
        level: "error",
        step: "publisher",
        message: `reviewPass=true but reviewer status=${reviewResult.status}`,
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
    `LLM pipeline late-stage check: ${errors.length} error(s), ${warnings.length} warning(s) for ${runId}`,
  );
  console.log(`Checked steps: ${lateStageSteps.join(" -> ")}`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
