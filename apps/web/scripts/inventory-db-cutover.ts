import { createPrismaClient, databaseUrl, missingTables } from "./prisma-client";
import "./load-local-env";

const prisma = createPrismaClient();

type ProjectCandidate = {
  id: string;
  title: string;
  runId: string;
  status: string;
  publishDecision: string;
  validationStatus: string | null;
  featured: boolean;
  publishedAt: string | null;
  artifactRoot: string;
  recommendation: "keep_evidence" | "deprioritize_seed" | "candidate_current_feed";
  reasons: string[];
};

const requiredTables = [
  "Project",
  "Run",
  "Artifact",
  "Validation",
  "ValidationCheck",
  "Feedback",
  "RunEvent",
];

const hasFlag = (flag: string) => process.argv.includes(flag);

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

const includesAny = (value: string, needles: string[]) => {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
};

const classifyProject = (project: {
  id: string;
  title: string;
  runId: string;
  status: string;
  publishDecision: string;
  validationStatus: string | null;
  featured: boolean;
  publishedAt: Date | null;
  artifactRoot: string;
}): ProjectCandidate => {
  const text = [
    project.id,
    project.title,
    project.runId,
    project.status,
    project.publishDecision,
    project.validationStatus ?? "",
    project.artifactRoot,
  ].join(" ");
  const reasons: string[] = [];

  if (includesAny(text, ["seed", "dummy", "demo", "manual_202606", "proj_g_github_mission_maker"])) {
    reasons.push("seed/demo/manual marker");
  }
  if (project.featured) reasons.push("featured fallback evidence");
  if (project.publishedAt) reasons.push("published");
  if (project.publishDecision === "approved" || project.status === "auto_published") {
    reasons.push("publish-approved/current-feed status");
  }
  if (project.validationStatus && project.validationStatus !== "pass") {
    reasons.push(`validation=${project.validationStatus}`);
  }

  let recommendation: ProjectCandidate["recommendation"] = "keep_evidence";
  if (reasons.some((reason) => reason.includes("seed/demo/manual"))) {
    recommendation = project.featured ? "keep_evidence" : "deprioritize_seed";
  } else if (
    project.validationStatus === "pass" &&
    (project.status === "auto_published" || project.publishDecision === "approved")
  ) {
    recommendation = "candidate_current_feed";
  }

  return {
    id: project.id,
    title: project.title,
    runId: project.runId,
    status: project.status,
    publishDecision: project.publishDecision,
    validationStatus: project.validationStatus,
    featured: project.featured,
    publishedAt: iso(project.publishedAt),
    artifactRoot: project.artifactRoot,
    recommendation,
    reasons,
  };
};

async function main() {
  const json = hasFlag("--json");
  const url = databaseUrl();
  const missing = await missingTables(prisma, requiredTables);
  if (missing.length > 0) {
    const result = {
      result: "blocked",
      databaseUrl: url,
      missingTables: missing,
      note: "Read-only inventory skipped because required tables are missing.",
    };
    console.log(json ? JSON.stringify(result, null, 2) : `DB cutover inventory blocked: missing ${missing.join(", ")}`);
    return;
  }

  const [
    runCount,
    projectCount,
    artifactCount,
    validationCount,
    validationCheckCount,
    feedbackCount,
    runEventCount,
    projects,
  ] = await Promise.all([
    prisma.run.count(),
    prisma.project.count(),
    prisma.artifact.count(),
    prisma.validation.count(),
    prisma.validationCheck.count(),
    prisma.feedback.count(),
    prisma.runEvent.count(),
    prisma.project.findMany({
      orderBy: [{ featured: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        title: true,
        runId: true,
        status: true,
        publishDecision: true,
        validationStatus: true,
        featured: true,
        publishedAt: true,
        artifactRoot: true,
      },
    }),
  ]);

  const candidates = projects.map(classifyProject);
  const byRecommendation = candidates.reduce<Record<ProjectCandidate["recommendation"], ProjectCandidate[]>>(
    (acc, item) => {
      acc[item.recommendation].push(item);
      return acc;
    },
    { keep_evidence: [], deprioritize_seed: [], candidate_current_feed: [] },
  );

  const result = {
    result: "ok",
    mode: "dry-run",
    databaseUrl: url,
    counts: {
      Run: runCount,
      Project: projectCount,
      Artifact: artifactCount,
      Validation: validationCount,
      ValidationCheck: validationCheckCount,
      Feedback: feedbackCount,
      RunEvent: runEventCount,
    },
    recommendations: {
      keepEvidence: byRecommendation.keep_evidence.length,
      deprioritizeSeed: byRecommendation.deprioritize_seed.length,
      candidateCurrentFeed: byRecommendation.candidate_current_feed.length,
    },
    candidates,
    safety:
      "No rows were modified. Use this output to request explicit approval before archive/delete/publish writes.",
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("DB cutover inventory dry-run");
  console.log(`databaseUrl: ${url}`);
  console.log(
    `counts: Run=${runCount}, Project=${projectCount}, Artifact=${artifactCount}, Validation=${validationCount}, ValidationCheck=${validationCheckCount}, Feedback=${feedbackCount}, RunEvent=${runEventCount}`,
  );
  console.log(
    `recommendations: keepEvidence=${result.recommendations.keepEvidence}, deprioritizeSeed=${result.recommendations.deprioritizeSeed}, candidateCurrentFeed=${result.recommendations.candidateCurrentFeed}`,
  );
  for (const [label, items] of Object.entries(byRecommendation)) {
    console.log(`\n[${label}] ${items.length}`);
    for (const item of items.slice(0, 10)) {
      console.log(
        `- ${item.id} | ${item.title} | run=${item.runId} | status=${item.status}/${item.publishDecision} | reasons=${item.reasons.join(", ") || "none"}`,
      );
    }
  }
  console.log("\nNo rows were modified.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
