import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient, missingTables } from "./prisma-client";
import { parseArgs, readJson } from "./llm-pipeline/shared";

type ReviewerResponse = {
  artifactId?: string;
  reviewerAgentId?: string;
  status?: string;
  problems?: Array<{ issue?: string; requiredChange?: string; severity?: string }>;
  publishRecommendation?: { reason?: string };
  learningExtraction?: {
    caseSummary?: string;
    reviewerLearningCandidates?: Array<{
      lessonType?: string;
      lesson?: string;
      evidence?: string[];
    }>;
  };
};

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const compactIssueSummary = (response: ReviewerResponse) => {
  const caseSummary = response.learningExtraction?.caseSummary;
  if (caseSummary) return caseSummary;
  const firstProblem = response.problems?.find((problem) => problem.issue);
  if (firstProblem?.issue) return firstProblem.issue;
  return response.publishRecommendation?.reason ?? null;
};

async function main() {
  const args = parseArgs();
  const runId = typeof args.run === "string" ? args.run : null;
  const responsePath =
    typeof args.response === "string"
      ? path.resolve(args.response)
      : runId
        ? path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, "reviewer", "response.json")
        : null;

  if (!responsePath) {
    throw new Error("--run or --response is required");
  }

  const response = await readJson<ReviewerResponse>(responsePath);
  const reviewerAgentId = asString(response.reviewerAgentId, "reviewer_v1");
  const reviewCaseId = `review_case_${randomUUID()}`;
  const learningCandidates = response.learningExtraction?.reviewerLearningCandidates ?? [];
  const promoted = args.promote === true;
  const now = new Date();

  const prisma = createPrismaClient();
  try {
    const missing = await missingTables(prisma, ["ReviewCase", "ReviewerLearning"]);
    if (missing.length > 0) {
      console.warn(`Reviewer learning tables are missing; skipped write: ${missing.join(", ")}`);
      return;
    }

    await prisma.$executeRaw`
      INSERT INTO "ReviewCase" (
        "id",
        "reviewerAgentId",
        "runId",
        "artifactId",
        "reviewStatus",
        "issueSummary",
        "reviewResultJson",
        "learningExtracted",
        "createdAt"
      ) VALUES (
        ${reviewCaseId},
        ${reviewerAgentId},
        ${runId},
        ${response.artifactId ?? null},
        ${asString(response.status, "unknown")},
        ${compactIssueSummary(response)},
        ${JSON.stringify(response)},
        ${learningCandidates.length > 0},
        ${now}
      )
    `;

    for (const candidate of learningCandidates) {
      const lesson = asString(candidate.lesson).trim();
      if (!lesson) continue;
      await prisma.$executeRaw`
        INSERT INTO "ReviewerLearning" (
          "id",
          "reviewerAgentId",
          "sourceCaseId",
          "lessonType",
          "lesson",
          "evidenceJson",
          "promoted",
          "createdAt",
          "updatedAt"
        ) VALUES (
          ${`reviewer_learning_${randomUUID()}`},
          ${reviewerAgentId},
          ${reviewCaseId},
          ${asString(candidate.lessonType, "failure_pattern")},
          ${lesson},
          ${JSON.stringify(candidate.evidence ?? [])},
          ${promoted},
          ${now},
          ${now}
        )
      `;
    }

    console.log(
      `Saved reviewer case ${reviewCaseId} with ${learningCandidates.length} learning candidate(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
