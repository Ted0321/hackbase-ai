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
  const combinationPath =
    typeof values.get("combination") === "string"
      ? String(values.get("combination"))
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, "combination", "response.json")
        : "";
  const conceptPath =
    typeof values.get("concept") === "string"
      ? String(values.get("concept"))
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, "concept", "response.json")
        : "";
  const builderPath =
    typeof values.get("builder") === "string"
      ? String(values.get("builder"))
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, "builder", "response.json")
        : "";
  const publisherPath =
    typeof values.get("publisher") === "string"
      ? String(values.get("publisher"))
      : runId
        ? path.join("artifacts", "llm-pipeline-runs", runId, "publisher", "response.json")
        : "";

  if (!combinationPath && !conceptPath) {
    console.error(
      "Usage: tsx scripts/check-source-provenance-contract.ts --run <runId> OR --combination <path> [--concept <path>] [--builder <path>] [--publisher <path>]",
    );
    process.exit(1);
  }

  return { combinationPath, conceptPath, builderPath, publisherPath };
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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const sourceUseValues = new Set([
  "direct_evidence",
  "inspiration_only",
  "do_not_use_as_fact",
  "primary_source_core",
  "weak_context",
  "candidate_only",
  "exclude",
]);

const checkSourceUse = (value: unknown): CheckStatus => {
  if (!isNonEmptyString(value)) return "fail";
  return sourceUseValues.has(value) ? "pass" : "warn";
};

const checkAudit = (value: unknown): CheckStatus => {
  if (!isRecord(value)) return "fail";
  if (!isNonEmptyString(value.evidenceLevel)) return "fail";
  if (!isStringArray(value.observedFields)) return "fail";
  if (!isStringArray(value.inferredFields)) return "fail";
  if (!isStringArray(value.missingFields)) return "fail";
  if (!isNonEmptyString(value.usePolicy)) return "fail";
  return "pass";
};

const sourceTraceRecord = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (isRecord(value.sourceTrace)) return value.sourceTrace;
  if (isRecord(value.sourceProvenance)) return value.sourceProvenance;
  return null;
};

const hasNonEmptyStringArray = (item: Record<string, unknown>, field: string) =>
  isStringArray(item[field]) && item[field].length > 0;

const checkSourceIdentity = (
  checks: Check[],
  label: string,
  item: Record<string, unknown>,
  mode: "remix" | "concept",
) => {
  if (mode === "remix") {
    const hasSourceIds =
      hasNonEmptyStringArray(item, "sourceProductCardIds") ||
      hasNonEmptyStringArray(item, "productSourceIndexEntryIds");
    checks.push({
      id: `${label}.sourceProductIds`,
      status: hasSourceIds ? "pass" : "fail",
      message: hasSourceIds
        ? `${label} carries source product ids`
        : `${label} must carry sourceProductCardIds or productSourceIndexEntryIds`,
    });
    return;
  }

  checks.push({
    id: `${label}.sourceProductUsed`,
    status: isNonEmptyString(item.sourceProductUsed) ? "pass" : "fail",
    message: isNonEmptyString(item.sourceProductUsed)
      ? `${label}.sourceProductUsed is non-empty`
      : `${label}.sourceProductUsed is missing`,
  });
};

const selectedConceptRecord = (concept: unknown): Record<string, unknown> | null => {
  if (!isRecord(concept)) return null;
  const selected = concept.selectedConcept;
  const candidates = Array.isArray(concept.candidates) ? concept.candidates : [];
  if (isRecord(selected)) {
    const selectedId = selected.id;
    if (isNonEmptyString(selectedId)) {
      const candidate = candidates.find((item): item is Record<string, unknown> => {
        return isRecord(item) && item.id === selectedId;
      });
      return candidate ? { ...candidate, ...selected } : selected;
    }
    return selected;
  }
  if (isNonEmptyString(selected)) {
    return candidates.find((candidate): candidate is Record<string, unknown> => {
      return isRecord(candidate) && candidate.id === selected;
    }) ?? null;
  }
  return null;
};

const checkProvenanceCarrier = (
  checks: Check[],
  label: string,
  item: Record<string, unknown>,
  mode: "remix" | "concept",
) => {
  checkSourceIdentity(checks, label, item, mode);

  const useStatus = checkSourceUse(item.sourceProductUse);
  checks.push({
    id: `${label}.sourceProductUse`,
    status: useStatus,
    message:
      useStatus === "pass"
        ? `${label}.sourceProductUse is explicit`
        : useStatus === "warn"
          ? `${label}.sourceProductUse is present but not one of the preferred enum values`
          : `${label}.sourceProductUse is missing`,
  });

  const auditStatus = checkAudit(item.sourceEvidenceAudit);
  checks.push({
    id: `${label}.sourceEvidenceAudit`,
    status: auditStatus,
    message:
      auditStatus === "pass"
        ? `${label}.sourceEvidenceAudit has evidenceLevel, observedFields, inferredFields, missingFields, and usePolicy`
        : `${label}.sourceEvidenceAudit is missing required provenance fields`,
  });

  const antiCloneStatus = isNonEmptyString(item.antiCloneBoundary) ? "pass" : "fail";
  checks.push({
    id: `${label}.antiCloneBoundary`,
    status: antiCloneStatus,
    message:
      antiCloneStatus === "pass"
        ? `${label}.antiCloneBoundary is non-empty`
        : `${label}.antiCloneBoundary is missing`,
  });
};

function checkContract(combination: unknown, concept: unknown): CheckResult {
  const checks: Check[] = [];

  if (combination === null) {
    checks.push({ id: "combination.response", status: "warn", message: "Combination response not checked" });
  } else if (!isRecord(combination)) {
    checks.push({ id: "combination.response", status: "fail", message: "Combination response must be an object" });
  } else {
    const selectedRemixes = Array.isArray(combination.selectedRemixes) ? combination.selectedRemixes : [];
    checks.push({
      id: "combination.selectedRemixes",
      status: selectedRemixes.length > 0 ? "pass" : "fail",
      message:
        selectedRemixes.length > 0
          ? `selectedRemixes contains ${selectedRemixes.length} item(s)`
          : "selectedRemixes must be non-empty",
    });
    selectedRemixes.forEach((remix, index) => {
      if (!isRecord(remix)) {
        checks.push({
          id: `combination.selectedRemixes[${index}]`,
          status: "fail",
          message: `combination.selectedRemixes[${index}] must be an object`,
        });
        return;
      }
      checkProvenanceCarrier(checks, `combination.selectedRemixes[${index}]`, remix, "remix");
    });
  }

  if (concept === null) {
    checks.push({ id: "concept.response", status: "warn", message: "Concept response not checked" });
  } else if (!isRecord(concept)) {
    checks.push({ id: "concept.response", status: "fail", message: "Concept response must be an object" });
  } else {
    const candidates = Array.isArray(concept.candidates) ? concept.candidates : [];
    checks.push({
      id: "concept.candidates",
      status: candidates.length > 0 ? "pass" : "fail",
      message: candidates.length > 0 ? `candidates contains ${candidates.length} item(s)` : "candidates must be non-empty",
    });
    candidates.forEach((candidate, index) => {
      if (!isRecord(candidate)) {
        checks.push({
          id: `concept.candidates[${index}]`,
          status: "fail",
          message: `concept.candidates[${index}] must be an object`,
        });
        return;
      }
      checkProvenanceCarrier(checks, `concept.candidates[${index}]`, candidate, "concept");
    });

    const selected = selectedConceptRecord(concept);
    if (!selected) {
      checks.push({ id: "concept.selectedConcept", status: "fail", message: "selectedConcept could not be resolved" });
    } else {
      checkProvenanceCarrier(checks, "concept.selectedConcept", selected, "concept");
    }
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: CheckResult["result"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

function checkLateStageContract(
  current: CheckResult,
  builder: unknown,
  publisher: unknown,
): CheckResult {
  const checks = [...current.checks];

  if (builder === null) {
    checks.push({ id: "builder.response", status: "warn", message: "Builder response not checked" });
  } else if (!isRecord(builder)) {
    checks.push({ id: "builder.response", status: "fail", message: "Builder response must be an object" });
  } else {
    const trace = sourceTraceRecord(builder);
    if (!trace) {
      checks.push({
        id: "builder.sourceTrace",
        status: "fail",
        message: "builder response must include sourceTrace or sourceProvenance",
      });
    } else {
      checkProvenanceCarrier(checks, "builder.sourceTrace", trace, "concept");
      checks.push({
        id: "builder.sourceTrace.sourceBoundary",
        status: isNonEmptyString(trace.sourceBoundary) ? "pass" : "fail",
        message: isNonEmptyString(trace.sourceBoundary)
          ? "builder.sourceTrace.sourceBoundary is non-empty"
          : "builder.sourceTrace.sourceBoundary is missing",
      });
    }
  }

  if (publisher === null) {
    checks.push({ id: "publisher.response", status: "warn", message: "Publisher response not checked" });
  } else if (!isRecord(publisher)) {
    checks.push({ id: "publisher.response", status: "fail", message: "Publisher response must be an object" });
  } else {
    const status = publisher.status;
    const pass = publisher.sourceTracePass;
    checks.push({
      id: "publisher.sourceTracePass",
      status: typeof pass === "boolean" ? "pass" : "fail",
      message: typeof pass === "boolean" ? "publisher.sourceTracePass is boolean" : "publisher.sourceTracePass is missing",
    });
    checks.push({
      id: "publisher.publishSourceTraceGate",
      status: status === "publish" && pass !== true ? "fail" : "pass",
      message:
        status === "publish" && pass !== true
          ? "publisher status=publish requires sourceTracePass=true"
          : "publisher source trace gate is consistent",
    });
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: CheckResult["result"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
  return {
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

async function main() {
  const { combinationPath, conceptPath, builderPath, publisherPath } = parseArgs();
  const combination = await readJsonOptional(combinationPath);
  const concept = await readJsonOptional(conceptPath);
  const builder = await readJsonOptional(builderPath);
  const publisher = await readJsonOptional(publisherPath);
  const result = checkLateStageContract(checkContract(combination, concept), builder, publisher);

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
