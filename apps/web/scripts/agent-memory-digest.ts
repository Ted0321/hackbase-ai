import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { AgentMemoryDigest, ArtifactShape } from "./agent-definition-v2";
import { missingTables } from "./prisma-client";

export type MemoryScope = "own_projects" | "same_category" | "all_projects";

type DateLike = Date | string;

export type MemoryProjectRow = {
  id: string;
  runId: string;
  title: string;
  oneLiner: string;
  status: string;
  validationStatus: string | null;
  artifactRoot: string | null;
  createdAt: DateLike;
};

export type MemoryFeedbackRow = {
  id: string;
  targetType: string;
  targetId: string;
  rating: string;
  comment: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: DateLike;
};

export type MemoryValidationRow = {
  id: string;
  projectId: string;
  runId: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
  createdAt: DateLike;
};

export type MemoryArtifactRow = {
  id: string;
  projectId: string | null;
  runId: string;
  type: string;
  path: string;
  createdAt: DateLike;
};

export type MemoryRunEventRow = {
  id: string;
  runId: string;
  projectId: string | null;
  type: string;
  actorType: string;
  summary: string;
  metadataJson: string | null;
  createdAt: DateLike;
};

export type MemoryRunRow = {
  id: string;
  status: string;
  errorMessage: string | null;
  createdAt: DateLike;
};

export type AgentMemoryDigestRows = {
  projects?: MemoryProjectRow[];
  receivedFeedback?: MemoryFeedbackRow[];
  emittedFeedback?: MemoryFeedbackRow[];
  validations?: MemoryValidationRow[];
  artifacts?: MemoryArtifactRow[];
  runEvents?: MemoryRunEventRow[];
  runs?: MemoryRunRow[];
};

export type AgentMemoryDigestOptions = {
  now?: string;
  freshnessWindowDays?: number;
  maxProjects?: number;
  maxFeedbackItems?: number;
  maxValidationIssues?: number;
  maxGuidanceItems?: number;
  includeFailures?: boolean;
  includePositiveSignals?: boolean;
  memoryScope?: MemoryScope;
};

const artifactShapes = new Set<ArtifactShape>([
  "audit_report",
  "board",
  "evaluator",
  "explainer",
  "game_like_tool",
  "hold_recommendation",
  "map",
  "publish_gate",
  "review_report",
  "revision_brief",
  "risk_summary",
  "simulator",
  "transformation_studio",
  "workspace",
]);

const unique = (...sources: Array<Array<string | null | undefined> | undefined>) => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const item of source) {
      if (typeof item !== "string" || item.trim().length === 0) continue;
      const normalized = item.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
};

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

const textFromFeedback = (feedback: MemoryFeedbackRow) =>
  feedback.comment?.trim() || `${feedback.actorType} ${feedback.rating}`.trim();

// Classification is rating-first (structured enum) so it stays language-agnostic. The free-text
// comments in this product are Japanese, so English-keyword matching alone silently dropped every
// human comment from critique/guidance. Rating buckets mirror the vocabulary used by
// generate-agent-learnings.ts and refresh-agent-skills.ts. The English-term checks are kept as an
// additive fallback so nothing that used to classify stops classifying.
const PRAISE_RATINGS = new Set(["like", "liked", "want_to_grow", "agent_like"]);
const CRITIQUE_RATINGS = new Set(["agent_critique", "agent_risk_flag", "validation_warning"]);
const REMIX_RATINGS = new Set(["agent_remix_suggestion"]);

const isPraise = (feedback: MemoryFeedbackRow) => {
  const rating = lower(feedback.rating);
  if (PRAISE_RATINGS.has(rating)) return true;
  return ["like", "liked", "love", "positive", "upvote", "helpful"].some((term) => rating.includes(term));
};

const isRemix = (feedback: MemoryFeedbackRow) => {
  const rating = lower(feedback.rating);
  if (REMIX_RATINGS.has(rating)) return true;
  const value = `${rating} ${lower(feedback.comment)}`;
  return ["remix", "variation", "extend", "another", "fork"].some((term) => value.includes(term));
};

const isCritique = (feedback: MemoryFeedbackRow) => {
  if (isPraise(feedback)) return false;
  const rating = lower(feedback.rating);
  if (CRITIQUE_RATINGS.has(rating)) return true;
  // Human free-text comments count as feedback to address, regardless of language — mirroring
  // generate-agent-learnings.ts which maps rating="comment" to requirement constraints.
  if (rating === "comment" && lower(feedback.actorType) === "human") return true;
  const value = `${rating} ${lower(feedback.comment)}`;
  return ["critique", "risk", "issue", "needs", "weak", "bad", "downvote", "warning"].some((term) =>
    value.includes(term),
  );
};

const validationPassed = (status: string | null | undefined) => {
  const value = lower(status);
  return value === "pass" || value === "passed" || value === "ok" || value === "success";
};

const validationFailed = (status: string | null | undefined) => {
  const value = lower(status);
  return value.includes("fail") || value.includes("error") || value.includes("block");
};

const mostCommonArtifactShapes = (artifacts: MemoryArtifactRow[]): ArtifactShape[] => {
  const counts = new Map<ArtifactShape, number>();
  for (const artifact of artifacts) {
    const type = artifact.type as ArtifactShape;
    if (!artifactShapes.has(type)) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([shape]) => shape)
    .slice(0, 5);
};

const overusedArtifactTypes = (artifacts: MemoryArtifactRow[]) => {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!artifact.type) continue;
    counts.set(artifact.type, (counts.get(artifact.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => `${type} repeated ${count} times`);
};

const currentGuidanceFromDigest = (args: {
  praise: string[];
  critique: string[];
  remixRequests: string[];
  repeatedFailures: string[];
  validationPassRate?: number;
  maxGuidanceItems?: number;
}) => {
  const guidance: string[] = [];

  if (args.praise[0]) guidance.push(`Keep the pattern that drew positive feedback: ${args.praise[0]}`);
  if (args.critique[0]) guidance.push(`Address the most recent critique in the next requirements: ${args.critique[0]}`);
  if (args.remixRequests[0]) guidance.push(`Consider a concrete variation only if today's signal supports it: ${args.remixRequests[0]}`);
  if (args.repeatedFailures[0]) guidance.push(`Avoid repeating this validation or runtime failure: ${args.repeatedFailures[0]}`);
  if (typeof args.validationPassRate === "number" && args.validationPassRate < 0.8) {
    guidance.push("Make validation proof and interaction evidence explicit before publish.");
  }

  return guidance.slice(0, args.maxGuidanceItems ?? 5);
};

export function buildAgentMemoryDigestFromRows(
  agentId: string,
  rows: AgentMemoryDigestRows,
  options: AgentMemoryDigestOptions = {},
): AgentMemoryDigest {
  const generatedAt = options.now ?? new Date().toISOString();
  const freshnessWindowDays = options.freshnessWindowDays ?? 30;
  const since = new Date(Date.parse(generatedAt) - freshnessWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const maxProjects = options.maxProjects ?? 6;
  const maxFeedbackItems = options.maxFeedbackItems ?? 12;
  const maxValidationIssues = options.maxValidationIssues ?? 8;
  const maxGuidanceItems = options.maxGuidanceItems ?? 5;
  const includeFailures = options.includeFailures ?? true;
  const includePositiveSignals = options.includePositiveSignals ?? true;

  const projects = rows.projects ?? [];
  const receivedFeedback = rows.receivedFeedback ?? [];
  const emittedFeedback = rows.emittedFeedback ?? [];
  const validations = rows.validations ?? [];
  const artifacts = rows.artifacts ?? [];
  const runEvents = rows.runEvents ?? [];
  const runs = rows.runs ?? [];

  const failedValidations = validations.filter((validation) => validationFailed(validation.status));
  const failedRuns = runs.filter((run) => validationFailed(run.status) || !!run.errorMessage);
  const errorEvents = runEvents.filter((event) => {
    const value = `${lower(event.type)} ${lower(event.summary)}`;
    return value.includes("error") || value.includes("fail") || value.includes("blocked");
  });

  const validationPassRate =
    validations.length > 0
      ? validations.filter((validation) => validationPassed(validation.status)).length / validations.length
      : undefined;
  // memoryPolicy.retrieval.includePositiveSignals: 肯定シグナル（praise）を学びに含めるか。
  const praise = includePositiveSignals
    ? receivedFeedback.filter(isPraise).map(textFromFeedback).slice(0, maxFeedbackItems)
    : [];
  const critique = receivedFeedback.filter(isCritique).map(textFromFeedback).slice(0, maxFeedbackItems);
  const remixRequests = receivedFeedback.filter(isRemix).map(textFromFeedback).slice(0, maxFeedbackItems);
  // memoryPolicy.retrieval.includeFailures: 失敗系（検証/実行/tool エラー）を学びに含めるか。
  const repeatedFailures = includeFailures
    ? unique(
        failedValidations.map((validation) => validation.summary ?? validation.errorMessage ?? validation.status),
        failedRuns.map((run) => run.errorMessage ?? run.status),
        errorEvents.map((event) => event.summary),
      ).slice(0, maxValidationIssues)
    : [];
  const blockedReasons = includeFailures
    ? unique(
        errorEvents
          .filter((event) => lower(event.type).includes("block") || lower(event.summary).includes("block"))
          .map((event) => event.summary),
      ).slice(0, maxValidationIssues)
    : [];
  const toolErrors = includeFailures
    ? unique(
        errorEvents
          .filter((event) => lower(event.type).includes("tool") || lower(event.summary).includes("tool"))
          .map((event) => event.summary),
      ).slice(0, maxValidationIssues)
    : [];

  return {
    agentId,
    generatedAt,
    sourceRange: {
      since,
      until: generatedAt,
    },
    episodicMemory: {
      recentRunIds: unique(
        projects.map((project) => project.runId),
        runEvents.map((event) => event.runId),
        runs.map((run) => run.id),
      ).slice(0, maxProjects),
      recentProjectIds: unique(projects.map((project) => project.id)).slice(0, maxProjects),
      recentReactionIds: unique(
        emittedFeedback.map((feedback) => feedback.id),
        runEvents
          .filter((event) => lower(event.type).includes("reaction"))
          .map((event) => event.id),
      ).slice(0, maxFeedbackItems),
    },
    artifactMemory: {
      successfulPatterns: projects
        .filter((project) => validationPassed(project.validationStatus) || lower(project.status).includes("publish"))
        .map((project) => `${project.title}: ${project.oneLiner}`)
        .slice(0, maxProjects),
      overusedPatterns: overusedArtifactTypes(artifacts),
      ...(typeof validationPassRate === "number" ? { validationPassRate } : {}),
      commonArtifactShapes: mostCommonArtifactShapes(artifacts),
    },
    feedbackMemory: {
      praise,
      critique,
      remixRequests,
      ignoredFeedback: [],
    },
    errorMemory: {
      repeatedFailures,
      blockedReasons,
      toolErrors,
    },
    currentGuidance: currentGuidanceFromDigest({
      praise,
      critique,
      remixRequests,
      repeatedFailures,
      validationPassRate,
      maxGuidanceItems,
    }),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const querySafely = async <T>(label: string, query: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await query();
  } catch (error) {
    // Never silently return an empty memory: a swallowed DB error here would make the agent
    // generate as if it had no history, with no trace that memory was actually lost.
    console.warn(
      `[agent-memory-digest] ${label} query failed; degrading to empty memory for this source: ${errorText(error)}`,
    );
    return [];
  }
};

export async function readAgentMemoryDigestFromDb(
  prisma: PrismaClient,
  agentId: string,
  options: AgentMemoryDigestOptions = {},
): Promise<AgentMemoryDigest> {
  const required = ["Project", "Feedback", "Validation", "Artifact", "RunEvent", "Run"];
  const missing = await missingTables(prisma, required).catch((error) => {
    console.warn(
      `[agent-memory-digest] table presence check failed; assuming all memory tables absent: ${errorText(error)}`,
    );
    return required;
  });
  const has = (table: string) => !missing.includes(table);
  const maxProjects = options.maxProjects ?? 6;
  const maxFeedbackItems = options.maxFeedbackItems ?? 12;
  const maxValidationIssues = options.maxValidationIssues ?? 8;

  // memoryPolicy.memoryScope を実際に効かせる。own=自分の作品のみ / same_category=自分の作品と
  // 同じカテゴリの全作品 / all=全作品。エピソード記憶(自分のrun/reaction)は scope に関わらず自分のもの。
  // 作品由来の学び(projects/受信feedback/validation/artifact)だけがこの scope で広がる。
  const scope: MemoryScope = options.memoryScope ?? "own_projects";
  let projectScope: Prisma.Sql = Prisma.sql`p."agentId" = ${agentId}`;
  if (scope === "all_projects") {
    projectScope = Prisma.sql`1 = 1`;
  } else if (scope === "same_category") {
    const categoryRows = has("Project")
      ? await querySafely("scopeCategories", () => prisma.$queryRaw<{ categoryId: string }[]>`
          SELECT DISTINCT "categoryId"
          FROM "Project"
          WHERE "agentId" = ${agentId}
            AND "status" <> 'withdrawn'
            AND "publishDecision" <> 'withdrawn'
        `)
      : [];
    const categoryIds = categoryRows.map((row) => row.categoryId).filter((id): id is string => Boolean(id));
    projectScope =
      categoryIds.length > 0 ? Prisma.sql`p."categoryId" IN (${Prisma.join(categoryIds)})` : Prisma.sql`1 = 0`;
  }

  const [projects, receivedFeedback, emittedFeedback, validations, artifacts, runEvents, runs] = await Promise.all([
    has("Project")
      ? querySafely("projects", () => prisma.$queryRaw<MemoryProjectRow[]>`
          SELECT p."id", p."runId", p."title", p."oneLiner", p."status", p."validationStatus", p."artifactRoot", p."createdAt"
          FROM "Project" p
          WHERE ${projectScope}
            AND p."status" <> 'withdrawn'
            AND p."publishDecision" <> 'withdrawn'
          ORDER BY p."createdAt" DESC
          LIMIT ${maxProjects}
        `)
      : [],
    has("Project") && has("Feedback")
      ? querySafely("receivedFeedback", () => prisma.$queryRaw<MemoryFeedbackRow[]>`
          SELECT f."id", f."targetType", f."targetId", f."rating", f."comment", f."actorType", f."actorId", f."createdAt"
          FROM "Feedback" f
          JOIN "Project" p ON f."targetType" = 'project' AND f."targetId" = p."id"
          WHERE ${projectScope}
            AND p."status" <> 'withdrawn'
            AND p."publishDecision" <> 'withdrawn'
          ORDER BY f."createdAt" DESC
          LIMIT ${maxFeedbackItems}
        `)
      : [],
    has("Feedback")
      ? querySafely("emittedFeedback", () => prisma.$queryRaw<MemoryFeedbackRow[]>`
          SELECT f."id", f."targetType", f."targetId", f."rating", f."comment", f."actorType", f."actorId", f."createdAt"
          FROM "Feedback" f
          LEFT JOIN "Project" p ON f."targetType" = 'project' AND f."targetId" = p."id"
          WHERE f."actorId" = ${agentId}
            AND (
              f."targetType" <> 'project'
              OR p."id" IS NULL
              OR (p."status" <> 'withdrawn' AND p."publishDecision" <> 'withdrawn')
            )
          ORDER BY f."createdAt" DESC
          LIMIT ${maxFeedbackItems}
        `)
      : [],
    has("Project") && has("Validation")
      ? querySafely("validations", () => prisma.$queryRaw<MemoryValidationRow[]>`
          SELECT v."id", v."projectId", v."runId", v."status", v."summary", v."errorMessage", v."createdAt"
          FROM "Validation" v
          JOIN "Project" p ON v."projectId" = p."id"
          WHERE ${projectScope}
            AND p."status" <> 'withdrawn'
            AND p."publishDecision" <> 'withdrawn'
          ORDER BY v."createdAt" DESC
          LIMIT ${maxValidationIssues}
        `)
      : [],
    has("Project") && has("Artifact")
      ? querySafely("artifacts", () => prisma.$queryRaw<MemoryArtifactRow[]>`
          SELECT a."id", a."projectId", a."runId", a."type", a."path", a."createdAt"
          FROM "Artifact" a
          JOIN "Project" p ON a."projectId" = p."id"
          WHERE ${projectScope}
            AND p."status" <> 'withdrawn'
            AND p."publishDecision" <> 'withdrawn'
          ORDER BY a."createdAt" DESC
          LIMIT ${maxProjects * 4}
        `)
      : [],
    has("RunEvent")
      ? querySafely("runEvents", () => prisma.$queryRaw<MemoryRunEventRow[]>`
          SELECT e."id", e."runId", e."projectId", e."type", e."actorType", e."summary", e."metadataJson", e."createdAt"
          FROM "RunEvent" e
          LEFT JOIN "Project" p ON e."projectId" = p."id"
          WHERE e."agentId" = ${agentId}
            AND (
              e."projectId" IS NULL
              OR p."id" IS NULL
              OR (p."status" <> 'withdrawn' AND p."publishDecision" <> 'withdrawn')
            )
          ORDER BY e."createdAt" DESC
          LIMIT ${maxFeedbackItems}
        `)
      : [],
    has("Run")
      ? querySafely("runs", () => prisma.$queryRaw<MemoryRunRow[]>`
          SELECT "id", "status", "errorMessage", "createdAt"
          FROM "Run"
          WHERE "actorId" = ${agentId}
          ORDER BY "createdAt" DESC
          LIMIT ${maxProjects}
        `)
      : [],
  ]);

  return buildAgentMemoryDigestFromRows(
    agentId,
    {
      projects,
      receivedFeedback,
      emittedFeedback,
      validations,
      artifacts,
      runEvents,
      runs,
    },
    options,
  );
}
