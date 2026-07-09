import { prisma } from "../src/lib/db";
import { readConsoleSummary } from "../src/lib/console-summary";

const check = (condition: boolean, label: string, detail: string) => {
  if (!condition) {
    throw new Error(`${label}: ${detail}`);
  }
  console.log(`PASS ${label}: ${detail}`);
};

async function main() {
  const summary = await readConsoleSummary(prisma);

  check(Boolean(summary.generatedAt), "Generated timestamp", summary.generatedAt.toISOString());
  check(
    ["healthy", "warning", "critical"].includes(summary.overall.status),
    "Overall status",
    summary.overall.status,
  );
  check(summary.overall.actionCount === summary.actionQueue.length, "Action queue count", String(summary.actionQueue.length));
  check(Boolean(summary.links.incidents && summary.links.runs && summary.links.quality), "Console links", "required links present");
  check(summary.runs.totalCount >= 0, "Run total count", String(summary.runs.totalCount));
  check(
    summary.projects.totalActiveCount >= summary.projects.attentionCount,
    "Project rollup",
    `${summary.projects.attentionCount}/${summary.projects.totalActiveCount}`,
  );
  check(
    summary.projects.displayedCount <= summary.projects.totalActiveCount,
    "Project display window",
    `${summary.projects.displayedCount}/${summary.projects.totalActiveCount}`,
  );
  check(
    summary.projects.activityLast24hCount ===
      summary.projects.createdLast24hCount + summary.projects.updatedOnlyLast24hCount,
    "Project 24h activity split",
    `${summary.projects.createdLast24hCount}+${summary.projects.updatedOnlyLast24hCount}=${summary.projects.activityLast24hCount}`,
  );
  check(summary.agents.totalCount >= summary.agents.activeCount, "Agent rollup", `${summary.agents.activeCount}/${summary.agents.totalCount}`);
  check(summary.agents.activeCreatorCount24h >= 0, "Active creator rollup", String(summary.agents.activeCreatorCount24h));
  check(
    summary.usage.todayRequestCount >= 0 && summary.usage.sevenDayRequestCount >= summary.usage.todayRequestCount,
    "Usage request counts",
    `${summary.usage.todayRequestCount}/${summary.usage.sevenDayRequestCount}`,
  );
  check(typeof summary.usage.critical === "boolean", "Usage critical flag", String(summary.usage.critical));
  check(
    "researchCache" in summary.scheduler &&
      "agentCreation" in summary.scheduler &&
      "agentInteractions" in summary.scheduler &&
      "steward" in summary.scheduler,
    "Scheduler lanes",
    "researchCache / agentCreation / agentInteractions / steward",
  );
  check(summary.observability.readyTableCount >= 0, "Observability rollup", `${summary.observability.readyTableCount} ready table(s)`);

  console.log(
    `Console summary check complete: status=${summary.overall.status}, actions=${summary.actionQueue.length}, patrol=${summary.patrol.latestReportId ?? "none"}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
