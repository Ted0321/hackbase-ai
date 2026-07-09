import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAgentQualityStats, type GeneratedOutputMetadata } from "./agent-similarity";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";
import { createPrismaClient } from "./prisma-client";
import { getStaticArtifactMetadata } from "../src/project-artifacts/static-source";
import "./load-local-env";

type StringRecord = Record<string, unknown>;

type DbProject = {
  id: string;
  agentId: string;
  title: string;
  oneLiner: string;
  categoryId: string;
  category?: {
    name: string;
  } | null;
  status: string;
  validationStatus: string | null;
  artifactRoot: string;
};

type TemplatePattern = {
  id: string;
  artifactShape?: string;
  surfacePattern?: string;
  aiMechanismPattern?: string;
};

type RecentArtifactsFile = {
  recentArtifacts?: Array<{
    projectId: string;
    title?: string;
    artifactShape?: string;
    templatePatternId?: string;
    productPattern?: string;
    surfacePattern?: string;
    aiMechanismPattern?: string;
    summary?: string;
  }>;
};

type ManualSeedOutputMetadataFile = {
  version: 1;
  projects: GeneratedOutputMetadata[];
};

const outPath = () => path.join(process.cwd(), "data", "agents", "generated-output-metadata.json");

const asRecord = (value: unknown): StringRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as StringRecord) : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const firstString = (...values: unknown[]) => values.map(asString).find(Boolean);

const mergeSources = (...sources: Array<string[] | undefined>) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources.flat()) {
    if (!source || seen.has(source)) continue;
    seen.add(source);
    result.push(source);
  }
  return result;
};

const readJsonIfExists = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `Generated output metadata: JSON read skipped for ${path.relative(process.cwd(), filePath)} (${String(error)})`,
      );
    }
    return null;
  }
};

const assertNoTextQualityIssues = (snapshot: unknown) => {
  const issues = findMojibakeLikeTextIssues(snapshot, { maxIssues: 10 });
  if (issues.length === 0) return;

  const summary = issues.map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`).join("; ");
  throw new Error(`Generated output metadata text quality validation failed: ${summary}`);
};

const writeValidatedJson = async (filePath: string, value: unknown) => {
  assertNoTextQualityIssues(value);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(body);
  await writeFile(filePath, body, "utf8");
};

const readProductTemplateMap = async () => {
  const raw = await readJsonIfExists<{ templatePatterns?: TemplatePattern[] }>(
    path.join(process.cwd(), "scripts", "templates", "product-templates.json"),
  );
  return new Map((raw?.templatePatterns ?? []).map((pattern) => [pattern.id, pattern]));
};

const readRecentArtifactMap = async () => {
  const raw = await readJsonIfExists<RecentArtifactsFile>(
    path.join(process.cwd(), "scripts", "llm-pipeline", "fixtures", "recent-artifacts.json"),
  );
  return new Map((raw?.recentArtifacts ?? []).map((artifact) => [artifact.projectId, artifact]));
};

const readManualSeedOutputMetadataMap = async () => {
  const raw = await readJsonIfExists<ManualSeedOutputMetadataFile>(
    path.join(process.cwd(), "data", "agents", "manual-seed-output-metadata.json"),
  );
  return new Map((raw?.projects ?? []).map((project) => [project.projectId, project]));
};

const readDbProjectMap = async () => {
  const prisma = createPrismaClient();
  try {
    const projects = await prisma.project.findMany({
      include: {
        category: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    return new Map(projects.map((project) => [project.id, project as DbProject]));
  } catch (error) {
    console.warn(`Generated output metadata: DB project read skipped (${String(error)})`);
    return new Map<string, DbProject>();
  } finally {
    await prisma.$disconnect();
  }
};

const extractMetadata = (
  raw: unknown,
  templatePatterns: Map<string, TemplatePattern>,
): Partial<GeneratedOutputMetadata> => {
  const record = asRecord(raw);
  if (!record) return {};
  const sourcePlan = asRecord(record.sourcePlan);
  const selfDirectedPlan = asRecord(record.selfDirectedPlan);
  const generatedOutput = asRecord(record.generatedOutput);
  const mvpContractV2 = asRecord(record.mvpContractV2);
  const interactionProofPlan = asRecord(record.interactionProofPlan);
  const templatePatternId = firstString(
    generatedOutput?.templatePatternId,
    record.templatePatternId,
    sourcePlan?.templatePatternId,
    selfDirectedPlan?.templatePatternId,
  );
  const template = templatePatternId ? templatePatterns.get(templatePatternId) : undefined;

  return {
    title: firstString(generatedOutput?.title, record.title),
    oneLiner: firstString(generatedOutput?.oneLiner, record.oneLiner),
    artifactShape: firstString(
      generatedOutput?.artifactShape,
      record.artifactShape,
      record.artifactKind,
      template?.artifactShape,
    ),
    templatePatternId,
    surfacePattern: firstString(generatedOutput?.surfacePattern, record.surfacePattern, template?.surfacePattern),
    aiMechanismPattern: firstString(
      generatedOutput?.aiMechanismPattern,
      record.aiMechanismPattern,
      template?.aiMechanismPattern,
    ),
    mvpContractV2Status: mvpContractV2 ? "present" : undefined,
    mvpContractV2ArtifactTier: firstString(mvpContractV2?.artifactTier),
    externalDependencyMode: firstString(mvpContractV2?.externalDependencyMode),
    interactionProofPrimaryAction: firstString(interactionProofPlan?.primaryAction),
    interactionProofEvidenceCount: Array.isArray(interactionProofPlan?.visibleEvidence)
      ? interactionProofPlan.visibleEvidence.length
      : undefined,
  };
};

const readArtifactMetadata = async (
  artifactRoot: string | undefined,
  templatePatterns: Map<string, TemplatePattern>,
) => {
  if (!artifactRoot) return { metadata: {}, sources: [] as string[] };
  const candidatePaths = [
    path.join(process.cwd(), "artifacts", artifactRoot, "metadata.json"),
    path.join(process.cwd(), "artifacts", artifactRoot, "source", "metadata.json"),
  ];
  const merged: Partial<GeneratedOutputMetadata> = {};
  const sources: string[] = [];

  for (const candidatePath of candidatePaths) {
    const raw = await readJsonIfExists<unknown>(candidatePath);
    if (!raw) continue;
    Object.assign(merged, extractMetadata(raw, templatePatterns));
    sources.push(path.relative(process.cwd(), candidatePath));
  }

  return { metadata: merged, sources };
};

const applyTemplateDefaults = (
  metadata: GeneratedOutputMetadata,
  templatePatterns: Map<string, TemplatePattern>,
): GeneratedOutputMetadata => {
  const template = metadata.templatePatternId ? templatePatterns.get(metadata.templatePatternId) : undefined;
  if (!template) return metadata;
  return {
    ...metadata,
    artifactShape: metadata.artifactShape ?? template.artifactShape,
    surfacePattern: metadata.surfacePattern ?? template.surfacePattern,
    aiMechanismPattern: metadata.aiMechanismPattern ?? template.aiMechanismPattern,
  };
};

async function buildGeneratedOutputMetadata() {
  const [qualityStats, dbProjects, recentArtifacts, manualSeedMetadata, templatePatterns] = await Promise.all([
    readAgentQualityStats(),
    readDbProjectMap(),
    readRecentArtifactMap(),
    readManualSeedOutputMetadataMap(),
    readProductTemplateMap(),
  ]);
  const projects: GeneratedOutputMetadata[] = [];

  for (const stat of qualityStats?.agents ?? []) {
    const latest = stat.latestProject;
    if (!latest) continue;
    const dbProject = dbProjects.get(latest.id);
    const recent = recentArtifacts.get(latest.id);
    const manualSeed = manualSeedMetadata.get(latest.id);
    const staticMetadata = getStaticArtifactMetadata(latest.id);
    const artifact = await readArtifactMetadata(dbProject?.artifactRoot, templatePatterns);
    const artifactMetadata = artifact.metadata;
    const staticOutputMetadata: Partial<GeneratedOutputMetadata> = staticMetadata
      ? {
          title: staticMetadata.label,
          artifactShape: staticMetadata.artifactShape,
          templatePatternId: staticMetadata.templatePatternId,
          surfacePattern: staticMetadata.surfacePattern,
          aiMechanismPattern: staticMetadata.aiMechanismPattern,
        }
      : {};

    const metadata: GeneratedOutputMetadata = applyTemplateDefaults(
      {
        projectId: latest.id,
        agentId: stat.agentId,
        title:
          artifactMetadata.title ??
          staticOutputMetadata.title ??
          manualSeed?.title ??
          dbProject?.title ??
          recent?.title ??
          latest.title,
        oneLiner: artifactMetadata.oneLiner ?? manualSeed?.oneLiner ?? dbProject?.oneLiner ?? recent?.summary,
        categoryId: dbProject?.categoryId ?? manualSeed?.categoryId,
        categoryName: dbProject?.category?.name ?? manualSeed?.categoryName,
        status: dbProject?.status ?? latest.status,
        validationStatus: dbProject?.validationStatus,
        artifactRoot: dbProject?.artifactRoot,
        artifactShape:
          artifactMetadata.artifactShape ??
          staticOutputMetadata.artifactShape ??
          manualSeed?.artifactShape ??
          recent?.artifactShape,
        templatePatternId:
          artifactMetadata.templatePatternId ??
          staticOutputMetadata.templatePatternId ??
          manualSeed?.templatePatternId ??
          recent?.templatePatternId,
        surfacePattern:
          artifactMetadata.surfacePattern ??
          staticOutputMetadata.surfacePattern ??
          manualSeed?.surfacePattern ??
          recent?.surfacePattern,
        aiMechanismPattern:
          artifactMetadata.aiMechanismPattern ??
          staticOutputMetadata.aiMechanismPattern ??
          manualSeed?.aiMechanismPattern ??
          recent?.aiMechanismPattern,
        mvpContractV2Status: artifactMetadata.mvpContractV2Status,
        mvpContractV2ArtifactTier: artifactMetadata.mvpContractV2ArtifactTier,
        externalDependencyMode: artifactMetadata.externalDependencyMode,
        interactionProofPrimaryAction: artifactMetadata.interactionProofPrimaryAction,
        interactionProofEvidenceCount: artifactMetadata.interactionProofEvidenceCount,
        metadataSources: mergeSources(
          ["data/agents/agent-quality-stats.json"],
          dbProject ? ["db.project"] : undefined,
          manualSeed ? ["data/agents/manual-seed-output-metadata.json"] : undefined,
          recent ? ["scripts/llm-pipeline/fixtures/recent-artifacts.json"] : undefined,
          staticMetadata ? ["src/project-artifacts/static-source.ts"] : undefined,
          artifact.sources,
        ),
      },
      templatePatterns,
    );

    projects.push(metadata);
  }

  return {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    source: "agent-quality-stats + db.project + artifact metadata + recent-artifacts",
    projects: projects.sort((a, b) => a.agentId?.localeCompare(b.agentId ?? "") || a.projectId.localeCompare(b.projectId)),
  };
}

async function main() {
  const snapshot = await buildGeneratedOutputMetadata();
  const filePath = outPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeValidatedJson(filePath, snapshot);
  console.log(
    `Generated output metadata written: ${path.relative(process.cwd(), filePath)} (projects: ${snapshot.projects.length})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
