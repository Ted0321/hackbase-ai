/**
 * AgentDefinitionV2 adapter and runtime context smoke tests.
 *
 * Run:
 *   npx tsx scripts/agent-definition-v2.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readAgentRegistry } from "./agent-registry";
import { buildAgentDefinitionV2, buildAgentDefinitionV2RegistrySnapshot } from "./agent-definition-v2-adapter";
import {
  buildAgentRuntimeContext,
  buildAgentRuntimeContextFromRegistryProfile,
} from "./agent-runtime-context";
import type { AgentSkillDefinition, AgentToolDefinition, AgentTriggerDefinition } from "./agent-definition-v2";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const readFixture = <T>(fileName: string): T =>
  JSON.parse(readFileSync(`scripts/llm-pipeline/fixtures/${fileName}`, "utf8")) as T;

async function main() {
  const registry = await readAgentRegistry();
  const toolRegistry = readFixture<{ tools: AgentToolDefinition[] }>("agent-tool-registry.json").tools;
  const skillRegistry = readFixture<{ skills: AgentSkillDefinition[] }>("agent-skill-registry.json").skills;
  const triggerRegistry = readFixture<{ triggers: AgentTriggerDefinition[] }>("agent-trigger-registry.json").triggers;
  const transformedAt = "2026-07-01T00:00:00.000Z";
  const snapshot = buildAgentDefinitionV2RegistrySnapshot(registry, { transformedAt });
  const creator = registry.agents.find((agent) => agent.agentId === "agent_a");
  const playfulCreator = registry.agents.find((agent) => agent.agentId === "agent_b");
  const reviewer = registry.agents.find((agent) => agent.agentId === "reviewer_v1");
  const steward = registry.agents.find((agent) => agent.agentId === "steward");

  if (!creator || !playfulCreator || !reviewer || !steward) {
    throw new Error("agent-registry.json must include agent_a, agent_b, reviewer_v1, and steward");
  }

  check("registry snapshot preserves agent count and source version", () => {
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.sourceRegistryVersion, registry.version);
    assert.equal(snapshot.transformedAt, transformedAt);
    assert.equal(snapshot.agents.length, registry.agents.length);
    assert.equal(snapshot.agents.every((agent) => agent.schemaVersion === 2), true);
  });

  check("creator profile maps existing fields into Persona, Memory, Tool, and Trigger", () => {
    const definition = buildAgentDefinitionV2(creator, { transformedAt });

    assert.equal(definition.agentId, "agent_a");
    assert.equal(definition.role, "creator");
    assert.equal(definition.defaultAutonomyLevel, "L1_assisted");
    assert.equal(definition.persona.soul.principle, creator.identity?.principle);
    assert.ok(definition.persona.soul.background.includes("Turns ambiguous operational problems"));
    assert.ok(definition.persona.creationTaste.preferredInputs.includes("productSourceIndex"));
    assert.ok(definition.persona.creationTaste.artifactStrengths.includes("board"));
    assert.equal(definition.memoryPolicy.memoryScope, creator.learningPolicy?.memoryScope);
    assert.ok(definition.skillPolicy.enabledSkillIds.includes("concept_signal_to_decision_surface"));
    assert.ok(definition.skillPolicy.enabledSkillIds.includes("artifact_contract_validation_loop"));
    assert.ok(definition.skillPolicy.enabledSkillIds.includes("reaction_with_persona_boundary"));
    assert.ok(definition.toolPolicy.allowedToolIds.includes("generate_artifact"));
    assert.ok(definition.triggerPolicy.enabledTriggerIds.includes("scheduled_creation:daily"));
    assert.equal(definition.triggerPolicy.cooldown.cooldownHours, 24);
    assert.ok(definition.migration?.sourceFields.includes("identity"));
    assert.ok(definition.migration?.sourceFields.includes("creationPolicy"));
  });

  check("reviewer and steward profiles do not require creator-only source fields", () => {
    const reviewerDefinition = buildAgentDefinitionV2(reviewer, { transformedAt });
    const stewardDefinition = buildAgentDefinitionV2(steward, { transformedAt });

    assert.equal(reviewerDefinition.role, "reviewer");
    assert.equal(stewardDefinition.role, "governance");
    assert.ok(reviewerDefinition.persona.creationTaste.mission.length > 0);
    assert.ok(stewardDefinition.persona.creationTaste.mission.length > 0);
    assert.ok(reviewerDefinition.skillPolicy.enabledSkillIds.includes("reaction_with_persona_boundary"));
    assert.ok(stewardDefinition.skillPolicy.enabledSkillIds.includes("governance_evidence_report"));
    assert.ok(reviewerDefinition.toolPolicy.allowedToolIds.includes("create_reaction"));
    assert.ok(stewardDefinition.toolPolicy.allowedToolIds.includes("governance_report"));
    assert.equal(reviewerDefinition.governancePolicy.allowedPublishTargets.includes("local_feed"), false);
    assert.equal(stewardDefinition.governancePolicy.allowedPublishTargets.includes("local_feed"), false);
  });

  check("creator skill policy reflects persona-specific creation tendencies", () => {
    const practicalDefinition = buildAgentDefinitionV2(creator, { transformedAt });
    const playfulDefinition = buildAgentDefinitionV2(playfulCreator, { transformedAt });

    assert.ok(practicalDefinition.skillPolicy.enabledSkillIds.includes("concept_signal_to_decision_surface"));
    assert.equal(practicalDefinition.skillPolicy.enabledSkillIds.includes("playful_remix_to_touchable_artifact"), false);
    assert.ok(playfulDefinition.skillPolicy.enabledSkillIds.includes("playful_remix_to_touchable_artifact"));
  });

  check("runtime context composes individual layers with shared-base tool permissions", () => {
    const definition = buildAgentDefinitionV2(creator, { transformedAt });
    const context = buildAgentRuntimeContext({
      runId: "test-run",
      agent: definition,
      phase: "concept",
      trigger: {
        triggerId: "scheduled_creation:daily",
      },
      toolRegistry,
      skillRegistry,
      triggerRegistry,
      inputBundle: {
        trendSignals: [],
        productSourceIndex: [],
      },
      outputContract: {
        schema: "concept-response",
      },
    });

    assert.equal(context.runId, "test-run");
    assert.equal(context.agentId, "agent_a");
    assert.equal(context.phase, "concept");
    assert.equal(context.trigger.type, "schedule");
    assert.equal(context.trigger.attribution.humanInfluence, "system_scheduled");
    assert.equal(context.personaSnapshot.soul.principle, definition.persona.soul.principle);
    assert.ok(context.allowedTools.some((tool) => tool.toolId === "compose_prompt"));
    assert.ok(context.allowedTools.some((tool) => tool.name === "Compose Prompt"));
    assert.equal(context.allowedTools.some((tool) => tool.toolId === "publish_local"), false);
    assert.ok(context.skillRefs.some((skill) => skill.skillId === "concept_signal_to_decision_surface"));
    assert.deepEqual(Object.keys(context.inputBundle).sort(), ["productSourceIndex", "trendSignals"]);
  });

  check("runtime context can be built directly from a registry profile", () => {
    const context = buildAgentRuntimeContextFromRegistryProfile({
      runId: "reaction-run",
      agent: reviewer,
      phase: "reaction",
      transformedAt,
      trigger: {
        triggerId: "feedback_received",
        type: "feedback_received",
      },
    });

    assert.equal(context.agentId, "reviewer_v1");
    assert.equal(context.trigger.attribution.humanInfluence, "human_seeded");
    assert.ok(context.allowedTools.some((tool) => tool.toolId === "create_reaction"));
  });

  check("tool policy caps medium-risk tools and drops external-write capabilities", () => {
    const definition = buildAgentDefinitionV2(creator, { transformedAt });
    // creator riskBudget.maxMediumRiskToolsPerRun = 2, confirmationPolicy.externalWriteRequiresHumanApproval = true.
    const toolDef = (
      toolId: string,
      permissionLevel: AgentToolDefinition["permissionLevel"],
      riskLevel: AgentToolDefinition["riskLevel"],
    ): AgentToolDefinition => ({
      schemaVersion: 1,
      toolId,
      name: toolId,
      purpose: `test tool ${toolId}`,
      capability: "generate_artifact",
      inputSchemaRef: "test",
      outputSchemaRef: "test",
      allowedPhases: ["materialize"],
      permissionLevel,
      riskLevel,
      requiresSecret: false,
      costPolicy: "free",
      networkPolicy: "none",
      sandboxPolicy: "repo_write",
      auditLogRequired: false,
      agentEligibility: "all",
    });

    const context = buildAgentRuntimeContext({
      runId: "tool-policy-run",
      agent: definition,
      phase: "materialize",
      toolRegistry: [
        toolDef("generate_artifact", "local_write", "medium"),
        toolDef("validate_artifact", "local_write", "medium"),
        toolDef("publish_local", "external_write", "medium"),
      ],
    });

    const toolIds = context.allowedTools.map((tool) => tool.toolId);
    assert.equal(toolIds.includes("publish_local"), false, "external-write capability is dropped from an autonomous surface");
    assert.ok(
      context.allowedTools.filter((tool) => tool.riskLevel === "medium").length <= 2,
      "medium-risk capabilities are capped by riskBudget.maxMediumRiskToolsPerRun",
    );
  });

  console.log(`\nAll ${passed} AgentDefinitionV2 checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
