/**
 * Unit checks for DOC-80 agent set diversity report.
 *
 * Run:
 *   npx tsx scripts/agent-diversity-report.test.ts
 */
import assert from "node:assert/strict";
import { readAgentRegistry } from "./agent-registry";
import { buildAgentDiversityReport } from "./agent-diversity-report";
import { readAgentQualityStats, type GeneratedOutputMetadataFile } from "./agent-similarity";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

async function main() {
  const registry = await readAgentRegistry();
  const qualityStats = await readAgentQualityStats();
  if (!qualityStats) {
    throw new Error("agent-quality-stats.json must be readable for diversity report tests");
  }

  const generatedOutputMetadata: GeneratedOutputMetadataFile = {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    source: "test",
    projects: [
      {
        projectId: "proj_manual_20260625T23142195_01_ai_artifact",
        agentId: "agent_a",
        title: "AIセキュリティレビュー会議ダッシュボード",
        templatePatternId: "evidence_decision_board",
        surfacePattern: "decision_helper",
        aiMechanismPattern: "evaluation_scoring",
      },
      {
        projectId: "proj_manual_20260625T001032_02_prompt_roulette",
        agentId: "agent_b",
        title: "Prompt Roulette",
        templatePatternId: "remix_roulette",
        surfacePattern: "playful_game",
        aiMechanismPattern: "personalized_reasoning",
      },
      {
        projectId: "proj_manual_20260625T001032_03_why_it_matters_brief",
        agentId: "agent_c",
        title: "Why It Matters Brief",
        templatePatternId: "guided_explainer_path",
        surfacePattern: "learning_explainer",
        aiMechanismPattern: "adaptive_explainer",
      },
      {
        projectId: "proj_g_github_mission_maker",
        agentId: "agent_d",
        title: "GitHub攻略ミッションメーカー",
        templatePatternId: "source_to_mission",
        surfacePattern: "learning_explainer",
        aiMechanismPattern: "workflow_generation",
      },
    ],
  };

  const report = await buildAgentDiversityReport({
    registryVersion: registry.version,
    agents: registry.agents,
    qualityStats,
    generatedOutputMetadata,
    generatedAt: "2026-07-01T00:00:00.000Z",
    nearestPairLimit: 5,
  });

  check("report covers active creators and unordered pairs", () => {
    assert.equal(report.version, 1);
    assert.equal(report.generatedAt, "2026-07-01T00:00:00.000Z");
    assert.equal(report.activeCreatorCount, 20);
    assert.equal(report.pairwiseComparisons, 190);
    assert.ok(report.includedPairwiseComparisons > 0);
    assert.ok((report.averagePairwiseSimilarity ?? 0) > 0);
    assert.ok((report.maxPairwiseSimilarity ?? 0) > 0);
  });

  check("coverage summaries include profile and reaction dimensions", () => {
    assert.ok(report.specialtyCoverage.uniqueCount > 0);
    assert.ok(report.artifactStrengthCoverage.uniqueCount > 0);
    assert.ok(report.templatePatternCoverage.uniqueCount > 0);
    assert.ok(report.preferredInputCoverage.uniqueCount > 0);
    assert.ok(report.reactionTypeCoverage.uniqueCount > 0);
    assert.ok(report.cadenceDistribution.uniqueCount > 0);
  });

  check("nearest neighbor pairs are capped and do not include non-creators", () => {
    assert.equal(report.nearestNeighborPairs.length, 5);
    assert.equal(report.nearestNeighborPairs.some((pair) => pair.agentId === "reviewer_v1"), false);
    assert.equal(report.nearestNeighborPairs.some((pair) => pair.agentId === "steward"), false);
    assert.equal(report.nearestNeighborPairs.every((pair) => pair.score > 0), true);
  });

  check("generated output coverage uses metadata fields", () => {
    assert.equal(report.generatedOutputCoverage.latestProjectCount, 4);
    assert.equal(report.generatedOutputCoverage.metadataProjectCount, 4);
    assert.equal(report.generatedOutputCoverage.templatePatternCoverage.uniqueCount, 4);
    assert.equal(report.generatedOutputCoverage.surfacePatternCoverage.uniqueCount, 3);
    assert.ok(report.generatedOutputCoverage.maxTitleJaccard);
  });

  console.log(`\nAll ${passed} agent-diversity-report checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
