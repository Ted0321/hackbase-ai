/**
 * Unit checks for DOC-80 agent similarity.
 *
 * Run:
 *   npx tsx scripts/agent-similarity.test.ts
 */
import assert from "node:assert/strict";
import { activeCreatorProfiles, readAgentRegistry } from "./agent-registry";
import {
  agentSimilarity,
  buildAgentSimilaritySnapshot,
  cosineSimilarity,
  generatedOutputSimilarity,
  generatedOutputMetadataMap,
  qualityStatsMap,
  readAgentQualityStats,
  runtimeQualitySimilarity,
  setSimilarity,
  textSimilarity,
} from "./agent-similarity";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

async function main() {
  const registry = await readAgentRegistry();
  const activeCreators = activeCreatorProfiles(registry);
  const byId = new Map(registry.agents.map((agent) => [agent.agentId, agent]));
  const agentA = byId.get("agent_a");
  const agentB = byId.get("agent_b");
  const agentE = byId.get("agent_e");
  const statsFile = await readAgentQualityStats();
  const stats = qualityStatsMap(statsFile);

  if (!agentA || !agentB || !agentE) {
    throw new Error("agent-registry.json must include agent_a, agent_b, and agent_e");
  }
  if (!statsFile) {
    throw new Error("agent-quality-stats.json must be readable for similarity tests");
  }

  check("primitive similarity helpers are deterministic", () => {
    assert.equal(setSimilarity(["a", "b"], ["b", "c"]), 0.3333);
    assert.equal(textSimilarity("decision board risk", "decision board map"), 0.5);
    assert.equal(cosineSimilarity({ like: 1, critique: 0 }, { like: 1, critique: 0 }), 1);
    assert.equal(cosineSimilarity({}, {}), null);
  });

  check("registry-only similarity excludes runtime and generated groups", () => {
    const result = agentSimilarity(agentA, agentB);

    assert.equal(result.included, true);
    assert.equal(result.dataCoverage, 0.75);
    assert.notEqual(result.score, null);
    assert.notEqual(result.groupScores.profileSimilarity, null);
    assert.notEqual(result.groupScores.creationSimilarity, null);
    assert.notEqual(result.groupScores.reactionSimilarity, null);
    assert.equal(result.groupScores.runtimeQualitySimilarity, null);
    assert.equal(result.groupScores.generatedOutputSimilarity, null);
  });

  check("quality stats add runtime and generated-output groups when available", () => {
    const result = agentSimilarity(agentA, agentB, stats);

    assert.equal(result.included, true);
    assert.equal(result.dataCoverage, 1);
    assert.notEqual(result.score, null);
    assert.notEqual(runtimeQualitySimilarity(agentA, agentB, stats), null);
    assert.notEqual(generatedOutputSimilarity(agentA, agentB, stats), null);
    assert.ok(result.reasons.length > 0);
    assert.ok(result.differences.length > 0);
  });

  check("generated-output metadata enriches generated similarity", () => {
    const baseline = generatedOutputSimilarity(agentA, agentB, stats);
    const outputMetadata = generatedOutputMetadataMap({
      version: 1,
      generatedAt: "2026-07-01T00:00:00.000Z",
      source: "test",
      projects: [
        {
          projectId: "proj_manual_20260625T23142195_01_ai_artifact",
          templatePatternId: "evidence_decision_board",
          surfacePattern: "decision_helper",
          aiMechanismPattern: "evaluation_scoring",
          oneLiner: "Evidence weighted decision board",
          validationStatus: "pass",
          mvpContractV2Status: "present",
          interactionProofPrimaryAction: "Move card",
        },
        {
          projectId: "proj_manual_20260625T001032_02_prompt_roulette",
          templatePatternId: "evidence_decision_board",
          surfacePattern: "decision_helper",
          aiMechanismPattern: "evaluation_scoring",
          oneLiner: "Evidence weighted decision board",
          validationStatus: "pass",
          mvpContractV2Status: "present",
          interactionProofPrimaryAction: "Move card",
        },
      ],
    });
    const enriched = generatedOutputSimilarity(agentA, agentB, stats, outputMetadata);
    const result = agentSimilarity(agentA, agentB, stats, outputMetadata);

    assert.notEqual(baseline, null);
    assert.notEqual(enriched, null);
    assert.ok((enriched ?? 0) > (baseline ?? 0));
    assert.equal(result.included, true);
    assert.equal(result.groupScores.generatedOutputSimilarity, enriched);
  });

  check("missing quality stats do not fabricate runtime similarity", () => {
    assert.equal(runtimeQualitySimilarity(agentA, agentB, new Map()), null);
    assert.equal(generatedOutputSimilarity(agentA, agentB, new Map()), null);
    assert.equal(runtimeQualitySimilarity(agentA, agentE, stats), null);
    assert.equal(generatedOutputSimilarity(agentA, agentE, stats), null);
  });

  check("snapshot includes only active creators and caps nearest agents", () => {
    const snapshot = buildAgentSimilaritySnapshot({
      registryVersion: registry.version,
      agents: registry.agents,
      qualityStats: statsFile,
      generatedAt: "2026-07-01T00:00:00.000Z",
      maxSimilarAgentsPerAgent: 3,
    });

    assert.equal(activeCreators.length, 20);
    assert.equal(snapshot.generatedAt, "2026-07-01T00:00:00.000Z");
    assert.equal(snapshot.activeCreatorCount, 20);
    assert.equal(snapshot.maxSimilarAgentsPerAgent, 3);
    assert.equal(snapshot.pairs.length, 60);
    assert.equal(snapshot.pairs.some((pair) => pair.agentId === pair.similarAgentId), false);
    assert.equal(snapshot.pairs.some((pair) => pair.agentId === "reviewer_v1"), false);
    assert.equal(snapshot.pairs.some((pair) => pair.agentId === "steward"), false);
    assert.equal(snapshot.pairs.every((pair) => pair.included), true);

    for (const agent of activeCreators) {
      assert.equal(
        snapshot.pairs.filter((pair) => pair.agentId === agent.agentId).length,
        3,
      );
    }
  });

  console.log(`\nAll ${passed} agent-similarity checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
