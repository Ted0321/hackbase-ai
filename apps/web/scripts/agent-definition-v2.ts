export type AgentStatus = "draft" | "active" | "paused" | "retired";
export type AgentRole = "creator" | "reviewer" | "governance";
export type AgentOwnerType = "system" | "human_owner";

export type AutonomyLevel =
  | "L0_manual_only"
  | "L1_assisted"
  | "L2_self_directed_draft"
  | "L3_local_publish_after_validation"
  | "L4_external_action_requires_human_approval";

export type AgentInputKind =
  | "trendSignals"
  | "productSourceIndex"
  | "topicRadar"
  | "currentTopicRadar"
  | "recentArtifacts"
  | "humanFeedback"
  | "agentFeedback"
  | "validationResults"
  | "agentMemoryDigest"
  | "agentRegistry"
  | "agentLearnings";

export type ArtifactShape =
  | "audit_report"
  | "board"
  | "evaluator"
  | "explainer"
  | "game_like_tool"
  | "hold_recommendation"
  | "map"
  | "publish_gate"
  | "review_report"
  | "revision_brief"
  | "risk_summary"
  | "simulator"
  | "transformation_studio"
  | "workspace";

export type AgentReactionType =
  | "agent_like"
  | "agent_critique"
  | "agent_remix_suggestion"
  | "agent_compare_note"
  | "agent_risk_flag"
  | "human_review"
  | "validation_warning";

export type ReactionTargetPreference = string;

export type AgentPhase =
  | "research"
  | "combination"
  | "concept"
  | "agent-router"
  | "requirements"
  | "builder"
  | "materialize"
  | "reviewer"
  | "rewriter"
  | "publisher"
  | "reaction"
  | "learning"
  | "governance";

export type TriggerType =
  | "schedule"
  | "data_refresh"
  | "feedback_received"
  | "like_received"
  | "manual"
  | "threshold"
  | "governance";

export type TriggerAttributionPolicy = {
  humanInfluence:
    | "none"
    | "human_seeded"
    | "human_requested"
    | "human_approved"
    | "system_scheduled";
  recordPromptSource: boolean;
  recordOwner: boolean;
};

export type AgentBoundaries = {
  forbiddenDomains: string[];
  forbiddenClaims: string[];
  refusedDirections: string[];
  externalDependencyRules: string[];
  publishAuthority: "none" | "local_only" | "requires_validation";
};

export type PersonaLayer = {
  soul: {
    principle: string;
    worldview: string;
    motivation: string;
    voice: string;
    background: string;
  };
  creationTaste: {
    mission: string;
    preferredProblems: string[];
    preferredUsers: string[];
    preferredInputs: AgentInputKind[];
    sourceReadingStyle: string;
    conceptSelectionRules: string[];
    materialTaste: string[];
    signatureScreenTypes: string[];
    artifactStrengths: ArtifactShape[];
    defaultTemplatePatterns: string[];
    qualityBar: string[];
    antiPatterns: string[];
  };
  reactionTaste: {
    canReactWith: AgentReactionType[];
    critiqueFocus: string[];
    targetPreference: ReactionTargetPreference[];
    likeCriteria: string[];
    remixCriteria: string[];
    doNotDo: string[];
    propensity?: Partial<Record<AgentReactionType, number>>;
  };
  expressionStyle: {
    explanationTone: string;
    uiStyle: string[];
    namingStyle: string[];
    copyStyle: string[];
  };
  boundaries: AgentBoundaries;
};

export type MemoryPolicy = {
  memoryScope: "own_projects" | "same_category" | "all_projects";
  retrieval: {
    maxProjects: number;
    maxFeedbackItems: number;
    maxValidationIssues: number;
    freshnessWindowDays: number;
    includeFailures: boolean;
    includePositiveSignals: boolean;
  };
  update: {
    autoDigestAfterRun: boolean;
    autoDigestAfterReaction: boolean;
    profileTextUpdateRequiresHumanApproval: boolean;
    skillPromotionRequiresHumanApproval: boolean;
    maxGuidanceItems: number;
  };
  feedbackUse: {
    useFeedbackTypes: AgentReactionType[];
    useHumanReview: boolean;
    useValidationWarnings: boolean;
    ignoreSignals: string[];
  };
};

export type AgentMemoryDigest = {
  agentId: string;
  generatedAt: string;
  sourceRange: {
    since?: string;
    until: string;
  };
  episodicMemory: {
    recentRunIds: string[];
    recentProjectIds: string[];
    recentReactionIds: string[];
  };
  artifactMemory: {
    successfulPatterns: string[];
    overusedPatterns: string[];
    validationPassRate?: number;
    commonArtifactShapes: ArtifactShape[];
  };
  feedbackMemory: {
    praise: string[];
    critique: string[];
    remixRequests: string[];
    ignoredFeedback: string[];
  };
  errorMemory: {
    repeatedFailures: string[];
    blockedReasons: string[];
    toolErrors: string[];
  };
  currentGuidance: string[];
};

export type SkillPolicy = {
  enabledSkillIds: string[];
  preferredSkillTags: string[];
  phaseRules: Partial<Record<AgentPhase, SkillSelectionRule>>;
  promotionPolicy: {
    allowSkillCandidateFromRun: boolean;
    minSuccessfulUses: number;
    minHumanPositiveSignals: number;
    requireHumanApproval: boolean;
  };
};

export type SkillSelectionRule = {
  requiredSkillIds?: string[];
  preferredSkillIds?: string[];
  forbiddenSkillIds?: string[];
  maxSkillsPerRun: number;
};

export type AgentSkillDefinition = {
  schemaVersion: 1;
  skillId: string;
  name: string;
  description: string;
  tags: string[];
  applicablePhases: AgentPhase[];
  triggerHints: string[];
  inputRequirements: string[];
  procedure: string[];
  outputContract: string[];
  examples: Array<{
    sourceRunId?: string;
    summary: string;
  }>;
  failureModes: string[];
  validationChecks: string[];
  sourceEvidence: {
    runIds: string[];
    projectIds: string[];
    feedbackIds: string[];
  };
  version: number;
  status: "draft" | "active" | "deprecated";
};

export type ToolPolicy = {
  allowedToolIds: string[];
  phasePermissions: Partial<Record<AgentPhase, string[]>>;
  riskBudget: {
    maxMediumRiskToolsPerRun: number;
    highRiskRequiresHumanApproval: boolean;
  };
  confirmationPolicy: {
    dbWriteRequiresValidation: boolean;
    externalWriteRequiresHumanApproval: boolean;
    destructiveActionForbidden: boolean;
  };
};

export type AgentToolDefinition = {
  schemaVersion: 1;
  toolId: string;
  name: string;
  purpose: string;
  capability: ToolCapability;
  inputSchemaRef: string;
  outputSchemaRef: string;
  allowedPhases: AgentPhase[];
  permissionLevel: ToolPermissionLevel;
  riskLevel: "low" | "medium" | "high";
  requiresSecret: boolean;
  costPolicy: "free" | "metered" | "paid_requires_approval";
  networkPolicy: "none" | "allowlisted" | "open_requires_approval";
  sandboxPolicy: "repo_read" | "repo_write" | "db_write" | "external_write";
  auditLogRequired: boolean;
  agentEligibility: "creator" | "reviewer" | "governance" | "all";
};

export type ToolCapability =
  | "read_signal"
  | "read_artifact"
  | "compose_prompt"
  | "generate_artifact"
  | "validate_artifact"
  | "publish_local"
  | "create_reaction"
  | "update_memory"
  | "create_skill_candidate"
  | "governance_report";

export type ToolPermissionLevel = "read_only" | "local_write" | "db_write" | "external_write";

export type TriggerPolicy = {
  enabledTriggerIds: string[];
  defaultInputBundle: AgentInputKind[];
  cooldown: {
    cooldownHours: number;
    maxRunsPerDay: number;
    maxReactionsPerDay: number;
  };
  idempotency: {
    keyStrategy: "agent_day" | "agent_trigger_source" | "run_id";
    duplicateWindowHours: number;
  };
};

export type AgentTriggerDefinition = {
  schemaVersion: 1;
  triggerId: string;
  name: string;
  type: TriggerType;
  enabled: boolean;
  condition: TriggerCondition;
  actingAgentSelector: ActingAgentSelector;
  inputBundle: AgentInputKind[];
  targetPhase: AgentPhase;
  autonomyLevel: AutonomyLevel;
  priority: number;
  safetyGate: {
    validationRequired: boolean;
    stewardCheckRequired: boolean;
    humanApprovalRequired: boolean;
  };
  attribution: TriggerAttributionPolicy;
};

export type TriggerCondition = {
  cadence?: "daily" | "every_other_day" | "every_2_days" | "every_3_days" | "weekly" | "on_demand";
  preferredHours?: number[];
  eventTypes?: string[];
  minSignalCount?: number;
  minFeedbackCount?: number;
  minLikeCount?: number;
};

export type ActingAgentSelector =
  | { mode: "specific_agent"; agentId: string }
  | { mode: "due_active_creators"; maxAgents: number }
  | { mode: "category_matched"; categoryIds: string[]; maxAgents: number };

export type GovernancePolicy = {
  actorAttributionRequired: boolean;
  autonomousActionLabelRequired: boolean;
  humanInfluenceLabelRequired: boolean;
  allowedPublishTargets: Array<"local_feed" | "admin_only" | "external_requires_approval">;
  forbiddenActions: Array<"delete" | "unpublish" | "ban" | "auto_approve" | "external_publish">;
  reviewRequiredFor: Array<"profile_update" | "skill_activation" | "high_risk_tool" | "external_write">;
};

export type PublicAgentProfile = Record<string, unknown>;

export type AgentMigrationMetadata = {
  sourceSchema: "agent-registry.v2";
  sourceAgentId: string;
  sourceProfileVersion?: number;
  sourceFields: string[];
  transformedAt: string;
  notes: string[];
};

export type AgentDefinitionV2 = {
  schemaVersion: 2;
  agentId: string;
  profileVersion: number;
  displayName: string;
  status: AgentStatus;
  role: AgentRole;
  ownerType: AgentOwnerType;
  defaultAutonomyLevel: AutonomyLevel;
  persona: PersonaLayer;
  memoryPolicy: MemoryPolicy;
  skillPolicy: SkillPolicy;
  toolPolicy: ToolPolicy;
  triggerPolicy: TriggerPolicy;
  governancePolicy: GovernancePolicy;
  publicProfile?: PublicAgentProfile;
  migration?: AgentMigrationMetadata;
};

export type AgentRuntimeContext = {
  runId: string;
  agentId: string;
  phase: AgentPhase;
  trigger: {
    triggerId: string;
    type: TriggerType;
    autonomyLevel: AutonomyLevel;
    attribution: TriggerAttributionPolicy;
  };
  personaSnapshot: Pick<PersonaLayer, "soul" | "creationTaste" | "reactionTaste" | "boundaries">;
  memoryDigest?: AgentMemoryDigest;
  skillRefs: Array<
    Pick<AgentSkillDefinition, "skillId" | "name" | "description" | "procedure" | "outputContract">
  >;
  allowedTools: Array<
    Pick<AgentToolDefinition, "toolId" | "name" | "purpose" | "permissionLevel" | "riskLevel">
  >;
  inputBundle: Record<string, unknown>;
  outputContract: Record<string, unknown>;
};
