import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPipelineStep } from "./llm-pipeline/shared";
import type { PipelineStep } from "./llm-pipeline/types";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

export type AgentRuntimeReflectionCheckResult = {
  path: string;
  step: PipelineStep;
  result: "pass" | "fail" | "warn";
  checks: Check[];
  summary: string;
};

type ExpectedRuntime = {
  agentId?: string;
  phase?: string;
  hasRuntimeContext: boolean;
  memoryGuidanceCount: number;
  rawContextLeakTerms: string[];
};

const reflectionArrayFields = [
  "personaInfluence",
  "memoryInfluence",
  "skillApplied",
  "toolBoundary",
  "outputContractApplied",
  "governanceBoundary",
] as const;

const requiredNonEmptyArrayFields = new Set<string>([
  "personaInfluence",
  "skillApplied",
  "toolBoundary",
  "outputContractApplied",
  "governanceBoundary",
]);

const rawContextLeakTerms = [
  "input.agentRuntimeContext",
  "agentRuntimeContext",
  "personaSnapshot",
  "memoryDigest",
  "currentGuidance",
  "allowedTools",
  "toolId",
  "skillRefs",
  "skillId",
  "triggerId",
  "creationPolicy",
  "learningPolicy",
  "structuredBoundaries",
];

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
  const explicitInput = typeof values.get("input") === "string" ? String(values.get("input")) : "";
  const runId = typeof values.get("run") === "string" ? String(values.get("run")) : "";
  const stepRaw = typeof values.get("step") === "string" ? String(values.get("step")) : "";
  const step = isPipelineStep(stepRaw) ? stepRaw : null;

  if (!step) {
    console.error("Usage: tsx scripts/check-agent-runtime-reflection.ts --step <concept|requirements|builder> (--run <runId> OR --path <response.json>)");
    process.exit(1);
  }

  const responsePath =
    explicitPath ||
    (runId ? path.join("artifacts", "llm-pipeline-runs", runId, step, "response.json") : "");
  const inputPath =
    explicitInput ||
    (runId ? path.join("artifacts", "llm-pipeline-runs", runId, step, "input.json") : "");

  if (!responsePath) {
    console.error("Usage: --path <response.json> OR --run <runId>");
    process.exit(1);
  }

  return { responsePath, inputPath, step };
};

const readJson = async <T = unknown>(filePath: string): Promise<T> =>
  JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as T;

const readJsonOptional = async <T = unknown>(filePath: string): Promise<T | null> => {
  if (!filePath) return null;
  try {
    return await readJson<T>(filePath);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown, allowEmpty: boolean) =>
  Array.isArray(value) &&
  (allowEmpty || value.length > 0) &&
  value.every((item) => typeof item === "string" && item.trim().length > 0);

const expectedFromInput = (input: unknown): ExpectedRuntime => {
  if (!isRecord(input)) return { hasRuntimeContext: false, memoryGuidanceCount: 0, rawContextLeakTerms: [] };
  const context = input.agentRuntimeContext;
  if (!isRecord(context)) return { hasRuntimeContext: false, memoryGuidanceCount: 0, rawContextLeakTerms: [] };
  const memoryDigest = isRecord(context.memoryDigest) ? context.memoryDigest : null;
  const currentGuidance = Array.isArray(memoryDigest?.currentGuidance) ? memoryDigest.currentGuidance : [];
  const allowedTools = Array.isArray(context.allowedTools) ? context.allowedTools : [];
  const skillRefs = Array.isArray(context.skillRefs) ? context.skillRefs : [];
  const trigger = isRecord(context.trigger) ? context.trigger : null;
  const rawIds = [
    ...allowedTools
      .map((tool) => (isRecord(tool) && typeof tool.toolId === "string" ? tool.toolId : ""))
      .filter(Boolean),
    ...skillRefs
      .map((skill) => (isRecord(skill) && typeof skill.skillId === "string" ? skill.skillId : ""))
      .filter(Boolean),
    typeof trigger?.triggerId === "string" ? trigger.triggerId : "",
  ].filter(Boolean);

  return {
    agentId: typeof context.agentId === "string" ? context.agentId : undefined,
    phase: typeof context.phase === "string" ? context.phase : undefined,
    hasRuntimeContext: true,
    memoryGuidanceCount: currentGuidance.filter(isNonEmptyString).length,
    rawContextLeakTerms: Array.from(new Set(rawIds)),
  };
};

const reflectionsForStep = (
  response: unknown,
  step: PipelineStep,
): Array<{ id: string; value: unknown }> => {
  if (!isRecord(response)) return [{ id: "root", value: undefined }];

  if (step === "concept") {
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    if (candidates.length === 0) return [{ id: "candidates", value: undefined }];
    return candidates.map((candidate, index) => ({
      id: `candidates[${index}].agentRuntimeReflection`,
      value: isRecord(candidate) ? candidate.agentRuntimeReflection : undefined,
    }));
  }

  return [{ id: "agentRuntimeReflection", value: response.agentRuntimeReflection }];
};

const checkOneReflection = (
  checks: Check[],
  id: string,
  reflection: unknown,
  expected: ExpectedRuntime,
  step: PipelineStep,
) => {
  if (!isRecord(reflection)) {
    checks.push({
      id,
      status: "fail",
      message: `${id} must be an object`,
    });
    return;
  }

  const expectedPhase = expected.phase ?? step;
  const agentMatches = expected.agentId
    ? reflection.agentId === expected.agentId
    : isNonEmptyString(reflection.agentId);
  checks.push({
    id: `${id}.agentId`,
    status: agentMatches ? "pass" : "fail",
    message: expected.agentId
      ? `${id}.agentId matches input agentId`
      : `${id}.agentId is present`,
  });

  checks.push({
    id: `${id}.phase`,
    status: reflection.phase === expectedPhase ? "pass" : "fail",
    message: `${id}.phase should be ${expectedPhase}`,
  });

  checks.push({
    id: `${id}.triggerUsed`,
    status: isNonEmptyString(reflection.triggerUsed) ? "pass" : "fail",
    message: `${id}.triggerUsed is non-empty`,
  });

  for (const field of reflectionArrayFields) {
    const allowEmpty =
      !requiredNonEmptyArrayFields.has(field) || (field === "skillApplied" && !expected.hasRuntimeContext);
    checks.push({
      id: `${id}.${field}`,
      status: isStringArray(reflection[field], allowEmpty) ? "pass" : "fail",
      message: `${id}.${field} must be ${allowEmpty ? "a valid" : "a non-empty"} string array`,
    });
  }

  checks.push({
    id: `${id}.memoryInfluenceFromDigest`,
    status:
      expected.memoryGuidanceCount === 0 || isStringArray(reflection.memoryInfluence, false)
        ? "pass"
        : "fail",
    message:
      expected.memoryGuidanceCount === 0
        ? `${id}.memoryInfluence may be empty because no current guidance exists`
        : `${id}.memoryInfluence must contain at least one short public-safe summary of how current memory guidance shaped this output (input includes ${expected.memoryGuidanceCount} guidance item(s)); [] is only allowed when no guidance exists; do not copy raw field names`,
  });

  const serialized = JSON.stringify(reflection);
  const leaked = [...rawContextLeakTerms, ...expected.rawContextLeakTerms].filter((term) => serialized.includes(term));
  checks.push({
    id: `${id}.raw_context_leak`,
    status: leaked.length === 0 ? "pass" : "fail",
    message:
      leaked.length === 0
        ? `${id} does not expose raw runtime context field names`
        : `${id} exposes raw runtime context terms: ${leaked.join(", ")} — rewrite each as plain public language (e.g. "input preparation", "local demo creation", "read-only source review") anywhere it appears in the reflection`,
  });
};

export function checkAgentRuntimeReflection(args: {
  response: unknown;
  input?: unknown;
  step: PipelineStep;
  path?: string;
}): AgentRuntimeReflectionCheckResult {
  const checks: Check[] = [];
  const expected = expectedFromInput(args.input);

  for (const item of reflectionsForStep(args.response, args.step)) {
    checkOneReflection(checks, item.id, item.value, expected, args.step);
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: AgentRuntimeReflectionCheckResult["result"] =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    path: args.path ?? "",
    step: args.step,
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

async function main() {
  const { responsePath, inputPath, step } = parseArgs();
  const resolvedPath = path.resolve(process.cwd(), responsePath);
  const response = await readJson(resolvedPath);
  const input = await readJsonOptional(inputPath);
  const result = checkAgentRuntimeReflection({
    response,
    input,
    step,
    path: resolvedPath,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Result: ${result.result.toUpperCase()} - ${result.summary}`);

  if (result.result === "fail") {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
