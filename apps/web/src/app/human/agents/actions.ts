"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  assertCadence,
  assertPositiveInt,
  assertStatus,
  activationReady,
  applyAdminAgentSettings,
  buildDraftAdminAgent,
  normalizeAgentId,
  parseList,
  parsePreferredHours,
  type AdminAgentProfile,
} from "@/lib/admin-agent-registry";
import { assertAdminWriteAllowed, assertConsoleWriteAllowed, type AdminActor } from "@/lib/admin-auth";
import {
  readAdminAgentRegistryWithContracts,
  readAdminAgentWithContract,
  upsertAgentOperatingContract,
} from "@/lib/agent-operating-contract-store";
import { prisma } from "@/lib/db";

const valueOf = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const checked = (formData: FormData, key: string) => formData.get(key) === "on";

const intOf = (formData: FormData, key: string) => {
  const value = Number.parseInt(valueOf(formData, key), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  return value;
};

const stringify = (value: unknown) => JSON.stringify(value, null, 2);

const compactPolicy = (agent: AdminAgentProfile | null) =>
  agent
    ? {
        displayName: agent.displayName,
        status: agent.status,
        oneLiner: agent.oneLiner,
        schedulingPolicy: agent.schedulingPolicy,
        interactionPolicy: {
          maxReactionsPerDay: agent.interactionPolicy?.maxReactionsPerDay,
          maxReactionsPerProject: agent.interactionPolicy?.maxReactionsPerProject,
        },
      }
    : null;

const writeAdminAudit = async (args: {
  decisionType: string;
  status: string;
  action: string;
  agentId: string;
  reason: string;
  actor: AdminActor;
  metadata?: unknown;
}) => {
  try {
    await prisma.$transaction([
      prisma.adminDecision.create({
        data: {
          id: randomUUID(),
          decisionType: args.decisionType,
          status: args.status,
          targetType: "agent",
          targetId: args.agentId,
          agentId: args.agentId,
          adminActorId: args.actor.actorId,
          adminName: args.actor.actorName,
          source: "human_agent_console",
          reason: args.reason,
          metadataJson: args.metadata ? stringify(args.metadata) : null,
        },
      }),
      prisma.userActivityLog.create({
        data: {
          id: randomUUID(),
          actorType: "human",
          actorId: args.actor.actorId,
          action: args.action,
          targetType: "agent",
          targetId: args.agentId,
          source: "human_agent_console",
          metadataJson: args.metadata ? stringify(args.metadata) : null,
        },
      }),
    ]);
  } catch {
    // Observability tables may be absent in a dry local DB. Admin writes should still succeed.
  }
};

const defaultCategories = [
  { id: "cat_research", name: "Research", description: "Source-backed exploration, investigation, and evidence gathering." },
  { id: "cat_automation", name: "Automation", description: "Small tools that reduce repetitive work and routine handling." },
  { id: "cat_learning", name: "Learning", description: "Products that help people understand, practice, or learn faster." },
  { id: "cat_ideation", name: "Ideation", description: "Idea generation, remixing, and concept expansion tools." },
  { id: "cat_operations", name: "Operations", description: "Runbooks, routing, triage, and operational support surfaces." },
  { id: "cat_decision", name: "Decision", description: "Tools that make choices, tradeoffs, and next actions easier to inspect." },
  { id: "cat_scoring", name: "Scoring", description: "Ranking, evaluation, scoring, and weighted assessment tools." },
  { id: "cat_summary", name: "Summary", description: "Condensation, briefing, and digest-style products." },
  { id: "cat_writing", name: "Writing", description: "Drafting, rewriting, wording, and communication support." },
  { id: "cat_creative", name: "Creative", description: "Generated expression, storytelling, and creative presentation." },
  { id: "cat_utility", name: "Utility", description: "Small practical tools for everyday actions and scientific-style helpers." },
];

const inferPrimaryCategoryId = (agent: AdminAgentProfile) => {
  if (agent.primaryCategoryId) return agent.primaryCategoryId;

  const text = [
    ...(agent.creationPolicy?.artifactStrengths ?? []),
    ...(agent.creationPolicy?.defaultTemplatePatterns ?? []),
    ...(agent.makerProfile?.signatureScreenTypes ?? []),
    agent.creationPolicy?.mission ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (text.includes("runbook") || text.includes("ops") || text.includes("operator")) return "cat_operations";
  if (text.includes("score") || text.includes("rating") || text.includes("evaluate")) return "cat_scoring";
  if (text.includes("write") || text.includes("rewrite") || text.includes("draft")) return "cat_writing";
  if (text.includes("summary") || text.includes("brief") || text.includes("digest")) return "cat_summary";
  if (text.includes("game") || text.includes("roulette") || text.includes("play") || text.includes("remix")) return "cat_ideation";
  if (text.includes("map") || text.includes("timeline") || text.includes("matrix") || text.includes("source")) return "cat_research";
  if (text.includes("explainer") || text.includes("learning") || text.includes("term")) return "cat_learning";
  if (text.includes("decision") || text.includes("board") || text.includes("risk")) return "cat_decision";
  return "cat_automation";
};

const nextDbCode = async (agentId: string) => {
  const suffix = agentId.replace(/^agent[_-]?/, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "DRAFT";
  const base = `AI-${suffix.slice(0, 8)}`;
  let code = base;
  for (let index = 2; index < 20; index += 1) {
    const existing = await prisma.agent.findUnique({ where: { code } });
    if (!existing || existing.id === agentId) return code;
    code = `${base}-${index}`;
  }
  throw new Error(`Could not allocate a unique DB code for ${agentId}.`);
};

const ensureDefaultCategories = async () => {
  for (const category of defaultCategories) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: category,
      create: category,
    });
  }
};

const syncAgentToDb = async (agent: AdminAgentProfile) => {
  await ensureDefaultCategories();
  const primaryCategoryId = inferPrimaryCategoryId(agent);
  const secondaryCategoryId = primaryCategoryId === "cat_learning" ? "cat_summary" : "cat_learning";
  const code = await nextDbCode(agent.agentId);
  const data = {
    code,
    name: agent.displayName ?? agent.agentId,
    oneLiner: agent.oneLiner ?? agent.creationPolicy?.mission ?? "下書きとして追加されたAgent。",
    primaryValue: agent.creationPolicy?.artifactStrengths?.[0] ?? "draft",
    primaryCategoryId,
    secondaryCategoryId,
    themeDiscoveryPolicy:
      agent.creationPolicy?.sourceReadingStyle ??
      "運用ルールに従って、入力signalから安全なMVP題材を選ぶ。",
    prototypingPolicy:
      agent.creationPolicy?.mission ??
      "外部API・ログイン・credentialに依存しない、小さく検証できるWeb artifactを作る。",
    descriptionTone: agent.identity?.voice ?? "Concrete, reviewable, bounded",
    avoidPolicy: [
      ...(agent.creationPolicy?.antiPatterns ?? []),
      ...(agent.structuredBoundaries?.forbiddenDomains ?? []),
    ].join(", "),
    active: (agent.status ?? "active") === "active",
  };

  return prisma.agent.upsert({
    where: { id: agent.agentId },
    update: data,
    create: {
      id: agent.agentId,
      ...data,
    },
  });
};

export async function updateAgentSettingsAction(agentId: string, formData: FormData) {
  assertConsoleWriteAllowed();
  const actor = assertAdminWriteAllowed(formData);
  const displayName = valueOf(formData, "displayName");
  const oneLiner = valueOf(formData, "oneLiner");

  if (!displayName) throw new Error("displayName is required.");
  if (!oneLiner) throw new Error("oneLiner is required.");

  const before = await readAdminAgentWithContract(prisma, agentId);
  if (!before) throw new Error(`Agent not found: ${agentId}`);

  const next = applyAdminAgentSettings(before, {
    displayName,
    oneLiner,
    status: assertStatus(valueOf(formData, "status")),
    enabled: checked(formData, "enabled"),
    cadence: assertCadence(valueOf(formData, "cadence")),
    maxRunsPerDay: assertPositiveInt(intOf(formData, "maxRunsPerDay"), "maxRunsPerDay", 0, 24),
    cooldownHours: assertPositiveInt(intOf(formData, "cooldownHours"), "cooldownHours", 0, 720),
    preferredHours: parsePreferredHours(valueOf(formData, "preferredHours")),
    skipIfLowSignal: checked(formData, "skipIfLowSignal"),
    maxReactionsPerDay: assertPositiveInt(intOf(formData, "maxReactionsPerDay"), "maxReactionsPerDay", 0, 200),
    maxReactionsPerProject: assertPositiveInt(
      intOf(formData, "maxReactionsPerProject"),
      "maxReactionsPerProject",
      0,
      50,
    ),
  });
  await upsertAgentOperatingContract(prisma, next, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorName: actor.actorName,
  });
  await writeAdminAudit({
    decisionType: "agent_settings_update",
    status: "completed",
    action: "agent_settings_update",
    agentId,
    actor,
    reason: "Agentの運用ルールを更新しました。",
    metadata: { before: compactPolicy(before), after: compactPolicy(next) },
  });

  revalidatePath("/human/agents");
  revalidatePath(`/human/agents/${agentId}`);
  revalidatePath(`/human/agents/${agentId}/settings`);
  redirect(`/human/agents/${agentId}?tab=settings&saved=1`);
}

export async function createDraftAgentAction(formData: FormData) {
  assertConsoleWriteAllowed();
  let actor: ReturnType<typeof assertAdminWriteAllowed>;
  try {
    actor = assertAdminWriteAllowed(formData);
  } catch {
    redirect("/human/agents/new?error=admin_write_key");
  }
  const agentId = normalizeAgentId(valueOf(formData, "agentId"));
  const displayName = valueOf(formData, "displayName");
  const oneLiner = valueOf(formData, "oneLiner");
  const motivation = valueOf(formData, "motivation");
  const mission = valueOf(formData, "mission");

  if (!agentId) throw new Error("agentId is required.");
  if (!displayName) throw new Error("displayName is required.");
  if (!oneLiner) throw new Error("oneLiner is required.");
  if (!motivation) throw new Error("motivation is required.");
  if (!mission) throw new Error("mission is required.");

  const registry = await readAdminAgentRegistryWithContracts(prisma);
  if (registry.agents.some((agent) => agent.agentId === agentId)) {
    throw new Error(`Agent already exists: ${agentId}`);
  }

  const draft = buildDraftAdminAgent({
    agentId,
    displayName,
    oneLiner,
    motivation,
    mission,
    role: valueOf(formData, "roleHint") || undefined,
    voice: valueOf(formData, "voiceHint") || undefined,
    primaryCategoryId: valueOf(formData, "primaryCategoryId") || undefined,
    initialRunMode: valueOf(formData, "initialRunModeHint") || undefined,
    lowSignalPolicy: valueOf(formData, "lowSignalPolicyHint") || undefined,
    commentTone: valueOf(formData, "commentToneHint") || undefined,
    reactionAllowed: valueOf(formData, "reactionAllowedHint") || undefined,
    reactionForbidden: valueOf(formData, "reactionForbiddenHint") || undefined,
    materialTaste: parseList(valueOf(formData, "materialTaste")),
    signatureScreenTypes: parseList(valueOf(formData, "signatureScreenTypes")).length
      ? parseList(valueOf(formData, "signatureScreenTypes"))
      : ["small_inspectable_product"],
    forbiddenDomains: parseList(valueOf(formData, "forbiddenDomains")),
  });
  await upsertAgentOperatingContract(prisma, draft, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorName: actor.actorName,
  });
  await writeAdminAudit({
    decisionType: "agent_draft_created",
    status: "completed",
    action: "agent_draft_created",
    agentId: draft.agentId,
    actor,
    reason: "下書きAgentを作成しました。",
    metadata: { draft: compactPolicy(draft) },
  });

  revalidatePath("/human/agents");
  redirect(`/human/agents/${draft.agentId}?tab=settings&created=1`);
}

export async function syncAgentToDbAction(agentId: string, formData: FormData) {
  assertConsoleWriteAllowed();
  const actor = assertAdminWriteAllowed(formData);
  const agent = await readAdminAgentWithContract(prisma, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const dbAgent = await syncAgentToDb(agent);
  await writeAdminAudit({
    decisionType: "agent_db_sync",
    status: "completed",
    action: "agent_db_sync",
    agentId,
    actor,
    reason: "公開プロフィール連携用のAgent情報を更新しました。",
    metadata: {
      registry: compactPolicy(agent),
      dbAgent: {
        id: dbAgent.id,
        code: dbAgent.code,
        name: dbAgent.name,
        active: dbAgent.active,
        primaryCategoryId: dbAgent.primaryCategoryId,
        secondaryCategoryId: dbAgent.secondaryCategoryId,
      },
    },
  });

  revalidatePath("/human/agents");
  revalidatePath(`/human/agents/${agentId}`);
  revalidatePath(`/human/agents/${agentId}/settings`);
  redirect(`/human/agents/${agentId}?tab=settings&synced=1`);
}

export async function activateAgentAction(agentId: string, formData: FormData) {
  assertConsoleWriteAllowed();
  const actor = assertAdminWriteAllowed(formData);
  const before = await readAdminAgentWithContract(prisma, agentId);
  if (!before) throw new Error(`Agent not found: ${agentId}`);
  const next: AdminAgentProfile = {
    ...before,
    profileVersion: (before.profileVersion ?? 0) + 1,
    status: "active",
    schedulingPolicy: {
      ...(before.schedulingPolicy ?? {}),
      enabled: true,
      cadence: before.schedulingPolicy?.cadence ?? "daily",
      maxRunsPerDay: before.schedulingPolicy?.maxRunsPerDay ?? 1,
      cooldownHours: before.schedulingPolicy?.cooldownHours ?? 24,
      preferredHours: before.schedulingPolicy?.preferredHours ?? [],
    },
  };

  if (!activationReady(next)) {
    throw new Error("Agent cannot be activated until the activation checklist passes.");
  }

  await upsertAgentOperatingContract(prisma, next, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorName: actor.actorName,
  });
  await syncAgentToDb(next);
  await writeAdminAudit({
    decisionType: "agent_activate",
    status: "completed",
    action: "agent_activate",
    agentId,
    actor,
    reason: "チェック完了後にAgentを有効化しました。",
    metadata: { before: compactPolicy(before), after: compactPolicy(next) },
  });

  revalidatePath("/human/agents");
  revalidatePath(`/human/agents/${agentId}`);
  revalidatePath(`/human/agents/${agentId}/settings`);
  redirect(`/human/agents/${agentId}?tab=settings&activated=1`);
}
