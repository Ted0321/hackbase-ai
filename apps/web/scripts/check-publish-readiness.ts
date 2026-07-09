import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

type GateStatus = "pass" | "fail" | "warn";

type GateResult = {
  id: string;
  status: GateStatus;
  message: string;
  evidencePath?: string;
};

type ReadinessResult = {
  version: 1;
  generatedAt: string;
  mode: "unattended_auto_publish";
  artifactPath: string;
  runId: string | null;
  result: "pass" | "fail";
  blockers: string[];
  warnings: string[];
  gateResults: GateResult[];
  evidencePaths: Record<string, string | null>;
  publisherStatus: string | null;
  reviewerStatus: string | null;
  validationStatus: string | null;
  mvpResult: string | null;
  mvpContractV2Result: string | null;
  interactionProofResult: string | null;
  renderProofResult: string | null;
};

type JsonRecord = Record<string, unknown>;

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const artifactPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  if (!artifactPath) {
    console.error(
      "Usage: tsx scripts/check-publish-readiness.ts --path <artifact-dir> [--run <runId>] [--write] [--output <publish-readiness.json>]",
    );
    process.exit(1);
  }

  return {
    artifactPath,
    runId: typeof values.get("run") === "string" ? String(values.get("run")) : "",
    write: values.get("write") === true,
    output: typeof values.get("output") === "string" ? String(values.get("output")) : "",
  };
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isNonEmptyString(item)) : [];

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const toRel = (filePath: string) =>
  path.relative(process.cwd(), filePath).replace(/\\/g, "/");

const addGate = (
  gates: GateResult[],
  id: string,
  ok: boolean,
  pass: string,
  fail: string,
  evidencePath?: string | null,
) => {
  gates.push({
    id,
    status: ok ? "pass" : "fail",
    message: ok ? pass : fail,
    ...(evidencePath ? { evidencePath: toRel(evidencePath) } : {}),
  });
};

const addWarning = (
  gates: GateResult[],
  id: string,
  message: string,
  evidencePath?: string | null,
) => {
  gates.push({
    id,
    status: "warn",
    message,
    ...(evidencePath ? { evidencePath: toRel(evidencePath) } : {}),
  });
};

const publicCopyPayload = (metadata: JsonRecord | null, publisher: JsonRecord | null) => {
  const payload: JsonRecord = {};
  if (isRecord(metadata)) {
    payload.metadata = {
      title: metadata.title,
      oneLiner: metadata.oneLiner,
      generatedOutput: metadata.generatedOutput,
      sourceFiles: Array.isArray(metadata.sourceFiles)
        ? metadata.sourceFiles.map((file) =>
            isRecord(file)
              ? {
                  relativePath: file.relativePath,
                  purpose: file.purpose,
                }
              : file,
          )
        : undefined,
      demo: metadata.demo,
      readiness: metadata.readiness,
      mvpContract: metadata.mvpContract,
      mvpContractV2: isRecord(metadata.mvpContractV2)
        ? {
            claimBoundary: metadata.mvpContractV2.claimBoundary,
            humanReviewTriggers: metadata.mvpContractV2.humanReviewTriggers,
          }
        : undefined,
      interactionProofPlan: isRecord(metadata.interactionProofPlan)
        ? {
            primaryAction: metadata.interactionProofPlan.primaryAction,
            initialState: metadata.interactionProofPlan.initialState,
            expectedState: metadata.interactionProofPlan.expectedState,
            visibleEvidence: metadata.interactionProofPlan.visibleEvidence,
          }
        : undefined,
      implementationNotes: metadata.implementationNotes,
      knownRisks: metadata.knownRisks,
    };
  }
  if (isRecord(publisher)) {
    payload.publisher = {
      reason: publisher.reason,
      publishSummary: publisher.publishSummary,
      safetyBlockers: publisher.safetyBlockers,
    };
  }
  return payload;
};

const parseFirstJsonObject = (text: string): unknown | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const deriveRunRoot = (artifactDir: string, runId: string): { runRoot: string | null; runId: string | null } => {
  if (runId) {
    return {
      runRoot: path.resolve(process.cwd(), "artifacts", "llm-pipeline-runs", runId),
      runId,
    };
  }

  const parent = path.dirname(artifactDir);
  if (path.basename(parent) === "materialized") {
    const runRoot = path.dirname(parent);
    return { runRoot, runId: path.basename(runRoot) };
  }

  let dir = artifactDir;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      existsSync(path.join(dir, "publisher", "response.json")) ||
      existsSync(path.join(dir, "validation-summary.json"))
    ) {
      return { runRoot: dir, runId: path.basename(dir) };
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return { runRoot: null, runId: null };
};

const runMvpStrictCheck = (artifactPath: string): { result: JsonRecord | null; output: string; exitCode: number } => {
  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/check-mvp-artifact.ts",
      "--path",
      artifactPath,
      "--strict-auto-publish",
      "--json-only",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
      },
    },
  );

  const output = [child.stdout, child.stderr].filter(Boolean).join("\n");
  const parsed = parseFirstJsonObject(output);
  return {
    result: isRecord(parsed) ? parsed : null,
    output,
    exitCode: typeof child.status === "number" ? child.status : 1,
  };
};

const runInteractionProofCheck = (
  artifactPath: string,
  writeReport: boolean,
): { result: JsonRecord | null; output: string; exitCode: number } => {
  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/check-interaction-proof.ts",
      "--path",
      artifactPath,
      ...(writeReport ? ["--write"] : []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
      },
    },
  );

  const output = [child.stdout, child.stderr].filter(Boolean).join("\n");
  const parsed = parseFirstJsonObject(output);
  return {
    result: isRecord(parsed) ? parsed : null,
    output,
    exitCode: typeof child.status === "number" ? child.status : 1,
  };
};

const runRenderProofCheck = (
  artifactPath: string,
  writeReport: boolean,
): { result: JsonRecord | null; output: string; exitCode: number } => {
  const reportPath = path.join(artifactPath, "validation", "render-verification.json");
  if (!writeReport && existsSync(reportPath)) {
    try {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
      return {
        result: isRecord(parsed) ? parsed : null,
        output: "",
        exitCode: isRecord(parsed) && parsed.result === "pass" ? 0 : 1,
      };
    } catch {
      return {
        result: null,
        output: "",
        exitCode: 1,
      };
    }
  }

  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/render-materialized-artifact.ts",
      "--path",
      artifactPath,
      ...(writeReport ? ["--write"] : []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
      },
    },
  );

  const output = [child.stdout, child.stderr].filter(Boolean).join("\n");
  const parsed = parseFirstJsonObject(output);
  return {
    result: isRecord(parsed) ? parsed : null,
    output,
    exitCode: typeof child.status === "number" ? child.status : 1,
  };
};

const runMvpContractV2Check = (
  artifactPath: string,
  writeReport: boolean,
): { result: JsonRecord | null; output: string; exitCode: number } => {
  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/check-mvp-contract-v2.ts",
      "--path",
      artifactPath,
      "--json-only",
      ...(writeReport ? ["--write"] : []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
      },
    },
  );

  const output = [child.stdout, child.stderr].filter(Boolean).join("\n");
  const parsed = parseFirstJsonObject(output);
  return {
    result: isRecord(parsed) ? parsed : null,
    output,
    exitCode: typeof child.status === "number" ? child.status : 1,
  };
};

const readRunJson = async <T>(
  runRoot: string | null,
  relativePath: string,
): Promise<{ path: string | null; parsed: T | null }> => {
  if (!runRoot) return { path: null, parsed: null };
  const filePath = path.join(runRoot, relativePath);
  return { path: filePath, parsed: await readJson<T>(filePath) };
};

const reviewerRequiredProblemIds = (reviewer: unknown): string[] => {
  if (!isRecord(reviewer) || !Array.isArray(reviewer.problems)) return [];
  return reviewer.problems
    .filter(isRecord)
    .filter((problem) => ["medium", "high", "blocker"].includes(String(problem.severity)))
    .map((problem) => problem.id)
    .filter(isNonEmptyString);
};

const reviewerProblemIds = (reviewer: unknown): string[] => {
  if (!isRecord(reviewer) || !Array.isArray(reviewer.problems)) return [];
  return reviewer.problems
    .filter(isRecord)
    .map((problem) => problem.id)
    .filter(isNonEmptyString);
};

const checkReviewResolution = (
  gates: GateResult[],
  reviewer: unknown,
  rewriter: unknown,
  reviewerPath: string | null,
  rewriterPath: string | null,
) => {
  if (!isRecord(reviewer)) {
    addGate(
      gates,
      "reviewer.response",
      false,
      "reviewer response exists",
      "reviewer/response.json is required for unattended auto-publish",
      reviewerPath,
    );
    return;
  }

  const reviewerStatus = String(reviewer.status ?? "");
  addGate(
    gates,
    "reviewer.status_not_block",
    reviewerStatus !== "block",
    "reviewer status is not block",
    "reviewer status=block cannot auto-publish",
    reviewerPath,
  );

  if (reviewerStatus === "pass") {
    addGate(
      gates,
      "reviewer.status_pass_or_resolved",
      true,
      "reviewer passed the artifact",
      "reviewer did not pass the artifact",
      reviewerPath,
    );
    return;
  }

  const requiredIds = reviewerRequiredProblemIds(reviewer);
  if (requiredIds.length === 0) {
    addWarning(gates, "reviewer.no_required_issue_ids", "reviewer did not pass, but no medium/high/blocker issue IDs were found", reviewerPath);
    return;
  }

  if (!isRecord(rewriter)) {
    addGate(
      gates,
      "rewriter.response_for_review_issues",
      false,
      "rewriter response exists for reviewer issues",
      `reviewer status=${reviewerStatus}; rewriter/response.json is required to resolve ${requiredIds.join(", ")}`,
      rewriterPath,
    );
    return;
  }

  const knownIds = new Set(reviewerProblemIds(reviewer));
  const resolutions = Array.isArray(rewriter.issueResolutions)
    ? rewriter.issueResolutions.filter(isRecord)
    : [];
  const resolutionById = new Map(
    resolutions
      .map((resolution) => [resolution.issueId, resolution])
      .filter((entry): entry is [string, JsonRecord] => isNonEmptyString(entry[0])),
  );
  const missing = requiredIds.filter((id) => !resolutionById.has(id));
  const unknown = [...resolutionById.keys()].filter((id) => !knownIds.has(id));
  const unsafe = requiredIds.filter((id) => {
    const resolution = resolutionById.get(id);
    const outcome = String(resolution?.outcome ?? "");
    return outcome === "needs_human" || outcome === "blocked" || !["changed", "no_change"].includes(outcome);
  });

  addGate(
    gates,
    "rewriter.issue_resolution_coverage",
    missing.length === 0,
    "rewriter covers all required reviewer issues",
    `Missing rewriter issueResolutions for: ${missing.join(", ")}`,
    rewriterPath,
  );
  addGate(
    gates,
    "rewriter.issue_resolution_ids_known",
    unknown.length === 0,
    "rewriter issue IDs all exist in reviewer.problems",
    `rewriter references unknown reviewer issue IDs: ${unknown.join(", ")}`,
    rewriterPath,
  );
  addGate(
    gates,
    "rewriter.issue_resolution_outcomes_publishable",
    unsafe.length === 0,
    "rewriter resolutions are publishable",
    `Reviewer issues still need human/block handling: ${unsafe.join(", ")}`,
    rewriterPath,
  );
};

async function main() {
  const args = parseArgs();
  const artifactDir = path.resolve(process.cwd(), args.artifactPath);
  const artifactPathForCommand = path.relative(process.cwd(), artifactDir).replace(/\\/g, "/");
  const gates: GateResult[] = [];

  try {
    const info = await stat(artifactDir);
    addGate(gates, "artifact_dir", info.isDirectory(), "artifact directory exists", "artifact path is not a directory", artifactDir);
  } catch {
    addGate(gates, "artifact_dir", false, "artifact directory exists", "artifact directory is missing", artifactDir);
  }

  const { runRoot, runId } = deriveRunRoot(artifactDir, args.runId);
  addGate(
    gates,
    "run_root",
    !!runRoot,
    "run root could be derived",
    "run root could not be derived from artifact path or --run",
    runRoot,
  );

  const metadataPath = path.join(artifactDir, "metadata.json");
  const metadata = await readJson<JsonRecord>(metadataPath);
  addGate(
    gates,
    "metadata.response",
    isRecord(metadata),
    "metadata.json exists",
    "metadata.json is missing or invalid",
    metadataPath,
  );
  const sourceProvenance = isRecord(metadata) ? metadata.sourceProvenance : null;
  addGate(
    gates,
    "metadata.source_provenance",
    isRecord(sourceProvenance),
    "source provenance is present for audit",
    "metadata.sourceProvenance is required for unattended auto-publish",
    metadataPath,
  );

  const mvp = runMvpStrictCheck(artifactPathForCommand);
  const mvpResult = isRecord(mvp.result) ? String(mvp.result.result ?? "") : null;
  addGate(
    gates,
    "mvp.strict_result",
    mvpResult === "pass" && mvp.exitCode === 0,
    "strict MVP artifact check passed",
    `strict MVP artifact check failed (${mvpResult ?? "unparsed"})`,
  );
  if (isRecord(mvp.result) && Array.isArray(mvp.result.checks)) {
    for (const check of mvp.result.checks.filter(isRecord)) {
      const status = String(check.status ?? "");
      if (status === "fail" || status === "warn") {
        gates.push({
          id: `mvp.${String(check.id ?? "unknown")}`,
          status: status === "fail" ? "fail" : "warn",
          message: String(check.message ?? "MVP artifact check did not pass cleanly"),
        });
      }
    }
  }

  const mvpContractV2 = runMvpContractV2Check(artifactPathForCommand, args.write);
  const mvpContractV2Result = isRecord(mvpContractV2.result)
    ? String(mvpContractV2.result.result ?? "")
    : null;
  addGate(
    gates,
    "mvp_contract_v2.result",
    (mvpContractV2Result === "pass" || mvpContractV2Result === "warn") && mvpContractV2.exitCode === 0,
    `MVP Contract V2 check completed (${mvpContractV2Result})`,
    `MVP Contract V2 check failed (${mvpContractV2Result ?? "unparsed"})`,
  );
  if (isRecord(mvpContractV2.result) && Array.isArray(mvpContractV2.result.checks)) {
    for (const check of mvpContractV2.result.checks.filter(isRecord)) {
      const status = String(check.status ?? "");
      if (status === "fail" || status === "warn") {
        gates.push({
          id: `mvp_contract_v2.${String(check.id ?? "unknown")}`,
          status: status === "fail" ? "fail" : "warn",
          message: String(check.message ?? "MVP Contract V2 check did not pass cleanly"),
        });
      }
    }
  }

  const renderProof = runRenderProofCheck(artifactPathForCommand, args.write);
  const renderProofResult = isRecord(renderProof.result) ? String(renderProof.result.result ?? "") : null;
  const renderProofPassed = renderProofResult === "pass" && renderProof.exitCode === 0;

  const interaction = runInteractionProofCheck(artifactPathForCommand, args.write);
  const interactionResult = isRecord(interaction.result) ? String(interaction.result.result ?? "") : null;
  // The static interaction proof warns when declared visibleEvidence is dynamic (not literal
  // in source). That is expected for stateful demos, and the browser render proof — which
  // actually clicks the primary action and observes the DOM change — is strictly stronger
  // evidence of interactivity. Accept warn when the render proof passed; a warn with no
  // passing render proof still blocks (observed 2026-07-08: a fully valid artifact was held
  // on this warn alone).
  const interactionAcceptable =
    interaction.exitCode === 0 && (interactionResult === "pass" || (interactionResult === "warn" && renderProofPassed));
  addGate(
    gates,
    "interaction_proof.result",
    interactionAcceptable,
    interactionResult === "warn"
      ? "interaction proof warn accepted (browser render proof passed)"
      : "interaction proof passed",
    `interaction proof failed (${interactionResult ?? "unparsed"})`,
  );
  if (isRecord(interaction.result) && Array.isArray(interaction.result.checks)) {
    for (const check of interaction.result.checks.filter(isRecord)) {
      const status = String(check.status ?? "");
      if (status === "fail" || status === "warn") {
        gates.push({
          id: `interaction.${String(check.id ?? "unknown")}`,
          status: status === "fail" ? "fail" : "warn",
          message: String(check.message ?? "interaction proof check did not pass cleanly"),
        });
      }
    }
  }

  addGate(
    gates,
    "render_proof.result",
    renderProofPassed,
    "browser render proof passed",
    `browser render proof failed (${renderProofResult ?? "unparsed"})`,
  );
  if (isRecord(renderProof.result) && Array.isArray(renderProof.result.checks)) {
    for (const check of renderProof.result.checks.filter(isRecord)) {
      const status = String(check.status ?? "");
      if (status === "fail" || status === "warn") {
        gates.push({
          id: `render_proof.${String(check.id ?? "unknown")}`,
          status: status === "fail" ? "fail" : "warn",
          message: String(check.message ?? "browser render proof check did not pass cleanly"),
        });
      }
    }
  }

  const validation = await readRunJson<JsonRecord>(runRoot, "validation-summary.json");
  const validationStatus = isRecord(validation.parsed) ? String(validation.parsed.status ?? "") : null;
  addGate(
    gates,
    "validation_summary.status",
    validationStatus === "pass",
    "validation-summary.json status is pass",
    `validation-summary.json status must be pass, got ${validationStatus ?? "missing"}`,
    validation.path,
  );

  const publisher = await readRunJson<JsonRecord>(runRoot, "publisher/response.json");
  const publisherStatus = isRecord(publisher.parsed) ? String(publisher.parsed.status ?? "") : null;
  addGate(
    gates,
    "publisher.status",
    publisherStatus === "publish",
    "publisher decided publish",
    `publisher status must be publish, got ${publisherStatus ?? "missing"}`,
    publisher.path,
  );
  if (isRecord(publisher.parsed)) {
    for (const field of ["requiredArtifactsPresent", "reviewPass", "validationPass", "mvpContractPass"]) {
      addGate(
        gates,
        `publisher.${field}`,
        publisher.parsed[field] === true,
        `publisher.${field}=true`,
        `publisher.${field} must be true for unattended auto-publish`,
        publisher.path,
      );
    }
    const safetyBlockers = asStringArray(publisher.parsed.safetyBlockers);
    addGate(
      gates,
      "publisher.safety_blockers",
      safetyBlockers.length === 0,
      "publisher has no safety blockers",
      `publisher safetyBlockers must be empty: ${safetyBlockers.join(", ")}`,
      publisher.path,
    );
  }

  const publicCopyIssues = findMojibakeLikeTextIssues(
    publicCopyPayload(metadata, publisher.parsed),
    { maxIssues: 12, path: "$.publicCopy" },
  );
  addGate(
    gates,
    "public_copy.text_quality",
    publicCopyIssues.length === 0,
    "public copy has no mojibake-like text",
    `public copy has mojibake-like text: ${publicCopyIssues.map((issue) => `${issue.path}:${issue.term}`).join(", ")}`,
    publisher.path ?? metadataPath,
  );

  const reviewer = await readRunJson<JsonRecord>(runRoot, "reviewer/response.json");
  const rewriter = await readRunJson<JsonRecord>(runRoot, "rewriter/response.json");
  checkReviewResolution(gates, reviewer.parsed, rewriter.parsed, reviewer.path, rewriter.path);

  const failGates = gates.filter((gate) => gate.status === "fail");
  const warningGates = gates.filter((gate) => gate.status === "warn");
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : runRoot
      ? path.join(runRoot, "publish-readiness.json")
      : path.join(artifactDir, "publish-readiness.json");
  const result: ReadinessResult = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: "unattended_auto_publish",
    artifactPath: toRel(artifactDir),
    runId,
    result: failGates.length === 0 ? "pass" : "fail",
    blockers: failGates.map((gate) => `${gate.id}: ${gate.message}`),
    warnings: warningGates.map((gate) => `${gate.id}: ${gate.message}`),
    gateResults: gates,
    evidencePaths: {
      metadata: toRel(metadataPath),
      validationSummary: validation.path ? toRel(validation.path) : null,
      publisher: publisher.path ? toRel(publisher.path) : null,
      reviewer: reviewer.path ? toRel(reviewer.path) : null,
      rewriter: rewriter.path && existsSync(rewriter.path) ? toRel(rewriter.path) : null,
      interactionProof: toRel(path.join(artifactDir, "validation", "interaction-proof.json")),
      renderProof: toRel(path.join(artifactDir, "validation", "render-verification.json")),
      mvpContractV2: toRel(path.join(artifactDir, "validation", "mvp-contract-v2.json")),
      publishReadiness: toRel(outputPath),
    },
    publisherStatus,
    reviewerStatus: isRecord(reviewer.parsed) ? String(reviewer.parsed.status ?? "") : null,
    validationStatus,
    mvpResult,
    mvpContractV2Result,
    interactionProofResult: interactionResult,
    renderProofResult,
  };

  if (args.write) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Result: ${result.result.toUpperCase()} - ${result.blockers.length} blocker(s), ${result.warnings.length} warning(s)`);

  if (result.result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
