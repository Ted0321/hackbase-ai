/**
 * agent-profile-projection.ts の単体テスト。
 * DOC-79のPhase 1として、Full Profileから用途別Projectionを安全に作れることを検証する。
 *
 * Run:
 *   npx tsx scripts/agent-profile-projection.test.ts
 */
import assert from "node:assert/strict";
import { readAgentRegistry } from "./agent-registry";
import {
  buildAgentProfileProjections,
  buildBuildConstraintProjection,
  buildConceptProjection,
  buildReactionProjection,
  isCreatorProjectionCandidate,
  normalizeArtifactStrengths,
  normalizeCreativeAntiPatterns,
} from "./agent-profile-projection";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

async function main() {
  const registry = await readAgentRegistry();
  const activeCreators = registry.agents.filter(isCreatorProjectionCandidate);
  const nonCreatorAgents = registry.agents.filter((agent) => !isCreatorProjectionCandidate(agent));

  const firstCreator = activeCreators[0];
  if (!firstCreator) {
    throw new Error("agent-registry.json must contain at least one active creator");
  }

  check("all active creators can produce three projections", () => {
    assert.equal(activeCreators.length, 20);

    for (const agent of activeCreators) {
      const projections = buildAgentProfileProjections(agent, "learning guidance", {
        selfSelectionReason: "scheduled self-directed run",
        materialsRead: ["productSourceIndex", "currentTopicRadar"],
        learningApplied: ["keep uncertainty visible"],
      });

      assert.equal(projections.conceptProjection.agentId, agent.agentId);
      assert.equal(projections.reactionProjection.agentId, agent.agentId);
      assert.equal(projections.buildConstraintProjection.agentId, agent.agentId);
      assert.ok(projections.conceptProjection.sourcePreferences.length > 0);
      assert.ok(projections.reactionProjection.allowedReactionTypes.length > 0);
      assert.ok(projections.buildConstraintProjection.preferredScreenTypes.length > 0);
    }
  });

  check("reviewer and governance agents are excluded from creator projection candidates", () => {
    const roles = new Set(nonCreatorAgents.map((agent) => agent.role));
    assert.ok(roles.has("reviewer"));
    assert.ok(roles.has("governance"));
    assert.equal(nonCreatorAgents.some((agent) => agent.agentId === "reviewer_v1"), true);
    assert.equal(nonCreatorAgents.some((agent) => agent.agentId === "steward"), true);
  });

  check("concept projection keeps concept fields and excludes reaction/build noise", () => {
    const projection = buildConceptProjection(firstCreator, "learning text", {
      selfSelectionReason: "mission fit",
      materialsRead: ["productSourceIndex"],
      learningApplied: ["show risk next to recommendation"],
    });
    const serialized = JSON.stringify(projection);

    assert.equal(projection.projectionType, "concept");
    assert.ok(projection.makerRationale);
    assert.ok(projection.conceptSelectionRules.length > 0);
    assert.ok(projection.safetyBoundaries.length > 0);
    assert.equal(projection.learningGuidance, "learning text");
    assert.deepEqual(projection.selfDirectedPlan?.materialsRead, ["productSourceIndex"]);
    assert.equal(serialized.includes("schedulingPolicy"), false);
    assert.equal(serialized.includes("interactionPolicy"), false);
    assert.equal(serialized.includes("qualityStats"), false);
    assert.equal(serialized.includes("recentUsageCount"), false);
  });

  check("reaction projection keeps interaction policy and excludes creation-only rules", () => {
    const projection = buildReactionProjection(firstCreator);
    const serialized = JSON.stringify(projection);

    assert.equal(projection.projectionType, "reaction");
    assert.ok(projection.allowedReactionTypes.includes("agent_critique"));
    assert.ok(projection.critiqueFocus.length > 0);
    assert.ok(projection.targetPreference.length > 0);
    assert.ok(projection.propensity);
    assert.equal(serialized.includes("conceptSelectionRules"), false);
    assert.equal(serialized.includes("sourceReadingStyle"), false);
    assert.equal(serialized.includes("learningPolicy"), false);
    assert.equal(serialized.includes("qualityStats"), false);
  });

  check("build constraint projection keeps artifact constraints and excludes reaction policy", () => {
    const projection = buildBuildConstraintProjection(firstCreator, "learning text");
    const serialized = JSON.stringify(projection);

    assert.equal(projection.projectionType, "build_constraint");
    assert.ok(projection.materialGuidance.length > 0);
    assert.ok(projection.artifactStrengths.length > 0);
    assert.ok(projection.templatePatternPreferences.length > 0);
    assert.ok(projection.qualityBar.length > 0);
    assert.ok(projection.externalDependencyRules.includes("no paid API dependency for MVP"));
    assert.equal(projection.learningGuidance, "learning text");
    assert.equal(serialized.includes("interactionPolicy"), false);
    assert.equal(serialized.includes("schedulingPolicy"), false);
    assert.equal(serialized.includes("qualityStats"), false);
  });

  check("normalization prefers creationPolicy artifact strengths and de-duplicates avoid fields", () => {
    assert.ok(firstCreator.creationPolicy);
    const agent = {
      ...firstCreator,
      artifactStrengths: ["legacy-board"],
      creationPolicy: {
        ...firstCreator.creationPolicy,
        artifactStrengths: ["board", "board", "workspace"],
        antiPatterns: ["pure_explainer", "pure_explainer"],
      },
      avoid: ["pure_explainer", "consumer_game"],
    };

    assert.deepEqual(normalizeArtifactStrengths(agent), ["board", "workspace"]);
    assert.deepEqual(normalizeCreativeAntiPatterns(agent), ["pure_explainer", "consumer_game"]);
  });

  check("each projection is shorter than the full profile for active creators", () => {
    for (const agent of activeCreators) {
      const fullLength = JSON.stringify(agent).length;
      assert.ok(JSON.stringify(buildConceptProjection(agent)).length < fullLength);
      assert.ok(JSON.stringify(buildReactionProjection(agent)).length < fullLength);
      assert.ok(JSON.stringify(buildBuildConstraintProjection(agent)).length < fullLength);
    }
  });

  console.log(`\nAll ${passed} agent-profile-projection checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
