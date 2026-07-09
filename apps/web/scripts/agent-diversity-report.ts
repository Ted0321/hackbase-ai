import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeCreatorProfiles, readAgentRegistry, type AgentRegistryProfile } from "./agent-registry";
import { buildConceptProjection, buildReactionProjection } from "./agent-profile-projection";
import {
  agentSimilarity,
  generatedOutputMetadataMap,
  qualityStatsMap,
  readAgentQualityStats,
  readGeneratedOutputMetadata,
  textSimilarity,
  type AgentQualityStatsFile,
  type GeneratedOutputMetadata,
  type GeneratedOutputMetadataFile,
} from "./agent-similarity";

export type DistributionEntry = {
  value: string;
  count: number;
  ratio: number;
  agentIds: string[];
};

export type CoverageSummary = {
  uniqueCount: number;
  totalAssignments: number;
  distribution: DistributionEntry[];
};

export type NearestNeighborPair = {
  agentId: string;
  similarAgentId: string;
  score: number;
  dataCoverage: number;
  reasons: string[];
  differences: string[];
};

export type OverlapHotspot = {
  field: string;
  value: string;
  count: number;
  ratio: number;
  threshold: number;
  agentIds: string[];
};

export type CoverageGap = {
  field: string;
  issue: string;
  severity: "info" | "warning";
  missingValues?: string[];
};

export type GeneratedOutputCoverage = {
  latestProjectCount: number;
  metadataProjectCount: number;
  templatePatternCoverage: CoverageSummary;
  surfacePatternCoverage: CoverageSummary;
  aiMechanismPatternCoverage: CoverageSummary;
  categoryCoverage: CoverageSummary;
  maxTitleJaccard: {
    score: number;
    projectIds: string[];
    titles: string[];
  } | null;
};

export type AgentDiversityReport = {
  version: 1;
  generatedAt: string;
  source: string;
  registryVersion: number;
  activeCreatorCount: number;
  pairwiseComparisons: number;
  includedPairwiseComparisons: number;
  averagePairwiseSimilarity: number | null;
  maxPairwiseSimilarity: number | null;
  nearestNeighborPairs: NearestNeighborPair[];
  specialtyCoverage: CoverageSummary;
  artifactStrengthCoverage: CoverageSummary;
  templatePatternCoverage: CoverageSummary;
  preferredInputCoverage: CoverageSummary;
  reactionTypeCoverage: CoverageSummary;
  cadenceDistribution: CoverageSummary;
  generatedOutputCoverage: GeneratedOutputCoverage;
  overlapHotspots: OverlapHotspot[];
  coverageGaps: CoverageGap[];
};

const round4 = (value: number) => Number(value.toFixed(4));

const compact = (values: Array<string | undefined | null>) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const coverageSummary = (
  agents: AgentRegistryProfile[],
  valuesForAgent: (agent: AgentRegistryProfile) => string[],
): CoverageSummary => {
  const buckets = new Map<string, Set<string>>();
  let totalAssignments = 0;

  for (const agent of agents) {
    for (const value of compact(valuesForAgent(agent))) {
      totalAssignments += 1;
      const current = buckets.get(value) ?? new Set<string>();
      current.add(agent.agentId);
      buckets.set(value, current);
    }
  }

  return {
    uniqueCount: buckets.size,
    totalAssignments,
    distribution: [...buckets.entries()]
      .map(([value, agentIds]) => ({
        value,
        count: agentIds.size,
        ratio: round4(agentIds.size / Math.max(agents.length, 1)),
        agentIds: [...agentIds].sort(),
      }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
};

const outputCoverageSummary = (
  outputs: GeneratedOutputMetadata[],
  valuesForOutput: (output: GeneratedOutputMetadata) => string[],
): CoverageSummary => {
  const buckets = new Map<string, Set<string>>();
  let totalAssignments = 0;

  for (const output of outputs) {
    for (const value of compact(valuesForOutput(output))) {
      totalAssignments += 1;
      const current = buckets.get(value) ?? new Set<string>();
      current.add(output.agentId ?? output.projectId);
      buckets.set(value, current);
    }
  }

  return {
    uniqueCount: buckets.size,
    totalAssignments,
    distribution: [...buckets.entries()]
      .map(([value, agentIds]) => ({
        value,
        count: agentIds.size,
        ratio: round4(agentIds.size / Math.max(outputs.length, 1)),
        agentIds: [...agentIds].sort(),
      }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
};

const hotspotEntries = (
  field: string,
  coverage: CoverageSummary,
  threshold: number,
): OverlapHotspot[] =>
  coverage.distribution
    .filter((entry) => entry.ratio >= threshold)
    .map((entry) => ({
      field,
      value: entry.value,
      count: entry.count,
      ratio: entry.ratio,
      threshold,
      agentIds: entry.agentIds,
    }));

const readTemplatePatternIds = async () => {
  try {
    const raw = JSON.parse(
      await readFile(path.join(process.cwd(), "scripts", "templates", "product-templates.json"), "utf8"),
    ) as { templatePatterns?: Array<{ id: string }> };
    return (raw.templatePatterns ?? []).map((pattern) => pattern.id).sort();
  } catch {
    return [];
  }
};

const maxTitleJaccard = (outputs: GeneratedOutputMetadata[]) => {
  let maxScore = -1;
  let maxPair: [GeneratedOutputMetadata, GeneratedOutputMetadata] | null = null;
  const titled = outputs.filter((output) => output.title);

  for (let i = 0; i < titled.length; i += 1) {
    for (let j = i + 1; j < titled.length; j += 1) {
      const a = titled[i];
      const b = titled[j];
      const score = textSimilarity(a.title, b.title) ?? 0;
      if (score > maxScore) {
        maxScore = score;
        maxPair = [a, b];
      }
    }
  }

  if (!maxPair) return null;
  return {
    score: round4(maxScore),
    projectIds: [maxPair[0].projectId, maxPair[1].projectId],
    titles: compact([maxPair[0].title, maxPair[1].title]),
  };
};

export async function buildAgentDiversityReport(args: {
  registryVersion: number;
  agents: AgentRegistryProfile[];
  qualityStats?: AgentQualityStatsFile | null;
  generatedOutputMetadata?: GeneratedOutputMetadataFile | null;
  generatedAt?: string;
  nearestPairLimit?: number;
}): Promise<AgentDiversityReport> {
  const creators = activeCreatorProfiles({ version: args.registryVersion, agents: args.agents });
  const stats = qualityStatsMap(args.qualityStats);
  const outputMetadata = generatedOutputMetadataMap(args.generatedOutputMetadata);
  const templatePatternIds = await readTemplatePatternIds();
  const pairResults: NearestNeighborPair[] = [];

  for (let i = 0; i < creators.length; i += 1) {
    for (let j = i + 1; j < creators.length; j += 1) {
      const result = agentSimilarity(creators[i], creators[j], stats, outputMetadata);
      if (!result.included || result.score === null) continue;
      pairResults.push({
        agentId: result.agentId,
        similarAgentId: result.similarAgentId,
        score: result.score,
        dataCoverage: result.dataCoverage,
        reasons: result.reasons,
        differences: result.differences,
      });
    }
  }

  const pairScores = pairResults.map((pair) => pair.score);
  const specialtyCoverage = coverageSummary(creators, (agent) => agent.specialties ?? []);
  const artifactStrengthCoverage = coverageSummary(
    creators,
    (agent) => buildConceptProjection(agent).artifactStrengths,
  );
  const templatePatternCoverage = coverageSummary(
    creators,
    (agent) => buildConceptProjection(agent).templatePatternPreferences,
  );
  const preferredInputCoverage = coverageSummary(
    creators,
    (agent) => buildConceptProjection(agent).sourcePreferences,
  );
  const reactionTypeCoverage = coverageSummary(
    creators,
    (agent) => buildReactionProjection(agent).allowedReactionTypes,
  );
  const cadenceDistribution = coverageSummary(creators, (agent) =>
    compact([agent.schedulingPolicy?.cadence]),
  );

  const latestOutputs = creators
    .map((agent) => {
      const latestProject = stats.get(agent.agentId)?.latestProject;
      return latestProject ? outputMetadata.get(latestProject.id) : undefined;
    })
    .filter((output): output is GeneratedOutputMetadata => Boolean(output));

  const generatedOutputCoverage: GeneratedOutputCoverage = {
    latestProjectCount: creators.filter((agent) => stats.get(agent.agentId)?.latestProject).length,
    metadataProjectCount: latestOutputs.length,
    templatePatternCoverage: outputCoverageSummary(latestOutputs, (output) =>
      compact([output.templatePatternId]),
    ),
    surfacePatternCoverage: outputCoverageSummary(latestOutputs, (output) =>
      compact([output.surfacePattern]),
    ),
    aiMechanismPatternCoverage: outputCoverageSummary(latestOutputs, (output) =>
      compact([output.aiMechanismPattern]),
    ),
    categoryCoverage: outputCoverageSummary(latestOutputs, (output) =>
      compact([output.categoryId, output.categoryName]),
    ),
    maxTitleJaccard: maxTitleJaccard(latestOutputs),
  };

  const missingTemplatePatterns = templatePatternIds.filter(
    (id) => !templatePatternCoverage.distribution.some((entry) => entry.value === id),
  );
  const outputMissingTemplates = latestOutputs
    .filter((output) => !output.templatePatternId)
    .map((output) => output.projectId);
  const coverageGaps: CoverageGap[] = [];
  if (missingTemplatePatterns.length > 0) {
    coverageGaps.push({
      field: "templatePatternPreferences",
      issue: "Some executable template patterns are not represented in active creator preferences.",
      severity: "info",
      missingValues: missingTemplatePatterns,
    });
  }
  if (generatedOutputCoverage.latestProjectCount > generatedOutputCoverage.metadataProjectCount) {
    coverageGaps.push({
      field: "generatedOutputMetadata",
      issue: "Some latest projects exist in quality stats but have no generated-output metadata row.",
      severity: "warning",
    });
  }
  if (outputMissingTemplates.length > 0) {
    coverageGaps.push({
      field: "generatedOutput.templatePatternId",
      issue: "Some latest project metadata rows do not include templatePatternId.",
      severity: "warning",
      missingValues: outputMissingTemplates,
    });
  }

  return {
    version: 1,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    source: "agent-registry + agent-quality-stats + generated-output-metadata",
    registryVersion: args.registryVersion,
    activeCreatorCount: creators.length,
    pairwiseComparisons: (creators.length * (creators.length - 1)) / 2,
    includedPairwiseComparisons: pairResults.length,
    averagePairwiseSimilarity:
      pairScores.length > 0
        ? round4(pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length)
        : null,
    maxPairwiseSimilarity: pairScores.length > 0 ? round4(Math.max(...pairScores)) : null,
    nearestNeighborPairs: pairResults
      .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId))
      .slice(0, args.nearestPairLimit ?? 10),
    specialtyCoverage,
    artifactStrengthCoverage,
    templatePatternCoverage,
    preferredInputCoverage,
    reactionTypeCoverage,
    cadenceDistribution,
    generatedOutputCoverage,
    overlapHotspots: [
      ...hotspotEntries("artifactStrengths", artifactStrengthCoverage, 0.5),
      ...hotspotEntries("templatePatternPreferences", templatePatternCoverage, 0.5),
      ...hotspotEntries("preferredInputs", preferredInputCoverage, 0.5),
      ...hotspotEntries("reactionTypes", reactionTypeCoverage, 0.6),
      ...hotspotEntries("cadence", cadenceDistribution, 0.5),
    ],
    coverageGaps,
  };
}

export const agentDiversityReportPath = () =>
  path.join(process.cwd(), "data", "agents", "agent-diversity-report.json");

export async function writeAgentDiversityReport(filePath = agentDiversityReportPath()) {
  const [registry, stats, outputMetadata] = await Promise.all([
    readAgentRegistry(),
    readAgentQualityStats(),
    readGeneratedOutputMetadata(),
  ]);
  const report = await buildAgentDiversityReport({
    registryVersion: registry.version,
    agents: registry.agents,
    qualityStats: stats,
    generatedOutputMetadata: outputMetadata,
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { filePath, report };
}
