import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

type CheckStatus = "pass" | "fail";

type CheckResult = {
  status: CheckStatus;
  label: string;
  detail: string;
};

type GovernanceReportCheckResult = {
  reportPath: string;
  checks: CheckResult[];
};

const appRoot = path.resolve(import.meta.dirname, "..");
const defaultReportDir = path.join(appRoot, "artifacts", "governance-reports");
const schemaPath = path.join(appRoot, "scripts", "llm-pipeline", "fixtures", "governance-report-schema.json");

const requiredTopLevelKeys = [
  "version",
  "id",
  "generatedAt",
  "governanceAgentId",
  "scope",
  "summary",
  "overallStatus",
  "findings",
  "cleanupCandidates",
  "operationalResponsibility",
  "proposedActionDefinitions",
  "dailyOpsChecklist",
  "devOpsCandidates",
  "interactionSummary",
  "patrolPolicy",
  "runEventRecordingDecision",
  "coverageGaps",
  "hardRules",
  "nextReviewHint",
];

const forbiddenActions = ["delete", "unpublish", "ban", "auto_approve"];
const humanApprovalActions = ["hold_for_review", "withdrawal_review", "profile_pause_review"];

function parseArgs() {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    file: typeof values.get("file") === "string" ? String(values.get("file")) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function pass(label: string, detail: string): CheckResult {
  return { status: "pass", label, detail };
}

function fail(label: string, detail: string): CheckResult {
  return { status: "fail", label, detail };
}

function allowedValues(schema: Record<string, unknown>, pathParts: string[]) {
  let current: unknown = schema;
  for (const part of pathParts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (!isRecord(current)) return [];
    current = current[part];
  }
  if (typeof current !== "string") return [];
  return current.split("|").map((item) => item.trim()).filter(Boolean);
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
}

async function latestReportPath() {
  if (!existsSync(defaultReportDir)) {
    throw new Error(`Governance report directory does not exist: ${path.relative(process.cwd(), defaultReportDir)}`);
  }

  const entries = await readdir(defaultReportDir);
  const jsonFiles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(defaultReportDir, entry);
        return { filePath, stats: await stat(filePath) };
      }),
  );
  const latest = jsonFiles.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)[0];
  if (!latest) {
    throw new Error(`No governance report artifacts found in ${path.relative(process.cwd(), defaultReportDir)}`);
  }
  return latest.filePath;
}

function checkReportObject(report: unknown, schema: Record<string, unknown>, reportPath: string): GovernanceReportCheckResult {
  const checks: CheckResult[] = [];
  const overallStatuses = allowedValues(schema, ["reportShape", "overallStatus"]);
  const findingSeverities = allowedValues(schema, ["reportShape", "findings", "0", "severity"]);
  const findingCategories = allowedValues(schema, ["reportShape", "findings", "0", "category"]);
  const proposedActions = allowedValues(schema, ["reportShape", "findings", "0", "proposedAction"]);

  if (!isRecord(report)) {
    return { reportPath, checks: [fail("Report object", "Report JSON root must be an object.")] };
  }

  const missingKeys = requiredTopLevelKeys.filter((key) => !(key in report));
  checks.push(
    missingKeys.length === 0
      ? pass("Top-level shape", `Required keys present: ${requiredTopLevelKeys.length}`)
      : fail("Top-level shape", `Missing keys: ${missingKeys.join(", ")}`),
  );

  checks.push(
    isNonEmptyString(report.id) && typeof report.version === "number" && isNonEmptyString(report.generatedAt)
      ? pass("Report identity", `id=${String(report.id)}, version=${String(report.version)}`)
      : fail("Report identity", "version, id, and generatedAt are required."),
  );
  checks.push(
    Number.isNaN(Date.parse(String(report.generatedAt)))
      ? fail("generatedAt", "generatedAt must be an ISO-compatible timestamp.")
      : pass("generatedAt", String(report.generatedAt)),
  );
  checks.push(
    report.governanceAgentId === "steward"
      ? pass("Governance agent", "steward")
      : fail("Governance agent", "governanceAgentId must be steward."),
  );
  checks.push(
    overallStatuses.includes(String(report.overallStatus))
      ? pass("Overall status", String(report.overallStatus))
      : fail("Overall status", `Unexpected overallStatus: ${String(report.overallStatus)}`),
  );

  const scope = report.scope;
  checks.push(
    isRecord(scope) && isStringArray(scope.runIds) && isStringArray(scope.projectIds) && isNonEmptyString(scope.lookbackWindow)
      ? pass("Scope", `${scope.projectIds.length} project(s), ${scope.runIds.length} run(s), ${scope.lookbackWindow}`)
      : fail("Scope", "scope.runIds, scope.projectIds, and scope.lookbackWindow are required."),
  );

  const findings = Array.isArray(report.findings) ? report.findings : [];
  checks.push(
    Array.isArray(report.findings)
      ? pass("Findings array", `${findings.length} finding(s)`)
      : fail("Findings array", "findings must be an array."),
  );

  const malformedFindings = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => {
      if (!isRecord(finding)) return true;
      return (
        !isNonEmptyString(finding.id) ||
        !isNonEmptyString(finding.targetType) ||
        !isNonEmptyString(finding.targetId) ||
        !findingSeverities.includes(String(finding.severity)) ||
        !findingCategories.includes(String(finding.category)) ||
        !isStringArray(finding.evidence) ||
        !isNonEmptyString(finding.recommendation) ||
        !proposedActions.includes(String(finding.proposedAction))
      );
    });
  checks.push(
    malformedFindings.length === 0
      ? pass("Finding shape", "All findings match the expected shape.")
      : fail("Finding shape", `Malformed finding index(es): ${malformedFindings.map((item) => item.index).join(", ")}`),
  );

  const highWithoutEvidence = findings
    .filter(isRecord)
    .filter((finding) => finding.severity === "high" || finding.severity === "blocker")
    .filter((finding) => !isStringArray(finding.evidence) || finding.evidence.filter((item) => item.trim().length > 0).length === 0);
  checks.push(
    highWithoutEvidence.length === 0
      ? pass("High evidence", "Every high/blocker finding has evidence.")
      : fail("High evidence", `Missing evidence on: ${highWithoutEvidence.map((finding) => String(finding.id)).join(", ")}`),
  );

  const forbiddenProposedActions = findings
    .filter(isRecord)
    .filter((finding) => forbiddenActions.includes(String(finding.proposedAction)));
  checks.push(
    forbiddenProposedActions.length === 0
      ? pass("Advisory actions", "No finding proposes delete/unpublish/ban/auto_approve.")
      : fail("Advisory actions", `Forbidden proposedAction on: ${forbiddenProposedActions.map((finding) => String(finding.id)).join(", ")}`),
  );

  const actionDefinitions = report.proposedActionDefinitions;
  const malformedHumanActionDefinitions = humanApprovalActions.filter((action) => {
    if (!isRecord(actionDefinitions)) return true;
    const definition = actionDefinitions[action];
    return (
      !isRecord(definition) ||
      definition.owner !== "human_admin" ||
      definition.requiresHumanApproval !== true ||
      definition.allowedStewardEffect !== "report_only" ||
      !isNonEmptyString(definition.meaning)
    );
  });
  checks.push(
    malformedHumanActionDefinitions.length === 0
      ? pass("Human approval actions", "hold_for_review/withdrawal_review/profile_pause_review are fixed as Human Admin review intents.")
      : fail(
          "Human approval actions",
          `Missing or unsafe definitions: ${malformedHumanActionDefinitions.join(", ")}`,
        ),
  );

  const nonHumanReviewFindings = findings
    .filter(isRecord)
    .filter((finding) => humanApprovalActions.includes(String(finding.proposedAction)))
    .filter((finding) => {
      if (!isRecord(actionDefinitions)) return true;
      const definition = actionDefinitions[String(finding.proposedAction)];
      return !isRecord(definition) || definition.owner !== "human_admin" || definition.requiresHumanApproval !== true;
    });
  checks.push(
    nonHumanReviewFindings.length === 0
      ? pass("Finding review intent", "Findings with hold/withdrawal/profile-pause actions require Human Admin judgement.")
      : fail("Finding review intent", `Unsafe review intent on: ${nonHumanReviewFindings.map((finding) => String(finding.id)).join(", ")}`),
  );

  const cleanupCandidates = Array.isArray(report.cleanupCandidates) ? report.cleanupCandidates : [];
  const unsafeCleanupCandidates = cleanupCandidates
    .filter(isRecord)
    .filter((candidate) => candidate.requiresHumanApproval !== true);
  checks.push(
    Array.isArray(report.cleanupCandidates) && unsafeCleanupCandidates.length === 0
      ? pass("Cleanup candidates", `${cleanupCandidates.length} candidate(s), all require human approval.`)
      : fail("Cleanup candidates", "cleanupCandidates must be an array and requireHumanApproval must be true when present."),
  );

  const patrolPolicy = report.patrolPolicy;
  const policyForbiddenActions = isRecord(patrolPolicy) && isStringArray(patrolPolicy.forbiddenActions)
    ? patrolPolicy.forbiddenActions
    : [];
  const policyHumanApprovalActions =
    isRecord(patrolPolicy) && isStringArray(patrolPolicy.humanApprovalRequiredActions)
      ? patrolPolicy.humanApprovalRequiredActions
      : [];
  checks.push(
    isRecord(patrolPolicy) &&
      patrolPolicy.advisoryOnly === true &&
      forbiddenActions.every((action) => policyForbiddenActions.includes(action)) &&
      humanApprovalActions.every((action) => policyHumanApprovalActions.includes(action))
      ? pass("Advisory policy", "advisoryOnly=true, forbidden actions, and human-approval actions are declared.")
      : fail("Advisory policy", "patrolPolicy must keep the report advisory-only and declare forbidden/human-approval actions."),
  );

  const operationalResponsibility = report.operationalResponsibility;
  checks.push(
    isRecord(operationalResponsibility) &&
      isNonEmptyString(operationalResponsibility.model) &&
      String(operationalResponsibility.model).includes("Human Admin decides") &&
      isStringArray(operationalResponsibility.humanAdmin) &&
      isStringArray(operationalResponsibility.system) &&
      isNonEmptyString(operationalResponsibility.steward) &&
      String(operationalResponsibility.steward).includes("advisory-only")
      ? pass("Operational responsibility", "AI detects, Human Admin decides, system verifies.")
      : fail("Operational responsibility", "Report must state Steward advisory-only, Human Admin decisions, and system verification."),
  );

  checks.push(
    isStringArray(report.dailyOpsChecklist) &&
      report.dailyOpsChecklist.some((item) => item.includes("Human Admin")) &&
      report.dailyOpsChecklist.some((item) => item.includes("System"))
      ? pass("Daily ops checklist", `${report.dailyOpsChecklist.length} step(s) for human/system review.`)
      : fail("Daily ops checklist", "dailyOpsChecklist must include Human Admin and System review steps."),
  );

  const devOpsCandidates = Array.isArray(report.devOpsCandidates) ? report.devOpsCandidates : [];
  const malformedDevOpsCandidates = devOpsCandidates
    .filter(isRecord)
    .filter(
      (candidate) =>
        !isNonEmptyString(candidate.runner) ||
        !isNonEmptyString(candidate.fit) ||
        !isNonEmptyString(candidate.guardrail) ||
        forbiddenActions.some((action) => String(candidate.guardrail).includes(action)) === false,
    );
  checks.push(
    devOpsCandidates.length >= 3 && malformedDevOpsCandidates.length === 0
      ? pass("DevOps handoff", "Cloud Scheduler, Cloud Run Jobs, or GitHub Actions candidates include guardrails.")
      : fail("DevOps handoff", "devOpsCandidates must include runner/fit/guardrail entries with forbidden-action guardrails."),
  );

  const interactionSummary = report.interactionSummary;
  const feedbackByActorType = isRecord(interactionSummary) ? interactionSummary.feedbackByActorType : undefined;
  const eventsByActorType = isRecord(interactionSummary) ? interactionSummary.eventsByActorType : undefined;
  checks.push(
    isRecord(interactionSummary) &&
      isRecord(feedbackByActorType) &&
      isRecord(eventsByActorType) &&
      ["human", "agent", "system", "validation_worker"].every(
        (actorType) =>
          typeof feedbackByActorType[actorType] === "number" &&
          typeof eventsByActorType[actorType] === "number",
      )
      ? pass("Actor attribution", "human/agent/system/validation_worker counts are separated.")
      : fail("Actor attribution", "interactionSummary must separate human/agent/system/validation_worker counts."),
  );

  const agentDiversitySummary = report.agentDiversitySummary;
  if (agentDiversitySummary !== undefined) {
    checks.push(
      isRecord(agentDiversitySummary) &&
        ["available", "unavailable"].includes(String(agentDiversitySummary.status)) &&
        isNonEmptyString(agentDiversitySummary.advisoryUse) &&
        String(agentDiversitySummary.advisoryUse).includes("must not")
        ? pass("Agent diversity summary", `status=${String(agentDiversitySummary.status)}`)
        : fail(
            "Agent diversity summary",
            "agentDiversitySummary must be advisory-only and declare status=available|unavailable.",
          ),
    );
  } else {
    checks.push(pass("Agent diversity summary", "Not present on legacy report."));
  }

  checks.push(
    isStringArray(report.coverageGaps) && isStringArray(report.hardRules) && isNonEmptyString(report.nextReviewHint)
      ? pass("Review metadata", "coverageGaps, hardRules, and nextReviewHint are present.")
      : fail("Review metadata", "coverageGaps, hardRules, and nextReviewHint are required."),
  );

  const textIssues = findMojibakeLikeTextIssues(report, { maxIssues: 10 });
  checks.push(
    textIssues.length === 0
      ? pass("Text quality", "No mojibake-like text found in governance report.")
      : fail(
          "Text quality",
          textIssues.map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`).join("; "),
        ),
  );

  return { reportPath, checks };
}

export async function checkGovernanceReport(filePath?: string): Promise<GovernanceReportCheckResult> {
  const reportPath = path.resolve(filePath ?? (await latestReportPath()));
  const [report, schema] = await Promise.all([readJson(reportPath), readJson(schemaPath)]);
  if (!isRecord(schema)) {
    throw new Error(`Governance report schema fixture must be an object: ${schemaPath}`);
  }
  return checkReportObject(report, schema, reportPath);
}

export async function checkGovernanceReportObject(
  report: Record<string, unknown>,
  reportPath = "(generated report)",
): Promise<GovernanceReportCheckResult> {
  const schema = await readJson(schemaPath);
  if (!isRecord(schema)) {
    throw new Error(`Governance report schema fixture must be an object: ${schemaPath}`);
  }
  return checkReportObject(report, schema, reportPath);
}

export function hasGovernanceReportFailures(result: GovernanceReportCheckResult) {
  return result.checks.some((check) => check.status === "fail");
}

export function printGovernanceReportCheck(result: GovernanceReportCheckResult) {
  console.log(`Governance report check: ${path.relative(process.cwd(), result.reportPath)}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
  }
  const failures = result.checks.filter((check) => check.status === "fail");
  console.log("");
  console.log(`Summary: ${result.checks.length - failures.length} pass, ${failures.length} fail`);
}

async function main() {
  const args = parseArgs();
  const result = await checkGovernanceReport(args.file);
  printGovernanceReportCheck(result);
  if (hasGovernanceReportFailures(result)) {
    process.exit(1);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/check-governance-report.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
