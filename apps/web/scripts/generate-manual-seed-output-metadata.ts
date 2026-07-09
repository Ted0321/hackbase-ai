import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";
import { createPrismaClient } from "./prisma-client";
import { getStaticArtifactMetadata } from "../src/project-artifacts/static-source";
import "./load-local-env";

type ManualSeedOutputMetadata = {
  projectId: string;
  agentId?: string;
  title?: string;
  oneLiner?: string;
  categoryId?: string;
  categoryName?: string;
  status?: string;
  validationStatus?: string | null;
  artifactRoot?: string;
  artifactShape?: string;
  templatePatternId?: string;
  surfacePattern?: string;
  aiMechanismPattern?: string;
  metadataSources?: string[];
};

const outPath = () => path.join(process.cwd(), "data", "agents", "manual-seed-output-metadata.json");

const prisma = createPrismaClient();

async function main() {
  const projects = await prisma.project.findMany({
    include: {
      category: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  const manualSeedProjects: ManualSeedOutputMetadata[] = [];
  for (const project of projects) {
    const staticMetadata = getStaticArtifactMetadata(project.id);
    if (!staticMetadata) continue;

    manualSeedProjects.push({
      projectId: project.id,
      agentId: project.agentId,
      title: staticMetadata.label || project.title,
      oneLiner: project.oneLiner,
      categoryId: project.categoryId,
      categoryName: project.category?.name,
      status: project.status,
      validationStatus: project.validationStatus,
      artifactRoot: project.artifactRoot,
      artifactShape: staticMetadata.artifactShape,
      templatePatternId: staticMetadata.templatePatternId,
      surfacePattern: staticMetadata.surfacePattern,
      aiMechanismPattern: staticMetadata.aiMechanismPattern,
      metadataSources: ["db.project", "src/project-artifacts/static-source.ts"],
    });
  }

  const snapshot = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    source: "db.project + static artifact metadata",
    projects: manualSeedProjects,
  };

  const textIssues = findMojibakeLikeTextIssues(snapshot, { maxIssues: 10 });
  if (textIssues.length > 0) {
    throw new Error(
      `Manual seed output metadata text quality validation failed: ${textIssues
        .map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`)
        .join("; ")}`,
    );
  }

  const filePath = outPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    `Manual seed output metadata written: ${path.relative(process.cwd(), filePath)} (projects: ${manualSeedProjects.length})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
