import type { PrismaClient } from "@prisma/client";
import { isPostgresUrl } from "./prisma-factory";
import {
  activationChecklist,
  readAdminAgentRegistry,
  type ActivationChecklistItem,
  type AdminAgentProfile,
  type AdminAgentRegistry,
} from "./admin-agent-registry";

type ContractRow = {
  agentId: string;
  version: number;
  status: string;
  role: string;
  contractJson: string;
  schedulingPolicyJson: string;
  interactionPolicyJson: string | null;
  activationChecklistJson: string | null;
  source: string;
  updatedByType: string;
  updatedById: string | null;
  updatedByName: string | null;
  activatedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type ContractSource = "db" | "registry";

export type AdminAgentProfileWithSource = AdminAgentProfile & {
  contractSource: ContractSource;
  contractRowSource?: string;
  contractUpdatedAt?: string;
  activationChecklist?: ActivationChecklistItem[];
};

export type ContractUpdater = {
  actorType: string;
  actorId?: string | null;
  actorName?: string | null;
  source?: string;
};

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const dateToIso = (value: Date | string | null | undefined) => {
  if (!value) return undefined;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const agentContractTableName = "AgentOperatingContract";

export async function ensureAgentOperatingContractTable(prisma: PrismaClient) {
  if (isPostgresUrl()) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AgentOperatingContract" (
        "agentId" TEXT PRIMARY KEY,
        "version" INTEGER NOT NULL DEFAULT 1,
        "status" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'creator',
        "contractJson" TEXT NOT NULL,
        "schedulingPolicyJson" TEXT NOT NULL,
        "interactionPolicyJson" TEXT,
        "activationChecklistJson" TEXT,
        "source" TEXT NOT NULL DEFAULT 'admin_console',
        "updatedByType" TEXT NOT NULL DEFAULT 'human',
        "updatedById" TEXT,
        "updatedByName" TEXT,
        "activatedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_status_idx" ON "AgentOperatingContract" ("status")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_role_idx" ON "AgentOperatingContract" ("role")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_source_idx" ON "AgentOperatingContract" ("source")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_updatedAt_idx" ON "AgentOperatingContract" ("updatedAt")`);
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentOperatingContract" (
      "agentId" TEXT PRIMARY KEY NOT NULL,
      "version" INTEGER NOT NULL DEFAULT 1,
      "status" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'creator',
      "contractJson" TEXT NOT NULL,
      "schedulingPolicyJson" TEXT NOT NULL,
      "interactionPolicyJson" TEXT,
      "activationChecklistJson" TEXT,
      "source" TEXT NOT NULL DEFAULT 'admin_console',
      "updatedByType" TEXT NOT NULL DEFAULT 'human',
      "updatedById" TEXT,
      "updatedByName" TEXT,
      "activatedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_status_idx" ON "AgentOperatingContract" ("status")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_role_idx" ON "AgentOperatingContract" ("role")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_source_idx" ON "AgentOperatingContract" ("source")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentOperatingContract_updatedAt_idx" ON "AgentOperatingContract" ("updatedAt")`);
}

function rowToAgent(row: ContractRow): AdminAgentProfileWithSource {
  const contract = parseJson<AdminAgentProfile>(row.contractJson, {
    agentId: row.agentId,
    displayName: row.agentId,
    status: row.status,
    role: row.role,
  });
  return {
    ...contract,
    agentId: row.agentId,
    status: row.status,
    role: row.role,
    schedulingPolicy: parseJson(row.schedulingPolicyJson, contract.schedulingPolicy ?? {}),
    interactionPolicy: parseJson(row.interactionPolicyJson, contract.interactionPolicy ?? {}),
    contractSource: "db",
    contractRowSource: row.source,
    contractUpdatedAt: dateToIso(row.updatedAt),
    activationChecklist: parseJson(row.activationChecklistJson, activationChecklist(contract)),
  };
}

async function readContractRows(prisma: PrismaClient): Promise<ContractRow[]> {
  try {
    return await prisma.$queryRaw<ContractRow[]>`
      SELECT
        "agentId", "version", "status", "role", "contractJson", "schedulingPolicyJson",
        "interactionPolicyJson", "activationChecklistJson", "source", "updatedByType",
        "updatedById", "updatedByName", "activatedAt", "createdAt", "updatedAt"
      FROM "AgentOperatingContract"
      ORDER BY "agentId" ASC
    `;
  } catch {
    return [];
  }
}

export async function readDbAgentContracts(prisma: PrismaClient) {
  const rows = await readContractRows(prisma);
  return rows.map(rowToAgent);
}

export async function readAdminAgentRegistryWithContracts(
  prisma: PrismaClient,
): Promise<AdminAgentRegistry & { agents: AdminAgentProfileWithSource[]; contractSourceSummary: { db: number; registry: number } }> {
  const [registry, dbContracts] = await Promise.all([readAdminAgentRegistry(), readDbAgentContracts(prisma)]);
  const dbById = new Map(dbContracts.map((agent) => [agent.agentId, agent]));
  const ids = new Set<string>();
  const agents: AdminAgentProfileWithSource[] = [];

  for (const agent of registry.agents) {
    ids.add(agent.agentId);
    const dbAgent = dbById.get(agent.agentId);
    agents.push(
      dbAgent && dbAgent.contractRowSource !== "registry_import"
        ? dbAgent
        : {
        ...agent,
        contractSource: "registry",
        activationChecklist: activationChecklist(agent),
      },
    );
  }

  for (const dbAgent of dbContracts) {
    if (!ids.has(dbAgent.agentId)) {
      agents.push(dbAgent);
    }
  }

  return {
    ...registry,
    agents,
    contractSourceSummary: {
      db: agents.filter((agent) => agent.contractSource === "db").length,
      registry: agents.filter((agent) => agent.contractSource === "registry").length,
    },
  };
}

export async function readAdminAgentWithContract(prisma: PrismaClient, agentId: string) {
  const registry = await readAdminAgentRegistryWithContracts(prisma);
  return registry.agents.find((agent) => agent.agentId === agentId) ?? null;
}

export async function upsertAgentOperatingContract(
  prisma: PrismaClient,
  agent: AdminAgentProfile,
  updater: ContractUpdater,
) {
  await ensureAgentOperatingContractTable(prisma);
  const checklist = activationChecklist(agent);
  const contractJson = JSON.stringify(agent);
  const schedulingPolicyJson = JSON.stringify(agent.schedulingPolicy ?? {});
  const interactionPolicyJson = JSON.stringify(agent.interactionPolicy ?? {});
  const activationChecklistJson = JSON.stringify(checklist);
  const status = agent.status ?? "draft";
  const role = agent.role ?? "creator";
  const version = agent.profileVersion ?? 1;
  const source = updater.source ?? "admin_console";
  const updatedByType = updater.actorType;
  const updatedById = updater.actorId ?? null;
  const updatedByName = updater.actorName ?? null;
  const activatedAt = status === "active" ? new Date() : null;
  const now = new Date();

  await prisma.$executeRaw`
    INSERT INTO "AgentOperatingContract" (
      "agentId", "version", "status", "role", "contractJson", "schedulingPolicyJson",
      "interactionPolicyJson", "activationChecklistJson", "source", "updatedByType",
      "updatedById", "updatedByName", "activatedAt", "createdAt", "updatedAt"
    )
    VALUES (
      ${agent.agentId}, ${version}, ${status}, ${role}, ${contractJson}, ${schedulingPolicyJson},
      ${interactionPolicyJson}, ${activationChecklistJson}, ${source}, ${updatedByType},
      ${updatedById}, ${updatedByName}, ${activatedAt}, ${now}, ${now}
    )
    ON CONFLICT ("agentId") DO UPDATE SET
      "version" = "AgentOperatingContract"."version" + 1,
      "status" = excluded."status",
      "role" = excluded."role",
      "contractJson" = excluded."contractJson",
      "schedulingPolicyJson" = excluded."schedulingPolicyJson",
      "interactionPolicyJson" = excluded."interactionPolicyJson",
      "activationChecklistJson" = excluded."activationChecklistJson",
      "source" = excluded."source",
      "updatedByType" = excluded."updatedByType",
      "updatedById" = excluded."updatedById",
      "updatedByName" = excluded."updatedByName",
      "activatedAt" = COALESCE("AgentOperatingContract"."activatedAt", excluded."activatedAt"),
      "updatedAt" = excluded."updatedAt"
  `;

  return readAdminAgentWithContract(prisma, agent.agentId);
}

export async function importRegistryContractsToDb(prisma: PrismaClient, updater: ContractUpdater) {
  const registry = await readAdminAgentRegistry();
  const imported: string[] = [];
  for (const agent of registry.agents) {
    await upsertAgentOperatingContract(prisma, agent, { ...updater, source: updater.source ?? "registry_import" });
    imported.push(agent.agentId);
  }
  return imported;
}
