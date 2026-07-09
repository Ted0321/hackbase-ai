import { readFile } from "node:fs/promises";
import { fixturePath } from "./llm-pipeline/shared";
import { readAgentRegistry } from "./agent-registry";
import { buildAgentDefinitionV2RegistrySnapshot } from "./agent-definition-v2-adapter";
import type {
  AgentInputKind,
  AgentPhase,
  AgentSkillDefinition,
  AgentToolDefinition,
  AgentTriggerDefinition,
} from "./agent-definition-v2";

type ToolRegistryFixture = {
  version?: unknown;
  tools?: unknown;
};

type SkillRegistryFixture = {
  version?: unknown;
  skills?: unknown;
};

type TriggerRegistryFixture = {
  version?: unknown;
  triggers?: unknown;
};

const validPhases = new Set<AgentPhase>([
  "research",
  "combination",
  "concept",
  "agent-router",
  "requirements",
  "builder",
  "materialize",
  "reviewer",
  "rewriter",
  "publisher",
  "reaction",
  "learning",
  "governance",
]);

const validInputKinds = new Set<AgentInputKind>([
  "trendSignals",
  "productSourceIndex",
  "topicRadar",
  "currentTopicRadar",
  "recentArtifacts",
  "humanFeedback",
  "agentFeedback",
  "validationResults",
  "agentMemoryDigest",
  "agentRegistry",
  "agentLearnings",
]);

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const requireString = (value: unknown, label: string, failures: string[]) => {
  if (!isNonEmptyString(value)) failures.push(`${label} must be a non-empty string`);
};

const requireNumber = (value: unknown, label: string, failures: string[]) => {
  if (typeof value !== "number" || !Number.isFinite(value)) failures.push(`${label} must be a finite number`);
};

const requireBoolean = (value: unknown, label: string, failures: string[]) => {
  if (typeof value !== "boolean") failures.push(`${label} must be boolean`);
};

const requireArray = (value: unknown, label: string, failures: string[]) => {
  if (!Array.isArray(value)) failures.push(`${label} must be an array`);
};

const requireStringArray = (value: unknown, label: string, failures: string[]) => {
  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array`);
    return;
  }
  const invalid = value.filter((item) => !isNonEmptyString(item));
  if (invalid.length > 0) failures.push(`${label} must contain only non-empty strings`);
};

const duplicateIds = (ids: string[]) => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
};

async function readJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(fixturePath(fileName), "utf8")) as T;
}

const validateTool = (tool: unknown, index: number, failures: string[]) => {
  const record = asRecord(tool);
  const label = `tools[${index}]`;
  if (!record) {
    failures.push(`${label} must be an object`);
    return;
  }

  requireNumber(record.schemaVersion, `${label}.schemaVersion`, failures);
  requireString(record.toolId, `${label}.toolId`, failures);
  requireString(record.name, `${label}.name`, failures);
  requireString(record.purpose, `${label}.purpose`, failures);
  requireString(record.capability, `${label}.capability`, failures);
  requireString(record.inputSchemaRef, `${label}.inputSchemaRef`, failures);
  requireString(record.outputSchemaRef, `${label}.outputSchemaRef`, failures);
  requireStringArray(record.allowedPhases, `${label}.allowedPhases`, failures);
  requireString(record.permissionLevel, `${label}.permissionLevel`, failures);
  requireString(record.riskLevel, `${label}.riskLevel`, failures);
  requireBoolean(record.requiresSecret, `${label}.requiresSecret`, failures);
  requireString(record.costPolicy, `${label}.costPolicy`, failures);
  requireString(record.networkPolicy, `${label}.networkPolicy`, failures);
  requireString(record.sandboxPolicy, `${label}.sandboxPolicy`, failures);
  requireBoolean(record.auditLogRequired, `${label}.auditLogRequired`, failures);
  requireString(record.agentEligibility, `${label}.agentEligibility`, failures);

  for (const phase of Array.isArray(record.allowedPhases) ? record.allowedPhases : []) {
    if (!validPhases.has(phase as AgentPhase)) {
      failures.push(`${label}.allowedPhases includes unknown phase: ${String(phase)}`);
    }
  }
};

const validateSkill = (skill: unknown, index: number, failures: string[]) => {
  const record = asRecord(skill);
  const label = `skills[${index}]`;
  if (!record) {
    failures.push(`${label} must be an object`);
    return;
  }

  requireNumber(record.schemaVersion, `${label}.schemaVersion`, failures);
  requireString(record.skillId, `${label}.skillId`, failures);
  requireString(record.name, `${label}.name`, failures);
  requireString(record.description, `${label}.description`, failures);
  requireStringArray(record.tags, `${label}.tags`, failures);
  requireStringArray(record.applicablePhases, `${label}.applicablePhases`, failures);
  requireStringArray(record.triggerHints, `${label}.triggerHints`, failures);
  requireStringArray(record.inputRequirements, `${label}.inputRequirements`, failures);
  requireStringArray(record.procedure, `${label}.procedure`, failures);
  requireStringArray(record.outputContract, `${label}.outputContract`, failures);
  requireArray(record.examples, `${label}.examples`, failures);
  requireStringArray(record.failureModes, `${label}.failureModes`, failures);
  requireStringArray(record.validationChecks, `${label}.validationChecks`, failures);
  requireNumber(record.version, `${label}.version`, failures);
  requireString(record.status, `${label}.status`, failures);

  for (const phase of Array.isArray(record.applicablePhases) ? record.applicablePhases : []) {
    if (!validPhases.has(phase as AgentPhase)) {
      failures.push(`${label}.applicablePhases includes unknown phase: ${String(phase)}`);
    }
  }
};

const validateTrigger = (trigger: unknown, index: number, failures: string[]) => {
  const record = asRecord(trigger);
  const label = `triggers[${index}]`;
  if (!record) {
    failures.push(`${label} must be an object`);
    return;
  }

  requireNumber(record.schemaVersion, `${label}.schemaVersion`, failures);
  requireString(record.triggerId, `${label}.triggerId`, failures);
  requireString(record.name, `${label}.name`, failures);
  requireString(record.type, `${label}.type`, failures);
  requireBoolean(record.enabled, `${label}.enabled`, failures);
  if (!asRecord(record.condition)) failures.push(`${label}.condition must be an object`);
  if (!asRecord(record.actingAgentSelector)) failures.push(`${label}.actingAgentSelector must be an object`);
  requireStringArray(record.inputBundle, `${label}.inputBundle`, failures);
  requireString(record.targetPhase, `${label}.targetPhase`, failures);
  requireString(record.autonomyLevel, `${label}.autonomyLevel`, failures);
  requireNumber(record.priority, `${label}.priority`, failures);
  if (!asRecord(record.safetyGate)) failures.push(`${label}.safetyGate must be an object`);
  if (!asRecord(record.attribution)) failures.push(`${label}.attribution must be an object`);

  if (isNonEmptyString(record.targetPhase) && !validPhases.has(record.targetPhase as AgentPhase)) {
    failures.push(`${label}.targetPhase is unknown: ${record.targetPhase}`);
  }

  for (const inputKind of Array.isArray(record.inputBundle) ? record.inputBundle : []) {
    if (!validInputKinds.has(inputKind as AgentInputKind)) {
      failures.push(`${label}.inputBundle includes unknown input kind: ${String(inputKind)}`);
    }
  }
};

async function main() {
  const failures: string[] = [];
  const [toolRegistry, skillRegistry, triggerRegistry, agentRegistry] = await Promise.all([
    readJson<ToolRegistryFixture>("agent-tool-registry.json"),
    readJson<SkillRegistryFixture>("agent-skill-registry.json"),
    readJson<TriggerRegistryFixture>("agent-trigger-registry.json"),
    readAgentRegistry(),
  ]);

  requireNumber(toolRegistry.version, "agent-tool-registry.version", failures);
  requireNumber(skillRegistry.version, "agent-skill-registry.version", failures);
  requireNumber(triggerRegistry.version, "agent-trigger-registry.version", failures);
  requireArray(toolRegistry.tools, "agent-tool-registry.tools", failures);
  requireArray(skillRegistry.skills, "agent-skill-registry.skills", failures);
  requireArray(triggerRegistry.triggers, "agent-trigger-registry.triggers", failures);

  const tools = Array.isArray(toolRegistry.tools) ? (toolRegistry.tools as AgentToolDefinition[]) : [];
  const skills = Array.isArray(skillRegistry.skills) ? (skillRegistry.skills as AgentSkillDefinition[]) : [];
  const triggers = Array.isArray(triggerRegistry.triggers)
    ? (triggerRegistry.triggers as AgentTriggerDefinition[])
    : [];

  tools.forEach((tool, index) => validateTool(tool, index, failures));
  skills.forEach((skill, index) => validateSkill(skill, index, failures));
  triggers.forEach((trigger, index) => validateTrigger(trigger, index, failures));

  const toolIds = tools.map((tool) => tool.toolId).filter(isNonEmptyString);
  const skillIds = skills.map((skill) => skill.skillId).filter(isNonEmptyString);
  const triggerIds = triggers.map((trigger) => trigger.triggerId).filter(isNonEmptyString);

  for (const duplicate of duplicateIds(toolIds)) failures.push(`duplicate toolId: ${duplicate}`);
  for (const duplicate of duplicateIds(skillIds)) failures.push(`duplicate skillId: ${duplicate}`);
  for (const duplicate of duplicateIds(triggerIds)) failures.push(`duplicate triggerId: ${duplicate}`);

  const toolIdSet = new Set(toolIds);
  const skillIdSet = new Set(skillIds);
  const triggerIdSet = new Set(triggerIds);
  const agentSnapshot = buildAgentDefinitionV2RegistrySnapshot(agentRegistry, {
    transformedAt: "2026-07-01T00:00:00.000Z",
  });

  for (const agent of agentSnapshot.agents) {
    for (const toolId of agent.toolPolicy.allowedToolIds) {
      if (!toolIdSet.has(toolId)) failures.push(`${agent.agentId}.toolPolicy references unknown tool: ${toolId}`);
    }
    for (const phaseToolIds of Object.values(agent.toolPolicy.phasePermissions)) {
      for (const toolId of phaseToolIds ?? []) {
        if (!toolIdSet.has(toolId)) failures.push(`${agent.agentId}.phasePermissions references unknown tool: ${toolId}`);
      }
    }
    for (const skillId of agent.skillPolicy.enabledSkillIds) {
      if (!skillIdSet.has(skillId)) failures.push(`${agent.agentId}.skillPolicy references unknown skill: ${skillId}`);
    }
    for (const triggerId of agent.triggerPolicy.enabledTriggerIds) {
      if (!triggerIdSet.has(triggerId)) {
        failures.push(`${agent.agentId}.triggerPolicy references unknown trigger: ${triggerId}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Agent shared registry validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Agent shared registries valid: ${tools.length} tool(s), ${skills.length} skill(s), ${triggers.length} trigger(s).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
