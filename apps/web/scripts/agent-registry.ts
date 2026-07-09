import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * コメント専用の文体プロファイル。voice/styleTraits とは別軸で、
 * 「いいね」等コメントの“長さ・絵文字・口調”をエージェントごとに変えるために使う。
 */
export type CommentStyle = {
  length: "short" | "medium" | "long";
  emoji: "none" | "occasional" | "frequent";
  styleHintJP: string;
};

export type AgentRegistryProfile = {
  agentId: string;
  profileVersion?: number;
  displayName: string;
  status?: string;
  ownerType?: string;
  role?: string;
  oneLiner?: string;
  defaultAutonomyLevel?: string;
  identity?: {
    principle: string;
    worldview: string;
    voice: string;
    motivation?: string;
  };
  makerProfile?: {
    creationReason: string;
    materialTaste: string[];
    refusesToMake: string[];
    signatureScreenTypes: string[];
  };
  specialties?: string[];
  creationPolicy?: {
    mission: string;
    preferredInputs: string[];
    sourceReadingStyle: string;
    conceptSelectionRules: string[];
    artifactStrengths: string[];
    defaultTemplatePatterns: string[];
    qualityBar: string[];
    antiPatterns: string[];
  };
  artifactStrengths?: string[];
  styleTraits?: string[];
  commentStyle?: CommentStyle;
  avoid?: string[];
  boundaries?: string[];
  structuredBoundaries?: {
    forbiddenDomains: string[];
    forbiddenClaims: string[];
    externalDependencyRules: string[];
    publishAuthority: "none" | "local_only" | "requires_validation";
  };
  interactionPolicy?: {
    canReactWith: string[];
    critiqueFocus: string[];
    targetPreference?: string[];
    maxReactionsPerDay?: number;
    maxReactionsPerProject?: number;
    doNotDo: string[];
    // A-4: 性格を行動に反映する反応タイプの傾向（重み）。selectInteractionTypeが重み付きで選ぶ。
    propensity?: Record<string, number>;
  };
  learningPolicy?: {
    feedbackToUse: string[];
    feedbackToIgnore: string[];
    memoryScope: "own_projects" | "same_category" | "all_projects";
    updateRequiresHumanApproval: boolean;
    maxGuidanceItems: number;
  };
  reviewPolicy?: {
    mission: string;
    reviewFocus: string[];
    passBar: string[];
    failurePatterns: string[];
    evidenceToRecord: string[];
    learningSources: string[];
  };
  recentUsageCount?: number;
  qualityStats?: {
    validationPassRate: number | null;
    noveltyAverage: number | null;
    humanWantToGrowCount: number;
  };
  // P1-C: per-agent 自走スケジューラの稼働枠
  schedulingPolicy?: {
    cadence?: "daily" | "every_other_day" | "every_2_days" | "every_3_days" | "weekly" | "on_demand";
    maxRunsPerDay?: number;
    preferredHours?: number[];
    enabled?: boolean;
    cooldownHours?: number;
    skipIfLowSignal?: boolean;
  };
};

export type AgentRegistry = {
  version: number;
  registryPolicy?: unknown;
  agents: AgentRegistryProfile[];
};

export type AgentProfileSnapshot = {
  version: 1;
  snapshotAt: string;
  source: string;
  selectedAgentIds: string[];
  profiles: AgentRegistryProfile[];
  missingAgentIds: string[];
};

export const agentRegistryPath = () =>
  path.join(process.cwd(), "scripts", "llm-pipeline", "fixtures", "agent-registry.json");

export async function readAgentRegistry(): Promise<AgentRegistry> {
  return JSON.parse(await readFile(agentRegistryPath(), "utf8")) as AgentRegistry;
}

export async function buildAgentProfileSnapshot(
  selectedAgentIds: string[],
  source: string,
): Promise<AgentProfileSnapshot> {
  const registry = await readAgentRegistry();
  const idSet = new Set(selectedAgentIds);
  const profiles = registry.agents.filter((agent) => idSet.has(agent.agentId));
  const foundIds = new Set(profiles.map((profile) => profile.agentId));

  return {
    version: 1,
    snapshotAt: new Date().toISOString(),
    source,
    selectedAgentIds,
    profiles,
    missingAgentIds: selectedAgentIds.filter((agentId) => !foundIds.has(agentId)),
  };
}

export function activeCreatorProfiles(registry: AgentRegistry) {
  return registry.agents.filter((agent) => {
    return (agent.role ?? "creator") === "creator" && (agent.status ?? "active") === "active";
  });
}
