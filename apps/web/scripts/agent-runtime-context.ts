import type { AgentRegistryProfile } from "./agent-registry";
import { buildAgentDefinitionV2 } from "./agent-definition-v2-adapter";
import type {
  AgentDefinitionV2,
  AgentMemoryDigest,
  AgentPhase,
  AgentRuntimeContext,
  AgentSkillDefinition,
  AgentToolDefinition,
  AgentTriggerDefinition,
  AutonomyLevel,
  ToolPermissionLevel,
  TriggerAttributionPolicy,
  TriggerType,
} from "./agent-definition-v2";

export type RuntimeTriggerInput = {
  triggerId?: string;
  type?: TriggerType;
  autonomyLevel?: AutonomyLevel;
  attribution?: Partial<TriggerAttributionPolicy>;
};

export type BuildAgentRuntimeContextArgs = {
  runId: string;
  agent: AgentDefinitionV2;
  phase: AgentPhase;
  trigger?: RuntimeTriggerInput;
  memoryDigest?: AgentMemoryDigest;
  skillRegistry?: AgentSkillDefinition[];
  toolRegistry?: AgentToolDefinition[];
  triggerRegistry?: AgentTriggerDefinition[];
  inputBundle?: Record<string, unknown>;
  outputContract?: Record<string, unknown>;
};

const defaultAttribution = (type: TriggerType): TriggerAttributionPolicy => {
  if (type === "schedule" || type === "data_refresh" || type === "threshold" || type === "governance") {
    return {
      humanInfluence: "system_scheduled",
      recordPromptSource: true,
      recordOwner: true,
    };
  }

  if (type === "feedback_received" || type === "like_received") {
    return {
      humanInfluence: "human_seeded",
      recordPromptSource: true,
      recordOwner: true,
    };
  }

  return {
    humanInfluence: "human_requested",
    recordPromptSource: true,
    recordOwner: true,
  };
};

const unique = (...sources: Array<string[] | undefined>) => {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const source of sources) {
    if (!source) continue;
    for (const value of source) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const normalized = value.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }

  return values;
};

const resolveToolIdsForPhase = (agent: AgentDefinitionV2, phase: AgentPhase) => {
  const phaseToolIds = agent.toolPolicy.phasePermissions[phase];
  if (phaseToolIds && phaseToolIds.length > 0) {
    return unique(phaseToolIds).filter((toolId) => agent.toolPolicy.allowedToolIds.includes(toolId));
  }
  return unique(agent.toolPolicy.allowedToolIds);
};

const defaultPermissionLevel = (toolId: string): ToolPermissionLevel => {
  if (toolId === "update_memory") return "db_write";
  if (toolId === "generate_artifact" || toolId === "publish_local") return "local_write";
  return "read_only";
};

const defaultRiskLevel = (toolId: string): "low" | "medium" | "high" => {
  if (toolId === "publish_local" || toolId === "update_memory") return "medium";
  return "low";
};

const defaultToolPurpose = (toolId: string) => {
  switch (toolId) {
    case "read_signal":
      return "Read trend, topic, and product-source signals.";
    case "read_artifact":
      return "Read existing projects, artifacts, feedback, and validation results.";
    case "compose_prompt":
      return "Compose phase-specific prompt context from agent and shared-base inputs.";
    case "generate_artifact":
      return "Generate or materialize a local product artifact.";
    case "validate_artifact":
      return "Validate the generated artifact against output and safety contracts.";
    case "publish_local":
      return "Publish a validated artifact to the local Prodia feed.";
    case "create_reaction":
      return "Create an agent like, critique, compare note, remix suggestion, or risk flag.";
    case "update_memory":
      return "Persist a memory digest or learning signal for the next run.";
    case "governance_report":
      return "Create a governance report from runs, artifacts, feedback, and validation evidence.";
    default:
      return "Allowed by the agent tool policy.";
  }
};

const minimalToolRef = (toolId: string): AgentRuntimeContext["allowedTools"][number] => ({
  toolId,
  name: toolId,
  purpose: defaultToolPurpose(toolId),
  permissionLevel: defaultPermissionLevel(toolId),
  riskLevel: defaultRiskLevel(toolId),
});

// Enforce the agent's own toolPolicy / governancePolicy on the emitted capability list, so the
// runtime context actually reflects riskBudget / confirmationPolicy / forbiddenActions instead of
// merely declaring them. allowedTools is the capability surface handed to the model for the phase.
const applyToolPolicy = (
  refs: AgentRuntimeContext["allowedTools"],
  agent: AgentDefinitionV2,
): AgentRuntimeContext["allowedTools"] => {
  const { riskBudget, confirmationPolicy } = agent.toolPolicy;
  const forbidsExternalWrite =
    confirmationPolicy.externalWriteRequiresHumanApproval ||
    agent.governancePolicy.forbiddenActions.includes("external_publish");
  const autonomyAllowsHighRisk =
    agent.defaultAutonomyLevel === "L4_external_action_requires_human_approval";

  let mediumUsed = 0;
  const kept: AgentRuntimeContext["allowedTools"] = [];
  for (const ref of refs) {
    // External-write capabilities need human approval, so they never enter an autonomous surface.
    if (ref.permissionLevel === "external_write" && forbidsExternalWrite) continue;
    // High-risk tools need human approval unless the autonomy level explicitly permits them.
    if (ref.riskLevel === "high" && riskBudget.highRiskRequiresHumanApproval && !autonomyAllowsHighRisk) {
      continue;
    }
    // Cap medium-risk capabilities per run per riskBudget.
    if (ref.riskLevel === "medium") {
      if (mediumUsed >= riskBudget.maxMediumRiskToolsPerRun) continue;
      mediumUsed += 1;
    }
    kept.push(ref);
  }
  return kept;
};

const buildAllowedTools = (
  agent: AgentDefinitionV2,
  phase: AgentPhase,
  toolRegistry: AgentToolDefinition[] = [],
): AgentRuntimeContext["allowedTools"] => {
  const toolIds = resolveToolIdsForPhase(agent, phase);
  const registryById = new Map(toolRegistry.map((tool) => [tool.toolId, tool]));

  const refs = toolIds.map((toolId) => {
    const tool = registryById.get(toolId);
    if (!tool) return minimalToolRef(toolId);
    return {
      toolId: tool.toolId,
      name: tool.name,
      purpose: tool.purpose,
      permissionLevel: tool.permissionLevel,
      riskLevel: tool.riskLevel,
    };
  });

  return applyToolPolicy(refs, agent);
};

const buildSkillRefs = (
  agent: AgentDefinitionV2,
  phase: AgentPhase,
  skillRegistry: AgentSkillDefinition[] = [],
): AgentRuntimeContext["skillRefs"] => {
  if (skillRegistry.length === 0) return [];

  const rule = agent.skillPolicy.phaseRules[phase];
  const allowedSkillIds = unique(
    agent.skillPolicy.enabledSkillIds,
    rule?.requiredSkillIds,
    rule?.preferredSkillIds,
  );
  const preferredTags = new Set(agent.skillPolicy.preferredSkillTags);
  const forbidden = new Set(rule?.forbiddenSkillIds ?? []);
  const maxSkills = rule?.maxSkillsPerRun ?? Math.max(allowedSkillIds.length, 3);

  return skillRegistry
    .filter((skill) => skill.status === "active")
    .filter((skill) => {
      if (allowedSkillIds.includes(skill.skillId)) return true;
      if (allowedSkillIds.length > 0) return false;
      return skill.tags.some((tag) => preferredTags.has(tag));
    })
    .filter((skill) => !forbidden.has(skill.skillId))
    .filter((skill) => skill.applicablePhases.includes(phase))
    .slice(0, maxSkills)
    .map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      procedure: skill.procedure,
      outputContract: skill.outputContract,
    }));
};

export function buildAgentRuntimeContext(args: BuildAgentRuntimeContextArgs): AgentRuntimeContext {
  const registryTrigger = args.trigger?.triggerId
    ? args.triggerRegistry?.find((trigger) => trigger.triggerId === args.trigger?.triggerId)
    : undefined;
  const triggerType = args.trigger?.type ?? registryTrigger?.type ?? "manual";
  const attributionDefaults = registryTrigger?.attribution ?? defaultAttribution(triggerType);

  return {
    runId: args.runId,
    agentId: args.agent.agentId,
    phase: args.phase,
    trigger: {
      triggerId: args.trigger?.triggerId ?? registryTrigger?.triggerId ?? "manual",
      type: triggerType,
      autonomyLevel: args.trigger?.autonomyLevel ?? registryTrigger?.autonomyLevel ?? args.agent.defaultAutonomyLevel,
      attribution: {
        ...attributionDefaults,
        ...args.trigger?.attribution,
      },
    },
    personaSnapshot: {
      soul: args.agent.persona.soul,
      creationTaste: args.agent.persona.creationTaste,
      reactionTaste: args.agent.persona.reactionTaste,
      boundaries: args.agent.persona.boundaries,
    },
    ...(args.memoryDigest ? { memoryDigest: args.memoryDigest } : {}),
    skillRefs: buildSkillRefs(args.agent, args.phase, args.skillRegistry),
    allowedTools: buildAllowedTools(args.agent, args.phase, args.toolRegistry),
    inputBundle: args.inputBundle ?? {},
    outputContract: args.outputContract ?? {},
  };
}

export function buildAgentRuntimeContextFromRegistryProfile(
  args: Omit<BuildAgentRuntimeContextArgs, "agent"> & {
    agent: AgentRegistryProfile;
    transformedAt?: string;
  },
): AgentRuntimeContext {
  const agentDefinition = buildAgentDefinitionV2(args.agent, { transformedAt: args.transformedAt });
  return buildAgentRuntimeContext({
    ...args,
    agent: agentDefinition,
  });
}
