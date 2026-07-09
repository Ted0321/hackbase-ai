import "./load-local-env";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "./prisma-client";
import { deleteStoredArtifactTree } from "../src/lib/artifact-store";
import { publicProjectWhere } from "../src/lib/project-visibility";

/**
 * Withdraw a published Project from the public feed (ops / human-triggered).
 *
 * Public feed/detail/demo/source/agent pages gate on Project visibility, so
 * setting status/publishDecision to "withdrawn" removes the project from public
 * surfaces while preserving DB rows and artifact files for admin/ops review.
 *
 * Dry-run is the default. `--write` requires `--confirm` (destructive prod write).
 * Mirrors the conventions in publish-llm-pipeline-artifact.ts.
 *
 * Usage:
 *   tsx scripts/withdraw-artifact.ts --project <id> --reason "<text>"            # dry-run
 *   tsx scripts/withdraw-artifact.ts --project <id> --reason "<text>" --write --confirm
 *   tsx scripts/withdraw-artifact.ts --project <id> --reason "<text>" --write --confirm --purge-artifacts
 */

const prisma = createPrismaClient();

const WITHDRAWN = "withdrawn";

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--write") {
      values.set("write", true);
    } else if (item === "--confirm") {
      values.set("confirm", true);
    } else if (item === "--purge-artifacts") {
      values.set("purge-artifacts", true);
    } else if (item === "--dry-run") {
      values.set("dry-run", true);
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

  const projectId = values.get("project") as string | undefined;
  const reason = typeof values.get("reason") === "string" ? (values.get("reason") as string) : "";
  const write = values.get("write") === true;
  const confirm = values.get("confirm") === true;
  const purgeArtifacts = values.get("purge-artifacts") === true;
  const dryRun = !write; // dry-run is the default unless --write is passed

  return { projectId, reason, write, confirm, purgeArtifacts, dryRun };
};

async function main() {
  const args = parseArgs();

  if (!args.projectId) {
    console.error(
      'Usage: tsx scripts/withdraw-artifact.ts --project <id> --reason "<text>" [--write --confirm] [--purge-artifacts]',
    );
    process.exit(1);
  }

  const project = await prisma.project.findUnique({ where: { id: args.projectId } });
  if (!project) {
    console.error(`Project not found: ${args.projectId}`);
    process.exit(1);
  }

  console.log("=== withdraw-artifact ===");
  console.log(`  mode:            ${args.dryRun ? "DRY-RUN (no writes)" : "WRITE"}`);
  console.log(`  project:         ${project.id}`);
  console.log(`  title:           ${project.title}`);
  console.log(`  current status:  ${project.status}`);
  console.log(`  publishDecision: ${project.publishDecision}`);
  console.log(`  publishedAt:     ${project.publishedAt ? project.publishedAt.toISOString() : "(none)"}`);
  console.log(`  featured:        ${project.featured}`);
  console.log(`  artifactRoot:    ${project.artifactRoot}`);
  console.log(`  purgeArtifacts:  ${args.purgeArtifacts}`);
  console.log(`  reason:          ${args.reason || "(none)"}`);

  if (project.status === WITHDRAWN) {
    console.log(`\nProject ${project.id} is already withdrawn. Nothing to do.`);
    return;
  }

  if (!args.reason) {
    console.error('\nRefusing to withdraw without --reason "<text>" (audit trail).');
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(
      "\nDry run: would set status=withdrawn, publishDecision=withdrawn, featured=false, and record a RunEvent.",
    );
    console.log(
      `Dry run: would recount Run.publishedProjectCount for run ${project.runId} from public projects.`,
    );
    if (args.purgeArtifacts) {
      console.log(`Dry run: would delete artifact tree at ${project.artifactRoot} from FS + GCS.`);
    } else {
      console.log(
        "Note: without --purge-artifacts the project leaves public surfaces, but artifact files remain stored for admin/ops review.",
      );
    }
    console.log("\nRe-run with --write --confirm to apply.");
    return;
  }

  if (!args.confirm) {
    console.error("\n--write requires --confirm to proceed with a production withdrawal.");
    process.exit(1);
  }

  // Apply: remove from the public feed.
  await prisma.project.update({
    where: { id: project.id },
    data: {
      status: WITHDRAWN,
      publishDecision: WITHDRAWN,
      publishDecisionReason: args.reason,
      featured: false,
    },
  });
  console.log(`\nUpdated Project ${project.id}: status -> withdrawn (removed from public feed).`);

  // Audit trail (same RunEvent convention as publish-llm-pipeline-artifact.ts).
  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId: project.runId,
      projectId: project.id,
      agentId: project.agentId,
      type: "withdrawn",
      actorType: "human",
      actorId: "ops",
      actorName: "Ops (withdraw-artifact)",
      summary: `Withdrew ${project.title} (${project.id}) from the public feed. reason=${args.reason}`,
      metadataJson: JSON.stringify({
        reason: args.reason,
        previousStatus: project.status,
        previousPublishDecision: project.publishDecision,
        purgeArtifacts: args.purgeArtifacts,
        artifactRoot: project.artifactRoot,
      }),
    },
  });
  console.log("Recorded RunEvent(type=withdrawn) for audit.");

  // Run.publishedProjectCount を実テーブルから再集計（withdraw後に過大なままになるのを防ぐ）。
  const publishedProjectCount = await prisma.project.count({
    where: { runId: project.runId, ...publicProjectWhere },
  });
  await prisma.run.update({
    where: { id: project.runId },
    data: { publishedProjectCount },
  });
  console.log(
    `Recounted Run ${project.runId}: publishedProjectCount -> ${publishedProjectCount}.`,
  );

  if (args.purgeArtifacts) {
    const result = await deleteStoredArtifactTree(project.artifactRoot);
    console.log(
      `Purged artifact tree at ${project.artifactRoot} (fs=${result.fsDeleted}, gcs=${result.gcsDeleted}). Direct demo/source URLs now 404.`,
    );
  } else {
    console.log(
      "Note: artifact files kept. Public routes are gated by withdrawn status; admin/ops can still review stored artifacts.",
    );
  }

  console.log("\nDone.");
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
