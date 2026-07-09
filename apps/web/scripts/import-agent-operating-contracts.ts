import { readAdminAgentRegistry } from "../src/lib/admin-agent-registry";
import {
  importRegistryContractsToDb,
  readAdminAgentRegistryWithContracts,
} from "../src/lib/agent-operating-contract-store";
import { createPrismaClient } from "./prisma-client";

function parseArgs() {
  return {
    dryRun: process.argv.includes("--dry-run"),
  };
}

async function main() {
  const { dryRun } = parseArgs();
  const prisma = createPrismaClient();

  try {
    const registry = await readAdminAgentRegistry();
    const current = await readAdminAgentRegistryWithContracts(prisma);

    console.log(
      `[agent-contract-import] registry=${registry.agents.length} currentDb=${current.contractSourceSummary.db} currentRegistryFallback=${current.contractSourceSummary.registry}`,
    );

    if (dryRun) {
      for (const agent of registry.agents) {
        const currentAgent = current.agents.find((item) => item.agentId === agent.agentId);
        const source =
          currentAgent && "contractSource" in currentAgent && typeof currentAgent.contractSource === "string"
            ? currentAgent.contractSource
            : "registry";
        console.log(`[agent-contract-import] DRY ${agent.agentId} source=${source} status=${agent.status ?? "active"}`);
      }
      console.log("[agent-contract-import] dry-run complete; no DB writes performed.");
      return;
    }

    const imported = await importRegistryContractsToDb(prisma, {
      actorType: "system",
      actorId: "agent_contract_import",
      actorName: "Agent Contract Import",
      source: "registry_import",
    });
    console.log(`[agent-contract-import] imported=${imported.length} agents=${imported.join(", ")}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
