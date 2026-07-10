export const pipelineSteps = [
  "research",
  "combination",
  "concept",
  "agent-router",
  "requirements",
  "builder",
  "reviewer",
  "rewriter",
  "publisher",
] as const;

export type PipelineStep = (typeof pipelineSteps)[number];

export type SourceRef = {
  title: string;
  url: string;
  sourceType: string;
  observedAt?: string;
  evidenceSummary: string;
};

export type ResearchLane =
  | "theme_durable_base"
  | "theme_current_trend"
  | "winning_pattern_research"
  | "tech_frontier"
  | "social_trend"
  | "product_market_watch"
  | "research_editor"
  | string;

export type ResearchReport = {
  id: string;
  generatedAt: string;
  researcherAgentId: string;
  lane?: ResearchLane;
  sourceArea: string;
  queryOrBrief: string;
  searchDepth?: "deep" | "broad" | "market_scan" | "editorial";
  sources: SourceRef[];
  findings: Array<{
    title: string;
    observedFacts?: string[];
    interpretation?: string;
    trendSignal?: string;
    audienceReaction?: string;
    underlyingMechanism?: string;
    technicalShift?: string | null;
    adoptionProof?: string[];
    developerPain?: string | null;
    newCapability?: string | null;
    noveltyType?:
      | "new_capability"
      | "new_interface"
      | "new_workflow"
      | "new_distribution"
      | "new_risk_surface"
      | "benchmark_or_eval"
      | "market_packaging"
      | "social_behavior"
      | "other"
      | string;
    artifactPotential?: string;
    possibleUseContexts?: string[];
    researchAngles?: string[];
    /** @deprecated Researcher should prefer researchAngles / possibleUseContexts. */
    conceptSeeds?: string[];
    uncertainties?: string[];
    whyItMatters: string;
    /** @deprecated Researcher should prefer researchAngles / possibleUseContexts. */
    prototypeOpportunity?: string;
    /** @deprecated Researcher should not define a final interaction. */
    prototypeInteraction?: string;
    /** @deprecated Researcher should leave artifact shape decisions to Concept Strategist. */
    prototypeArchetypes?: string[];
    transferAngles?: string[];
    risks: string[];
  }>;
  confidence: "low" | "medium" | "high";
  notesForConceptAgent: string;
};

export type SignalCard = {
  id: string;
  researchReportId?: string;
  lane?: ResearchLane;
  sourceType: string;
  title: string;
  url?: string;
  summary: string;
  observedFacts?: string[];
  trendSignal?: string;
  audience?: string;
  underlyingMechanism?: string;
  technicalShift?: string | null;
  adoptionProof?: string[];
  developerPain?: string | null;
  newCapability?: string | null;
  noveltyType?:
    | "new_capability"
    | "new_interface"
    | "new_workflow"
    | "new_distribution"
    | "new_risk_surface"
    | "benchmark_or_eval"
    | "market_packaging"
    | "social_behavior"
    | "other"
    | string;
  artifactPotential?: string;
  possibleUseContexts?: string[];
  researchAngles?: string[];
  /** @deprecated Researcher should prefer researchAngles / possibleUseContexts. */
  conceptSeeds?: string[];
  whyItMatters?: string;
  /** @deprecated Researcher should prefer researchAngles / possibleUseContexts. */
  prototypeHint?: string;
  /** @deprecated Researcher should leave artifact shape decisions to Concept Strategist. */
  prototypeArchetypes?: string[];
  diversityTags?: string[];
  scores: {
    freshness: number;
    momentum: number;
    evidenceStrengthScore?: number;
    technicalNovelty: number;
    socialResonance?: number;
    marketSignal?: number;
    culturalEnergy?: number;
    productizability?: number;
    visualPotential?: number;
    playfulness?: number;
    riskLow: number;
  };
  evidenceStrength?: "low" | "medium" | "high";
  rawEvidenceRefs: string[];
};

export type ThemeMaterial = {
  id: string;
  themeType: "durable_base" | "technical_trend" | "social_trend" | string;
  title: string;
  summary: string;
  whyItMattersNow: string;
  durability: "short_event" | "seasonal" | "recurring" | "evergreen" | string;
  audience: string;
  userFrictionOrDesire: string;
  possibleInputs: string[];
  evidenceRefs: string[];
  relatedSignals: string[];
  combinableWithPatternTags: string[];
  confidence: "low" | "medium" | "high";
};

export type WinningPatternReport = {
  id: string;
  patternTag:
    | "existing_surface_ai_hand"
    | "learning_package"
    | "trust_boundary"
    | "failure_analysis"
    | "domain_pain_to_tool"
    | "visible_transformation"
    | "evidence_weighted_decision"
    | "multi_agent_organization"
    | "workflow_generation"
    | "playful_simulation"
    | "other"
    | string;
  patternName: string;
  summary: string;
  exampleProducts: Array<{
    name: string;
    url: string;
    evidence: string;
  }>;
  patternMechanism: string;
  audiencePull: string;
  transferableRule: string;
  antiCloneBoundary: string;
  bestFitThemeTypes: Array<"durable_base" | "technical_trend" | "social_trend" | string>;
  evidenceStrength: "low" | "medium" | "high";
};

export type CombinationHint = {
  id: string;
  themeMaterialId: string;
  winningPatternReportId: string;
  whyThisPairingMayBeInteresting: string;
  audienceHypothesis: string;
  evidenceRefs: string[];
  riskOrUnknown: string;
};

export type SourceProductCard = {
  id: string;
  name: string;
  sourceType:
    | "github_trending"
    | "github_high_star"
    | "hackathon_winner"
    | "hackathon_demo"
    | "product_showcase"
    | "indie_product"
    | "huggingface_space"
    | "product_hunt"
    | "other"
    | string;
  sourceCategory?: string;
  url: string;
  productUrl?: string | null;
  codeUrl?: string | null;
  observedAt: string;
  originalDomain: string;
  concept?: string;
  targetUser?: string;
  oneLineDescription: string;
  problemSolved?: string;
  userFriction?: string;
  coreUserInput: string;
  coreOutput: string;
  coreMechanism: string;
  interactionPattern: string;
  whyItIsInteresting: string;
  whyItGotAttention?: string;
  adoptionOrAttentionProof: string[];
  attentionProof?: string[];
  scaleClassification?:
    | "small_rising"
    | "indie"
    | "hackathon"
    | "prototype"
    | "early_oss"
    | "showcase_launch"
    | "other"
    | string;
  reasonIncluded?: string;
  reasonNotMajorProduct?: string;
  transferableStructure: string;
  ideaKernel?: string;
  noveltyKernel?: string;
  outputArtifact?: string;
  transformationAxes?: string[];
  cloneRisk: string;
  antiCloneBoundary?: string;
  doNotCopy: string[];
  remixableThemes: string[];
  bestRemixTargets?: string[];
  evidenceRefs: string[];
  evidenceStrength?: "low" | "medium" | "high";
  evidenceLevel?: "verified" | "partial" | "thin" | "unknown" | string;
  observedFields?: string[];
  inferredFields?: string[];
  missingFields?: string[];
  usePolicy?: string;
  confidence: "low" | "medium" | "high";
};

export type SourceProductUse = "direct_evidence" | "inspiration_only" | "do_not_use_as_fact" | string;

export type SourceEvidenceAudit = {
  evidenceLevel: "verified" | "partial" | "thin" | "unknown" | string;
  observedFields: string[];
  inferredFields: string[];
  missingFields: string[];
  usePolicy: string;
};

export type ProductSourceIndexEntry = SourceProductCard & {
  canonicalKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUpdatedAt: string;
  status: "active" | "stale" | "duplicate" | "excluded" | string;
  sourceCategories: Array<"hackathon_winner" | "github_rising" | "product_gallery" | string>;
  discoverySources: SourceArchiveIndexItem[];
  valueKnowledgeCardIds: string[];
  productUrl: string | null;
  codeUrl: string | null;
  sourceCategory: string;
  concept: string;
  problemSolved: string;
  targetUser: string;
  userFriction: string;
  whyItGotAttention: string;
  noveltyKernel: string;
  outputArtifact: string;
  ideaKernel: string;
  transformationAxes: string[];
  antiCloneBoundary: string;
  attentionProof: string[];
  bestRemixTargets: string[];
  evidenceStrength: "low" | "medium" | "high";
  duplicateOf?: string | null;
  sightingsCount?: number;
};

export type SourceArchiveIndexItem = {
  id: string;
  sourceProductCardId: string;
  sourceCategory: "hackathon_winner" | "github_rising" | "product_gallery" | "other" | string;
  sourceName: string;
  sourceUrl: string | null;
  retrievalQueryOrPath: string;
  observedAt: string;
  revisitCadence: "daily" | "weekly" | "monthly" | "ad_hoc" | string;
  storedEvidenceSummary: string;
  evidenceStrength: "low" | "medium" | "high";
};

export type ProductSourceIndex = {
  version: number;
  updatedAt: string;
  purpose: string;
  updatePolicy: {
    cadence: "daily" | "weekly" | "manual" | string;
    dedupeKey: string;
    addWhen: string[];
    updateWhen: string[];
    excludeWhen: string[];
  };
  entries: ProductSourceIndexEntry[];
  sourceArchiveIndex: SourceArchiveIndexItem[];
  valueKnowledgeCards: ValueKnowledgeCard[];
  excludedAsSourceProductCards: string[];
  maintenanceNotes: string[];
};

export type ValueKnowledgeCard = {
  id: string;
  sourceProductCardId: string;
  valueName: string;
  whatIsValuable: string;
  whyPeopleReact: string;
  underlyingMechanism: string;
  transferableRule: string;
  antiCloneBoundary: string;
  bestRemixTargets: string[];
  confidence: "low" | "medium" | "high";
};

export type TopicCard = {
  id: string;
  category:
    | "technology"
    | "social_trend"
    | "sdgs_civic"
    | "education"
    | "research"
    | "culture_sports"
    | "consumer_life"
    | string;
  title: string;
  summary: string;
  whyHotNow: string;
  audience: string[];
  userFrictionOrDesire: string;
  possibleInputs: string[];
  evidenceRefs: string[];
  trendMaturity: "temporary_event" | "seasonal" | "recurring" | "evergreen" | string;
  remixUse: string;
  riskNotes: string[];
  confidence: "low" | "medium" | "high";
};

export type TopicRadar = {
  version: number;
  generatedAt: string;
  purpose: string;
  topicCards: TopicCard[];
  coverageGaps: string[];
};

export type ResearchResponse = {
  researchRunSummary: {
    id: string;
    generatedAt: string;
    coverageSummary: string;
    coverageGaps: string[];
    strongestSignals: string[];
    editorNotesForConceptStrategist: string;
  };
  researchReports: ResearchReport[];
  productSourceIndexSnapshot?: {
    entryCount: number;
    selectedEntryIds: string[];
    excludedMajorProducts: string[];
    staleOrDuplicateNotes: string[];
  };
  sourceProductCards?: SourceProductCard[];
  sourceArchiveIndex?: SourceArchiveIndexItem[];
  valueKnowledgeCards?: ValueKnowledgeCard[];
  topicCards?: TopicCard[];
  themeMaterials?: ThemeMaterial[];
  winningPatternReports?: WinningPatternReport[];
  combinationHints?: CombinationHint[];
  signalCards: SignalCard[];
};

export type ThemePatternCombination = {
  id: string;
  themeMaterialIds: string[];
  winningPatternReportIds: string[];
  sourceSignalIds: string[];
  combinationTitle: string;
  pairingSummary: string;
  whyThisCouldBeInteresting: string;
  broadAudienceHook: string;
  aiNativeHook: string;
  possibleUserInputs: string[];
  visibleInteractionPossibilities: string[];
  antiGenericRisk: string;
  antiCloneBoundary: string;
  evidenceRefs: string[];
  scores: {
    themeLegibility: number;
    patternStrength: number;
    themePatternFit: number;
    aiNativeInterest: number;
    broadUserAppeal: number;
    oneScreenArtifactPotential: number;
    noveltyAgainstRecentArtifacts: number;
    feasibility: number;
    riskLow: number;
    total: number;
  };
  confidence: "low" | "medium" | "high";
};

export type CombinationStrategyResponse = {
  combinationRunSummary: {
    id: string;
    generatedAt: string;
    inputResearchRunId?: string;
    strategySummary: string;
    strongestCombinations: string[];
    rejectedButInteresting: string[];
    risksForConceptStrategist: string[];
  };
  evaluatedCombinations: ThemePatternCombination[];
  selectedCombinations: ThemePatternCombination[];
  rejectedInterestingCombinations: Array<{
    id: string;
    themeMaterialIds: string[];
    winningPatternReportIds: string[];
    reasonRejected: string;
    whyStillInteresting: string;
    whatWouldMakeItStronger: string;
  }>;
};

export type ProductCoreRemixCandidate = {
  id: string;
  sourceProductCardIds: string[];
  productSourceIndexEntryIds?: string[];
  valueKnowledgeCardIds?: string[];
  topicCardIds?: string[];
  ideaMoveIds?: string[];
  sourceProductNames: string[];
  originalDomain: string;
  newTheme: string;
  remixTitle: string;
  whatWasTransferred: string;
  whatWasChanged: string;
  ideaMoveApplied?: string;
  topicApplied?: string;
  whyThisMayWork: string;
  broadAudienceHook: string;
  aiNativeHook: string;
  possibleUserInputs: string[];
  visibleInteractionPossibilities: string[];
  antiCloneBoundary: string;
  sourceProductUse?: SourceProductUse;
  sourceEvidenceAudit?: SourceEvidenceAudit;
  evidenceRefs: string[];
  scores: {
    sourceProductStrength: number;
    coreTransferClarity: number;
    themeShiftSurprise: number;
    broadUserAppeal: number;
    aiNativeInterest: number;
    oneScreenArtifactPotential: number;
    noveltyAgainstRecentArtifacts: number;
    feasibility: number;
    riskLow: number;
      total: number;
  };
  reviewerNotes?: string[];
  iterationNotes?: string[];
  confidence: "low" | "medium" | "high";
};

export type RemixStrategyResponse = {
  remixRunSummary: {
    id: string;
    generatedAt: string;
    inputResearchRunId?: string;
    strategySummary: string;
    strongestRemixes: string[];
    rejectedButInteresting: string[];
    risksForConceptStrategist: string[];
  };
  evaluatedRemixes: ProductCoreRemixCandidate[];
  selectedRemixes: ProductCoreRemixCandidate[];
  rejectedInterestingRemixes: Array<{
    id: string;
    sourceProductCardIds: string[];
    newTheme: string;
    reasonRejected: string;
    whyStillInteresting: string;
    whatWouldMakeItStronger: string;
  }>;
};

export type AgentRuntimeReflection = {
  agentId?: string;
  phase?: string;
  triggerUsed?: string;
  personaInfluence?: string[];
  memoryInfluence?: string[];
  skillApplied?: string[];
  toolBoundary?: string[];
  outputContractApplied?: string[];
  governanceBoundary?: string[];
};

export type ConceptBrief = {
  id: string;
  title: string;
  oneLiner: string;
  // P1-B: この企画を一人称で書いた acting agent（指定がある自走runのみ）
  conceptAgentId?: string;
  agentMakerFit?: string;
  agentRuntimeReflection?: AgentRuntimeReflection;
  materialChoiceReason?: string;
  refusedDirection?: string;
  sourceSignalIds: string[];
  notObviousInsight: string;
  researchAngleUsed?: string;
  combinationUsed?: string;
  remixUsed?: string;
  sourceProductUsed?: string;
  sourceProductUse?: SourceProductUse;
  sourceEvidenceAudit?: SourceEvidenceAudit;
  originalCoreTransferred?: string;
  newThemeApplied?: string;
  ideaMoveUsed?: string;
  topicCardUsed?: string;
  reviewerInsightUsed?: string;
  themeMaterialUsed?: string;
  winningPatternUsed?: string;
  themePatternFit?: string;
  evidenceUsed?: string[];
  noveltyTypeUsed?: string;
  surfaceAudience?:
    | "general curious user"
    | "office worker"
    | "teacher/student"
    | "fan/casual participant"
    | "family/local citizen"
    | "creator"
    | "AI-curious professional"
    | string;
  aiAppreciationAudience?:
    | "AI engineer"
    | "AI power user"
    | "indie AI builder"
    | "domain expert using AI"
    | "tech-curious creator"
    | string;
  surfaceTheme?: "sports" | "education" | "work" | "civic" | "life" | "creativity" | "AI literacy" | "culture" | string;
  surfacePattern?:
    | "daily_utility"
    | "learning_explainer"
    | "playful_game"
    | "decision_helper"
    | "social_civic_tool"
    | "event_companion"
    | "creative_assistant"
    | "work_simplifier"
    | string;
  aiMechanismPattern?:
    | "personalized_reasoning"
    | "multi_source_synthesis"
    | "agentic_workflow"
    | "simulation"
    | "evaluation_scoring"
    | "trust_boundary"
    | "adaptive_explainer"
    | "workflow_generation"
    | string;
  templatePatternId?:
    | "source_to_mission"
    | "evidence_decision_board"
    | "signal_map"
    | "transformation_studio"
    | "boundary_simulator"
    | "guided_explainer_path"
    | "remix_roulette"
    | "ops_steward_console"
    | string;
  templatePatternReason?: string;
  whyNormalUserCares?: string;
  whyAIUserCares?: string;
  aiMechanism?: string;
  targetPersona?:
    | "AI engineer"
    | "AI power user"
    | "indie AI builder"
    | "domain expert using AI"
    | "tech-curious creator"
    | string;
  productPattern?:
    | "agent_observatory"
    | "risk_boundary_probe"
    | "eval_lab"
    | "frontier_explainer"
    | "builder_tool"
    | "trend_radar"
    | "vibe_coding_amplifier"
    | "playful_ai_simulation"
    | string;
  patternReason?: string;
  interestHook?: string;
  frontierMechanism?: string;
  funOrValueCore?: string;
  firstScreenMechanic?: string;
  whyThisUserWouldShare?: string;
  boringFailureMode?: string;
  targetUser: string;
  userMoment: string;
  coreInteraction: string;
  whyDifferentFromRecentArtifacts: string;
  artifactShape:
    | "board"
    | "simulator"
    | "evaluator"
    | "map"
    | "workspace"
    | "game_like_tool"
    | "explainer"
    | "other";
  antiGenericChecks?: string[];
  sharpnessChecks: string[];
  risks: string[];
  successCriteria: string[];
};

export type AgentRegistryEntry = {
  agentId: string;
  displayName: string;
  status?: "draft" | "active" | "paused" | "retired" | string;
  ownerType: "system" | "human" | "human_owner" | string;
  role?: "creator" | "reviewer" | "governance" | string;
  oneLiner?: string;
  defaultAutonomyLevel?: "L0_manual" | "L1_assisted" | "L2_scheduled" | "L3_auto_publish" | "L4_external" | string;
  identity?: {
    principle: string;
    worldview: string;
    voice: string;
  };
  specialties: string[];
  artifactStrengths: string[];
  styleTraits: string[];
  avoid: string[];
  boundaries?: string[];
  interactionPolicy?: {
    canReactWith: string[];
    critiqueFocus: string[];
    doNotDo: string[];
  };
  reviewPolicy?: {
    mission: string;
    reviewFocus: string[];
    passBar: string[];
    failurePatterns: string[];
    evidenceToRecord: string[];
    learningSources: string[];
  };
  recentUsageCount: number;
  qualityStats: {
    validationPassRate: number | null;
    noveltyAverage: number | null;
    humanWantToGrowCount: number;
  };
};

export type AgentAssignment = {
  conceptId: string;
  selectedAgentIds: string[];
  assignmentReason: string;
  rejectedAgents: Array<{
    agentId: string;
    reason: string;
  }>;
  collaborationMode: "single_agent" | "lead_plus_reviewers" | "small_team";
};

export type GovernanceReport = {
  id: string;
  generatedAt: string;
  governanceAgentId: string;
  scope: {
    runIds: string[];
    projectIds: string[];
    lookbackWindow: "manual" | "daily" | "weekly" | "custom" | string;
  };
  summary: string;
  overallStatus: "clear" | "needs_review" | "hold_recommended" | "blocked";
  findings: Array<{
    id: string;
    targetType: "project" | "run" | "agent" | "artifact" | "feedback" | string;
    targetId: string;
    severity: "info" | "warning" | "high" | "blocker";
    category:
      | "validation_gap"
      | "policy_risk"
      | "duplicate_like"
      | "secret_like"
      | "external_dependency_like"
      | "prompt_injection_like"
      | "display_regression"
      | "missing_artifact"
      | "unclear_attribution"
      | "agent_behavior"
      | string;
    evidence: string[];
    recommendation: string;
    proposedAction:
      | "none"
      | "needs_rewrite"
      | "hold_for_review"
      | "withdrawal_review"
      | "profile_pause_review"
      | string;
  }>;
  cleanupCandidates: Array<{
    targetType: "project" | "run" | "artifact" | string;
    targetId: string;
    reason: string;
    requiresHumanApproval: true;
  }>;
  coverageGaps: string[];
  nextReviewHint: string;
};

export type RequirementSpec = {
  id: string;
  conceptId: string;
  ownerAgentId: string;
  sourceBoundary?: string;
  antiCloneBoundary?: string;
  sourceUseBoundary?: string;
  templatePatternId?:
    | "source_to_mission"
    | "evidence_decision_board"
    | "signal_map"
    | "transformation_studio"
    | "boundary_simulator"
    | "guided_explainer_path"
    | "remix_roulette"
    | "ops_steward_console"
    | string;
  agentMakerFit?: string;
  agentRuntimeReflection?: AgentRuntimeReflection;
  materialChoices?: string[];
  refusedDirections?: string[];
  mvpGoal: string;
  screens: Array<{
    name: string;
    purpose: string;
    templatePatternSlot?: string;
    primaryControl?: string;
    stateOutput?: string;
    components: string[];
    interactions: string[];
  }>;
  dataModel: Array<{
    name: string;
    fields: string[];
    sampleShape?: unknown;
  }>;
  acceptanceCriteria: string[];
  nonGoals: string[];
  safetyConstraints: string[];
  // P1-B: 過去の反応(=学び)から要件へ反映した制約。「どの反応でどの要件を足したか」の追跡用。
  feedbackConstraints?: string[];
  publicProductionMemo?: string;
  externalDependencyPlan?: {
    externalDependencyMode: ExternalDependencyMode;
    externalIntegrations: ExternalIntegrationContract[];
    integrationAssumptions: IntegrationAssumption[];
    claimBoundary: ClaimBoundary;
  };
  interactionProofPlan?: InteractionProofPlan;
};

export type BuildPlan = {
  requirementSpecId: string;
  framework: string;
  agentRuntimeReflection?: AgentRuntimeReflection;
  files: Array<{
    path: string;
    purpose: string;
    content?: string;
  }>;
  implementationNotes: string[];
  knownRisks: string[];
  // トップフィード/詳細ページ「プロダクト名直下の一文キャッチコピー」(例:「長い議事録を3行の決定メモに変える」)。
  shortTagline?: string;
  // 詳細ページ「タブ上のボックス」に出す2〜3文のプロダクト説明。新規性の主張はしない(それは interestingness)。
  productSummary?: string;
  // 公開時 Project.categoryId の第1候補。PRODUCT_CATEGORIES(product-categories.ts)内の id のみ有効。
  categoryId?: string;
  // カテゴリー選定根拠の1文(監査用。DBには保存しない)。
  categoryReason?: string;
  // 詳細ページ「使い方」タブの番号付き手順。action=実UI要素名を含む命令形1文、result=画面に起きること1文。
  // 正規化・保存契約は src/lib/usage-guide.ts(normalizeUsageGuide)が正典。
  usageGuide?: {
    intro?: string;
    steps: Array<{ action: string; result: string }>;
    checkPoint?: string;
  };
  submissionReadiness: {
    firstScreenValue: string;
    coreInteraction: string;
    stateChange: string;
    inspectableOutput: string;
    staticDataBoundary: string;
    remainingWeakness: string;
  };
  mvpContract?: MvpContract;
  mvpContractV2?: MvpContractV2;
  interactionProofPlan?: InteractionProofPlan;
};

export type InteractionProofPlan = {
  primaryAction: string;
  initialState: string;
  expectedState: string;
  visibleEvidence: string[];
  proofSelectors?: string[];
  requiredSourceFiles: string[];
  manualFallbackReason?: string;
};

export type MvpContract = {
  firstScreenValue: string;
  coreInteraction: string;
  stateChange: string;
  inspectableOutput: string;
  staticDataBoundary: string;
  requiredFiles: string[];
  nonGoals: string[];
  forbiddenDependencies: string[];
};

export type ArtifactTier =
  | "static_mvp"
  | "proposed_integration"
  | "mocked_integration_mvp"
  | "live_integration_candidate";

export type ExternalDependencyMode = "none" | "proposed" | "mocked_adapter" | "live_required";

export type ExternalIntegrationContract = {
  service: string;
  intendedUse: string;
  dataFlow: string;
  authRequirement: "none" | "api_key" | "oauth" | "unknown";
  currentImplementation: "not_connected" | "mock_data" | "mock_adapter" | "live_call";
  adapterPath?: string;
  sampleDataPath?: string;
  riskNotes: string[];
};

export type RuntimeBoundary = {
  networkCalls: "none" | "live_required";
  secrets: "none" | "required";
  externalWrites: "none" | "proposed" | "live_required";
};

export type MvpComplexityBudget = {
  maxScreens: 1 | 2;
  maxPrimaryActions: 1;
  maxSourceFiles: number;
  maxNewDependencies: 0;
  allowDatabase: false;
};

export type IntegrationAssumption = {
  service: string;
  officialDocsVerifiedAt?: string;
  verificationStatus: "unverified" | "official_docs_checked" | "not_applicable";
  unavailableOrUnknown: string[];
  rateLimitRisk: "low" | "medium" | "high" | "unknown";
  costRisk: "low" | "medium" | "high" | "unknown";
  termsRisk: "low" | "medium" | "high" | "unknown";
};

export type MockFidelity = {
  samplePayloadPath?: string;
  simulatedBehaviors: string[];
  omittedBehaviors: string[];
  failureCasesIncluded: string[];
};

export type ClaimBoundary = {
  publicCopyMustSay: string[];
  publicCopyMustNotSay: string[];
};

export type RenderVerification = {
  required: true;
  checks: Array<"render" | "click" | "state_change" | "screenshot">;
  screenshotPath?: string;
};

export type MvpContractV2 = MvpContract & {
  contractVersion: "mvp-contract-v2";
  artifactTier: ArtifactTier;
  externalDependencyMode: ExternalDependencyMode;
  externalIntegrations: ExternalIntegrationContract[];
  runtimeBoundary: RuntimeBoundary;
  mvpComplexityBudget: MvpComplexityBudget;
  integrationAssumptions: IntegrationAssumption[];
  mockFidelity?: MockFidelity;
  claimBoundary: ClaimBoundary;
  renderVerification: RenderVerification;
  humanReviewTriggers: string[];
};

export type ReviewResult = {
  artifactId?: string;
  reviewerAgentId: string;
  status: "pass" | "needs_revision" | "block";
  scores: {
    novelty: number;
    notObviousInsight: number;
    userClarity: number;
    coreInteraction: number;
    visualSpecificity: number;
    codeFeasibility: number;
    sourceInspectability: number;
    artifactCompleteness: number;
    safety: number;
    differenceFromRecentArtifacts: number;
  };
  hackathonDemoChecks: {
    firstScreenValue: "pass" | "needs_revision" | "block";
    touchability: "pass" | "needs_revision" | "block";
    stateChange: "pass" | "needs_revision" | "block";
    inspectability: "pass" | "needs_revision" | "block";
    provenance: "pass" | "needs_revision" | "block";
    agentFit: "pass" | "needs_revision" | "block";
    publicBoundary: "pass" | "needs_revision" | "block";
    differentiation: "pass" | "needs_revision" | "block";
  };
  evidence?: {
    passEvidence: string[];
    failEvidence: string[];
    missingEvidence: string[];
  };
  strengths: string[];
  problems: Array<{
    id?: string;
    severity: "low" | "medium" | "high" | "blocker";
    issue: string;
    requiredChange: string;
  }>;
  rewriteInstructions: string[];
  publishRecommendation: {
    readyForRepresentativeDemo: boolean;
    reason: string;
    mustFixBeforePublish: string[];
  };
  learningExtraction?: {
    caseSummary: string;
    reviewerLearningCandidates: Array<{
      lessonType: "failure_pattern" | "pass_pattern" | "rewrite_pattern" | "safety_boundary" | string;
      lesson: string;
      evidence: string[];
    }>;
  };
};

export type RewriteResult = {
  status: "revised" | "needs_human" | "blocked";
  changedFiles: Array<{
    path: string;
    changeSummary: string;
    addressedReviewIssueIds?: string[];
    content?: string;
  }>;
  addressedReviewIssues: string[];
  issueResolutions?: Array<{
    issueId: string;
    outcome: "changed" | "no_change" | "needs_human" | "blocked";
    changedFiles: string[];
    reason: string;
  }>;
  remainingRisks: string[];
};

export type PublishDecision = {
  status: "publish" | "revise" | "hold_for_review" | "block";
  reason: string;
  requiredArtifactsPresent: boolean;
  reviewPass: boolean;
  validationPass: boolean;
  mvpContractPass?: boolean;
  safetyBlockers: string[];
  publishSummary: string;
};

export type PipelineRunManifest = {
  version: 1;
  runId: string;
  createdAt: string;
  steps: PipelineStep[];
  outputRoot: string;
};
