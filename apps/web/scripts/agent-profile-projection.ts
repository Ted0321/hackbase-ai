import type { AgentRegistryProfile, CommentStyle } from "./agent-registry";

type StringRecord = Record<string, unknown>;

export type SelfDirectedPlanProjection = {
  selfSelectionReason?: string;
  materialsRead: string[];
  learningApplied: string[];
};

export type ConceptProjection = {
  projectionType: "concept";
  agentId: string;
  displayName: string;
  profileVersion?: number;
  oneLiner?: string;
  principle?: string;
  worldview?: string;
  motivation?: string;
  voiceGuide?: string;
  makerRationale?: string;
  sourcePreferences: string[];
  sourceReadingStyle?: string;
  conceptSelectionRules: string[];
  materialTaste: string[];
  refusedDirections: string[];
  preferredScreenTypes: string[];
  specialties: string[];
  artifactStrengths: string[];
  templatePatternPreferences: string[];
  creativeAntiPatterns: string[];
  safetyBoundaries: string[];
  claimBoundaries: string[];
  learningGuidance?: string;
  selfDirectedPlan?: SelfDirectedPlanProjection;
};

export type ReactionProjection = {
  projectionType: "reaction";
  agentId: string;
  displayName: string;
  profileVersion?: number;
  principle?: string;
  worldview?: string;
  voiceGuide?: string;
  specialties: string[];
  makerRationale?: string;
  materialTaste: string[];
  refusedDirections: string[];
  preferredScreenTypes: string[];
  allowedReactionTypes: string[];
  critiqueFocus: string[];
  targetPreference: string[];
  maxReactionsPerDay?: number;
  maxReactionsPerProject?: number;
  doNotDo: string[];
  propensity?: Record<string, number>;
  commentBoundary: string[];
  commentStyle: CommentStyle;
};

/** commentStyle が未設定のエージェント向けのフォールバック（現状維持に近い中庸）。 */
const DEFAULT_COMMENT_STYLE: CommentStyle = {
  length: "medium",
  emoji: "occasional",
  styleHintJP:
    "一人称の自然な口調で2〜3文。作品名や説明を繰り返さず、触ってみた感想や気づいた一点から入る。無理に絵文字は使わないが、雰囲気に合えば1つ程度添える。",
};

export type BuildConstraintProjection = {
  projectionType: "build_constraint";
  agentId: string;
  displayName: string;
  profileVersion?: number;
  voiceGuide?: string;
  makerRationale?: string;
  materialGuidance: string[];
  refusedDirections: string[];
  preferredScreenTypes: string[];
  specialties: string[];
  artifactStrengths: string[];
  templatePatternPreferences: string[];
  qualityBar: string[];
  creativeAntiPatterns: string[];
  claimBoundaries: string[];
  externalDependencyRules: string[];
  publishAuthority?: string;
  learningGuidance?: string;
  selfDirectedPlan?: SelfDirectedPlanProjection;
};

export type AgentProfileProjections = {
  conceptProjection: ConceptProjection;
  reactionProjection: ReactionProjection;
  buildConstraintProjection: BuildConstraintProjection;
};

export const isCreatorProjectionCandidate = (agent: AgentRegistryProfile) =>
  (agent.role ?? "creator") === "creator" && (agent.status ?? "active") === "active";

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

const firstString = (...values: unknown[]) => values.find(nonEmptyString);

const asStringRecord = (value: unknown): StringRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as StringRecord;
};

const normalizeVoiceGuide = (agent: AgentRegistryProfile) => {
  const voice = firstString(agent.identity?.voice);
  const styleTraits = uniqueStrings(agent.styleTraits);
  if (!voice && styleTraits.length === 0) return undefined;
  if (voice && styleTraits.length > 0) return `${voice}; style tags: ${styleTraits.join(", ")}`;
  return voice ?? `style tags: ${styleTraits.join(", ")}`;
};

export const normalizeArtifactStrengths = (agent: AgentRegistryProfile) =>
  uniqueStrings(
    agent.creationPolicy?.artifactStrengths && agent.creationPolicy.artifactStrengths.length > 0
      ? agent.creationPolicy.artifactStrengths
      : agent.artifactStrengths,
  );

export const normalizeCreativeAntiPatterns = (agent: AgentRegistryProfile) =>
  uniqueStrings(agent.creationPolicy?.antiPatterns, agent.avoid);

export const normalizeRefusedDirections = (agent: AgentRegistryProfile) =>
  uniqueStrings(agent.makerProfile?.refusesToMake);

export const normalizeSafetyBoundaries = (agent: AgentRegistryProfile) =>
  uniqueStrings(agent.structuredBoundaries?.forbiddenDomains, agent.boundaries);

export const normalizeClaimBoundaries = (agent: AgentRegistryProfile) =>
  uniqueStrings(agent.structuredBoundaries?.forbiddenClaims, agent.boundaries);

const normalizeSelfDirectedPlan = (plan: unknown): SelfDirectedPlanProjection | undefined => {
  const record = asStringRecord(plan);
  if (!record) return undefined;

  const selfSelectionReason = firstString(record.selfSelectionReason);
  const materialsRead = uniqueStrings(Array.isArray(record.materialsRead) ? record.materialsRead : undefined);
  const learningApplied = uniqueStrings(Array.isArray(record.learningApplied) ? record.learningApplied : undefined);

  if (!selfSelectionReason && materialsRead.length === 0 && learningApplied.length === 0) return undefined;

  return {
    ...(selfSelectionReason ? { selfSelectionReason } : {}),
    materialsRead,
    learningApplied,
  };
};

const normalizePropensity = (value: unknown): Record<string, number> | undefined => {
  const record = asStringRecord(value);
  if (!record) return undefined;

  const entries = Object.entries(record).filter((entry): entry is [string, number] => {
    const [key, score] = entry;
    return nonEmptyString(key) && typeof score === "number" && Number.isFinite(score) && score >= 0;
  });

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
};

const withLearningGuidance = (learningGuidance?: string) =>
  nonEmptyString(learningGuidance) ? { learningGuidance: learningGuidance.trim() } : {};

const withSelfDirectedPlan = (selfDirectedPlan?: unknown) => {
  const normalized = normalizeSelfDirectedPlan(selfDirectedPlan);
  return normalized ? { selfDirectedPlan: normalized } : {};
};

export function buildConceptProjection(
  agent: AgentRegistryProfile,
  learningGuidance?: string,
  selfDirectedPlan?: unknown,
): ConceptProjection {
  return {
    projectionType: "concept",
    agentId: agent.agentId,
    displayName: agent.displayName,
    ...(typeof agent.profileVersion === "number" ? { profileVersion: agent.profileVersion } : {}),
    ...(agent.oneLiner ? { oneLiner: agent.oneLiner } : {}),
    ...(agent.identity?.principle ? { principle: agent.identity.principle } : {}),
    ...(agent.identity?.worldview ? { worldview: agent.identity.worldview } : {}),
    ...(agent.identity?.motivation ? { motivation: agent.identity.motivation } : {}),
    ...(normalizeVoiceGuide(agent) ? { voiceGuide: normalizeVoiceGuide(agent) } : {}),
    ...(agent.makerProfile?.creationReason ? { makerRationale: agent.makerProfile.creationReason } : {}),
    sourcePreferences: uniqueStrings(agent.creationPolicy?.preferredInputs),
    ...(agent.creationPolicy?.sourceReadingStyle
      ? { sourceReadingStyle: agent.creationPolicy.sourceReadingStyle }
      : {}),
    conceptSelectionRules: uniqueStrings(agent.creationPolicy?.conceptSelectionRules),
    materialTaste: uniqueStrings(agent.makerProfile?.materialTaste),
    refusedDirections: normalizeRefusedDirections(agent),
    preferredScreenTypes: uniqueStrings(agent.makerProfile?.signatureScreenTypes),
    specialties: uniqueStrings(agent.specialties),
    artifactStrengths: normalizeArtifactStrengths(agent),
    templatePatternPreferences: uniqueStrings(agent.creationPolicy?.defaultTemplatePatterns),
    creativeAntiPatterns: normalizeCreativeAntiPatterns(agent),
    safetyBoundaries: normalizeSafetyBoundaries(agent),
    claimBoundaries: normalizeClaimBoundaries(agent),
    ...withLearningGuidance(learningGuidance),
    ...withSelfDirectedPlan(selfDirectedPlan),
  };
}

export function buildReactionProjection(agent: AgentRegistryProfile): ReactionProjection {
  return {
    projectionType: "reaction",
    agentId: agent.agentId,
    displayName: agent.displayName,
    ...(typeof agent.profileVersion === "number" ? { profileVersion: agent.profileVersion } : {}),
    ...(agent.identity?.principle ? { principle: agent.identity.principle } : {}),
    ...(agent.identity?.worldview ? { worldview: agent.identity.worldview } : {}),
    ...(normalizeVoiceGuide(agent) ? { voiceGuide: normalizeVoiceGuide(agent) } : {}),
    specialties: uniqueStrings(agent.specialties),
    ...(agent.makerProfile?.creationReason ? { makerRationale: agent.makerProfile.creationReason } : {}),
    materialTaste: uniqueStrings(agent.makerProfile?.materialTaste),
    refusedDirections: normalizeRefusedDirections(agent),
    preferredScreenTypes: uniqueStrings(agent.makerProfile?.signatureScreenTypes),
    allowedReactionTypes: uniqueStrings(agent.interactionPolicy?.canReactWith),
    critiqueFocus: uniqueStrings(agent.interactionPolicy?.critiqueFocus),
    targetPreference: uniqueStrings(agent.interactionPolicy?.targetPreference),
    ...(typeof agent.interactionPolicy?.maxReactionsPerDay === "number"
      ? { maxReactionsPerDay: agent.interactionPolicy.maxReactionsPerDay }
      : {}),
    ...(typeof agent.interactionPolicy?.maxReactionsPerProject === "number"
      ? { maxReactionsPerProject: agent.interactionPolicy.maxReactionsPerProject }
      : {}),
    doNotDo: uniqueStrings(agent.interactionPolicy?.doNotDo),
    ...(normalizePropensity(agent.interactionPolicy?.propensity)
      ? { propensity: normalizePropensity(agent.interactionPolicy?.propensity) }
      : {}),
    commentBoundary: normalizeClaimBoundaries(agent),
    commentStyle: agent.commentStyle ?? DEFAULT_COMMENT_STYLE,
  };
}

export function buildBuildConstraintProjection(
  agent: AgentRegistryProfile,
  learningGuidance?: string,
  selfDirectedPlan?: unknown,
): BuildConstraintProjection {
  return {
    projectionType: "build_constraint",
    agentId: agent.agentId,
    displayName: agent.displayName,
    ...(typeof agent.profileVersion === "number" ? { profileVersion: agent.profileVersion } : {}),
    ...(normalizeVoiceGuide(agent) ? { voiceGuide: normalizeVoiceGuide(agent) } : {}),
    ...(agent.makerProfile?.creationReason ? { makerRationale: agent.makerProfile.creationReason } : {}),
    materialGuidance: uniqueStrings(agent.makerProfile?.materialTaste),
    refusedDirections: normalizeRefusedDirections(agent),
    preferredScreenTypes: uniqueStrings(agent.makerProfile?.signatureScreenTypes),
    specialties: uniqueStrings(agent.specialties),
    artifactStrengths: normalizeArtifactStrengths(agent),
    templatePatternPreferences: uniqueStrings(agent.creationPolicy?.defaultTemplatePatterns),
    qualityBar: uniqueStrings(agent.creationPolicy?.qualityBar),
    creativeAntiPatterns: normalizeCreativeAntiPatterns(agent),
    claimBoundaries: normalizeClaimBoundaries(agent),
    externalDependencyRules: uniqueStrings(agent.structuredBoundaries?.externalDependencyRules),
    ...(agent.structuredBoundaries?.publishAuthority
      ? { publishAuthority: agent.structuredBoundaries.publishAuthority }
      : {}),
    ...withLearningGuidance(learningGuidance),
    ...withSelfDirectedPlan(selfDirectedPlan),
  };
}

export function buildAgentProfileProjections(
  agent: AgentRegistryProfile,
  learningGuidance?: string,
  selfDirectedPlan?: unknown,
): AgentProfileProjections {
  return {
    conceptProjection: buildConceptProjection(agent, learningGuidance, selfDirectedPlan),
    reactionProjection: buildReactionProjection(agent),
    buildConstraintProjection: buildBuildConstraintProjection(agent, learningGuidance, selfDirectedPlan),
  };
}
