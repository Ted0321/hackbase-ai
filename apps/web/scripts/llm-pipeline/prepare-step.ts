import path from "node:path";
import {
  collectPreviousResponses,
  createRunId,
  ensureRun,
  ensureStepDir,
  fixturePath,
  handoffMarkdown,
  parseArgs,
  promptPathForStep,
  readJson,
  readJsonOptional,
  readStepResponse,
  readText,
  relativeArtifactRoot,
  requireStep,
  stepDir,
  writeJson,
  writeText,
} from "./shared";
import type { PipelineStep } from "./types";
import {
  DEFAULT_SOURCE_INDEX_INJECT_LIMIT_CONCEPT,
  resolveInjectLimit,
  selectSourceEntriesForInjection,
} from "./select-source-entries";
import {
  readAgentLearnings,
  getAgentLearning,
  formatAgentLearningForPrompt,
} from "../agent-learning";
import { readAgentSkillsFromDb, formatAgentSkillsForPrompt } from "../agent-skills";
import { createPrismaClient } from "../prisma-client";
import {
  readReviewerLearningsFromDb,
  formatReviewerLearningsForPrompt,
} from "../reviewer-learning";
import { readAdminAgentRegistryWithContracts } from "../../src/lib/agent-operating-contract-store";
import {
  buildBuildConstraintProjection,
  buildConceptProjection,
  type BuildConstraintProjection,
  type ConceptProjection,
} from "../agent-profile-projection";
import type { AgentRegistryProfile } from "../agent-registry";
import {
  buildAgentRuntimeContextFromRegistryProfile,
  type RuntimeTriggerInput,
} from "../agent-runtime-context";
import type {
  AgentMemoryDigest,
  AgentPhase,
  AgentSkillDefinition,
  AgentToolDefinition,
  AgentTriggerDefinition,
  TriggerType,
} from "../agent-definition-v2";
import { readAgentMemoryDigestFromDb, type AgentMemoryDigestOptions } from "../agent-memory-digest";
import { buildAgentDefinitionV2 } from "../agent-definition-v2-adapter";

const requiredPreviousStepsByStep: Record<PipelineStep, PipelineStep[]> = {
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

const requiredPreviousStepsForStep = (step: PipelineStep, isSelfDirected: boolean) => {
  const required = requiredPreviousStepsByStep[step];
  if (!isSelfDirected) return required;
  if (step === "requirements" || step === "builder" || step === "publisher") {
    return required.filter((requiredStep) => requiredStep !== "agent-router");
  }
  return required;
};

type RegistryAgent = {
  role?: string;
  status?: string;
  [key: string]: unknown;
};

type AgentRegistryFixture = {
  agents?: RegistryAgent[];
  [key: string]: unknown;
};

const asAgentRegistryProfile = (agent: RegistryAgent | null): AgentRegistryProfile | null => {
  if (!agent || typeof agent.agentId !== "string" || typeof agent.displayName !== "string") {
    return null;
  }
  return agent as unknown as AgentRegistryProfile;
};

const DEFAULT_REVIEWER_AGENT_ID = "reviewer_v1";

const stepToAgentPhase = (step: PipelineStep): AgentPhase => step as AgentPhase;

const TRIGGER_TYPES = new Set<TriggerType>([
  "schedule",
  "data_refresh",
  "feedback_received",
  "like_received",
  "manual",
  "threshold",
  "governance",
]);

// The run origin is passed down from the scheduler (run-agent-daily-scheduler sets
// PRODIA_TRIGGER_TYPE=schedule). Manual entrypoints leave it unset and default to manual.
const resolveTriggerTypeFromEnv = (): TriggerType => {
  const raw = process.env.PRODIA_TRIGGER_TYPE?.trim();
  return raw && TRIGGER_TYPES.has(raw as TriggerType) ? (raw as TriggerType) : "manual";
};

// Attribution is intentionally NOT hardcoded here: buildAgentRuntimeContext derives it from the
// matching trigger-registry entry (or defaultAttribution(type)), so a scheduled run is labeled
// system_scheduled instead of the previous always-"human_requested".
const runtimeTriggerForPreparedStep = (agent: AgentRegistryProfile): RuntimeTriggerInput => {
  const type = resolveTriggerTypeFromEnv();
  const scheduled = type === "schedule" || type === "data_refresh" || type === "threshold" || type === "governance";
  const cadence = agent.schedulingPolicy?.cadence ?? "daily";
  const triggerId =
    agent.role === "reviewer"
      ? scheduled
        ? "validation_review"
        : "manual_review"
      : agent.role === "governance"
        ? scheduled
          ? "daily_governance"
          : "manual_governance"
        : type === "feedback_received"
          ? "feedback_received"
          : type === "like_received"
            ? "like_received"
            : scheduled
              ? `scheduled_creation:${cadence}`
              : "manual_creation";
  return { triggerId, type };
};

const summarizeAgentRuntimeContext = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const context = value as {
    agentId?: unknown;
    phase?: unknown;
    trigger?: {
      triggerId?: unknown;
      type?: unknown;
      autonomyLevel?: unknown;
      attribution?: { humanInfluence?: unknown };
    };
    allowedTools?: Array<{ toolId?: unknown; permissionLevel?: unknown; riskLevel?: unknown }>;
    skillRefs?: Array<{ skillId?: unknown; name?: unknown }>;
    outputContract?: Record<string, unknown>;
  };

  const stringOrNull = (item: unknown) => (typeof item === "string" ? item : null);
  const allowedTools = Array.isArray(context.allowedTools) ? context.allowedTools : [];
  const skillRefs = Array.isArray(context.skillRefs) ? context.skillRefs : [];

  return {
    agentId: stringOrNull(context.agentId),
    phase: stringOrNull(context.phase),
    trigger: {
      triggerId: stringOrNull(context.trigger?.triggerId),
      type: stringOrNull(context.trigger?.type),
      autonomyLevel: stringOrNull(context.trigger?.autonomyLevel),
      humanInfluence: stringOrNull(context.trigger?.attribution?.humanInfluence),
    },
    allowedToolIds: allowedTools.map((tool) => stringOrNull(tool.toolId)).filter(Boolean),
    toolPermissionSummary: allowedTools.map((tool) => ({
      toolId: stringOrNull(tool.toolId),
      permissionLevel: stringOrNull(tool.permissionLevel),
      riskLevel: stringOrNull(tool.riskLevel),
    })),
    skillIds: skillRefs.map((skill) => stringOrNull(skill.skillId)).filter(Boolean),
    outputContractKeys:
      typeof context.outputContract === "object" && context.outputContract !== null
        ? Object.keys(context.outputContract)
        : [],
  };
};

type ReviewerAgentContext = {
  agentId: string;
  profile: RegistryAgent | null;
  reviewPolicy: unknown;
  promotedLearning: string;
};

type ToolRegistryFixture = {
  tools?: AgentToolDefinition[];
};

type SkillRegistryFixture = {
  skills?: AgentSkillDefinition[];
};

type TriggerRegistryFixture = {
  triggers?: AgentTriggerDefinition[];
};

const arrayFromRegistry = <T>(fixture: unknown, key: string): T[] => {
  if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) return [];
  const value = (fixture as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
};

async function buildReviewerAgentContext(
  registryAgents: RegistryAgent[],
  requestedAgentId?: string,
): Promise<ReviewerAgentContext> {
  const requestedProfile = requestedAgentId
    ? registryAgents.find((agent) => agent.agentId === requestedAgentId) ?? null
    : null;
  const defaultProfile = registryAgents.find((agent) => agent.agentId === DEFAULT_REVIEWER_AGENT_ID);
  const activeReviewerProfile = registryAgents.find((agent) => {
    return agent.role === "reviewer" && (agent.status ?? "active") === "active";
  });
  const profile = requestedProfile ?? defaultProfile ?? activeReviewerProfile ?? null;
  const agentId =
    typeof profile?.agentId === "string" ? profile.agentId : requestedAgentId ?? DEFAULT_REVIEWER_AGENT_ID;

  const prisma = createPrismaClient();
  let promotedLearning = "";
  try {
    promotedLearning = formatReviewerLearningsForPrompt(
      await readReviewerLearningsFromDb(prisma, agentId, { promotedOnly: true }),
    );
  } finally {
    await prisma.$disconnect();
  }

  return {
    agentId,
    profile,
    reviewPolicy: profile?.reviewPolicy ?? null,
    promotedLearning,
  };
}

async function buildStepInput(runId: string, step: PipelineStep, agentId?: string) {
  const [
    researchInput,
    recentArtifacts,
    agentRegistryFixture,
    ideaMutationFrameworks,
    agentToolRegistryFixture,
    agentSkillRegistryFixture,
    agentTriggerRegistryFixture,
  ] = await Promise.all([
    readJson(fixturePath("research-input.json")),
    readJson(fixturePath("recent-artifacts.json")),
    readJson(fixturePath("agent-registry.json")),
    readJson(fixturePath("idea-mutation-frameworks.json")),
    readJson<ToolRegistryFixture>(fixturePath("agent-tool-registry.json")),
    readJson<SkillRegistryFixture>(fixturePath("agent-skill-registry.json")),
    readJson<TriggerRegistryFixture>(fixturePath("agent-trigger-registry.json")),
  ]);
  const [researchSourceCatalog, collectedResearch, fullProductSourceIndex, currentTopicRadar] = await Promise.all([
    readJsonOptional(fixturePath("research-source-catalog.json")),
    readJsonOptional(path.join(process.cwd(), "data", "research-collector-input.json")),
    readJsonOptional(path.join(process.cwd(), "data", "product-research", "source-product-index.json")),
    readJsonOptional(path.join(process.cwd(), "data", "topic-research", "current-topic-radar.json")),
  ]);
  // Prompt-injection cap: the canonical index grows without bound, but prompts must not
  // (concept runs on 2.5-pro where >200k input tokens doubles the price, and the research
  // input would hit the 1M context limit around ~500 entries). Seeded by runId so all
  // steps/retries in one run see the same subset while different runs rotate. The concept
  // limit yields a strict prefix of the broad selection (same seed), so concept always
  // sees a subset of what research saw.
  const indexSource = fullProductSourceIndex as { entries?: Array<Record<string, unknown>> } | null;
  const productSourceIndex = selectSourceEntriesForInjection(indexSource, {
    limit: resolveInjectLimit(process.env.PRODIA_SOURCE_INDEX_INJECT_LIMIT),
    seed: runId,
  });
  const conceptProductSourceIndex = selectSourceEntriesForInjection(indexSource, {
    limit: resolveInjectLimit(
      process.env.PRODIA_SOURCE_INDEX_INJECT_LIMIT_CONCEPT,
      DEFAULT_SOURCE_INDEX_INJECT_LIMIT_CONCEPT,
    ),
    seed: runId,
  });
  const previous = await collectPreviousResponses(runId, step);
  const validationSummary = await readJsonOptional(
    path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, "validation-summary.json"),
  );
  const prismaForContracts = createPrismaClient();
  let agentRegistry: AgentRegistryFixture;
  try {
    agentRegistry = (await readAdminAgentRegistryWithContracts(prismaForContracts)) as AgentRegistryFixture;
  } catch {
    agentRegistry = agentRegistryFixture as AgentRegistryFixture;
  } finally {
    await prismaForContracts.$disconnect();
  }
  const isSelfDirected = Boolean(agentId);
  const requiredPreviousSteps = requiredPreviousStepsForStep(step, isSelfDirected);
  const missingRequiredPreviousResponses = requiredPreviousSteps.filter((requiredStep) =>
    previous.missing.includes(requiredStep),
  );
  const previousResponseStatus = {
    requiredPreviousSteps,
    missingRequiredPreviousResponses,
    missingPreviousResponses: previous.missing,
    note:
      missingRequiredPreviousResponses.length > 0
        ? "This step was prepared without one or more required upstream response.json files. Run or accept those upstream steps before asking the LLM for this step."
        : isSelfDirected && (step === "requirements" || step === "builder" || step === "publisher")
          ? "Required upstream response.json files are present for this self-directed step. agent-router is intentionally not required because ownerAgent is the execution subject."
        : "Required upstream response.json files are present for this step.",
  };
  const registry = agentRegistry as AgentRegistryFixture;
  const registryAgents = Array.isArray(registry.agents) ? registry.agents : [];
  const toolRegistry = arrayFromRegistry<AgentToolDefinition>(agentToolRegistryFixture, "tools");
  const skillRegistry = arrayFromRegistry<AgentSkillDefinition>(agentSkillRegistryFixture, "skills");
  const triggerRegistry = arrayFromRegistry<AgentTriggerDefinition>(agentTriggerRegistryFixture, "triggers");
  const creatorAgentRegistry = {
    ...registry,
    agents: registryAgents.filter((agent: { role?: string; status?: string }) => {
      return (agent.role ?? "creator") === "creator" && (agent.status ?? "active") === "active";
    }),
    governanceAgents: registryAgents.filter((agent: { role?: string; status?: string }) => {
      return agent.role === "governance" && (agent.status ?? "active") === "active";
    }),
  };

  // P1-B: その日の主語（acting agent）の人格＋学びを解決する。
  // 指定があれば concept/requirements/builder を一人称化し、学びを「どう作るか」に効かせる。
  const selfDirectedPlan = agentId
    ? await readJsonOptional(path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, "self-directed-plan.json"))
    : null;
  let actingAgent: {
    agentId: string;
    profile: RegistryAgent | null;
    learning: string;
    memoryDigest?: AgentMemoryDigest;
    conceptProjection: ConceptProjection | null;
    buildConstraintProjection: BuildConstraintProjection | null;
  } | null = null;
  if (agentId) {
    const profile = registryAgents.find((agent) => agent.agentId === agentId) ?? null;
    const projectionProfile = asAgentRegistryProfile(profile);
    // memoryPolicy を実際に効かせるため、この時点で acting agent の V2 定義を構築し、
    // retrieval 上限・memoryScope・maxGuidanceItems を digest 取得へ渡す（従来はデフォルト固定だった）。
    const agentDefinition = projectionProfile ? buildAgentDefinitionV2(projectionProfile) : null;
    const memoryOptions: AgentMemoryDigestOptions = agentDefinition
      ? {
          maxProjects: agentDefinition.memoryPolicy.retrieval.maxProjects,
          maxFeedbackItems: agentDefinition.memoryPolicy.retrieval.maxFeedbackItems,
          maxValidationIssues: agentDefinition.memoryPolicy.retrieval.maxValidationIssues,
          freshnessWindowDays: agentDefinition.memoryPolicy.retrieval.freshnessWindowDays,
          includeFailures: agentDefinition.memoryPolicy.retrieval.includeFailures,
          includePositiveSignals: agentDefinition.memoryPolicy.retrieval.includePositiveSignals,
          maxGuidanceItems: agentDefinition.memoryPolicy.update.maxGuidanceItems,
          memoryScope: agentDefinition.memoryPolicy.memoryScope,
        }
      : {};
    const learningsFile = await readAgentLearnings();
    const learningText = formatAgentLearningForPrompt(getAgentLearning(learningsFile, agentId));
    // フェーズ2/3: 過去の成功事例スキル（型）をDBから読み、learning ブロックへ追記して注入する。
    const prisma = createPrismaClient();
    let skillsText = "";
    let memoryDigest: AgentMemoryDigest | undefined;
    try {
      skillsText = formatAgentSkillsForPrompt(await readAgentSkillsFromDb(prisma, agentId));
      memoryDigest = await readAgentMemoryDigestFromDb(prisma, agentId, memoryOptions);
    } finally {
      await prisma.$disconnect();
    }
    const learning = [learningText, skillsText].filter((block) => block.length > 0).join("\n\n");
    actingAgent = {
      agentId,
      profile,
      learning,
      ...(memoryDigest ? { memoryDigest } : {}),
      conceptProjection: projectionProfile
        ? buildConceptProjection(projectionProfile, learning, selfDirectedPlan)
        : null,
      buildConstraintProjection: projectionProfile
        ? buildBuildConstraintProjection(projectionProfile, learning, selfDirectedPlan)
        : null,
    };
  }
  const selfDirectedAssignment = actingAgent
    ? {
        mode: "self_directed",
        selectedAgentIds: [actingAgent.agentId],
        ownerAgentId: actingAgent.agentId,
        assignmentReason:
          selfDirectedPlan && typeof selfDirectedPlan === "object"
            ? (selfDirectedPlan as { selfSelectionReason?: string }).selfSelectionReason ?? "Agent is the owner of this self-directed run."
            : "Agent is the owner of this self-directed run.",
      }
    : null;

  const generatedAt = new Date().toISOString();
  const runtimeContextProfile = asAgentRegistryProfile(actingAgent?.profile ?? null);
  const agentRuntimeContext =
    agentId && runtimeContextProfile
      ? buildAgentRuntimeContextFromRegistryProfile({
          runId,
          agent: runtimeContextProfile,
          phase: stepToAgentPhase(step),
          transformedAt: generatedAt,
          trigger: runtimeTriggerForPreparedStep(runtimeContextProfile),
          ...(actingAgent?.memoryDigest ? { memoryDigest: actingAgent.memoryDigest } : {}),
          toolRegistry,
          skillRegistry,
          triggerRegistry,
          inputBundle: {
            preparedStep: step,
            selfDirectedPlanPresent: Boolean(selfDirectedPlan),
            previousResponseStatus,
            availablePreviousResponseKeys: Object.keys(previous.responses),
          },
          outputContract: {
            returnFormat: "strict_json_only",
            noExternalPublish: true,
            noPaidApiRequired: true,
            noSecrets: true,
          },
        })
      : null;

  const base = {
    version: 1,
    runId,
    step,
    generatedAt,
    instructions: {
      returnFormat: "strict_json_only",
      noExternalPublish: true,
      noPaidApiRequired: true,
      noSecrets: true,
    },
    previousResponseStatus,
    selfDirectedPlan,
    agentRuntimeContext,
  };

  switch (step) {
    case "research":
      return {
        ...base,
        researchInput,
        researchSourceCatalog,
        collectedResearch,
        productSourceIndex,
        currentTopicRadar,
      };
    case "combination":
      return {
        ...base,
        research: previous.responses.research ?? null,
        productSourceIndex,
        currentTopicRadar,
        ideaMutationFrameworks,
        missingPreviousResponses: previous.missing,
        recentArtifacts,
      };
    case "concept":
      return {
        ...base,
        research: previous.responses.research ?? null,
        combination: previous.responses.combination ?? null,
        productSourceIndex: conceptProductSourceIndex,
        currentTopicRadar,
        ideaMutationFrameworks,
        missingPreviousResponses: previous.missing,
        recentArtifacts,
        actingAgent,
        selfDirectedPlan,
      };
    case "agent-router":
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        missingPreviousResponses: previous.missing,
        agentRegistry: creatorAgentRegistry,
        scheduledAgentId: actingAgent?.agentId ?? null,
      };
    case "requirements":
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        assignment: previous.responses["agent-router"] ?? selfDirectedAssignment,
        missingPreviousResponses: previous.missing,
        ownerAgent: actingAgent,
        selfDirectedPlan,
      };
    case "builder":
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        assignment: previous.responses["agent-router"] ?? selfDirectedAssignment,
        requirementSpec: previous.responses.requirements ?? null,
        missingPreviousResponses: previous.missing,
        ownerAgent: actingAgent,
        selfDirectedPlan,
      };
    case "reviewer": {
      const reviewerAgent = await buildReviewerAgentContext(registryAgents, agentId);
      // R3: rewrite 後の再評価で「修正済みの最新状態」を見られるよう rewriter 出力を渡す。
      // rewriter は pipeline 順で reviewer の後段なので previous.responses には入らない（明示読み）。
      const rewriteResult = await readStepResponse(runId, "rewriter");
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        requirementSpec: previous.responses.requirements ?? null,
        buildPlan: previous.responses.builder ?? null,
        rewriteResult,
        reviewerAgent,
        reviewerProfile: reviewerAgent.profile,
        reviewerPolicy: reviewerAgent.reviewPolicy,
        reviewerLearning: reviewerAgent.promotedLearning,
        recentArtifacts,
        missingPreviousResponses: previous.missing,
      };
    }
    case "rewriter":
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        requirementSpec: previous.responses.requirements ?? null,
        buildPlan: previous.responses.builder ?? null,
        reviewResult: previous.responses.reviewer ?? null,
        missingPreviousResponses: previous.missing,
      };
    case "publisher":
      return {
        ...base,
        concept: previous.responses.concept ?? null,
        assignment: previous.responses["agent-router"] ?? selfDirectedAssignment,
        requirementSpec: previous.responses.requirements ?? null,
        buildPlan: previous.responses.builder ?? null,
        reviewResult: previous.responses.reviewer ?? null,
        rewriteResult: previous.responses.rewriter ?? null,
        validationSummary: validationSummary ?? {
          status: "not_run",
          note: "Local artifact validation has not been written for this run yet. In autonomous publish mode, run materialization and check-mvp-artifact before requesting a publisher decision.",
        },
        missingPreviousResponses: previous.missing,
      };
  }
}

async function main() {
  const args = parseArgs();
  const step = requireStep(args.step);
  const runId = typeof args.run === "string" ? args.run : createRunId();
  const agentId = typeof args.agent === "string" ? args.agent : undefined;

  await ensureRun(runId);
  const dir = await ensureStepDir(runId, step);
  const promptTemplate = await readText(promptPathForStep(step));
  const input = await buildStepInput(runId, step, agentId);

  const promptFile = path.join(dir, "prompt.md");
  const inputFile = path.join(dir, "input.json");
  const responseFile = path.join(dir, "response.json");
  const handoffFile = path.join(dir, "handoff.md");
  const metadataFile = path.join(dir, "metadata.json");
  const agentRuntimeContextFile = path.join(dir, "agent-runtime-context.json");
  const inputAgentRuntimeContext = (input as { agentRuntimeContext?: unknown }).agentRuntimeContext ?? null;
  const agentRuntimeContextSummary = summarizeAgentRuntimeContext(inputAgentRuntimeContext);

  await writeText(promptFile, promptTemplate);
  await writeJson(inputFile, input);
  if (inputAgentRuntimeContext) {
    await writeJson(agentRuntimeContextFile, inputAgentRuntimeContext);
  }
  await writeText(
    handoffFile,
    handoffMarkdown({
      runId,
      step,
      promptPath: path.relative(process.cwd(), promptFile),
      inputPath: path.relative(process.cwd(), inputFile),
      responsePath: path.relative(process.cwd(), responseFile),
    }),
  );
  await writeJson(metadataFile, {
    version: 1,
    runId,
    step,
    preparedAt: new Date().toISOString(),
    outputRoot: relativeArtifactRoot(runId),
    files: {
      prompt: path.relative(process.cwd(), promptFile),
      input: path.relative(process.cwd(), inputFile),
      response: path.relative(process.cwd(), responseFile),
      handoff: path.relative(process.cwd(), handoffFile),
      ...(inputAgentRuntimeContext
        ? { agentRuntimeContext: path.relative(process.cwd(), agentRuntimeContextFile) }
        : {}),
    },
    previousResponseStatus: input.previousResponseStatus,
    agentRuntimeContext: agentRuntimeContextSummary,
  });

  console.log(`Prepared ${step} prompt`);
  console.log(`Run: ${runId}`);
  console.log(`Directory: ${path.relative(process.cwd(), stepDir(runId, step))}`);
  console.log(`Prompt: ${path.relative(process.cwd(), promptFile)}`);
  console.log(`Input: ${path.relative(process.cwd(), inputFile)}`);
  if (input.previousResponseStatus.missingRequiredPreviousResponses.length > 0) {
    console.warn(
      `Missing required upstream response.json for ${step}: ${input.previousResponseStatus.missingRequiredPreviousResponses.join(
        ", ",
      )}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
