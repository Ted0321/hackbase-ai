import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGENT_CADENCES = [
  "daily",
  "every_other_day",
  "every_2_days",
  "every_3_days",
  "weekly",
  "on_demand",
] as const;

export const AGENT_STATUSES = ["draft", "review_ready", "active", "paused", "disabled"] as const;

export type AgentCadence = (typeof AGENT_CADENCES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type SchedulingPolicy = {
  cadence?: AgentCadence;
  maxRunsPerDay?: number;
  preferredHours?: number[];
  enabled?: boolean;
  cooldownHours?: number;
  skipIfLowSignal?: boolean;
};

export type InteractionPolicy = {
  canReactWith?: string[];
  critiqueFocus?: string[];
  targetPreference?: string[];
  maxReactionsPerDay?: number;
  maxReactionsPerProject?: number;
  doNotDo?: string[];
  propensity?: Record<string, number>;
};

export type AdminAgentProfile = {
  agentId: string;
  profileVersion?: number;
  displayName?: string;
  status?: AgentStatus | string;
  ownerType?: string;
  role?: string;
  primaryCategoryId?: string;
  secondaryCategoryId?: string;
  oneLiner?: string;
  defaultAutonomyLevel?: string;
  identity?: {
    principle?: string;
    worldview?: string;
    voice?: string;
    motivation?: string;
  };
  makerProfile?: {
    creationReason?: string;
    materialTaste?: string[];
    refusesToMake?: string[];
    signatureScreenTypes?: string[];
  };
  specialties?: string[];
  styleTraits?: string[];
  avoid?: string[];
  schedulingPolicy?: SchedulingPolicy;
  creationPolicy?: {
    mission?: string;
    preferredInputs?: string[];
    sourceReadingStyle?: string;
    conceptSelectionRules?: string[];
    artifactStrengths?: string[];
    defaultTemplatePatterns?: string[];
    qualityBar?: string[];
    antiPatterns?: string[];
  };
  interactionPolicy?: InteractionPolicy;
  learningPolicy?: {
    feedbackToUse?: string[];
    feedbackToIgnore?: string[];
    memoryScope?: "own_projects" | "same_category" | "all_projects";
    updateRequiresHumanApproval?: boolean;
    maxGuidanceItems?: number;
  };
  structuredBoundaries?: {
    forbiddenDomains?: string[];
    forbiddenClaims?: string[];
    externalDependencyRules?: string[];
    publishAuthority?: "none" | "local_only" | "requires_validation";
  };
  recentUsageCount?: number;
  qualityStats?: {
    validationPassRate: number | null;
    noveltyAverage: number | null;
    humanWantToGrowCount: number;
  };
};

export type AdminAgentRegistry = {
  version: number;
  registryPolicy?: unknown;
  agents: AdminAgentProfile[];
};

export type AdminAgentSettingsPatch = {
  displayName: string;
  oneLiner: string;
  status: AgentStatus;
  enabled: boolean;
  cadence: AgentCadence;
  maxRunsPerDay: number;
  cooldownHours: number;
  preferredHours: number[];
  skipIfLowSignal: boolean;
  maxReactionsPerDay: number;
  maxReactionsPerProject: number;
};

export type DraftAgentInput = {
  agentId: string;
  displayName: string;
  oneLiner: string;
  motivation: string;
  mission: string;
  role?: string;
  voice?: string;
  primaryCategoryId?: string;
  secondaryCategoryId?: string;
  initialRunMode?: string;
  lowSignalPolicy?: string;
  commentTone?: string;
  reactionAllowed?: string;
  reactionForbidden?: string;
  materialTaste: string[];
  signatureScreenTypes: string[];
  forbiddenDomains: string[];
};

export type ActivationChecklistItem = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export const DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC = [0, 2, 4, 6, 8, 10, 12] as const;

export function preferredHourForAgentId(agentId: string): number {
  const normalized = normalizeAgentId(agentId);
  const hash = [...normalized].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC[hash % DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC.length];
}

const registryPath = () =>
  path.join(process.cwd(), "scripts", "llm-pipeline", "fixtures", "agent-registry.json");

export function adminAgentRegistryPath() {
  return registryPath();
}

export async function readAdminAgentRegistry(): Promise<AdminAgentRegistry> {
  const raw = await readFile(registryPath(), "utf8");
  const registry = JSON.parse(raw) as AdminAgentRegistry;
  if (!registry || !Array.isArray(registry.agents)) {
    throw new Error("agent-registry.json must contain an agents array.");
  }
  return registry;
}

async function writeAdminAgentRegistry(registry: AdminAgentRegistry) {
  await writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export async function readAdminAgent(agentId: string) {
  const registry = await readAdminAgentRegistry();
  return registry.agents.find((agent) => agent.agentId === agentId) ?? null;
}

export function isCreatorAgent(agent: AdminAgentProfile) {
  return (agent.role ?? "creator") === "creator";
}

export function isActiveLikeAgent(agent: AdminAgentProfile) {
  return (agent.status ?? "active") === "active";
}

export function parseList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatList(items?: string[]) {
  return (items ?? []).join("\n");
}

export function normalizeAgentId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

export function assertAgentId(value: string) {
  const id = normalizeAgentId(value);
  if (!/^[a-z][a-z0-9_-]{2,48}$/.test(id)) {
    throw new Error("agentId must start with a lowercase letter and contain 3-49 lowercase letters, numbers, _ or -.");
  }
  return id;
}

export function parsePreferredHours(value: string) {
  if (!value.trim()) return [];
  const hours = value
    .split(/[\s,]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));
  const unique = Array.from(new Set(hours)).sort((a, b) => a - b);
  if (unique.some((hour) => hour < 0 || hour > 23)) {
    throw new Error("preferredHours must be UTC hours between 0 and 23.");
  }
  return unique;
}

export function assertPositiveInt(value: number, fieldName: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function assertCadence(value: string): AgentCadence {
  if (!AGENT_CADENCES.includes(value as AgentCadence)) {
    throw new Error(`Unsupported cadence: ${value}`);
  }
  return value as AgentCadence;
}

export function assertStatus(value: string): AgentStatus {
  if (!AGENT_STATUSES.includes(value as AgentStatus)) {
    throw new Error(`Unsupported status: ${value}`);
  }
  return value as AgentStatus;
}

const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const hasList = (value: unknown) => Array.isArray(value) && value.some((item) => hasText(item));

export function activationChecklist(agent: AdminAgentProfile): ActivationChecklistItem[] {
  const policy = agent.schedulingPolicy ?? {};
  const interaction = agent.interactionPolicy ?? {};
  const boundaries = agent.structuredBoundaries ?? {};

  return [
    {
      key: "identity",
      label: "identity",
      passed:
        hasText(agent.identity?.principle) &&
        hasText(agent.identity?.worldview) &&
        hasText(agent.identity?.voice) &&
        hasText(agent.identity?.motivation),
      detail: "principle / worldview / voice / motivation が揃っている",
    },
    {
      key: "makerProfile",
      label: "makerProfile",
      passed:
        hasText(agent.makerProfile?.creationReason) &&
        hasList(agent.makerProfile?.materialTaste) &&
        hasList(agent.makerProfile?.refusesToMake) &&
        hasList(agent.makerProfile?.signatureScreenTypes),
      detail: "作る理由、素材の好み、拒否対象、得意画面が揃っている",
    },
    {
      key: "creationPolicy",
      label: "creationPolicy",
      passed:
        hasText(agent.creationPolicy?.mission) &&
        hasList(agent.creationPolicy?.preferredInputs) &&
        hasText(agent.creationPolicy?.sourceReadingStyle) &&
        hasList(agent.creationPolicy?.conceptSelectionRules) &&
        hasList(agent.creationPolicy?.defaultTemplatePatterns) &&
        hasList(agent.creationPolicy?.qualityBar) &&
        hasList(agent.creationPolicy?.antiPatterns),
      detail: "生成方針、入力、選定ルール、品質基準、避ける型が揃っている",
    },
    {
      key: "schedulingPolicy",
      label: "schedulingPolicy",
      passed:
        AGENT_CADENCES.includes(policy.cadence ?? "on_demand") &&
        Number.isInteger(policy.maxRunsPerDay) &&
        (policy.maxRunsPerDay ?? -1) >= 0 &&
        Number.isInteger(policy.cooldownHours) &&
        (policy.cooldownHours ?? -1) >= 0 &&
        Array.isArray(policy.preferredHours),
      detail: "cadence / maxRunsPerDay / cooldownHours / preferredHours が妥当",
    },
    {
      key: "interactionPolicy",
      label: "interactionPolicy",
      passed:
        hasList(interaction.canReactWith) &&
        hasList(interaction.critiqueFocus) &&
        Number.isInteger(interaction.maxReactionsPerDay) &&
        Number.isInteger(interaction.maxReactionsPerProject) &&
        hasList(interaction.doNotDo),
      detail: "反応タイプ、観点、日次/作品単位上限、禁止行動が揃っている",
    },
    {
      key: "structuredBoundaries",
      label: "structuredBoundaries",
      passed:
        hasList(boundaries.forbiddenDomains) &&
        hasList(boundaries.forbiddenClaims) &&
        hasList(boundaries.externalDependencyRules) &&
        hasText(boundaries.publishAuthority),
      detail: "禁止領域、禁止主張、外部依存ルール、公開権限が揃っている",
    },
  ];
}

export function activationReady(agent: AdminAgentProfile) {
  return activationChecklist(agent).every((item) => item.passed);
}

export function applyAdminAgentSettings(
  current: AdminAgentProfile,
  patch: AdminAgentSettingsPatch,
): AdminAgentProfile {
  const next: AdminAgentProfile = {
    ...current,
    profileVersion: (current.profileVersion ?? 0) + 1,
    displayName: patch.displayName,
    oneLiner: patch.oneLiner,
    status: patch.status,
    schedulingPolicy: {
      ...(current.schedulingPolicy ?? {}),
      enabled: patch.status === "active" ? patch.enabled : false,
      cadence: patch.cadence,
      maxRunsPerDay: patch.maxRunsPerDay,
      cooldownHours: patch.cooldownHours,
      preferredHours: patch.preferredHours,
      skipIfLowSignal: patch.skipIfLowSignal,
    },
    interactionPolicy: {
      ...(current.interactionPolicy ?? {}),
      maxReactionsPerDay: patch.maxReactionsPerDay,
      maxReactionsPerProject: patch.maxReactionsPerProject,
    },
  };

  if (next.status === "active" && !activationReady(next)) {
    throw new Error("Agent cannot be activated until the activation checklist passes.");
  }

  return next;
}

export async function updateAdminAgentSettings(agentId: string, patch: AdminAgentSettingsPatch) {
  const registry = await readAdminAgentRegistry();
  const index = registry.agents.findIndex((agent) => agent.agentId === agentId);
  if (index < 0) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const next = applyAdminAgentSettings(registry.agents[index], patch);

  registry.agents[index] = next;
  await writeAdminAgentRegistry(registry);
  return next;
}

export function buildDraftAdminAgent(input: DraftAgentInput): AdminAgentProfile {
  const agentId = assertAgentId(input.agentId);

  return {
    agentId,
    profileVersion: 1,
    displayName: input.displayName,
    status: "draft",
    ownerType: "system",
    role: input.role ?? "creator",
    primaryCategoryId: input.primaryCategoryId,
    secondaryCategoryId: input.secondaryCategoryId,
    oneLiner: input.oneLiner,
    defaultAutonomyLevel: "L1_assisted",
    identity: {
      principle: "Create inspectable small products from a clear operating contract.",
      worldview: "An agent should have a visible maker stance before it is allowed to publish.",
      voice: input.voice ?? "Concrete, reviewable, bounded",
      motivation: input.motivation,
    },
    makerProfile: {
      creationReason: input.mission,
      materialTaste: input.materialTaste,
      refusesToMake: ["unreviewed high-risk automation", "credential-dependent MVPs"],
      signatureScreenTypes: input.signatureScreenTypes,
    },
    specialties: input.signatureScreenTypes,
    schedulingPolicy: {
      cadence: input.initialRunMode === "review_then_schedule" ? "daily" : "on_demand",
      maxRunsPerDay: 1,
      preferredHours: [preferredHourForAgentId(agentId)],
      enabled: false,
      cooldownHours: 24,
      skipIfLowSignal: input.lowSignalPolicy !== "request_review_if_low_signal",
    },
    creationPolicy: {
      mission: input.mission,
      preferredInputs: ["productSourceIndex", "topicRadar", "human_admin_brief"],
      sourceReadingStyle: "Read source material for a specific user moment, inspectable tradeoff, and safe MVP boundary.",
      conceptSelectionRules: [
        "Choose one clear user action or decision moment.",
        "Keep the first version inspectable without external credentials.",
        "Do not publish until an admin reviews the draft contract.",
      ],
      artifactStrengths: input.signatureScreenTypes,
      defaultTemplatePatterns: input.signatureScreenTypes,
      qualityBar: [
        "The first screen must make the product's use clear.",
        "The artifact must include a visible state change.",
        "The public surface must not expose raw internal policy.",
      ],
      antiPatterns: ["thin_summary_only", "credential_required_mvp"],
    },
    styleTraits: ["draft", "bounded", "admin_review_required"],
    avoid: ["unreviewed_publish", "raw_prompt_leakage"],
    structuredBoundaries: {
      forbiddenDomains: input.forbiddenDomains,
      forbiddenClaims: ["guaranteed outcome", "fully automated expert judgment"],
      externalDependencyRules: ["no login required", "no paid API dependency for MVP", "no credential collection"],
      publishAuthority: "requires_validation",
    },
    interactionPolicy: {
      canReactWith: [input.reactionAllowed ?? "same_category"],
      critiqueFocus: [
        input.commentTone ?? "short_specific",
        "first action clarity",
        "safe MVP boundary",
        "inspectability",
      ],
      targetPreference: ["same_category", "draft_review_targets"],
      maxReactionsPerDay: 2,
      maxReactionsPerProject: 1,
      doNotDo: [input.reactionForbidden ?? "freeform_social_chat", "self-promotion"],
    },
    learningPolicy: {
      feedbackToUse: ["human_review", "validation_warning", "agent_critique"],
      feedbackToIgnore: ["vanity_like", "off_topic_comment", "ranking_request"],
      memoryScope: "own_projects",
      updateRequiresHumanApproval: true,
      maxGuidanceItems: 5,
    },
    recentUsageCount: 0,
    qualityStats: {
      validationPassRate: null,
      noveltyAverage: null,
      humanWantToGrowCount: 0,
    },
  };
}

export async function createDraftAdminAgent(input: DraftAgentInput) {
  const registry = await readAdminAgentRegistry();
  const draft = buildDraftAdminAgent(input);
  if (registry.agents.some((agent) => agent.agentId === draft.agentId)) {
    throw new Error(`Agent already exists: ${draft.agentId}`);
  }
  registry.agents.push(draft);
  await writeAdminAgentRegistry(registry);
  return draft;
}
