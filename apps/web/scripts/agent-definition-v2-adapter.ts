import type { AgentRegistry, AgentRegistryProfile } from "./agent-registry";
import type {
  AgentDefinitionV2,
  AgentInputKind,
  AgentMemoryDigest,
  AgentOwnerType,
  AgentPhase,
  AgentReactionType,
  AgentRole,
  AgentStatus,
  ArtifactShape,
  AutonomyLevel,
  MemoryPolicy,
  SkillPolicy,
  ToolPolicy,
  TriggerPolicy,
} from "./agent-definition-v2";

export type AgentDefinitionV2AdapterOptions = {
  transformedAt?: string;
};

export type AgentDefinitionV2RegistrySnapshot = {
  schemaVersion: 2;
  sourceRegistryVersion: number;
  transformedAt: string;
  agents: AgentDefinitionV2[];
};

const artifactShapes = new Set<ArtifactShape>([
  "audit_report",
  "board",
  "evaluator",
  "explainer",
  "game_like_tool",
  "hold_recommendation",
  "map",
  "publish_gate",
  "review_report",
  "revision_brief",
  "risk_summary",
  "simulator",
  "transformation_studio",
  "workspace",
]);

const inputKinds = new Set<AgentInputKind>([
  "trendSignals",
  "productSourceIndex",
  "topicRadar",
  "currentTopicRadar",
  "recentArtifacts",
  "humanFeedback",
  "agentFeedback",
  "validationResults",
  "agentMemoryDigest",
  "agentRegistry",
  "agentLearnings",
]);

const reactionTypes = new Set<AgentReactionType>([
  "agent_like",
  "agent_critique",
  "agent_remix_suggestion",
  "agent_compare_note",
  "agent_risk_flag",
  "human_review",
  "validation_warning",
]);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const uniqueStrings = (...sources: Array<unknown[] | undefined>): string[] => {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const value of source) {
      if (!nonEmptyString(value)) continue;
      const normalized = value.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }

  return values;
};

const uniqueInputKinds = (...sources: Array<unknown[] | undefined>): AgentInputKind[] =>
  uniqueStrings(...sources).filter((value): value is AgentInputKind => inputKinds.has(value as AgentInputKind));

const uniqueArtifactShapes = (...sources: Array<unknown[] | undefined>): ArtifactShape[] =>
  uniqueStrings(...sources).filter((value): value is ArtifactShape => artifactShapes.has(value as ArtifactShape));

const uniqueReactionTypes = (...sources: Array<unknown[] | undefined>): AgentReactionType[] =>
  uniqueStrings(...sources).filter((value): value is AgentReactionType => reactionTypes.has(value as AgentReactionType));

const firstString = (...values: unknown[]) => values.find(nonEmptyString)?.trim();

const normalizeStatus = (value: unknown): AgentStatus => {
  if (value === "draft" || value === "active" || value === "paused" || value === "retired") return value;
  return "active";
};

const normalizeRole = (value: unknown): AgentRole => {
  if (value === "reviewer" || value === "governance") return value;
  return "creator";
};

const normalizeOwnerType = (value: unknown): AgentOwnerType => {
  if (value === "human_owner" || value === "human") return "human_owner";
  return "system";
};

const normalizeAutonomyLevel = (value: unknown): AutonomyLevel => {
  switch (value) {
    case "L0_manual_only":
    case "L0_manual":
      return "L0_manual_only";
    case "L1_assisted":
      return "L1_assisted";
    case "L2_self_directed_draft":
    case "L2_scheduled":
      return "L2_self_directed_draft";
    case "L3_local_publish_after_validation":
    case "L3_auto_publish":
      return "L3_local_publish_after_validation";
    case "L4_external_action_requires_human_approval":
    case "L4_external":
      return "L4_external_action_requires_human_approval";
    default:
      return "L1_assisted";
  }
};

const normalizePropensity = (value: unknown): Partial<Record<AgentReactionType, number>> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const entries = Object.entries(value).filter((entry): entry is [AgentReactionType, number] => {
    const [key, score] = entry;
    return reactionTypes.has(key as AgentReactionType) && typeof score === "number" && Number.isFinite(score);
  });

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
};

const sourceFields = (agent: AgentRegistryProfile) =>
  [
    "agentId",
    "profileVersion",
    "displayName",
    "status",
    "ownerType",
    "role",
    "oneLiner",
    agent.identity ? "identity" : null,
    agent.makerProfile ? "makerProfile" : null,
    Array.isArray(agent.specialties) ? "specialties" : null,
    agent.creationPolicy ? "creationPolicy" : null,
    Array.isArray(agent.artifactStrengths) ? "artifactStrengths" : null,
    Array.isArray(agent.styleTraits) ? "styleTraits" : null,
    Array.isArray(agent.avoid) ? "avoid" : null,
    Array.isArray(agent.boundaries) ? "boundaries" : null,
    agent.structuredBoundaries ? "structuredBoundaries" : null,
    agent.interactionPolicy ? "interactionPolicy" : null,
    agent.learningPolicy ? "learningPolicy" : null,
    agent.reviewPolicy ? "reviewPolicy" : null,
    agent.qualityStats ? "qualityStats" : null,
    agent.schedulingPolicy ? "schedulingPolicy" : null,
  ].filter(nonEmptyString);

const defaultInputBundleForRole = (role: AgentRole): AgentInputKind[] => {
  if (role === "reviewer") return ["recentArtifacts", "humanFeedback", "agentFeedback", "validationResults"];
  if (role === "governance") return ["recentArtifacts", "validationResults", "agentFeedback", "agentMemoryDigest"];
  return ["trendSignals", "productSourceIndex", "currentTopicRadar", "recentArtifacts", "agentMemoryDigest"];
};

const enabledTriggerIdsForRole = (agent: AgentRegistryProfile, role: AgentRole): string[] => {
  if (role === "reviewer") return ["manual_review", "validation_review", "feedback_received"];
  if (role === "governance") return ["daily_governance", "manual_governance"];
  const cadence = agent.schedulingPolicy?.cadence ?? "daily";
  return [`scheduled_creation:${cadence}`, "manual_creation", "feedback_received", "like_received"];
};

const allowedToolIdsForRole = (role: AgentRole): string[] => {
  if (role === "reviewer") {
    return ["read_artifact", "compose_prompt", "create_reaction", "update_memory"];
  }
  if (role === "governance") {
    return ["read_artifact", "validate_artifact", "governance_report", "update_memory"];
  }
  return [
    "read_signal",
    "read_artifact",
    "compose_prompt",
    "generate_artifact",
    "validate_artifact",
    "publish_local",
    "create_reaction",
    "update_memory",
  ];
};

const phasePermissionsForRole = (role: AgentRole): Partial<Record<AgentPhase, string[]>> => {
  if (role === "reviewer") {
    return {
      reviewer: ["read_artifact", "compose_prompt", "create_reaction"],
      reaction: ["read_artifact", "compose_prompt", "create_reaction"],
      learning: ["update_memory"],
    };
  }

  if (role === "governance") {
    return {
      governance: ["read_artifact", "validate_artifact", "governance_report"],
      learning: ["update_memory"],
    };
  }

  return {
    concept: ["read_signal", "read_artifact", "compose_prompt"],
    requirements: ["read_artifact", "compose_prompt"],
    builder: ["compose_prompt", "generate_artifact"],
    materialize: ["generate_artifact", "validate_artifact", "publish_local"],
    reaction: ["read_artifact", "compose_prompt", "create_reaction"],
    learning: ["update_memory"],
  };
};

const normalizeSkillTag = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "_");

const agentSkillTags = (agent: AgentRegistryProfile) =>
  new Set(
    uniqueStrings(
      agent.specialties,
      agent.styleTraits,
      agent.artifactStrengths,
      agent.makerProfile?.materialTaste,
      agent.makerProfile?.signatureScreenTypes,
      agent.creationPolicy?.defaultTemplatePatterns,
    ).map(normalizeSkillTag),
  );

const hasAnySkillTag = (tags: Set<string>, candidates: string[]) =>
  candidates.some((candidate) => tags.has(normalizeSkillTag(candidate)));

const enabledSkillIdsForAgent = (agent: AgentRegistryProfile, role: AgentRole): string[] => {
  const tags = agentSkillTags(agent);
  const skillIds = new Set<string>();

  if (role === "governance") {
    skillIds.add("governance_evidence_report");
    skillIds.add("artifact_contract_validation_loop");
    return Array.from(skillIds);
  }

  if (role === "reviewer") {
    skillIds.add("reaction_with_persona_boundary");
    skillIds.add("artifact_contract_validation_loop");
    if (hasAnySkillTag(tags, ["provenance", "sourcing", "citation", "data_quality", "quality_memory", "safety_review"])) {
      skillIds.add("evidence_provenance_boundary_builder");
    }
    return Array.from(skillIds);
  }

  if (
    hasAnySkillTag(tags, [
      "workflow",
      "decision_support",
      "operator_tools",
      "operations",
      "incident_triage",
      "runbook",
      "decision_board",
      "difference_analysis",
    ])
  ) {
    skillIds.add("concept_signal_to_decision_surface");
  }

  if (
    hasAnySkillTag(tags, [
      "ideation",
      "remix",
      "playful_interaction",
      "game_design",
      "playable_learning",
      "analogy_transfer",
      "cross_domain",
      "roulette",
      "short_choice_game",
    ])
  ) {
    skillIds.add("playful_remix_to_touchable_artifact");
  }

  if (
    hasAnySkillTag(tags, [
      "explanation",
      "comparison",
      "onboarding",
      "learning_path",
      "curriculum",
      "plain_language",
      "accessibility",
      "simplification",
      "frontier_explainer",
      "narrative",
    ])
  ) {
    skillIds.add("explain_compare_path_builder");
  }

  if (
    hasAnySkillTag(tags, [
      "provenance",
      "sourcing",
      "citation",
      "data_quality",
      "hygiene",
      "issue_triage",
      "user_research",
      "field_notes",
    ])
  ) {
    skillIds.add("evidence_provenance_boundary_builder");
  }

  if (
    hasAnySkillTag(tags, [
      "simulation",
      "scenario_design",
      "tradeoff_modeling",
      "trust_boundary",
      "permission_design",
      "civic",
      "community",
      "local_tools",
    ])
  ) {
    skillIds.add("simulation_tradeoff_model");
  }

  if (skillIds.size === 0) {
    skillIds.add("concept_signal_to_decision_surface");
  }

  skillIds.add("artifact_contract_validation_loop");
  skillIds.add("reaction_with_persona_boundary");
  return Array.from(skillIds);
};

const buildMemoryPolicy = (agent: AgentRegistryProfile): MemoryPolicy => ({
  memoryScope: agent.learningPolicy?.memoryScope ?? "own_projects",
  retrieval: {
    maxProjects: 6,
    maxFeedbackItems: 12,
    maxValidationIssues: 8,
    freshnessWindowDays: 30,
    includeFailures: true,
    includePositiveSignals: true,
  },
  update: {
    autoDigestAfterRun: true,
    autoDigestAfterReaction: true,
    profileTextUpdateRequiresHumanApproval: agent.learningPolicy?.updateRequiresHumanApproval ?? true,
    // Skill promotion is automatic once a skill receives human reactions (see promotionPolicy /
    // refresh-agent-skills.ts); there is no separate human-approval gate, so this must stay false
    // to match the enforced behavior.
    skillPromotionRequiresHumanApproval: false,
    maxGuidanceItems: agent.learningPolicy?.maxGuidanceItems ?? 5,
  },
  feedbackUse: {
    useFeedbackTypes: uniqueReactionTypes(agent.learningPolicy?.feedbackToUse),
    useHumanReview: agent.learningPolicy?.feedbackToUse?.includes("human_review") ?? true,
    useValidationWarnings: agent.learningPolicy?.feedbackToUse?.includes("validation_warning") ?? true,
    ignoreSignals: uniqueStrings(agent.learningPolicy?.feedbackToIgnore),
  },
});

const buildSkillPolicy = (agent: AgentRegistryProfile, role: AgentRole): SkillPolicy => ({
  enabledSkillIds: enabledSkillIdsForAgent(agent, role),
  preferredSkillTags: uniqueStrings(agent.specialties, agent.styleTraits),
  phaseRules:
    role === "creator"
      ? {
          concept: { maxSkillsPerRun: 3 },
          builder: { maxSkillsPerRun: 2 },
          reaction: { maxSkillsPerRun: 1 },
        }
      : {
          reaction: { maxSkillsPerRun: 2 },
          governance: { maxSkillsPerRun: 2 },
        },
  promotionPolicy: {
    allowSkillCandidateFromRun: role === "creator",
    // Declared values match what is actually enforced: a skill is distilled from one passing MVP
    // run, and refresh-agent-skills.ts promotes it once it receives >= minHumanPositiveSignals
    // human reactions (comments/likes). Promotion is automatic on human signal — no separate
    // approval gate — so requireHumanApproval is false. AI critiques are stored but never promote.
    minSuccessfulUses: 1,
    minHumanPositiveSignals: 1,
    requireHumanApproval: false,
  },
});

const buildToolPolicy = (role: AgentRole): ToolPolicy => ({
  allowedToolIds: allowedToolIdsForRole(role),
  phasePermissions: phasePermissionsForRole(role),
  riskBudget: {
    maxMediumRiskToolsPerRun: role === "governance" ? 1 : 2,
    highRiskRequiresHumanApproval: true,
  },
  confirmationPolicy: {
    dbWriteRequiresValidation: true,
    externalWriteRequiresHumanApproval: true,
    destructiveActionForbidden: true,
  },
});

const buildTriggerPolicy = (agent: AgentRegistryProfile, role: AgentRole): TriggerPolicy => ({
  enabledTriggerIds: enabledTriggerIdsForRole(agent, role),
  defaultInputBundle: uniqueInputKinds(agent.creationPolicy?.preferredInputs, defaultInputBundleForRole(role)),
  cooldown: {
    cooldownHours: agent.schedulingPolicy?.cooldownHours ?? (role === "creator" ? 24 : 12),
    maxRunsPerDay: agent.schedulingPolicy?.maxRunsPerDay ?? (role === "creator" ? 1 : 3),
    maxReactionsPerDay: agent.interactionPolicy?.maxReactionsPerDay ?? 4,
  },
  idempotency: {
    keyStrategy: role === "creator" ? "agent_day" : "agent_trigger_source",
    duplicateWindowHours: agent.schedulingPolicy?.cooldownHours ?? 24,
  },
});

const memoryDigestFromQualityStats = (
  agent: AgentRegistryProfile,
  generatedAt: string,
): AgentMemoryDigest | undefined => {
  if (!agent.qualityStats) return undefined;

  return {
    agentId: agent.agentId,
    generatedAt,
    sourceRange: { until: generatedAt },
    episodicMemory: {
      recentRunIds: [],
      recentProjectIds: [],
      recentReactionIds: [],
    },
    artifactMemory: {
      successfulPatterns: [],
      overusedPatterns: [],
      ...(typeof agent.qualityStats.validationPassRate === "number"
        ? { validationPassRate: agent.qualityStats.validationPassRate }
        : {}),
      commonArtifactShapes: uniqueArtifactShapes(agent.creationPolicy?.artifactStrengths, agent.artifactStrengths),
    },
    feedbackMemory: {
      praise: [],
      critique: [],
      remixRequests: [],
      ignoredFeedback: uniqueStrings(agent.learningPolicy?.feedbackToIgnore),
    },
    errorMemory: {
      repeatedFailures: [],
      blockedReasons: [],
      toolErrors: [],
    },
    currentGuidance: [],
  };
};

export function buildAgentDefinitionV2(
  agent: AgentRegistryProfile,
  options: AgentDefinitionV2AdapterOptions = {},
): AgentDefinitionV2 {
  const transformedAt = options.transformedAt ?? new Date().toISOString();
  const role = normalizeRole(agent.role);
  const artifactStrengths = uniqueArtifactShapes(agent.creationPolicy?.artifactStrengths, agent.artifactStrengths);
  const fallbackMission =
    firstString(agent.creationPolicy?.mission, agent.reviewPolicy?.mission, agent.oneLiner, agent.identity?.motivation) ??
    `${agent.displayName} creates and reviews Prodia artifacts according to its role.`;
  const background = uniqueStrings(
    agent.oneLiner ? [agent.oneLiner] : undefined,
    agent.specialties,
    agent.styleTraits,
  ).join(" / ");
  const memoryDigest = memoryDigestFromQualityStats(agent, transformedAt);

  return {
    schemaVersion: 2,
    agentId: agent.agentId,
    profileVersion: agent.profileVersion ?? 1,
    displayName: agent.displayName,
    status: normalizeStatus(agent.status),
    role,
    ownerType: normalizeOwnerType(agent.ownerType),
    defaultAutonomyLevel: normalizeAutonomyLevel(agent.defaultAutonomyLevel),
    persona: {
      soul: {
        principle: firstString(agent.identity?.principle) ?? fallbackMission,
        worldview: firstString(agent.identity?.worldview) ?? fallbackMission,
        motivation: firstString(agent.identity?.motivation) ?? fallbackMission,
        voice: firstString(agent.identity?.voice) ?? "Clear, concise, product-minded",
        background: background || fallbackMission,
      },
      creationTaste: {
        mission: fallbackMission,
        preferredProblems: uniqueStrings(agent.makerProfile?.materialTaste, agent.specialties),
        preferredUsers: [],
        preferredInputs: uniqueInputKinds(agent.creationPolicy?.preferredInputs),
        sourceReadingStyle:
          firstString(agent.creationPolicy?.sourceReadingStyle) ??
          "Read inputs through the agent's role, specialty, and current product context.",
        conceptSelectionRules: uniqueStrings(agent.creationPolicy?.conceptSelectionRules),
        materialTaste: uniqueStrings(agent.makerProfile?.materialTaste),
        signatureScreenTypes: uniqueStrings(agent.makerProfile?.signatureScreenTypes),
        artifactStrengths,
        defaultTemplatePatterns: uniqueStrings(agent.creationPolicy?.defaultTemplatePatterns),
        qualityBar: uniqueStrings(agent.creationPolicy?.qualityBar, agent.reviewPolicy?.passBar),
        antiPatterns: uniqueStrings(agent.creationPolicy?.antiPatterns, agent.avoid),
      },
      reactionTaste: {
        canReactWith: uniqueReactionTypes(agent.interactionPolicy?.canReactWith),
        critiqueFocus: uniqueStrings(agent.interactionPolicy?.critiqueFocus, agent.reviewPolicy?.reviewFocus),
        targetPreference: uniqueStrings(agent.interactionPolicy?.targetPreference),
        likeCriteria: uniqueStrings(agent.creationPolicy?.qualityBar, agent.reviewPolicy?.passBar),
        remixCriteria: uniqueStrings(agent.creationPolicy?.conceptSelectionRules),
        doNotDo: uniqueStrings(agent.interactionPolicy?.doNotDo, agent.structuredBoundaries?.forbiddenClaims),
        ...(normalizePropensity(agent.interactionPolicy?.propensity)
          ? { propensity: normalizePropensity(agent.interactionPolicy?.propensity) }
          : {}),
      },
      expressionStyle: {
        explanationTone: firstString(agent.identity?.voice) ?? "Clear, concise, product-minded",
        uiStyle: uniqueStrings(agent.styleTraits, agent.makerProfile?.signatureScreenTypes),
        namingStyle: uniqueStrings(agent.styleTraits),
        copyStyle: uniqueStrings(agent.styleTraits),
      },
      boundaries: {
        forbiddenDomains: uniqueStrings(agent.structuredBoundaries?.forbiddenDomains),
        forbiddenClaims: uniqueStrings(agent.structuredBoundaries?.forbiddenClaims),
        refusedDirections: uniqueStrings(agent.makerProfile?.refusesToMake, agent.avoid, agent.boundaries),
        externalDependencyRules: uniqueStrings(agent.structuredBoundaries?.externalDependencyRules),
        publishAuthority: agent.structuredBoundaries?.publishAuthority ?? "requires_validation",
      },
    },
    memoryPolicy: buildMemoryPolicy(agent),
    skillPolicy: buildSkillPolicy(agent, role),
    toolPolicy: buildToolPolicy(role),
    triggerPolicy: buildTriggerPolicy(agent, role),
    governancePolicy: {
      actorAttributionRequired: true,
      autonomousActionLabelRequired: true,
      humanInfluenceLabelRequired: true,
      allowedPublishTargets: role === "creator" ? ["local_feed", "admin_only"] : ["admin_only"],
      forbiddenActions: ["delete", "unpublish", "ban", "auto_approve", "external_publish"],
      reviewRequiredFor: ["profile_update", "skill_activation", "high_risk_tool", "external_write"],
    },
    publicProfile: {
      oneLiner: agent.oneLiner ?? null,
      specialties: uniqueStrings(agent.specialties),
      qualityStats: agent.qualityStats ?? null,
      memoryDigestPreview: memoryDigest ?? null,
    },
    migration: {
      sourceSchema: "agent-registry.v2",
      sourceAgentId: agent.agentId,
      ...(typeof agent.profileVersion === "number" ? { sourceProfileVersion: agent.profileVersion } : {}),
      sourceFields: sourceFields(agent),
      transformedAt,
      notes: [
        "Existing agent-registry data is preserved; this definition is an adapter snapshot.",
        "SkillRegistry, ToolRegistry, and TriggerRegistry are represented as policy IDs until registry files are introduced.",
      ],
    },
  };
}

export function buildAgentDefinitionV2RegistrySnapshot(
  registry: AgentRegistry,
  options: AgentDefinitionV2AdapterOptions = {},
): AgentDefinitionV2RegistrySnapshot {
  const transformedAt = options.transformedAt ?? new Date().toISOString();

  return {
    schemaVersion: 2,
    sourceRegistryVersion: registry.version,
    transformedAt,
    agents: registry.agents.map((agent) => buildAgentDefinitionV2(agent, { transformedAt })),
  };
}
