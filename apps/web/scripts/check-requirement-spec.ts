import path from "node:path";
import { readFile } from "node:fs/promises";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

type RequirementSpecCheckResult = {
  path: string;
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

  const explicitPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  const runId = typeof values.get("run") === "string" ? String(values.get("run")) : "";
  const specPath =
    explicitPath ||
    (runId
      ? path.join("artifacts", "llm-pipeline-runs", runId, "requirements", "response.json")
      : "");

  if (!specPath) {
    console.error(
      "Usage: tsx scripts/check-requirement-spec.ts --path <requirements-response.json> OR --run <runId>",
    );
    process.exit(1);
  }

  return { specPath };
};

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const stringArrayStatus = (value: unknown, allowEmpty = false): CheckStatus => {
  if (!Array.isArray(value)) return "fail";
  if (!allowEmpty && value.length === 0) return "fail";
  return value.every(isNonEmptyString) ? "pass" : "fail";
};

const pushStringCheck = (checks: Check[], spec: Record<string, unknown>, field: string) => {
  const ok = isNonEmptyString(spec[field]);
  checks.push({
    id: field,
    status: ok ? "pass" : "fail",
    message: ok ? `${field} is non-empty` : `${field} is missing or empty`,
  });
};

const pushStringArrayCheck = (
  checks: Check[],
  spec: Record<string, unknown>,
  field: string,
  allowEmpty = false,
) => {
  const status = stringArrayStatus(spec[field], allowEmpty);
  checks.push({
    id: field,
    status,
    message:
      status === "pass"
        ? `${field} is a ${allowEmpty ? "valid" : "non-empty"} string array`
        : `${field} must be a ${allowEmpty ? "valid" : "non-empty"} string array`,
  });
};

function checkRequirementSpec(spec: unknown, specPath: string): RequirementSpecCheckResult {
  const checks: Check[] = [];

  if (!isRecord(spec)) {
    return {
      path: specPath,
      result: "fail",
      checks: [{ id: "root", status: "fail", message: "RequirementSpec must be a JSON object" }],
      summary: "0 pass, 1 fail, 0 warn",
    };
  }

  for (const field of ["id", "conceptId", "ownerAgentId", "mvpGoal", "publicProductionMemo"]) {
    pushStringCheck(checks, spec, field);
  }

  for (const field of [
    "acceptanceCriteria",
    "nonGoals",
    "safetyConstraints",
    "materialChoices",
    "refusedDirections",
  ]) {
    pushStringArrayCheck(checks, spec, field);
  }
  pushStringArrayCheck(checks, spec, "feedbackConstraints", true);

  const screens = Array.isArray(spec.screens) ? spec.screens : [];
  checks.push({
    id: "screens",
    status: screens.length > 0 ? "pass" : "fail",
    message: screens.length > 0 ? `screens contains ${screens.length} item(s)` : "screens must be non-empty",
  });

  screens.forEach((screen, index) => {
    const label = `screens[${index}]`;
    if (!isRecord(screen)) {
      checks.push({ id: label, status: "fail", message: `${label} must be an object` });
      return;
    }
    for (const field of ["name", "purpose", "templatePatternSlot", "primaryControl", "stateOutput"]) {
      const ok = isNonEmptyString(screen[field]);
      checks.push({
        id: `${label}.${field}`,
        status: ok ? "pass" : "fail",
        message: ok ? `${label}.${field} is non-empty` : `${label}.${field} is missing or empty`,
      });
    }
    for (const field of ["components", "interactions"]) {
      const status = stringArrayStatus(screen[field]);
      checks.push({
        id: `${label}.${field}`,
        status,
        message:
          status === "pass"
            ? `${label}.${field} is a non-empty string array`
            : `${label}.${field} must be a non-empty string array`,
      });
    }
  });

  const dataModel = Array.isArray(spec.dataModel) ? spec.dataModel : [];
  checks.push({
    id: "dataModel",
    status: dataModel.length > 0 ? "pass" : "fail",
    message: dataModel.length > 0 ? `dataModel contains ${dataModel.length} item(s)` : "dataModel must be non-empty",
  });

  dataModel.forEach((model, index) => {
    const label = `dataModel[${index}]`;
    if (!isRecord(model)) {
      checks.push({ id: label, status: "fail", message: `${label} must be an object` });
      return;
    }
    for (const field of ["name", "sampleShape"]) {
      const value = model[field];
      const ok = field === "sampleShape" ? isNonEmptyString(value) || isRecord(value) : isNonEmptyString(value);
      checks.push({
        id: `${label}.${field}`,
        status: ok ? "pass" : "fail",
        message: ok ? `${label}.${field} is present` : `${label}.${field} is missing or empty`,
      });
    }
    const status = stringArrayStatus(model.fields);
    checks.push({
      id: `${label}.fields`,
      status,
      message:
        status === "pass"
          ? `${label}.fields is a non-empty string array`
          : `${label}.fields must be a non-empty string array`,
    });
  });

  const hasSourceBoundary =
    isNonEmptyString(spec.sourceBoundary) ||
    isNonEmptyString(spec.antiCloneBoundary) ||
    isNonEmptyString(spec.sourceUseBoundary);
  checks.push({
    id: "source_boundary",
    status: hasSourceBoundary ? "pass" : "fail",
    message: hasSourceBoundary
      ? "A source or anti-clone boundary is present"
      : "No sourceBoundary / antiCloneBoundary / sourceUseBoundary found; source provenance contract must be enforced",
  });

  for (const field of ["sourceBoundary", "antiCloneBoundary"]) {
    const ok = isNonEmptyString(spec[field]);
    checks.push({
      id: field,
      status: ok ? "pass" : "fail",
      message: ok ? `${field} is non-empty` : `${field} is missing or empty`,
    });
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: RequirementSpecCheckResult["result"] =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    path: specPath,
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

async function main() {
  const { specPath } = parseArgs();
  const resolvedPath = path.resolve(process.cwd(), specPath);
  const spec = await readJson(resolvedPath);
  const result = checkRequirementSpec(spec, resolvedPath);

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Result: ${result.result.toUpperCase()} - ${result.summary}`);

  if (result.result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
