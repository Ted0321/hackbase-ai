import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  activeCreatorProfiles,
  readAgentRegistry,
  type AgentRegistryProfile,
} from "./agent-registry";
import {
  buildBuildConstraintProjection,
  buildConceptProjection,
  buildReactionProjection,
} from "./agent-profile-projection";

export type AgentQualityStat = {
  agentId: string;
  displayName?: string;
  role?: string;
  status?: string;
  posts?: number;
  published?: number;
  validations?: number;
  validationPassRate?: number | null;
  failedChecks?: number;
  duplicateWarnings?: number;
  promptRiskWarnings?: number;
  humanFeedback?: number;
  agentFeedback?: number;
  latestProject?: {
    id: string;
    title: string;
    status: string;
    createdAt?: string;
  } | null;
};

export type AgentQualityStatsFile = {
  version: number;
  generatedAt: string;
  source: string;
  registryVersion?: number;
  agents: AgentQualityStat[];
};

export type GeneratedOutputMetadata = {
  projectId: string;
  agentId?: string;
  title?: string;
  oneLiner?: string;
  categoryId?: string;
  categoryName?: string;
  status?: string;
  validationStatus?: string | null;
  artifactRoot?: string;
  artifactShape?: string;
  templatePatternId?: string;
  surfacePattern?: string;
  aiMechanismPattern?: string;
  mvpContractV2Status?: "present" | "missing";
  mvpContractV2ArtifactTier?: string;
  externalDependencyMode?: string;
  interactionProofPrimaryAction?: string;
  interactionProofEvidenceCount?: number;
  metadataSources?: string[];
};

export type GeneratedOutputMetadataFile = {
  version: 1;
  generatedAt: string;
  source: string;
  projects: GeneratedOutputMetadata[];
};

export type SimilarityGroupName =
  | "profileSimilarity"
  | "creationSimilarity"
  | "reactionSimilarity"
  | "runtimeQualitySimilarity"
  | "generatedOutputSimilarity";

export type SimilarityBreakdown = Record<SimilarityGroupName, number | null>;

export type AgentSimilarityResult = {
  agentId: string;
  similarAgentId: string;
  score: number | null;
  dataCoverage: number;
  included: boolean;
  reasons: string[];
  differences: string[];
  commonTags: string[];
  groupScores: SimilarityBreakdown;
};

export type AgentSimilaritySnapshot = {
  version: 1;
  generatedAt: string;
  source: string;
  registryVersion: number;
  activeCreatorCount: number;
  maxSimilarAgentsPerAgent: number;
  minimumDataCoverage: number;
  pairs: AgentSimilarityResult[];
};

const TOP_LEVEL_WEIGHTS: Record<SimilarityGroupName, number> = {
  profileSimilarity: 0.3,
  creationSimilarity: 0.2,
  reactionSimilarity: 0.25,
  runtimeQualitySimilarity: 0.1,
  generatedOutputSimilarity: 0.15,
};

const MINIMUM_DATA_COVERAGE = 0.65;

const round4 = (value: number) => Number(value.toFixed(4));
const round2 = (value: number) => Number(value.toFixed(2));

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const compactStrings = (values: Array<string | undefined | null>) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = str(value).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const normalizeToken = (value: string) => value.trim().toLowerCase();

const commonValues = (a: string[] | undefined, b: string[] | undefined) => {
  const setB = new Set((b ?? []).map(normalizeToken));
  return compactStrings(a ?? []).filter((value) => setB.has(normalizeToken(value)));
};

export const tokenize = (text: string): string[] => {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
};

export const setSimilarity = (
  a: string[] | undefined,
  b: string[] | undefined,
): number | null => {
  const setA = new Set(compactStrings(a ?? []).map(normalizeToken));
  const setB = new Set(compactStrings(b ?? []).map(normalizeToken));
  if (setA.size === 0 && setB.size === 0) return null;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? null : round4(intersection / union);
};

export const textSimilarity = (
  a: string | undefined,
  b: string | undefined,
): number | null => setSimilarity(tokenize(a ?? ""), tokenize(b ?? ""));

export const cosineSimilarity = (
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): number | null => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  if (keys.size === 0) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of keys) {
    const valueA = a?.[key] ?? 0;
    const valueB = b?.[key] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) return null;
  return round4(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
};

export const numericSimilarity = (
  a: number | null | undefined,
  b: number | null | undefined,
  range: number,
): number | null => {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || range <= 0) return null;
  return round4(1 - Math.min(Math.abs(a - b) / range, 1));
};

const weightedAverage = (
  items: Array<{ weight: number; score: number | null }>,
): number | null => {
  let totalWeight = 0;
  let weightedScore = 0;
  for (const item of items) {
    if (item.score === null) continue;
    totalWeight += item.weight;
    weightedScore += item.weight * item.score;
  }
  if (totalWeight === 0) return null;
  return round4(weightedScore / totalWeight);
};

const cadenceDays = (cadence: string | undefined): number | null => {
  if (!cadence) return null;
  if (cadence === "daily") return 1;
  if (cadence === "every_other_day" || cadence === "every_2_days") return 2;
  if (cadence === "every_3_days") return 3;
  if (cadence === "weekly" || cadence === "on_demand") return 7;
  return null;
};

export const cadenceSimilarity = (
  a: AgentRegistryProfile,
  b: AgentRegistryProfile,
): number | null =>
  numericSimilarity(cadenceDays(a.schedulingPolicy?.cadence), cadenceDays(b.schedulingPolicy?.cadence), 6);

const bucket = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  if (value <= 5) return 1;
  if (value <= 20) return 2;
  return 3;
};

const bucketSimilarity = (a: number | null | undefined, b: number | null | undefined) =>
  numericSimilarity(bucket(a), bucket(b), 3);

const warningPatterns = (stat: AgentQualityStat | undefined): string[] => {
  if (!stat) return [];
  const patterns: string[] = [];
  if ((stat.failedChecks ?? 0) > 0) patterns.push("failed_checks");
  if ((stat.duplicateWarnings ?? 0) > 0) patterns.push("duplicate_warning");
  if ((stat.promptRiskWarnings ?? 0) > 0) patterns.push("prompt_risk_warning");
  return patterns;
};

const warningPatternSimilarity = (
  a: AgentQualityStat | undefined,
  b: AgentQualityStat | undefined,
): number | null => {
  if (!a || !b) return null;
  const aPatterns = warningPatterns(a);
  const bPatterns = warningPatterns(b);
  if (aPatterns.length === 0 && bPatterns.length === 0) return 1;
  return setSimilarity(aPatterns, bPatterns);
};

const generatedOutputCategoryTags = (
  project: AgentQualityStat["latestProject"],
  metadata: GeneratedOutputMetadata | undefined,
) =>
  compactStrings([
    metadata?.categoryId,
    metadata?.categoryName,
    metadata?.surfacePattern,
    metadata?.artifactShape,
    project?.status,
  ]);

const generatedOutputMechanismTags = (metadata: GeneratedOutputMetadata | undefined) =>
  compactStrings([
    metadata?.aiMechanismPattern,
    metadata?.mvpContractV2ArtifactTier,
    metadata?.externalDependencyMode,
  ]);

const generatedOutputValidationTags = (
  project: AgentQualityStat["latestProject"],
  metadata: GeneratedOutputMetadata | undefined,
) =>
  compactStrings([
    project?.status,
    metadata?.status,
    metadata?.validationStatus ?? undefined,
    metadata?.mvpContractV2Status,
    metadata?.interactionProofPrimaryAction ? "interaction_proof_present" : undefined,
  ]);

const generatedOutputText = (
  project: AgentQualityStat["latestProject"],
  metadata: GeneratedOutputMetadata | undefined,
) =>
  compactStrings([project?.title, metadata?.title, metadata?.oneLiner]).join(" ");

const profileText = (agent: AgentRegistryProfile) =>
  compactStrings([
    agent.identity?.principle,
    agent.identity?.worldview,
    agent.identity?.voice,
    agent.identity?.motivation,
    agent.oneLiner,
    agent.makerProfile?.creationReason,
  ]).join(" ");

export const profileSimilarity = (a: AgentRegistryProfile, b: AgentRegistryProfile) => {
  const aBuild = buildBuildConstraintProjection(a);
  const bBuild = buildBuildConstraintProjection(b);
  return weightedAverage([
    { weight: 0.3, score: setSimilarity(a.specialties, b.specialties) },
    { weight: 0.25, score: setSimilarity(aBuild.artifactStrengths, bBuild.artifactStrengths) },
    { weight: 0.15, score: setSimilarity(a.styleTraits, b.styleTraits) },
    { weight: 0.2, score: textSimilarity(profileText(a), profileText(b)) },
    { weight: 0.1, score: setSimilarity(a.avoid, b.avoid) },
  ]);
};

export const creationSimilarity = (a: AgentRegistryProfile, b: AgentRegistryProfile) => {
  const aConcept = buildConceptProjection(a);
  const bConcept = buildConceptProjection(b);
  return weightedAverage([
    { weight: 0.25, score: setSimilarity(aConcept.sourcePreferences, bConcept.sourcePreferences) },
    {
      weight: 0.25,
      score: setSimilarity(aConcept.templatePatternPreferences, bConcept.templatePatternPreferences),
    },
    { weight: 0.2, score: setSimilarity(aConcept.artifactStrengths, bConcept.artifactStrengths) },
    {
      weight: 0.2,
      score: textSimilarity(
        [...aConcept.conceptSelectionRules, aConcept.sourceReadingStyle ?? ""].join(" "),
        [...bConcept.conceptSelectionRules, bConcept.sourceReadingStyle ?? ""].join(" "),
      ),
    },
    { weight: 0.1, score: cadenceSimilarity(a, b) },
  ]);
};

export const reactionSimilarity = (a: AgentRegistryProfile, b: AgentRegistryProfile) => {
  const aReaction = buildReactionProjection(a);
  const bReaction = buildReactionProjection(b);
  return weightedAverage([
    { weight: 0.25, score: setSimilarity(aReaction.allowedReactionTypes, bReaction.allowedReactionTypes) },
    { weight: 0.3, score: setSimilarity(aReaction.critiqueFocus, bReaction.critiqueFocus) },
    { weight: 0.2, score: setSimilarity(aReaction.targetPreference, bReaction.targetPreference) },
    { weight: 0.25, score: cosineSimilarity(aReaction.propensity, bReaction.propensity) },
  ]);
};

export const runtimeQualitySimilarity = (
  a: AgentRegistryProfile,
  b: AgentRegistryProfile,
  qualityStats: Map<string, AgentQualityStat>,
) => {
  const aStat = qualityStats.get(a.agentId);
  const bStat = qualityStats.get(b.agentId);
  if (!aStat || !bStat) return null;

  return weightedAverage([
    {
      weight: 0.25,
      score: numericSimilarity(aStat?.validationPassRate, bStat?.validationPassRate, 100),
    },
    { weight: 0.2, score: bucketSimilarity(aStat?.posts, bStat?.posts) },
    {
      weight: 0.2,
      score: bucketSimilarity(
        (aStat.humanFeedback ?? 0) + (aStat.agentFeedback ?? 0),
        (bStat.humanFeedback ?? 0) + (bStat.agentFeedback ?? 0),
      ),
    },
    { weight: 0.2, score: warningPatternSimilarity(aStat, bStat) },
    { weight: 0.15, score: cadenceSimilarity(a, b) },
  ]);
};

export const generatedOutputSimilarity = (
  a: AgentRegistryProfile,
  b: AgentRegistryProfile,
  qualityStats: Map<string, AgentQualityStat>,
  generatedOutputMetadata = new Map<string, GeneratedOutputMetadata>(),
) => {
  const aProject = qualityStats.get(a.agentId)?.latestProject;
  const bProject = qualityStats.get(b.agentId)?.latestProject;
  if (!aProject || !bProject) return null;
  const aMetadata = generatedOutputMetadata.get(aProject.id);
  const bMetadata = generatedOutputMetadata.get(bProject.id);

  return weightedAverage([
    {
      weight: 0.25,
      score: setSimilarity(
        generatedOutputCategoryTags(aProject, aMetadata),
        generatedOutputCategoryTags(bProject, bMetadata),
      ),
    },
    {
      weight: 0.2,
      score: textSimilarity(generatedOutputText(aProject, aMetadata), generatedOutputText(bProject, bMetadata)),
    },
    {
      weight: 0.25,
      score: setSimilarity(
        compactStrings([aMetadata?.templatePatternId]),
        compactStrings([bMetadata?.templatePatternId]),
      ),
    },
    {
      weight: 0.15,
      score: setSimilarity(generatedOutputMechanismTags(aMetadata), generatedOutputMechanismTags(bMetadata)),
    },
    {
      weight: 0.15,
      score: setSimilarity(
        generatedOutputValidationTags(aProject, aMetadata),
        generatedOutputValidationTags(bProject, bMetadata),
      ),
    },
  ]);
};

const describeList = (values: string[], max = 2) => values.slice(0, max).join(", ");

const firstDifference = (aValues: string[], bValues: string[]) => {
  const aCommon = new Set(commonValues(aValues, bValues).map(normalizeToken));
  const aOnly = compactStrings(aValues).filter((value) => !aCommon.has(normalizeToken(value)));
  const bOnly = compactStrings(bValues).filter((value) => !aCommon.has(normalizeToken(value)));
  return { aOnly, bOnly };
};

const explainSimilarity = (
  a: AgentRegistryProfile,
  b: AgentRegistryProfile,
  qualityStats: Map<string, AgentQualityStat>,
  generatedOutputMetadata: Map<string, GeneratedOutputMetadata>,
) => {
  const aConcept = buildConceptProjection(a);
  const bConcept = buildConceptProjection(b);
  const aReaction = buildReactionProjection(a);
  const bReaction = buildReactionProjection(b);

  const commonSpecialties = commonValues(a.specialties, b.specialties);
  const commonArtifacts = commonValues(aConcept.artifactStrengths, bConcept.artifactStrengths);
  const commonTemplates = commonValues(
    aConcept.templatePatternPreferences,
    bConcept.templatePatternPreferences,
  );
  const commonReactionTypes = commonValues(
    aReaction.allowedReactionTypes,
    bReaction.allowedReactionTypes,
  );
  const commonCritique = commonValues(aReaction.critiqueFocus, bReaction.critiqueFocus);
  const aProject = qualityStats.get(a.agentId)?.latestProject;
  const bProject = qualityStats.get(b.agentId)?.latestProject;
  const aOutput = aProject ? generatedOutputMetadata.get(aProject.id) : undefined;
  const bOutput = bProject ? generatedOutputMetadata.get(bProject.id) : undefined;
  const commonOutputTags = commonValues(
    compactStrings([aOutput?.templatePatternId, aOutput?.surfacePattern, aOutput?.aiMechanismPattern]),
    compactStrings([bOutput?.templatePatternId, bOutput?.surfacePattern, bOutput?.aiMechanismPattern]),
  );

  const reasons = compactStrings([
    commonSpecialties.length > 0 ? `specialties: ${describeList(commonSpecialties)}` : null,
    commonArtifacts.length > 0 ? `artifact: ${describeList(commonArtifacts)}` : null,
    commonTemplates.length > 0 ? `templates: ${describeList(commonTemplates)}` : null,
    commonReactionTypes.length > 0 ? `reaction: ${describeList(commonReactionTypes)}` : null,
    commonCritique.length > 0 ? `critique: ${describeList(commonCritique)}` : null,
    commonOutputTags.length > 0 ? `output: ${describeList(commonOutputTags)}` : null,
  ]).slice(0, 2);

  const artifactDiff = firstDifference(aConcept.artifactStrengths, bConcept.artifactStrengths);
  const templateDiff = firstDifference(
    aConcept.templatePatternPreferences,
    bConcept.templatePatternPreferences,
  );
  const critiqueDiff = firstDifference(aReaction.critiqueFocus, bReaction.critiqueFocus);
  const aLatest = aProject?.title;
  const bLatest = bProject?.title;

  const differences = compactStrings([
    artifactDiff.aOnly.length > 0 && artifactDiff.bOnly.length > 0
      ? `${a.displayName}: ${describeList(artifactDiff.aOnly)} / ${b.displayName}: ${describeList(artifactDiff.bOnly)}`
      : null,
    templateDiff.aOnly.length > 0 && templateDiff.bOnly.length > 0
      ? `${a.displayName} favors ${describeList(templateDiff.aOnly)}; ${b.displayName} favors ${describeList(templateDiff.bOnly)}`
      : null,
    critiqueDiff.aOnly.length > 0 && critiqueDiff.bOnly.length > 0
      ? `${a.displayName} comments on ${describeList(critiqueDiff.aOnly)}; ${b.displayName} comments on ${describeList(critiqueDiff.bOnly)}`
      : null,
    aLatest && bLatest && aLatest !== bLatest
      ? `latest outputs differ: ${aLatest} / ${bLatest}`
      : null,
    aOutput?.templatePatternId &&
    bOutput?.templatePatternId &&
    aOutput.templatePatternId !== bOutput.templatePatternId
      ? `output templates differ: ${aOutput.templatePatternId} / ${bOutput.templatePatternId}`
      : null,
  ]).slice(0, 2);

  return {
    reasons: reasons.length > 0 ? reasons : ["profile orientation is close"],
    differences:
      differences.length > 0
        ? differences
        : ["definitions are close; more generated-output history will clarify the difference"],
    commonTags: [
      ...commonSpecialties,
      ...commonArtifacts,
      ...commonTemplates,
      ...commonReactionTypes,
      ...commonOutputTags,
    ].slice(0, 6),
  };
};

export function agentSimilarity(
  a: AgentRegistryProfile,
  b: AgentRegistryProfile,
  qualityStats = new Map<string, AgentQualityStat>(),
  generatedOutputMetadata = new Map<string, GeneratedOutputMetadata>(),
): AgentSimilarityResult {
  const groupScores: SimilarityBreakdown = {
    profileSimilarity: profileSimilarity(a, b),
    creationSimilarity: creationSimilarity(a, b),
    reactionSimilarity: reactionSimilarity(a, b),
    runtimeQualitySimilarity: runtimeQualitySimilarity(a, b, qualityStats),
    generatedOutputSimilarity: generatedOutputSimilarity(a, b, qualityStats, generatedOutputMetadata),
  };

  let validWeight = 0;
  let weightedScore = 0;
  for (const [group, weight] of Object.entries(TOP_LEVEL_WEIGHTS) as Array<[SimilarityGroupName, number]>) {
    const score = groupScores[group];
    if (score === null) continue;
    validWeight += weight;
    weightedScore += weight * score;
  }

  const dataCoverage = round2(validWeight);
  const score = validWeight === 0 ? null : round4(weightedScore / validWeight);
  const included = dataCoverage >= MINIMUM_DATA_COVERAGE && score !== null;
  const explanation = explainSimilarity(a, b, qualityStats, generatedOutputMetadata);

  return {
    agentId: a.agentId,
    similarAgentId: b.agentId,
    score: included ? score : null,
    dataCoverage,
    included,
    reasons: explanation.reasons,
    differences: explanation.differences,
    commonTags: explanation.commonTags,
    groupScores,
  };
}

export const qualityStatsMap = (file: AgentQualityStatsFile | null | undefined) =>
  new Map((file?.agents ?? []).map((stat) => [stat.agentId, stat]));

export const generatedOutputMetadataMap = (file: GeneratedOutputMetadataFile | null | undefined) =>
  new Map((file?.projects ?? []).map((project) => [project.projectId, project]));

export function buildAgentSimilaritySnapshot(args: {
  registryVersion: number;
  agents: AgentRegistryProfile[];
  qualityStats?: AgentQualityStatsFile | null;
  generatedOutputMetadata?: GeneratedOutputMetadataFile | null;
  generatedAt?: string;
  maxSimilarAgentsPerAgent?: number;
}): AgentSimilaritySnapshot {
  const maxSimilarAgentsPerAgent = args.maxSimilarAgentsPerAgent ?? 3;
  const creators = activeCreatorProfiles({ version: args.registryVersion, agents: args.agents });
  const stats = qualityStatsMap(args.qualityStats);
  const outputMetadata = generatedOutputMetadataMap(args.generatedOutputMetadata);
  const pairs: AgentSimilarityResult[] = [];

  for (const agent of creators) {
    const candidates = creators
      .filter((candidate) => candidate.agentId !== agent.agentId)
      .map((candidate) => agentSimilarity(agent, candidate, stats, outputMetadata))
      .filter((pair) => pair.included)
      .sort((a, b) => {
        const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return a.similarAgentId.localeCompare(b.similarAgentId);
      })
      .slice(0, maxSimilarAgentsPerAgent);
    pairs.push(...candidates);
  }

  return {
    version: 1,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    source: "agent-registry + agent-quality-stats + generated-output-metadata",
    registryVersion: args.registryVersion,
    activeCreatorCount: creators.length,
    maxSimilarAgentsPerAgent,
    minimumDataCoverage: MINIMUM_DATA_COVERAGE,
    pairs,
  };
}

export const agentSimilarityPath = () =>
  path.join(process.cwd(), "data", "agents", "agent-similarity.json");

export const readAgentQualityStats = async (): Promise<AgentQualityStatsFile | null> => {
  try {
    return JSON.parse(
      await readFile(path.join(process.cwd(), "data", "agents", "agent-quality-stats.json"), "utf8"),
    ) as AgentQualityStatsFile;
  } catch {
    return null;
  }
};

export const readGeneratedOutputMetadata = async (): Promise<GeneratedOutputMetadataFile | null> => {
  try {
    return JSON.parse(
      await readFile(path.join(process.cwd(), "data", "agents", "generated-output-metadata.json"), "utf8"),
    ) as GeneratedOutputMetadataFile;
  } catch {
    return null;
  }
};

export async function writeAgentSimilaritySnapshot(filePath = agentSimilarityPath()) {
  const [registry, stats, outputMetadata] = await Promise.all([
    readAgentRegistry(),
    readAgentQualityStats(),
    readGeneratedOutputMetadata(),
  ]);
  const snapshot = buildAgentSimilaritySnapshot({
    registryVersion: registry.version,
    agents: registry.agents,
    qualityStats: stats,
    generatedOutputMetadata: outputMetadata,
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { filePath, snapshot };
}
