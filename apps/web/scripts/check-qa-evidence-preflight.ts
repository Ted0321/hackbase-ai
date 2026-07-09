import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkGovernanceReport, hasGovernanceReportFailures } from "./check-governance-report";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

type Check = {
  label: string;
  status: "pass" | "fail";
  detail: string;
};

type EvidenceFile = {
  label: string;
  path: string;
  kind: "json" | "governance-report";
  required?: boolean;
};

const appRoot = path.resolve(import.meta.dirname, "..");

const evidenceFiles: EvidenceFile[] = [
  {
    label: "generated output metadata",
    path: path.join(appRoot, "data", "agents", "generated-output-metadata.json"),
    kind: "json",
    required: true,
  },
  {
    label: "manual seed output metadata",
    path: path.join(appRoot, "data", "agents", "manual-seed-output-metadata.json"),
    kind: "json",
    required: true,
  },
  {
    label: "representative governance report",
    path: path.join(appRoot, "artifacts", "governance-reports", "steward_daily_20260627.json"),
    kind: "governance-report",
  },
  {
    label: "agent runtime inspection",
    path: path.join(appRoot, "artifacts", "agent-runtime-inspection", "doc84_real.json"),
    kind: "json",
  },
  ...["agent_a", "agent_b", "agent_h"].flatMap((agentId) =>
    ["concept", "requirements", "builder"].map(
      (step): EvidenceFile => ({
        label: `${agentId} ${step} response evidence`,
        path: path.join(appRoot, "artifacts", "llm-pipeline-runs", `doc84_real_${agentId}`, step, "response.json"),
        kind: "json",
      }),
    ),
  ),
  {
    label: "doc84 render verification",
    path: path.join(
      appRoot,
      "artifacts",
      "llm-pipeline-runs",
      "doc84_real_agent_a",
      "materialized",
      "doc84_agent_a_real_builder_proof",
      "validation",
      "render-verification.json",
    ),
    kind: "json",
  },
  {
    label: "contract render verification",
    path: path.join(
      appRoot,
      "artifacts",
      "llm-pipeline-runs",
      "contract_step2_builder_dryrun_20260629",
      "materialized",
      "contract_mock_permit_readiness",
      "validation",
      "render-verification.json",
    ),
    kind: "json",
  },
];

const pass = (label: string, detail: string): Check => ({ label, status: "pass", detail });
const fail = (label: string, detail: string): Check => ({ label, status: "fail", detail });

const relative = (filePath: string) => path.relative(process.cwd(), filePath).replace(/\\/g, "/");

const missingEvidenceCheck = (file: EvidenceFile) =>
  file.required === true
    ? fail(`${file.label} (${relative(file.path)})`, "file is missing")
    : pass(`${file.label} (${relative(file.path)})`, "optional local evidence is not present; skipped");

async function checkJsonEvidence(file: EvidenceFile): Promise<Check[]> {
  const checks: Check[] = [];
  const fileLabel = `${file.label} (${relative(file.path)})`;

  if (!existsSync(file.path)) {
    return [missingEvidenceCheck(file)];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(file.path, "utf8")).replace(/^\uFEFF/, ""));
    checks.push(pass(fileLabel, "parseable JSON"));
  } catch (error) {
    return [fail(fileLabel, String(error))];
  }

  const textIssues = findMojibakeLikeTextIssues(parsed, { maxIssues: 8 });
  checks.push(
    textIssues.length === 0
      ? pass(`${file.label} text quality`, "no mojibake-like text found")
      : fail(
          `${file.label} text quality`,
          textIssues.map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`).join("; "),
        ),
  );

  return checks;
}

async function checkGovernanceEvidence(file: EvidenceFile): Promise<Check[]> {
  if (!existsSync(file.path)) {
    return [missingEvidenceCheck(file)];
  }

  const result = await checkGovernanceReport(file.path);
  const failures = result.checks.filter((check) => check.status === "fail");
  return [
    hasGovernanceReportFailures(result)
      ? fail(`${file.label} (${relative(file.path)})`, failures.map((check) => `${check.label}: ${check.detail}`).join("; "))
      : pass(`${file.label} (${relative(file.path)})`, `${result.checks.length} governance checks passed`),
  ];
}

async function main() {
  const results = (
    await Promise.all(
      evidenceFiles.map((file) => (file.kind === "governance-report" ? checkGovernanceEvidence(file) : checkJsonEvidence(file))),
    )
  ).flat();

  for (const check of results) {
    console.log(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
  }

  const failures = results.filter((check) => check.status === "fail");
  console.log("");
  console.log(`Summary: ${results.length - failures.length} pass, ${failures.length} fail`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/check-qa-evidence-preflight.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
