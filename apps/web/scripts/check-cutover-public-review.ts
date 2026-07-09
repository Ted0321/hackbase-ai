import { createPrismaClient, databaseUrl, missingTables } from "./prisma-client";
import "./load-local-env";

const prisma = createPrismaClient();

const DEFAULT_PROJECT_ID = "proj_llm_artifact_manual_agent_a_quality_20260702_rewritt";
const requiredTables = [
  "Project",
  "Run",
  "Artifact",
  "Validation",
  "ValidationCheck",
  "RunEvent",
  "Incident",
  "ModelUsageLog",
];

const argValue = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const jsonMode = process.argv.includes("--json");
const projectId = argValue("--project") ?? DEFAULT_PROJECT_ID;
const topLimit = Number(argValue("--top") ?? 5);

type Check = {
  id: string;
  status: "pass" | "fail" | "warn";
  message: string;
};

const isSeedLike = (id: string) =>
  id.startsWith("proj_seed_") || id.includes("_seed") || id === "proj_g_github_mission_maker";

const isSeedLikeProject = (project: { id: string; runId: string }) =>
  isSeedLike(project.id) || project.runId.includes("_seed") || project.runId === "run_20260624_seed";

const byCurrentFeedPriority = <T extends { id: string; runId: string; featured: boolean; publishedAt: Date | null }>(
  a: T,
  b: T,
) => {
  const seedRank = Number(isSeedLikeProject(a)) - Number(isSeedLikeProject(b));
  if (seedRank !== 0) return seedRank;
  if (a.featured !== b.featured) return Number(b.featured) - Number(a.featured);
  return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
};

const asIso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

const checks: Check[] = [];

const check = (id: string, ok: boolean, pass: string, fail: string) => {
  checks.push({ id, status: ok ? "pass" : "fail", message: ok ? pass : fail });
};

const warn = (id: string, message: string) => {
  checks.push({ id, status: "warn", message });
};

async function main() {
  const missing = await missingTables(prisma, requiredTables);
  if (missing.length > 0) {
    const result = {
      result: "fail",
      databaseUrl: databaseUrl(),
      checks: [
        {
          id: "required_tables",
          status: "fail",
          message: `Missing required table(s): ${missing.join(", ")}`,
        },
      ],
    };
    console.log(jsonMode ? JSON.stringify(result, null, 2) : `FAIL required_tables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const [target, feedProjects, validations, validationFailures, artifacts, runEvents, openIncidents] =
    await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          status: true,
          publishDecision: true,
          validationStatus: true,
          featured: true,
          publishedAt: true,
          runId: true,
        },
      }),
      prisma.project.findMany({
        where: { status: { in: ["auto_published", "published"] } },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          title: true,
          status: true,
          publishDecision: true,
          validationStatus: true,
          featured: true,
          publishedAt: true,
          runId: true,
        },
      }),
      prisma.validation.findMany({
        where: { projectId },
        orderBy: { checkedAt: "desc" },
        select: { id: true, status: true, checkedAt: true },
      }),
      prisma.validationCheck.findMany({
        where: { projectId, status: { not: "pass" } },
        orderBy: { createdAt: "desc" },
        select: { key: true, status: true, summary: true },
      }),
      prisma.artifact.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, path: true },
      }),
      prisma.runEvent.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, type: true, summary: true, createdAt: true },
      }),
      prisma.incident.findMany({
        where: { projectId, status: { in: ["open", "acknowledged"] } },
        orderBy: [{ priority: "asc" }, { lastSeenAt: "desc" }],
        select: { id: true, severity: true, priority: true, title: true, status: true },
      }),
    ]);

  check(
    "target_project",
    Boolean(target),
    `Target project exists: ${projectId}`,
    `Target project not found: ${projectId}`,
  );

  if (!target) {
    const result = { result: "fail", databaseUrl: databaseUrl(), checks };
    console.log(jsonMode ? JSON.stringify(result, null, 2) : checks.map((item) => `${item.status.toUpperCase()} ${item.id}: ${item.message}`).join("\n"));
    process.exit(1);
  }

  const sortedFeedProjects = feedProjects.sort(byCurrentFeedPriority).slice(0, Math.max(1, topLimit));
  const sortedTargetIndex = sortedFeedProjects.findIndex((project) => project.id === projectId);
  const firstSeedIndex = sortedFeedProjects.findIndex((project) => isSeedLikeProject(project));
  const seedBeforeTarget = firstSeedIndex >= 0 && (sortedTargetIndex < 0 || firstSeedIndex < sortedTargetIndex);
  const latestValidation = validations[0];
  const artifactTypes = new Set(artifacts.map((artifact) => artifact.type));
  const hasPublishEvent = runEvents.some((event) => event.type === "published" || event.type === "auto_published");
  const usageRows = await prisma.modelUsageLog.findMany({
    where: { runId: target.runId },
    select: { id: true, totalTokens: true, estimatedCostUsd: true },
  });
  const usageCost = usageRows.reduce((sum, row) => sum + Number(row.estimatedCostUsd ?? 0), 0);

  check(
    "feed_visible",
    sortedTargetIndex >= 0,
    `Target appears in public feed top ${sortedFeedProjects.length} at position ${sortedTargetIndex + 1}`,
    `Target does not appear in public feed top ${sortedFeedProjects.length}`,
  );
  check(
    "feed_not_seed_first",
    !seedBeforeTarget,
    "No seed/demo project is prioritized above the target in the sampled feed",
    `Seed/demo project appears before target: ${sortedFeedProjects[firstSeedIndex]?.id}`,
  );
  check(
    "publish_status",
    ["auto_published", "published"].includes(target.status),
    `Target status is public: ${target.status}`,
    `Target status is not public: ${target.status}`,
  );
  check(
    "validation_status",
    target.validationStatus === "pass" && latestValidation?.status === "pass",
    `Target validation passes: project=${target.validationStatus}, latest=${latestValidation?.status}`,
    `Target validation is not pass: project=${target.validationStatus}, latest=${latestValidation?.status ?? "missing"}`,
  );
  check(
    "validation_failures",
    validationFailures.length === 0,
    "No non-pass validation checks for target project",
    `${validationFailures.length} non-pass validation check(s): ${validationFailures.map((item) => `${item.key}=${item.status}`).join(", ")}`,
  );
  check(
    "artifact_coverage",
    artifacts.length > 0 && artifactTypes.has("source"),
    `Target has ${artifacts.length} artifact(s), including source`,
    `Target artifact coverage is incomplete: ${[...artifactTypes].join(", ") || "none"}`,
  );
  check(
    "run_event_trace",
    runEvents.length > 0 && hasPublishEvent,
    `Target has ${runEvents.length} run event(s), including publish event`,
    `Target run events are incomplete: ${runEvents.map((event) => event.type).join(", ") || "none"}`,
  );
  check(
    "open_incidents",
    openIncidents.length === 0,
    "No open or acknowledged incidents for target project",
    `${openIncidents.length} incident(s): ${openIncidents.map((item) => `${item.priority}/${item.severity}:${item.title}`).join(", ")}`,
  );
  if (usageRows.length === 0) {
    warn("usage_rows", "No ModelUsageLog rows found for the target run; treat cost anomaly check as not applicable for this local DB.");
  } else {
    check(
      "usage_cost",
      usageCost <= 10,
      `Target run usage cost is within local daily cap: $${usageCost.toFixed(4)}`,
      `Target run usage cost exceeds local daily cap: $${usageCost.toFixed(4)}`,
    );
  }

  const result = {
    result: checks.some((item) => item.status === "fail") ? "fail" : "pass",
    databaseUrl: databaseUrl(),
    project: {
      ...target,
      publishedAt: asIso(target.publishedAt),
      latestValidationAt: asIso(latestValidation?.checkedAt),
    },
    feedTop: sortedFeedProjects.map((project, index) => ({
      position: index + 1,
      id: project.id,
      title: project.title,
      seedLike: isSeedLikeProject(project),
      featured: project.featured,
      publishedAt: asIso(project.publishedAt),
    })),
    artifacts: artifacts.map((artifact) => ({ type: artifact.type, path: artifact.path })),
    openIncidents,
    checks,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Cutover public feed / Human Console review check");
    console.log(`databaseUrl: ${result.databaseUrl}`);
    console.log(`target: ${target.id} | ${target.title}`);
    console.log(`feedTop: ${result.feedTop.map((item) => `${item.position}:${item.id}`).join(", ")}`);
    for (const item of checks) {
      console.log(`${item.status.toUpperCase()} ${item.id}: ${item.message}`);
    }
    console.log(`Result: ${result.result.toUpperCase()}`);
  }

  if (result.result !== "pass") process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
