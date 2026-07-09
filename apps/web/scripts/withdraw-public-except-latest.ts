import "./load-local-env";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "./prisma-client";
import { publicProjectWhere, WITHDRAWN_PROJECT_DECISION } from "../src/lib/project-visibility";

const prisma = createPrismaClient();

const WITHDRAWN = WITHDRAWN_PROJECT_DECISION;
const DEFAULT_KEEP_IDS = ["proj_llm_artifact_manual_agent_a_quality_20260702"];

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--write") {
      values.set("write", true);
    } else if (item === "--confirm") {
      values.set("confirm", true);
    } else if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(key, next);
        index += 1;
      } else {
        values.set(key, true);
      }
    }
  }

  const keep = Number(values.get("keep") ?? 2);
  const reason =
    typeof values.get("reason") === "string"
      ? (values.get("reason") as string)
      : "ops withdraw: keep latest public projects only";
  const requiredKeepIds =
    typeof values.get("required-keep") === "string"
      ? (values.get("required-keep") as string).trim().toLowerCase() === "none"
        ? []
        : (values.get("required-keep") as string)
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
      : DEFAULT_KEEP_IDS;

  return {
    keep,
    reason,
    requiredKeepIds,
    write: values.get("write") === true,
    confirm: values.get("confirm") === true,
  };
};

async function main() {
  const args = parseArgs();

  if (!Number.isInteger(args.keep) || args.keep < 0) {
    throw new Error("--keep must be a non-negative integer.");
  }

  if (args.write && !args.confirm) {
    throw new Error("--write requires --confirm.");
  }

  const publicProjects = await prisma.project.findMany({
    where: publicProjectWhere,
    select: {
      id: true,
      title: true,
      runId: true,
      agentId: true,
      status: true,
      publishDecision: true,
      createdAt: true,
      publishedAt: true,
      featured: true,
    },
    orderBy: [{ createdAt: "desc" }, { publishedAt: "desc" }, { id: "asc" }],
  });

  const keepProjects = publicProjects.slice(0, args.keep);
  const keepIds = new Set(keepProjects.map((project) => project.id));
  for (const requiredId of args.requiredKeepIds) {
    if (keepIds.has(requiredId)) {
      continue;
    }

    const requiredProject = publicProjects.find((project) => project.id === requiredId);
    if (!requiredProject) {
      throw new Error(`Required keep project is not currently public: ${requiredId}`);
    }

    const replaceIndex = keepProjects.findIndex((project) => !args.requiredKeepIds.includes(project.id));
    if (replaceIndex < 0) {
      throw new Error(`Cannot keep required project within keep=${args.keep}: ${requiredId}`);
    }

    const replacedProject = keepProjects[replaceIndex];
    keepIds.delete(replacedProject.id);
    keepProjects[replaceIndex] = requiredProject;
    keepIds.add(requiredProject.id);
  }

  const withdrawTargets = publicProjects.filter((project) => !keepIds.has(project.id));

  console.log("=== withdraw-public-except-latest ===");
  console.log(`mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`publicProjects: ${publicProjects.length}`);
  console.log(`keep: ${args.keep}`);
  console.log(`reason: ${args.reason}`);
  console.log("keepProjects:");
  for (const project of keepProjects) {
    console.log(`  KEEP ${project.createdAt.toISOString()} ${project.id} ${project.title}`);
  }
  console.log("withdrawTargets:");
  for (const project of withdrawTargets) {
    console.log(`  WITHDRAW ${project.createdAt.toISOString()} ${project.id} ${project.title}`);
  }

  if (!args.write) {
    console.log("Dry run only. Re-run with --write --confirm to apply.");
    return;
  }

  for (const project of withdrawTargets) {
    await prisma.project.update({
      where: { id: project.id },
      data: {
        status: WITHDRAWN,
        publishDecision: WITHDRAWN,
        publishDecisionReason: args.reason,
        featured: false,
      },
    });

    await prisma.runEvent.create({
      data: {
        id: randomUUID(),
        runId: project.runId,
        projectId: project.id,
        agentId: project.agentId,
        type: "withdrawn",
        actorType: "human",
        actorId: "ops",
        actorName: "Ops (withdraw-public-except-latest)",
        summary: `Withdrew ${project.title} (${project.id}) from public surfaces. reason=${args.reason}`,
        metadataJson: JSON.stringify({
          reason: args.reason,
          previousStatus: project.status,
          previousPublishDecision: project.publishDecision,
          keep: args.keep,
          keptProjectIds: [...keepIds],
        }),
      },
    });
  }

  // 対象runごとにRun.publishedProjectCountを実テーブルから再集計（withdraw後に過大なままになるのを防ぐ）。
  const affectedRunIds = [...new Set(withdrawTargets.map((project) => project.runId))];
  for (const runId of affectedRunIds) {
    const publishedProjectCount = await prisma.project.count({
      where: { runId, ...publicProjectWhere },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { publishedProjectCount },
    });
    console.log(`Recounted Run ${runId}: publishedProjectCount -> ${publishedProjectCount}`);
  }

  console.log(`Withdrawn projects: ${withdrawTargets.length}`);
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
