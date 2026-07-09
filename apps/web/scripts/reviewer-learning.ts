import type { PrismaClient } from "@prisma/client";
import { missingTables } from "./prisma-client";

export type ReviewerLearningRecord = {
  id: string;
  reviewerAgentId: string;
  sourceCaseId: string | null;
  lessonType: string;
  lesson: string;
  evidenceJson: string | null;
  promoted: boolean;
  createdAt: string;
  updatedAt: string;
};

type ReviewerLearningRow = Omit<ReviewerLearningRecord, "createdAt" | "updatedAt" | "promoted"> & {
  promoted: boolean | number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export const REVIEWER_LEARNING_TABLE = "ReviewerLearning";

const toIso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

const rowToReviewerLearning = (row: ReviewerLearningRow): ReviewerLearningRecord => ({
  id: row.id,
  reviewerAgentId: row.reviewerAgentId,
  sourceCaseId: row.sourceCaseId,
  lessonType: row.lessonType,
  lesson: row.lesson,
  evidenceJson: row.evidenceJson,
  promoted: typeof row.promoted === "number" ? row.promoted !== 0 : row.promoted,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

export const reviewerLearningTableMissing = async (prisma: PrismaClient): Promise<boolean> => {
  try {
    const missing = await missingTables(prisma, [REVIEWER_LEARNING_TABLE]);
    return missing.length > 0;
  } catch {
    return true;
  }
};

export async function readReviewerLearningsFromDb(
  prisma: PrismaClient,
  reviewerAgentId: string,
  options: { promotedOnly?: boolean; take?: number } = {},
): Promise<ReviewerLearningRecord[]> {
  if (!reviewerAgentId) return [];
  if (await reviewerLearningTableMissing(prisma)) return [];

  const take = options.take ?? 8;
  const rows = options.promotedOnly ?? true
    ? await prisma.$queryRaw<ReviewerLearningRow[]>`
        SELECT
          "id",
          "reviewerAgentId",
          "sourceCaseId",
          "lessonType",
          "lesson",
          "evidenceJson",
          "promoted",
          "createdAt",
          "updatedAt"
        FROM "ReviewerLearning"
        WHERE "reviewerAgentId" = ${reviewerAgentId}
          AND "promoted" = ${true}
        ORDER BY "updatedAt" DESC, "createdAt" DESC
        LIMIT ${take}
      `
    : await prisma.$queryRaw<ReviewerLearningRow[]>`
        SELECT
          "id",
          "reviewerAgentId",
          "sourceCaseId",
          "lessonType",
          "lesson",
          "evidenceJson",
          "promoted",
          "createdAt",
          "updatedAt"
        FROM "ReviewerLearning"
        WHERE "reviewerAgentId" = ${reviewerAgentId}
        ORDER BY "updatedAt" DESC, "createdAt" DESC
        LIMIT ${take}
      `;

  return rows.map(rowToReviewerLearning);
}

export function formatReviewerLearningsForPrompt(learnings: ReviewerLearningRecord[]): string {
  if (learnings.length === 0) return "";

  const lines = learnings.map((learning) => {
    const source = learning.sourceCaseId ? ` sourceCase=${learning.sourceCaseId}` : "";
    return `- [${learning.lessonType}]${source}: ${learning.lesson}`;
  });

  return [
    "### Promoted reviewer memory",
    "Use these as hidden review memory. Do not quote table names, IDs, or internal policy fields in public artifact copy.",
    ...lines,
  ].join("\n");
}
