import { createPrismaClient } from "./prisma-client";

type ContractRow = {
  agentId: string;
  status: string;
  role: string;
  source: string;
  schedulingPolicyJson: string;
};

function parseSchedulingPolicy(raw: string) {
  try {
    return JSON.parse(raw || "{}") as {
      cadence?: unknown;
      enabled?: unknown;
      preferredHours?: unknown;
    };
  } catch {
    return {};
  }
}

async function main() {
  const prisma = createPrismaClient();
  try {
    const rows = await prisma.$queryRaw<ContractRow[]>`
      SELECT "agentId", "status", "role", "source", "schedulingPolicyJson"
      FROM "AgentOperatingContract"
      ORDER BY "agentId" ASC
    `;

    const sourceSummary = new Map<string, number>();
    const activeCreatorRows = rows.filter((row) => row.status === "active" && row.role === "creator");
    const activeCreatorHours = new Map<string, number>();

    for (const row of rows) {
      sourceSummary.set(row.source, (sourceSummary.get(row.source) ?? 0) + 1);
    }

    console.log(`rows=${rows.length}`);
    console.log(`sourceSummary=${JSON.stringify(Object.fromEntries(sourceSummary.entries()))}`);
    console.log("activeCreators:");

    for (const row of activeCreatorRows) {
      const scheduling = parseSchedulingPolicy(row.schedulingPolicyJson);
      const preferredHours = Array.isArray(scheduling.preferredHours) ? scheduling.preferredHours : [];
      for (const hour of preferredHours) {
        if (typeof hour === "number" && Number.isInteger(hour)) {
          activeCreatorHours.set(String(hour), (activeCreatorHours.get(String(hour)) ?? 0) + 1);
        }
      }
      console.log(
        [
          row.agentId,
          `source=${row.source}`,
          `preferredHours=${JSON.stringify(preferredHours)}`,
          `enabled=${String(scheduling.enabled)}`,
          `cadence=${String(scheduling.cadence)}`,
        ].join(" "),
      );
    }

    console.log(`activeCreatorHourSummary=${JSON.stringify(Object.fromEntries(activeCreatorHours.entries()))}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
