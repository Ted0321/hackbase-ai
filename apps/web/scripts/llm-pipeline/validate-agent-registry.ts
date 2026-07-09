import { readAgentRegistry, type AgentRegistryProfile } from "../agent-registry";
import {
  buildAgentProfileProjections,
  isCreatorProjectionCandidate,
} from "../agent-profile-projection";
import { DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC } from "../../src/lib/admin-agent-registry";

type RegistryAgent = {
  agentId?: unknown;
  profileVersion?: unknown;
  displayName?: unknown;
  status?: unknown;
  role?: unknown;
  identity?: unknown;
  makerProfile?: unknown;
  creationPolicy?: unknown;
  schedulingPolicy?: unknown;
  learningPolicy?: unknown;
  reviewPolicy?: unknown;
  structuredBoundaries?: unknown;
  boundaries?: unknown;
  interactionPolicy?: unknown;
  artifactStrengths?: unknown;
  avoid?: unknown;
};

type AgentRegistry = {
  version?: unknown;
  agents?: unknown;
};

function requireString(value: unknown, label: string, failures: string[]) {
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${label} must be a non-empty string`);
  }
}

function requireArray(value: unknown, label: string, failures: string[]) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${label} must be a non-empty array`);
  }
}

function requireBoolean(value: unknown, label: string, failures: string[]) {
  if (typeof value !== "boolean") {
    failures.push(`${label} must be a boolean`);
  }
}

function requireNumber(value: unknown, label: string, failures: string[]) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${label} must be a finite number`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function preferredHoursOf(agent: RegistryAgent): number[] {
  const policy = asRecord(agent.schedulingPolicy);
  const preferredHours = policy?.preferredHours;
  if (!Array.isArray(preferredHours)) return [];
  return preferredHours.filter((hour): hour is number => typeof hour === "number" && Number.isFinite(hour));
}

function sameStringSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  if (aSet.size !== new Set(b).size) return false;
  return b.every((item) => aSet.has(item));
}

function validateIdentity(agent: RegistryAgent, label: string, failures: string[]) {
  const identity = asRecord(agent.identity);
  if (!identity) {
    failures.push(`${label}.identity must be present`);
    return;
  }

  requireString(identity.principle, `${label}.identity.principle`, failures);
  requireString(identity.worldview, `${label}.identity.worldview`, failures);
  requireString(identity.voice, `${label}.identity.voice`, failures);
  requireString(identity.motivation, `${label}.identity.motivation`, failures);
}

function validateMakerProfile(agent: RegistryAgent, label: string, failures: string[]) {
  const profile = asRecord(agent.makerProfile);
  if (!profile) {
    failures.push(`${label}.makerProfile must be present for creator agents`);
    return;
  }

  requireString(profile.creationReason, `${label}.makerProfile.creationReason`, failures);
  requireArray(profile.materialTaste, `${label}.makerProfile.materialTaste`, failures);
  requireArray(profile.refusesToMake, `${label}.makerProfile.refusesToMake`, failures);
  requireArray(profile.signatureScreenTypes, `${label}.makerProfile.signatureScreenTypes`, failures);
}

function validateSchedulingPolicy(agent: RegistryAgent, label: string, failures: string[]) {
  const policy = asRecord(agent.schedulingPolicy);
  if (!policy) {
    failures.push(`${label}.schedulingPolicy must be present`);
    return;
  }

  const cadence = policy.cadence;
  const validCadences = ["daily", "every_other_day", "every_2_days", "every_3_days", "weekly", "on_demand"];
  if (typeof cadence !== "string" || !validCadences.includes(cadence)) {
    failures.push(`${label}.schedulingPolicy.cadence must be one of ${validCadences.join(", ")}`);
  }

  requireNumber(policy.maxRunsPerDay, `${label}.schedulingPolicy.maxRunsPerDay`, failures);
  requireArray(policy.preferredHours, `${label}.schedulingPolicy.preferredHours`, failures);
  requireBoolean(policy.enabled, `${label}.schedulingPolicy.enabled`, failures);
  requireNumber(policy.cooldownHours, `${label}.schedulingPolicy.cooldownHours`, failures);
  requireBoolean(policy.skipIfLowSignal, `${label}.schedulingPolicy.skipIfLowSignal`, failures);
}

function validateCreationPolicy(agent: RegistryAgent, label: string, failures: string[]) {
  const policy = asRecord(agent.creationPolicy);
  if (!policy) {
    failures.push(`${label}.creationPolicy must be present`);
    return;
  }

  requireString(policy.mission, `${label}.creationPolicy.mission`, failures);
  requireArray(policy.preferredInputs, `${label}.creationPolicy.preferredInputs`, failures);
  requireString(policy.sourceReadingStyle, `${label}.creationPolicy.sourceReadingStyle`, failures);
  requireArray(policy.conceptSelectionRules, `${label}.creationPolicy.conceptSelectionRules`, failures);
  requireArray(policy.artifactStrengths, `${label}.creationPolicy.artifactStrengths`, failures);
  requireArray(policy.defaultTemplatePatterns, `${label}.creationPolicy.defaultTemplatePatterns`, failures);
  requireArray(policy.qualityBar, `${label}.creationPolicy.qualityBar`, failures);
  requireArray(policy.antiPatterns, `${label}.creationPolicy.antiPatterns`, failures);
}

function validateLearningPolicy(agent: RegistryAgent, label: string, failures: string[]) {
  const policy = asRecord(agent.learningPolicy);
  if (!policy) {
    failures.push(`${label}.learningPolicy must be present`);
    return;
  }

  requireArray(policy.feedbackToUse, `${label}.learningPolicy.feedbackToUse`, failures);
  requireArray(policy.feedbackToIgnore, `${label}.learningPolicy.feedbackToIgnore`, failures);

  const validScopes = ["own_projects", "same_category", "all_projects"];
  if (typeof policy.memoryScope !== "string" || !validScopes.includes(policy.memoryScope)) {
    failures.push(`${label}.learningPolicy.memoryScope must be one of ${validScopes.join(", ")}`);
  }

  requireBoolean(policy.updateRequiresHumanApproval, `${label}.learningPolicy.updateRequiresHumanApproval`, failures);
  requireNumber(policy.maxGuidanceItems, `${label}.learningPolicy.maxGuidanceItems`, failures);
}

function validateReviewPolicy(agent: RegistryAgent, label: string, failures: string[]) {
  const policy = asRecord(agent.reviewPolicy);
  if (!policy) {
    failures.push(`${label}.reviewPolicy must be present for reviewer agents`);
    return;
  }

  requireString(policy.mission, `${label}.reviewPolicy.mission`, failures);
  requireArray(policy.reviewFocus, `${label}.reviewPolicy.reviewFocus`, failures);
  requireArray(policy.passBar, `${label}.reviewPolicy.passBar`, failures);
  requireArray(policy.failurePatterns, `${label}.reviewPolicy.failurePatterns`, failures);
  requireArray(policy.evidenceToRecord, `${label}.reviewPolicy.evidenceToRecord`, failures);
  requireArray(policy.learningSources, `${label}.reviewPolicy.learningSources`, failures);
}

function validateStructuredBoundaries(agent: RegistryAgent, label: string, failures: string[]) {
  const boundaries = asRecord(agent.structuredBoundaries);
  if (!boundaries) {
    failures.push(`${label}.structuredBoundaries must be present`);
    return;
  }

  requireArray(boundaries.forbiddenDomains, `${label}.structuredBoundaries.forbiddenDomains`, failures);
  requireArray(boundaries.forbiddenClaims, `${label}.structuredBoundaries.forbiddenClaims`, failures);
  requireArray(boundaries.externalDependencyRules, `${label}.structuredBoundaries.externalDependencyRules`, failures);

  const validAuthority = ["none", "local_only", "requires_validation"];
  if (typeof boundaries.publishAuthority !== "string" || !validAuthority.includes(boundaries.publishAuthority)) {
    failures.push(`${label}.structuredBoundaries.publishAuthority must be one of ${validAuthority.join(", ")}`);
  }
}

function validateInteractionPolicy(
  agent: RegistryAgent,
  label: string,
  failures: string[],
  warnings: string[],
) {
  const policy = asRecord(agent.interactionPolicy);
  if (!policy) {
    failures.push(`${label}.interactionPolicy must be present`);
    return;
  }

  requireArray(policy.canReactWith, `${label}.interactionPolicy.canReactWith`, failures);
  requireArray(policy.critiqueFocus, `${label}.interactionPolicy.critiqueFocus`, failures);
  requireArray(policy.doNotDo, `${label}.interactionPolicy.doNotDo`, failures);
  requireArray(policy.targetPreference, `${label}.interactionPolicy.targetPreference`, failures);
  requireNumber(policy.maxReactionsPerDay, `${label}.interactionPolicy.maxReactionsPerDay`, failures);
  requireNumber(policy.maxReactionsPerProject, `${label}.interactionPolicy.maxReactionsPerProject`, failures);

  // 2.8: propensity は任意。あれば soft-check（非致命）。重みが実際に反応型選択へ効くため、
  // canReactWith に無いキーや負/非有限の重みは警告する（現 fixture はクリーンなので警告0）。
  const propensity = asRecord(policy.propensity);
  if (propensity) {
    const canReactWith = Array.isArray(policy.canReactWith) ? policy.canReactWith.map(String) : [];
    for (const [key, value] of Object.entries(propensity)) {
      if (!canReactWith.includes(key)) {
        warnings.push(`${label}.interactionPolicy.propensity key "${key}" is not in canReactWith`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        warnings.push(`${label}.interactionPolicy.propensity["${key}"] must be a finite number >= 0`);
      }
    }
  }
}

function validateProjectionReadiness(
  agent: RegistryAgent,
  label: string,
  failures: string[],
  warnings: string[],
) {
  const profile = agent as unknown as AgentRegistryProfile;
  if (!isCreatorProjectionCandidate(profile)) return;

  const projections = buildAgentProfileProjections(profile);
  const missing: string[] = [];
  const requireProjectionArray = (value: unknown[], projectionField: string) => {
    if (!Array.isArray(value) || value.length === 0) missing.push(projectionField);
  };

  requireProjectionArray(projections.conceptProjection.sourcePreferences, "conceptProjection.sourcePreferences");
  requireProjectionArray(projections.conceptProjection.conceptSelectionRules, "conceptProjection.conceptSelectionRules");
  requireProjectionArray(projections.conceptProjection.materialTaste, "conceptProjection.materialTaste");
  requireProjectionArray(projections.conceptProjection.refusedDirections, "conceptProjection.refusedDirections");
  requireProjectionArray(projections.conceptProjection.preferredScreenTypes, "conceptProjection.preferredScreenTypes");
  requireProjectionArray(projections.conceptProjection.artifactStrengths, "conceptProjection.artifactStrengths");
  requireProjectionArray(
    projections.conceptProjection.templatePatternPreferences,
    "conceptProjection.templatePatternPreferences",
  );
  requireProjectionArray(projections.conceptProjection.safetyBoundaries, "conceptProjection.safetyBoundaries");
  requireProjectionArray(projections.conceptProjection.claimBoundaries, "conceptProjection.claimBoundaries");

  requireProjectionArray(projections.reactionProjection.allowedReactionTypes, "reactionProjection.allowedReactionTypes");
  requireProjectionArray(projections.reactionProjection.critiqueFocus, "reactionProjection.critiqueFocus");
  requireProjectionArray(projections.reactionProjection.targetPreference, "reactionProjection.targetPreference");
  requireProjectionArray(projections.reactionProjection.doNotDo, "reactionProjection.doNotDo");
  requireProjectionArray(projections.reactionProjection.commentBoundary, "reactionProjection.commentBoundary");

  requireProjectionArray(projections.buildConstraintProjection.materialGuidance, "buildConstraintProjection.materialGuidance");
  requireProjectionArray(projections.buildConstraintProjection.refusedDirections, "buildConstraintProjection.refusedDirections");
  requireProjectionArray(
    projections.buildConstraintProjection.preferredScreenTypes,
    "buildConstraintProjection.preferredScreenTypes",
  );
  requireProjectionArray(projections.buildConstraintProjection.artifactStrengths, "buildConstraintProjection.artifactStrengths");
  requireProjectionArray(
    projections.buildConstraintProjection.templatePatternPreferences,
    "buildConstraintProjection.templatePatternPreferences",
  );
  requireProjectionArray(projections.buildConstraintProjection.qualityBar, "buildConstraintProjection.qualityBar");
  requireProjectionArray(
    projections.buildConstraintProjection.creativeAntiPatterns,
    "buildConstraintProjection.creativeAntiPatterns",
  );
  requireProjectionArray(projections.buildConstraintProjection.claimBoundaries, "buildConstraintProjection.claimBoundaries");
  requireProjectionArray(
    projections.buildConstraintProjection.externalDependencyRules,
    "buildConstraintProjection.externalDependencyRules",
  );

  if (missing.length > 0) {
    failures.push(`${label}.projection readiness missing: ${missing.join(", ")}`);
  }

  const creationPolicy = asRecord(agent.creationPolicy);
  const policyArtifactStrengths = toStringArray(creationPolicy?.artifactStrengths);
  const topLevelArtifactStrengths = toStringArray(agent.artifactStrengths);
  if (
    policyArtifactStrengths.length > 0 &&
    topLevelArtifactStrengths.length > 0 &&
    !sameStringSet(policyArtifactStrengths, topLevelArtifactStrengths)
  ) {
    warnings.push(
      `${label}.artifactStrengths differs from creationPolicy.artifactStrengths; projection uses creationPolicy.artifactStrengths`,
    );
  }
}

function validateCreatorPreferredHourDistribution(
  activeCreators: RegistryAgent[],
  failures: string[],
  warnings: string[],
) {
  const uniqueHours = new Set<number>();
  const standardSlots = new Set<number>(DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC);

  for (const agent of activeCreators) {
    const label = typeof agent.agentId === "string" ? agent.agentId : "<missing-agent-id>";
    const preferredHours = preferredHoursOf(agent);

    for (const hour of preferredHours) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        failures.push(`${label}.schedulingPolicy.preferredHours must contain UTC hours between 0 and 23`);
        continue;
      }

      uniqueHours.add(hour);
      if (!standardSlots.has(hour)) {
        warnings.push(
          `${label}.schedulingPolicy.preferredHours includes non-standard distributed slot ${hour}; standard slots are ${DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC.join(", ")}`,
        );
      }
    }
  }

  if (activeCreators.length >= 4 && uniqueHours.size < 3) {
    failures.push(
      `active creator preferredHours must be distributed across at least 3 UTC hours; found ${uniqueHours.size}`,
    );
  }
}

async function main() {
  const registry = await readAgentRegistry() as AgentRegistry;
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(registry.agents)) {
    throw new Error("agent-registry.json must contain an agents array");
  }

  const agents = registry.agents as RegistryAgent[];
  const ids = new Set<string>();

  for (const agent of agents) {
    const label = typeof agent.agentId === "string" ? agent.agentId : "<missing-agent-id>";
    requireString(agent.agentId, `${label}.agentId`, failures);
    requireString(agent.displayName, `${label}.displayName`, failures);
    requireString(agent.status, `${label}.status`, failures);
    requireString(agent.role, `${label}.role`, failures);
    requireArray(agent.avoid, `${label}.avoid`, failures);
    requireArray(agent.boundaries, `${label}.boundaries`, failures);
    requireNumber(agent.profileVersion, `${label}.profileVersion`, failures);

    if (typeof agent.agentId === "string") {
      if (ids.has(agent.agentId)) failures.push(`${agent.agentId} is duplicated`);
      ids.add(agent.agentId);
    }

    if (agent.status !== "active" && agent.status !== "draft" && agent.status !== "paused" && agent.status !== "retired") {
      failures.push(`${label}.status must be draft, active, paused, or retired`);
    }

    if (agent.role !== "creator" && agent.role !== "reviewer" && agent.role !== "governance") {
      failures.push(`${label}.role must be creator, reviewer, or governance`);
    }

    validateIdentity(agent, label, failures);
    validateStructuredBoundaries(agent, label, failures);
    validateInteractionPolicy(agent, label, failures, warnings);

    if (agent.role === "creator") {
      validateMakerProfile(agent, label, failures);
      validateCreationPolicy(agent, label, failures);
      validateSchedulingPolicy(agent, label, failures);
      validateLearningPolicy(agent, label, failures);
      validateProjectionReadiness(agent, label, failures, warnings);
    } else if (agent.role === "reviewer") {
      validateReviewPolicy(agent, label, failures);
    }
  }

  const activeCreators = agents.filter((agent) => agent.status === "active" && agent.role === "creator");
  const activeReviewers = agents.filter((agent) => agent.status === "active" && agent.role === "reviewer");
  const activeGovernanceAgents = agents.filter((agent) => agent.status === "active" && agent.role === "governance");

  if (activeCreators.length === 0) failures.push("registry must contain at least one active creator agent");
  if (activeReviewers.length === 0) failures.push("registry must contain at least one active reviewer agent");
  if (activeGovernanceAgents.length === 0) failures.push("registry must contain at least one active governance agent");
  validateCreatorPreferredHourDistribution(activeCreators, failures, warnings);

  const invalidCreatorIds = activeCreators
    .filter((agent) => agent.agentId === "steward" || agent.role === "governance")
    .map((agent) => String(agent.agentId));
  if (invalidCreatorIds.length > 0) {
    failures.push(`governance agents must not be active creator candidates: ${invalidCreatorIds.join(", ")}`);
  }

  if (failures.length > 0) {
    console.error("Agent registry validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("Agent registry soft warnings (non-fatal):");
    for (const warning of warnings) console.warn(`- ${warning}`);
  }

  console.log(
    `Agent registry valid: ${activeCreators.length} active creators, ${activeReviewers.length} active reviewer(s), ${activeGovernanceAgents.length} active governance agent(s).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
