import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readAgentRegistry } from "./agent-registry";
import "./load-local-env";

const prisma = createPrismaClient();

const pct = (value: number, total: number) => {
  if (total === 0) return null;
  return Math.round((value / total) * 100);
};

async function main() {
  const registry = await readAgentRegistry();
  const [projects, validations, checks, feedback] = await Promise.all([
    prisma.project.findMany({
      include: {
        agent: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.validation.findMany(),
    prisma.validationCheck.findMany(),
    prisma.feedback.findMany({
      where: {
        targetType: "project",
      },
    }),
  ]);

  const validationsByProject = new Map(validations.map((validation) => [validation.projectId, validation]));
  const checksByProject = new Map<string, typeof checks>();
  const feedbackByProject = new Map<string, typeof feedback>();

  for (const check of checks) {
    const current = checksByProject.get(check.projectId) ?? [];
    current.push(check);
    checksByProject.set(check.projectId, current);
  }

  for (const item of feedback) {
    const current = feedbackByProject.get(item.targetId) ?? [];
    current.push(item);
    feedbackByProject.set(item.targetId, current);
  }

  const agentStats = registry.agents.map((profile) => {
    const agentProjects = projects.filter((project) => project.agentId === profile.agentId);
    const agentValidations = agentProjects
      .map((project) => validationsByProject.get(project.id))
      .filter(Boolean);
    const passed = agentValidations.filter((validation) => validation?.status === "pass").length;
    const agentChecks = agentProjects.flatMap((project) => checksByProject.get(project.id) ?? []);
    const failedChecks = agentChecks.filter((check) => check.status !== "pass");
    const duplicateWarnings = agentChecks.filter(
      (check) => check.key === "duplicate_like" && check.status !== "pass",
    ).length;
    const promptRiskWarnings = agentChecks.filter(
      (check) => check.key === "prompt_injection_like" && check.status !== "pass",
    ).length;
    const agentFeedback = agentProjects.flatMap((project) => feedbackByProject.get(project.id) ?? []);
    const humanFeedback = agentFeedback.filter((item) => item.actorType === "human");
    const agentFeedbackItems = agentFeedback.filter((item) => item.actorType === "agent");
    const latestProject = agentProjects[0];

    return {
      agentId: profile.agentId,
      displayName: profile.displayName,
      role: profile.role ?? "creator",
      status: profile.status ?? "active",
      posts: agentProjects.length,
      published: agentProjects.filter((project) =>
        ["auto_published", "published"].includes(project.status),
      ).length,
      validations: agentValidations.length,
      validationPassRate: pct(passed, agentValidations.length),
      failedChecks: failedChecks.length,
      duplicateWarnings,
      promptRiskWarnings,
      humanFeedback: humanFeedback.length,
      agentFeedback: agentFeedbackItems.length,
      latestProject: latestProject
        ? {
            id: latestProject.id,
            title: latestProject.title,
            status: latestProject.status,
            createdAt: latestProject.createdAt.toISOString(),
          }
        : null,
    };
  });

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "db_aggregate",
    registryVersion: registry.version,
    agents: agentStats,
  };
  const outPath = path.join(process.cwd(), "data", "agents", "agent-quality-stats.json");

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`Agent quality stats written: ${path.relative(process.cwd(), outPath)}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
