import "./load-local-env";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPrismaClient } from "./prisma-client";
import {
  deleteStoredArtifactTree,
  writeStoredArtifactFile,
} from "../src/lib/artifact-store";

/**
 * 公開済み作品の「ソースだけ」を新しく生成した materialized ソースへ in-place で差し替える。
 *
 * 変えないもの（絶対にUPDATEしない）:
 *   - Project の公開コピー列（title/oneLiner/concept/useCase/whatWasTried/howItRuns/nextGrowth）
 *   - Project.status / publishDecision / publishedAt / artifactRoot / thumbnailPath
 *   - mockups/*（サムネ画像: showcase/thumbnail/logo）
 *
 * 変えるもの:
 *   - Artifact 行（type in {source, source_file}）を削除 → 新 source を既存 artifactRoot 配下に登録
 *   - metadata.json / manifest.json / README.md を新版で上書き（DBの当該 Artifact 行があれば checksum/size 更新）
 *   - ファイル本体: <artifactRoot>/source/** を削除 → 新 source/** を書き込み（FS+GCS）
 *   - 監査用 RunEvent(type=source_regenerated) を1件記録
 *
 * dry-run が既定。--write は差し替え前の旧 source バイト + 旧 Artifact 行を --backup-dir に退避する。
 *
 * Usage:
 *   tsx scripts/swap-project-source.ts --project <id> --new-artifact-dir <dir> [--backup-dir <dir>] [--dry-run|--write]
 */

const prisma = createPrismaClient();

const checksum = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const SOURCE_ARTIFACT_TYPES = ["source", "source_file"];
// artifactRoot 直下の固定ファイル。上書き対象（サムネ mockups/* や demo/validation は触らない）。
const FIXED_OVERWRITE_FILES = ["metadata.json", "manifest.json", "README.md"];

// 差し替えても触ってはいけない Project 列（監査表示用）。
const FROZEN_COPY_FIELDS = [
  "title",
  "oneLiner",
  "concept",
  "useCase",
  "whatWasTried",
  "howItRuns",
  "nextGrowth",
] as const;

const mimeTypeForPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".js": "text/javascript",
    ".jsx": "text/jsx",
    ".json": "application/json",
    ".md": "text/markdown",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return map[ext] ?? "application/octet-stream";
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--write") {
      values.set("write", true);
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
  const write = values.get("write") === true;
  return {
    projectId: values.get("project") as string | undefined,
    newArtifactDir: values.get("new-artifact-dir") as string | undefined,
    backupDir: typeof values.get("backup-dir") === "string" ? (values.get("backup-dir") as string) : undefined,
    write,
    dryRun: !write,
  };
};

type MaterializedFile = {
  relativePath: string;
  purpose?: string;
  sizeBytes?: number;
  checksum?: string;
};

async function main() {
  const args = parseArgs();

  if (!args.projectId || !args.newArtifactDir) {
    console.error(
      "Usage: tsx scripts/swap-project-source.ts --project <id> --new-artifact-dir <dir> [--backup-dir <dir>] [--write]",
    );
    process.exit(1);
  }

  // --- [1] Preflight ------------------------------------------------------
  const project = await prisma.project.findUnique({ where: { id: args.projectId } });
  if (!project) {
    console.error(`Project not found: ${args.projectId}`);
    process.exit(1);
  }

  const artifactRoot = project.artifactRoot;
  if (!artifactRoot) {
    console.error(`Project ${project.id} has no artifactRoot; cannot swap source in place.`);
    process.exit(1);
  }

  const isPublished = ["auto_published", "published"].includes(project.status);
  const isWithdrawn = project.publishDecision === "withdrawn" || project.status === "withdrawn";

  console.log("=== swap-project-source ===");
  console.log(`  mode:            ${args.dryRun ? "DRY-RUN (no writes)" : "WRITE"}`);
  console.log(`  project:         ${project.id}`);
  console.log(`  status:          ${project.status}`);
  console.log(`  publishDecision: ${project.publishDecision}`);
  console.log(`  artifactRoot:    ${artifactRoot}`);
  console.log(`  new-artifact-dir:${args.newArtifactDir}`);
  console.log(`  backup-dir:      ${args.backupDir ?? "(none)"}`);
  console.log("\n  --- frozen public copy (NOT modified) ---");
  for (const field of FROZEN_COPY_FIELDS) {
    const value = (project as unknown as Record<string, unknown>)[field];
    const text = typeof value === "string" ? value : value == null ? "(none)" : String(value);
    console.log(`  ${field.padEnd(14)}: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);
  }

  if (!isPublished || isWithdrawn) {
    console.error(
      `\nRefusing to swap: project is not in a published state (status=${project.status}, publishDecision=${project.publishDecision}).`,
    );
    process.exit(1);
  }

  // --- [2] Load new materialized source ----------------------------------
  const newDir = path.resolve(process.cwd(), args.newArtifactDir);
  const newMetadataRaw = await readFile(path.join(newDir, "metadata.json"), "utf8");
  const newMetadata = JSON.parse(newMetadataRaw) as { sourceFiles?: MaterializedFile[] };
  const newSourceFiles = Array.isArray(newMetadata.sourceFiles) ? newMetadata.sourceFiles : [];
  if (newSourceFiles.length === 0) {
    console.error(`\nNew metadata.json lists no sourceFiles; aborting: ${path.join(newDir, "metadata.json")}`);
    process.exit(1);
  }

  // 新 source バイトを読み込む（relativePath は "source/..." 前提）。
  const newSourceContents = new Map<string, string>();
  for (const file of newSourceFiles) {
    const abs = path.join(newDir, file.relativePath);
    const content = await readFile(abs, "utf8");
    newSourceContents.set(file.relativePath, content);
  }

  // 上書きする固定ファイル（存在するものだけ）。
  const fixedFileContents = new Map<string, string>();
  for (const rel of FIXED_OVERWRITE_FILES) {
    try {
      fixedFileContents.set(rel, await readFile(path.join(newDir, rel), "utf8"));
    } catch {
      // manifest/README が無いケースは許容（metadata.json は上で必須読み込み済み）。
    }
  }

  // --- Existing source Artifact rows -------------------------------------
  const existingSourceRows = await prisma.artifact.findMany({
    where: { projectId: project.id, type: { in: SOURCE_ARTIFACT_TYPES } },
  });
  const existingFixedRows = await prisma.artifact.findMany({
    where: {
      projectId: project.id,
      path: { in: FIXED_OVERWRITE_FILES.map((rel) => `${artifactRoot}/${rel}`) },
    },
  });

  // 新 source 行のアクター属性は既存 source 行から引き継ぐ（作者=エージェントを保持）。
  const actor = existingSourceRows[0] ?? null;
  const createdByType = actor?.createdByType ?? "agent";
  const createdById = actor?.createdById ?? project.agentId;
  const createdByName = actor?.createdByName ?? project.agentId;

  console.log("\n  --- planned mutations ---");
  console.log(`  delete Artifact rows (source/source_file): ${existingSourceRows.length}`);
  console.log(`  create Artifact rows (new source):         ${newSourceFiles.length}`);
  for (const file of newSourceFiles) {
    console.log(`    + ${artifactRoot}/${file.relativePath}`);
  }
  console.log(`  overwrite fixed files:                     ${[...fixedFileContents.keys()].join(", ") || "(none)"}`);
  console.log(`  update fixed Artifact rows (checksum/size):${existingFixedRows.length}`);
  console.log("  FS/GCS: deleteStoredArtifactTree(<root>/source) → write new source/** + fixed files");
  console.log("  NOT touched: mockups/*, demo-placeholder.md, validation/*, Project columns, status, publishedAt, artifactRoot");

  if (args.dryRun) {
    console.log("\nDry run: no DB/FS/GCS writes. Re-run with --write to apply.");
    return;
  }

  // --- [3] Backup (write only) -------------------------------------------
  if (args.backupDir) {
    const backupRoot = path.resolve(process.cwd(), args.backupDir);
    await mkdir(path.join(backupRoot, "source"), { recursive: true });
    // 旧 source バイト（既存 Artifact 行の path から読む）。
    const { readStoredArtifactPath } = await import("../src/lib/artifact-store");
    for (const row of existingSourceRows) {
      const content = await readStoredArtifactPath(row.path);
      if (content === null) continue;
      const rel = row.path.startsWith(`${artifactRoot}/`) ? row.path.slice(artifactRoot.length + 1) : path.basename(row.path);
      const dest = path.join(backupRoot, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    // 旧 Artifact 行（source + 固定）を JSON で退避。
    await writeFile(
      path.join(backupRoot, "artifact-rows.json"),
      `${JSON.stringify({ source: existingSourceRows, fixed: existingFixedRows }, null, 2)}\n`,
      "utf8",
    );
    console.log(`\nBackup written to ${path.relative(process.cwd(), backupRoot).replaceAll("\\", "/")}`);
  } else {
    console.warn("\nWARNING: --backup-dir not provided; proceeding without rollback backup.");
  }

  // --- [4] DB transaction -------------------------------------------------
  await prisma.$transaction(async (tx) => {
    await tx.artifact.deleteMany({
      where: { projectId: project.id, type: { in: SOURCE_ARTIFACT_TYPES } },
    });

    for (const file of newSourceFiles) {
      const content = newSourceContents.get(file.relativePath) ?? "";
      await tx.artifact.create({
        data: {
          id: randomUUID(),
          projectId: project.id,
          runId: project.runId,
          type: "source",
          path: `${artifactRoot}/${file.relativePath}`,
          mimeType: mimeTypeForPath(file.relativePath),
          sizeBytes: Buffer.byteLength(content),
          checksum: checksum(content),
          createdByType,
          createdById,
          createdByName,
          validationStatus: "pass",
          metadataJson: JSON.stringify({
            role: "source",
            generatedFrom: file.relativePath,
            regeneratedBy: "swap-project-source",
          }),
        },
      });
    }

    // 固定ファイルの Artifact 行があれば checksum/size を更新（無ければスキップ）。
    for (const row of existingFixedRows) {
      const rel = row.path.startsWith(`${artifactRoot}/`) ? row.path.slice(artifactRoot.length + 1) : "";
      const content = fixedFileContents.get(rel);
      if (content === undefined) continue;
      await tx.artifact.update({
        where: { id: row.id },
        data: { sizeBytes: Buffer.byteLength(content), checksum: checksum(content) },
      });
    }

    await tx.runEvent.create({
      data: {
        id: randomUUID(),
        runId: project.runId,
        projectId: project.id,
        agentId: project.agentId,
        type: "source_regenerated",
        actorType: "human",
        actorId: "ops",
        actorName: "Ops (swap-project-source)",
        summary: `Swapped source in place for ${project.title} (${project.id}) to core-logic-first format. ${newSourceFiles.length} source files.`,
        metadataJson: JSON.stringify({
          artifactRoot,
          newSourceFileCount: newSourceFiles.length,
          removedSourceRowCount: existingSourceRows.length,
          newArtifactDir: args.newArtifactDir,
        }),
      },
    });
  });
  console.log(`\nDB updated: replaced ${existingSourceRows.length} source rows with ${newSourceFiles.length} new rows; recorded RunEvent(source_regenerated).`);

  // --- [5] FS/GCS ---------------------------------------------------------
  const sourceRoot = `${artifactRoot}/source`;
  const del = await deleteStoredArtifactTree(sourceRoot);
  console.log(`Deleted old source tree ${sourceRoot} (fs=${del.fsDeleted}, gcs=${del.gcsDeleted}).`);

  for (const file of newSourceFiles) {
    const content = newSourceContents.get(file.relativePath) ?? "";
    await writeStoredArtifactFile(`${artifactRoot}/${file.relativePath}`, content.endsWith("\n") ? content : `${content}\n`);
  }
  for (const [rel, content] of fixedFileContents) {
    await writeStoredArtifactFile(`${artifactRoot}/${rel}`, content.endsWith("\n") ? content : `${content}\n`);
  }
  console.log(`Wrote ${newSourceFiles.length} new source files + ${fixedFileContents.size} fixed files to ${artifactRoot} (FS+GCS).`);

  console.log("\nDone. Project copy/status/publishedAt/artifactRoot/mockups left untouched.");
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
