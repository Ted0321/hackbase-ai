import "./load-local-env";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "./prisma-client";

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    projectId: typeof values.get("project") === "string" ? String(values.get("project")) : "",
    reason:
      typeof values.get("reason") === "string"
        ? String(values.get("reason"))
        : "Human operator approved this ops-review project for the public feed.",
    write: values.get("write") === true,
    dryRun: values.get("dry-run") === true,
  };
};

async function main() {
  const args = parseArgs();
  if (args.write && args.dryRun) {
    console.error("Use either --write or --dry-run, not both.");
    process.exit(1);
  }
  if (!args.projectId) {
    console.error("Usage: tsx scripts/approve-project-for-feed.ts --project <project-id> [--reason <text>] [--dry-run | --write]");
    process.exit(1);
  }

  const prisma = createPrismaClient();
  try {
    const project = await prisma.project.findUnique({
      where: { id: args.projectId },
      select: {
        id: true,
        agentId: true,
        runId: true,
        title: true,
        status: true,
        publishDecision: true,
        approvalRequired: true,
        publishedAt: true,
      },
    });

    if (!project) {
      console.error(`Project not found: ${args.projectId}`);
      process.exit(1);
    }

    console.log("Approve Project For Feed");
    console.log(`Mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
    console.log(`Project: ${project.id}`);
    console.log(`Before: status=${project.status}, decision=${project.publishDecision}, approvalRequired=${project.approvalRequired}, publishedAt=${project.publishedAt?.toISOString() ?? "(none)"}`);

    if (!args.write) {
      console.log("Dry run: would set status=published, publishDecision=human_approved, approvalRequired=false, and publishedAt=now.");
      return;
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: {
          status: "published",
          approvalRequired: false,
          approvedByType: "human",
          approvedById: "human_operator",
          approvedByName: "Human Operator",
          approvedAt: now,
          publishedByType: "human",
          publishedById: "human_operator",
          publishedByName: "Human Operator",
          publishedAt: now,
          publishDecision: "human_approved",
          publishDecisionReason: args.reason,
        },
      }),
      prisma.runEvent.create({
        data: {
          id: randomUUID(),
          runId: project.runId,
          projectId: project.id,
          agentId: project.agentId,
          type: "approved",
          actorType: "human",
          actorId: "human_operator",
          actorName: "Human Operator",
          summary: `${project.title} was approved by a human operator for the public feed.`,
          metadataJson: JSON.stringify({
            publishDecision: "human_approved",
            reason: args.reason,
            previousStatus: project.status,
            previousPublishDecision: project.publishDecision,
          }),
        },
      }),
    ]);

    const publishedProjectCount = await prisma.project.count({
      where: { runId: project.runId, status: { in: ["auto_published", "published"] } },
    });
    await prisma.run.update({
      where: { id: project.runId },
      data: { publishedProjectCount },
    });

    console.log(`Updated: status=published, publishDecision=human_approved, publishedProjectCount=${publishedProjectCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
