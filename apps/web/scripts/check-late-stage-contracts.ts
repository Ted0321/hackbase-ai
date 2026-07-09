import path from "node:path";
import { readFile } from "node:fs/promises";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

type CheckResult = {
  result: "pass" | "fail" | "warn";
  checks: Check[];
  summary: string;
};

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

  const runId = typeof values.get("run") === "string" ? String(values.get("run")) : "";
  const explicitPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  const step = typeof values.get("step") === "string" ? String(values.get("step")) : "";
  const root = runId ? path.join("artifacts", "llm-pipeline-runs", runId) : "";
  const includeRewriter = values.get("include-rewriter") === true || values.get("include-rewriter") === "true";

  const paths = {
    builder: explicitPath && step === "builder" ? explicitPath : root ? path.join(root, "builder", "response.json") : "",
    reviewer: explicitPath && step === "reviewer" ? explicitPath : root ? path.join(root, "reviewer", "response.json") : "",
    rewriter: explicitPath && step === "rewriter" ? explicitPath : root ? path.join(root, "rewriter", "response.json") : "",
    publisher: explicitPath && step === "publisher" ? explicitPath : root ? path.join(root, "publisher", "response.json") : "",
  };

  if (!runId && (!explicitPath || !step)) {
    console.error(
      "Usage: tsx scripts/check-late-stage-contracts.ts --run <runId> OR --step <builder|reviewer|rewriter|publisher> --path <response.json>",
    );
    process.exit(1);
  }

  return {
    paths,
    requiredSteps: step
      ? [step]
      : includeRewriter
        ? ["builder", "reviewer", "rewriter", "publisher"]
        : ["builder", "reviewer", "publisher"],
  };
};

const readJsonOptional = async (filePath: string): Promise<unknown | null> => {
  if (!filePath) return null;
  try {
    const raw = await readFile(path.resolve(process.cwd(), filePath), "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown, allowEmpty = false): value is string[] =>
  Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(isNonEmptyString);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isNumberInRange = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

const push = (checks: Check[], id: string, ok: boolean, pass: string, fail: string) => {
  checks.push({ id, status: ok ? "pass" : "fail", message: ok ? pass : fail });
};

const pushString = (checks: Check[], obj: Record<string, unknown>, field: string, id = field) => {
  push(checks, id, isNonEmptyString(obj[field]), `${id} is non-empty`, `${id} is missing or empty`);
};

const pushStringArray = (
  checks: Check[],
  obj: Record<string, unknown>,
  field: string,
  allowEmpty = false,
  id = field,
) => {
  push(
    checks,
    id,
    isStringArray(obj[field], allowEmpty),
    `${id} is a ${allowEmpty ? "valid" : "non-empty"} string array`,
    `${id} must be a ${allowEmpty ? "valid" : "non-empty"} string array`,
  );
};

const checkMvpContract = (checks: Check[], value: unknown, prefix: string) => {
  if (!isRecord(value)) {
    checks.push({ id: `${prefix}.mvpContract`, status: "fail", message: "mvpContract must be an object" });
    return;
  }
  for (const field of [
    "firstScreenValue",
    "coreInteraction",
    "stateChange",
    "inspectableOutput",
    "staticDataBoundary",
  ]) {
    push(
      checks,
      `${prefix}.mvpContract.${field}`,
      isNonEmptyString(value[field]),
      `${field} is non-empty`,
      `${field} is missing or empty`,
    );
  }
  for (const field of ["requiredFiles", "nonGoals", "forbiddenDependencies"]) {
    push(
      checks,
      `${prefix}.mvpContract.${field}`,
      isStringArray(value[field]),
      `${field} is a non-empty string array`,
      `${field} must be a non-empty string array`,
    );
  }
};

const checkBuilder = (value: unknown, checks: Check[]) => {
  if (!isRecord(value)) {
    checks.push({ id: "builder.root", status: "fail", message: "BuildPlan must be an object" });
    return;
  }
  for (const field of ["requirementSpecId", "framework"]) pushString(checks, value, field, `builder.${field}`);

  const files = Array.isArray(value.files) ? value.files : [];
  push(
    checks,
    "builder.files",
    files.length > 0,
    `files contains ${files.length} item(s)`,
    "files must be non-empty",
  );
  files.forEach((file, index) => {
    if (!isRecord(file)) {
      checks.push({ id: `builder.files[${index}]`, status: "fail", message: "file entry must be an object" });
      return;
    }
    push(
      checks,
      `builder.files[${index}].path`,
      isNonEmptyString(file.path),
      "path is non-empty",
      "path is missing or empty",
    );
    push(
      checks,
      `builder.files[${index}].purpose`,
      isNonEmptyString(file.purpose),
      "purpose is non-empty",
      "purpose is missing or empty",
    );
    if ("content" in file) {
      push(
        checks,
        `builder.files[${index}].content`,
        isNonEmptyString(file.content),
        "content is non-empty",
        "content is present but empty",
      );
    }
  });

  pushStringArray(checks, value, "implementationNotes", false, "builder.implementationNotes");
  pushStringArray(checks, value, "knownRisks", true, "builder.knownRisks");
  checkMvpContract(checks, value.mvpContract, "builder");

  const readiness = value.submissionReadiness;
  if (!isRecord(readiness)) {
    checks.push({ id: "builder.submissionReadiness", status: "fail", message: "submissionReadiness must be an object" });
  } else {
    for (const field of [
      "firstScreenValue",
      "coreInteraction",
      "stateChange",
      "inspectableOutput",
      "staticDataBoundary",
      "remainingWeakness",
    ]) {
      push(
        checks,
        `builder.submissionReadiness.${field}`,
        isNonEmptyString(readiness[field]),
        `${field} is non-empty`,
        `${field} is missing or empty`,
      );
    }
  }
};

const reviewStatuses = new Set(["pass", "needs_revision", "block"]);
const checkStatuses = new Set(["pass", "needs_revision", "block"]);
const scoreFields = [
  "novelty",
  "notObviousInsight",
  "userClarity",
  "coreInteraction",
  "visualSpecificity",
  "codeFeasibility",
  "sourceInspectability",
  "artifactCompleteness",
  "safety",
  "differenceFromRecentArtifacts",
  "weightedTotal",
] as const;
const demoCheckFields = [
  "firstScreenValue",
  "touchability",
  "stateChange",
  "inspectability",
  "provenance",
  "agentFit",
  "publicBoundary",
  "differentiation",
] as const;

const checkReviewer = (value: unknown, checks: Check[]) => {
  if (!isRecord(value)) {
    checks.push({ id: "reviewer.root", status: "fail", message: "ReviewResult must be an object" });
    return;
  }
  push(
    checks,
    "reviewer.status",
    reviewStatuses.has(String(value.status)),
    "status is a valid review decision",
    "status must be pass, needs_revision, or block",
  );
  pushString(checks, value, "reviewerAgentId", "reviewer.reviewerAgentId");

  const scores = value.scores;
  if (!isRecord(scores)) {
    checks.push({ id: "reviewer.scores", status: "fail", message: "scores must be an object" });
  } else {
    for (const field of scoreFields) {
      push(
        checks,
        `reviewer.scores.${field}`,
        isNumberInRange(scores[field], 1, 5),
        `${field} is a 1-5 score`,
        `${field} must be a number from 1 to 5`,
      );
    }
  }

  const demoChecks = value.hackathonDemoChecks;
  if (!isRecord(demoChecks)) {
    checks.push({ id: "reviewer.hackathonDemoChecks", status: "fail", message: "hackathonDemoChecks must be an object" });
  } else {
    for (const field of demoCheckFields) {
      push(
        checks,
        `reviewer.hackathonDemoChecks.${field}`,
        checkStatuses.has(String(demoChecks[field])),
        `${field} is a valid demo check`,
        `${field} must be pass, needs_revision, or block`,
      );
    }
  }

  const evidence = value.evidence;
  if (!isRecord(evidence)) {
    checks.push({ id: "reviewer.evidence", status: "fail", message: "evidence must be an object" });
  } else {
    for (const field of ["passEvidence", "failEvidence", "missingEvidence"]) {
      push(
        checks,
        `reviewer.evidence.${field}`,
        isStringArray(evidence[field], true),
        `${field} is a valid string array`,
        `${field} must be a string array`,
      );
    }
  }

  pushStringArray(checks, value, "strengths", true, "reviewer.strengths");
  pushStringArray(checks, value, "rewriteInstructions", true, "reviewer.rewriteInstructions");

  const problems = Array.isArray(value.problems) ? value.problems : [];
  checks.push({
    id: "reviewer.problems",
    status: Array.isArray(value.problems) ? "pass" : "fail",
    message: Array.isArray(value.problems) ? "problems is an array" : "problems must be an array",
  });
  const problemIds = new Set<string>();
  const duplicateProblemIds = new Set<string>();
  problems.forEach((problem, index) => {
    if (!isRecord(problem)) {
      checks.push({ id: `reviewer.problems[${index}]`, status: "fail", message: "problem must be an object" });
      return;
    }
    pushString(checks, problem, "id", `reviewer.problems[${index}].id`);
    if (isNonEmptyString(problem.id)) {
      if (problemIds.has(problem.id)) duplicateProblemIds.add(problem.id);
      problemIds.add(problem.id);
    }
    pushString(checks, problem, "issue", `reviewer.problems[${index}].issue`);
    pushString(checks, problem, "requiredChange", `reviewer.problems[${index}].requiredChange`);
  });
  checks.push({
    id: "reviewer.problems.uniqueIds",
    status: duplicateProblemIds.size === 0 ? "pass" : "fail",
    message:
      duplicateProblemIds.size === 0
        ? "reviewer problem IDs are unique"
        : `Duplicate reviewer problem IDs: ${[...duplicateProblemIds].join(", ")}`,
  });

  const recommendation = value.publishRecommendation;
  if (!isRecord(recommendation)) {
    checks.push({ id: "reviewer.publishRecommendation", status: "fail", message: "publishRecommendation must be an object" });
  } else {
    push(
      checks,
      "reviewer.publishRecommendation.readyForRepresentativeDemo",
      isBoolean(recommendation.readyForRepresentativeDemo),
      "readyForRepresentativeDemo is boolean",
      "readyForRepresentativeDemo must be boolean",
    );
    pushString(checks, recommendation, "reason", "reviewer.publishRecommendation.reason");
    pushStringArray(
      checks,
      recommendation,
      "mustFixBeforePublish",
      true,
      "reviewer.publishRecommendation.mustFixBeforePublish",
    );
  }
};

const rewriteStatuses = new Set(["revised", "needs_human", "blocked"]);
const rewriteOutcomes = new Set(["changed", "no_change", "needs_human", "blocked"]);

const reviewerProblemIds = (reviewer: unknown): string[] => {
  if (!isRecord(reviewer) || !Array.isArray(reviewer.problems)) return [];
  return reviewer.problems
    .filter(isRecord)
    .map((problem) => problem.id)
    .filter(isNonEmptyString);
};

const reviewerRequiredProblemIds = (reviewer: unknown): string[] => {
  if (!isRecord(reviewer) || !Array.isArray(reviewer.problems)) return [];
  return reviewer.problems
    .filter(isRecord)
    .filter((problem) => ["medium", "high", "blocker"].includes(String(problem.severity)))
    .map((problem) => problem.id)
    .filter(isNonEmptyString);
};

const checkRewriter = (value: unknown, checks: Check[], reviewer?: unknown) => {
  if (!isRecord(value)) {
    checks.push({ id: "rewriter.root", status: "fail", message: "RewriteResult must be an object" });
    return;
  }
  push(
    checks,
    "rewriter.status",
    rewriteStatuses.has(String(value.status)),
    "status is a valid rewrite decision",
    "status must be revised, needs_human, or blocked",
  );
  const changedFiles = Array.isArray(value.changedFiles) ? value.changedFiles : [];
  push(
    checks,
    "rewriter.changedFiles",
    Array.isArray(value.changedFiles) && (value.status !== "revised" || changedFiles.length > 0),
    "changedFiles is valid for the rewrite status",
    "changedFiles must be an array and non-empty when status=revised",
  );
  changedFiles.forEach((file, index) => {
    if (!isRecord(file)) {
      checks.push({ id: `rewriter.changedFiles[${index}]`, status: "fail", message: "changed file must be an object" });
      return;
    }
    pushString(checks, file, "path", `rewriter.changedFiles[${index}].path`);
    pushString(checks, file, "changeSummary", `rewriter.changedFiles[${index}].changeSummary`);
    if ("addressedReviewIssueIds" in file) {
      push(
        checks,
        `rewriter.changedFiles[${index}].addressedReviewIssueIds`,
        isStringArray(file.addressedReviewIssueIds, true),
        "addressedReviewIssueIds is a valid string array",
        "addressedReviewIssueIds must be a string array when present",
      );
    }
  });
  pushStringArray(checks, value, "addressedReviewIssues", true, "rewriter.addressedReviewIssues");

  const issueResolutions = Array.isArray(value.issueResolutions) ? value.issueResolutions : [];
  push(
    checks,
    "rewriter.issueResolutions",
    Array.isArray(value.issueResolutions),
    "issueResolutions is an array",
    "issueResolutions must be an array",
  );
  const changedFilePaths = new Set(
    changedFiles.filter(isRecord).map((file) => file.path).filter(isNonEmptyString),
  );
  issueResolutions.forEach((resolution, index) => {
    if (!isRecord(resolution)) {
      checks.push({ id: `rewriter.issueResolutions[${index}]`, status: "fail", message: "issue resolution must be an object" });
      return;
    }
    pushString(checks, resolution, "issueId", `rewriter.issueResolutions[${index}].issueId`);
    push(
      checks,
      `rewriter.issueResolutions[${index}].outcome`,
      rewriteOutcomes.has(String(resolution.outcome)),
      "outcome is valid",
      "outcome must be changed, no_change, needs_human, or blocked",
    );
    pushString(checks, resolution, "reason", `rewriter.issueResolutions[${index}].reason`);
    push(
      checks,
      `rewriter.issueResolutions[${index}].changedFiles`,
      isStringArray(resolution.changedFiles, resolution.outcome !== "changed"),
      "changedFiles is valid for the resolution outcome",
      "changed outcome requires non-empty changedFiles",
    );
    const resolutionChangedFiles = Array.isArray(resolution.changedFiles) ? resolution.changedFiles : [];
    if (resolution.outcome === "changed") {
      push(
        checks,
        `rewriter.issueResolutions[${index}].changedFilesMatch`,
        resolutionChangedFiles.every((filePath) => changedFilePaths.has(filePath)),
        "resolution changedFiles are present in changedFiles",
        "resolution changedFiles must match paths in changedFiles",
      );
    }
  });

  if (reviewer) {
    const knownProblemIds = new Set(reviewerProblemIds(reviewer));
    const requiredProblemIds = reviewerRequiredProblemIds(reviewer);
    const addressedIds = new Set(
      (Array.isArray(value.addressedReviewIssues) ? value.addressedReviewIssues : []).filter(isNonEmptyString),
    );
    const resolutionIds = new Set(
      issueResolutions
        .filter(isRecord)
        .map((resolution) => resolution.issueId)
        .filter(isNonEmptyString),
    );
    const allReferencedIds = new Set([...addressedIds, ...resolutionIds]);
    const unknownIds = [...allReferencedIds].filter((id) => !knownProblemIds.has(id));
    checks.push({
      id: "rewriter.reviewIssueIds.known",
      status: unknownIds.length === 0 ? "pass" : "fail",
      message:
        unknownIds.length === 0
          ? "All referenced review issue IDs exist in reviewer.problems"
          : `Unknown review issue IDs: ${unknownIds.join(", ")}`,
    });
    const missingRequired = requiredProblemIds.filter((id) => !resolutionIds.has(id));
    checks.push({
      id: "rewriter.reviewIssueIds.coverage",
      status: missingRequired.length === 0 ? "pass" : "fail",
      message:
        missingRequired.length === 0
          ? "All medium/high/blocker reviewer issues have issueResolutions"
          : `Missing issueResolutions for reviewer issues: ${missingRequired.join(", ")}`,
    });
  }

  pushStringArray(checks, value, "remainingRisks", true, "rewriter.remainingRisks");
};

const publishStatuses = new Set(["publish", "revise", "hold_for_review", "block"]);

const checkPublisher = (value: unknown, checks: Check[]) => {
  if (!isRecord(value)) {
    checks.push({ id: "publisher.root", status: "fail", message: "PublishDecision must be an object" });
    return;
  }
  const status = String(value.status);
  push(
    checks,
    "publisher.status",
    publishStatuses.has(status),
    "status is a valid publisher decision",
    "status must be publish, revise, hold_for_review, or block",
  );
  pushString(checks, value, "reason", "publisher.reason");
  pushString(checks, value, "publishSummary", "publisher.publishSummary");
  for (const field of ["requiredArtifactsPresent", "reviewPass", "validationPass", "mvpContractPass"]) {
    push(
      checks,
      `publisher.${field}`,
      isBoolean(value[field]),
      `${field} is boolean`,
      `${field} must be boolean`,
    );
  }
  pushStringArray(checks, value, "safetyBlockers", true, "publisher.safetyBlockers");

  if (status === "publish") {
    for (const field of ["requiredArtifactsPresent", "reviewPass", "validationPass", "mvpContractPass"]) {
      push(
        checks,
        `publisher.publishGate.${field}`,
        value[field] === true,
        `${field}=true for publish`,
        `status=publish requires ${field}=true`,
      );
    }
    push(
      checks,
      "publisher.publishGate.safetyBlockers",
      Array.isArray(value.safetyBlockers) && value.safetyBlockers.length === 0,
      "no safety blockers for publish",
      "status=publish requires safetyBlockers to be empty",
    );
  }
};

const checkByStep = (step: string, value: unknown, checks: Check[], previous: Record<string, unknown | null>) => {
  if (step === "builder") checkBuilder(value, checks);
  else if (step === "reviewer") checkReviewer(value, checks);
  else if (step === "rewriter") checkRewriter(value, checks, previous.reviewer);
  else if (step === "publisher") checkPublisher(value, checks);
  else checks.push({ id: step, status: "fail", message: `Unknown late-stage step: ${step}` });
};

async function main() {
  const { paths, requiredSteps } = parseArgs();
  const steps = requiredSteps;
  const checks: Check[] = [];
  const loaded: Record<string, unknown | null> = {};

  for (const step of steps) {
    const filePath = paths[step as keyof typeof paths];
    const value = await readJsonOptional(filePath);
    loaded[step] = value;
    if (value === null) {
      checks.push({
        id: `${step}.response`,
        status: "fail",
        message: `${step}/response.json is missing or invalid JSON`,
      });
      continue;
    }
    checkByStep(step, value, checks, loaded);
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: CheckResult["result"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
  const output: CheckResult = {
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };

  console.log(JSON.stringify(output, null, 2));
  console.log("");
  console.log(`Result: ${result.toUpperCase()} - ${output.summary}`);

  if (result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
