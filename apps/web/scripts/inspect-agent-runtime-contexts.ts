import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { isPipelineStep, parseArgs, readJsonOptional } from "./llm-pipeline/shared";
import type { PipelineStep } from "./llm-pipeline/types";
import type { AgentRuntimeContext } from "./agent-definition-v2";

type RuntimeContextSummary = {
  runId: string;
  agentId: string;
  step: PipelineStep;
  phase: string | null;
  triggerId: string | null;
  triggerType: string | null;
  humanInfluence: string | null;
  allowedToolIds: string[];
  skillIds: string[];
  memory: {
    present: boolean;
    recentRunCount: number;
    recentProjectCount: number;
    feedbackSignalCount: number;
    errorSignalCount: number;
    guidanceCount: number;
  };
};

type AgentRuntimeInspectionReport = {
  version: 1;
  generatedAt: string;
  runPrefix: string;
  agents: string[];
  steps: PipelineStep[];
  contexts: RuntimeContextSummary[];
  missingContexts: Array<{
    runId: string;
    agentId: string;
    step: PipelineStep;
    path: string;
  }>;
  comparison: {
    skillIdsByAgent: Record<string, string[]>;
    conceptToolIdsByAgent: Record<string, string[]>;
    memoryPresenceByAgent: Record<string, boolean>;
    distinctSkillSets: number;
  };
};

const csv = (value: unknown, fallback: string[]) => {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseSteps = (value: unknown): PipelineStep[] =>
  csv(value, ["concept", "requirements", "builder"]).map((step) => {
    if (!isPipelineStep(step)) {
      throw new Error(`Invalid step: ${step}`);
    }
    return step;
  });

const readContext = async (
  runId: string,
  agentId: string,
  step: PipelineStep,
): Promise<RuntimeContextSummary | null> => {
  const contextPath = path.join(
    process.cwd(),
    "artifacts",
    "llm-pipeline-runs",
    runId,
    step,
    "agent-runtime-context.json",
  );
  const context = await readJsonOptional<AgentRuntimeContext>(contextPath);
  if (!context) return null;

  const feedbackSignalCount =
    (context.memoryDigest?.feedbackMemory.praise.length ?? 0) +
    (context.memoryDigest?.feedbackMemory.critique.length ?? 0) +
    (context.memoryDigest?.feedbackMemory.remixRequests.length ?? 0);

  return {
    runId,
    agentId,
    step,
    phase: context.phase ?? null,
    triggerId: context.trigger?.triggerId ?? null,
    triggerType: context.trigger?.type ?? null,
    humanInfluence: context.trigger?.attribution?.humanInfluence ?? null,
    allowedToolIds: context.allowedTools.map((tool) => tool.toolId),
    skillIds: context.skillRefs.map((skill) => skill.skillId),
    memory: {
      present: Boolean(context.memoryDigest),
      recentRunCount: context.memoryDigest?.episodicMemory.recentRunIds.length ?? 0,
      recentProjectCount: context.memoryDigest?.episodicMemory.recentProjectIds.length ?? 0,
      feedbackSignalCount,
      errorSignalCount: context.memoryDigest?.errorMemory.repeatedFailures.length ?? 0,
      guidanceCount: context.memoryDigest?.currentGuidance.length ?? 0,
    },
  };
};

const uniqueSorted = (values: string[]) => Array.from(new Set(values)).sort();

async function main() {
  const args = parseArgs();
  const runPrefix = typeof args["run-prefix"] === "string" ? args["run-prefix"] : "doc82_agent_runtime_smoke";
  const agents = csv(args.agents, ["agent_a", "agent_b", "agent_h"]);
  const steps = parseSteps(args.steps);
  const strict = args.strict === true || args.strict === "true";
  const contexts: RuntimeContextSummary[] = [];
  const missingContexts: AgentRuntimeInspectionReport["missingContexts"] = [];

  for (const agentId of agents) {
    const runId = `${runPrefix}_${agentId}`;
    for (const step of steps) {
      const context = await readContext(runId, agentId, step);
      if (context) {
        contexts.push(context);
      } else {
        missingContexts.push({
          runId,
          agentId,
          step,
          path: path.join("artifacts", "llm-pipeline-runs", runId, step, "agent-runtime-context.json"),
        });
      }
    }
  }

  const skillIdsByAgent: Record<string, string[]> = {};
  const conceptToolIdsByAgent: Record<string, string[]> = {};
  const memoryPresenceByAgent: Record<string, boolean> = {};

  for (const agentId of agents) {
    const agentContexts = contexts.filter((context) => context.agentId === agentId);
    skillIdsByAgent[agentId] = uniqueSorted(agentContexts.flatMap((context) => context.skillIds));
    conceptToolIdsByAgent[agentId] = uniqueSorted(
      agentContexts
        .filter((context) => context.step === "concept")
        .flatMap((context) => context.allowedToolIds),
    );
    memoryPresenceByAgent[agentId] = agentContexts.some((context) => context.memory.present);
  }

  const report: AgentRuntimeInspectionReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runPrefix,
    agents,
    steps,
    contexts,
    missingContexts,
    comparison: {
      skillIdsByAgent,
      conceptToolIdsByAgent,
      memoryPresenceByAgent,
      distinctSkillSets: new Set(Object.values(skillIdsByAgent).map((ids) => ids.join("|"))).size,
    },
  };

  const outDir = path.join(process.cwd(), "artifacts", "agent-runtime-inspection");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${runPrefix}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  if (missingContexts.length > 0) {
    console.warn(
      `Missing ${missingContexts.length} runtime context file(s). Prepare the corresponding run step(s) before treating this inspection as complete.`,
    );
    if (strict) process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
