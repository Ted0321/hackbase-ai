/**
 * reviewer-learning の promote ループを閉じる（機械ルール・LLM不使用）。
 *
 * extract-reviewer-learning.ts は ReviewerLearning を promoted=false で保存するだけで、
 * promote は手動 `--promote` 任せだった。prepare-step.ts は promoted=true のみを
 * reviewer prompt へ注入するため、promote 基準が無いと学びがループに戻らない。
 *
 * 機械的 promote 基準（どちらかを満たせば promote）:
 *   (A) 再発: 同一 reviewer の同一 lessonType が >= --min-recurrence 件の異なる
 *       sourceCaseId（review case）で現れた = 複数の独立レビューで再現した安定した学び。
 *   (B) pass由来: lessonType が pass_pattern / safety_boundary で、その sourceCaseId の
 *       ReviewCase.reviewStatus が "pass" = 通った作品から得た型。
 *
 * 冪等（promoted=false のみ更新）。テーブルが無ければ何もせず exit 0。
 *
 * 使用:
 *   npm run reviewer:learning:promote:check   # dry-run（would-promote を表示）
 *   npm run reviewer:learning:promote          # 実 promote
 *   npm run reviewer:learning:promote -- --min-recurrence 3
 */
import { createPrismaClient, missingTables } from "./prisma-client";
import { parseArgs } from "./llm-pipeline/shared";

type LearningRow = {
  id: string;
  reviewerAgentId: string;
  sourceCaseId: string | null;
  lessonType: string;
  promoted: boolean | number;
};

type CaseRow = { id: string; reviewStatus: string | null };

const PASS_LESSON_TYPES = new Set(["pass_pattern", "safety_boundary"]);

const isPromoted = (value: boolean | number) => (typeof value === "number" ? value !== 0 : value);

async function main() {
  const args = parseArgs();
  const dryRun = args["dry-run"] === true || args.dryRun === true;
  const minRecurrence = typeof args["min-recurrence"] === "string" ? Number(args["min-recurrence"]) : 2;

  const prisma = createPrismaClient();
  try {
    const missing = await missingTables(prisma, ["ReviewCase", "ReviewerLearning"]);
    if (missing.length > 0) {
      console.log(
        JSON.stringify(
          { ok: true, skippedReason: `Missing table(s): ${missing.join(", ")}`, promoted: 0 },
          null,
          2,
        ),
      );
      return;
    }

    const learnings = await prisma.$queryRaw<LearningRow[]>`
      SELECT "id", "reviewerAgentId", "sourceCaseId", "lessonType", "promoted"
      FROM "ReviewerLearning"
    `;
    const cases = await prisma.$queryRaw<CaseRow[]>`
      SELECT "id", "reviewStatus" FROM "ReviewCase"
    `;
    const caseStatus = new Map(cases.map((row) => [row.id, (row.reviewStatus ?? "").toLowerCase()]));

    // (A) 再発カウント: (reviewer, lessonType) ごとの distinct sourceCaseId 数
    const recurrence = new Map<string, Set<string>>();
    for (const row of learnings) {
      const key = `${row.reviewerAgentId}::${row.lessonType}`;
      const set = recurrence.get(key) ?? new Set<string>();
      if (row.sourceCaseId) set.add(row.sourceCaseId);
      recurrence.set(key, set);
    }

    const toPromote: Array<{ id: string; reason: string }> = [];
    for (const row of learnings) {
      if (isPromoted(row.promoted)) continue;
      const key = `${row.reviewerAgentId}::${row.lessonType}`;
      const distinctCases = recurrence.get(key)?.size ?? 0;
      if (distinctCases >= minRecurrence) {
        toPromote.push({ id: row.id, reason: `recurrence ${distinctCases}>=${minRecurrence} for ${row.lessonType}` });
        continue;
      }
      if (
        PASS_LESSON_TYPES.has(row.lessonType) &&
        row.sourceCaseId &&
        caseStatus.get(row.sourceCaseId) === "pass"
      ) {
        toPromote.push({ id: row.id, reason: `pass-derived ${row.lessonType} from passing review` });
      }
    }

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            minRecurrence,
            totalLearnings: learnings.length,
            wouldPromote: toPromote.length,
            details: toPromote.slice(0, 25),
          },
          null,
          2,
        ),
      );
      return;
    }

    const now = new Date();
    let promotedCount = 0;
    for (const entry of toPromote) {
      const updated = await prisma.$executeRaw`
        UPDATE "ReviewerLearning"
        SET "promoted" = ${true}, "updatedAt" = ${now}
        WHERE "id" = ${entry.id} AND "promoted" = ${false}
      `;
      promotedCount += Number(updated) > 0 ? 1 : 0;
    }

    console.log(
      JSON.stringify(
        { ok: true, minRecurrence, totalLearnings: learnings.length, promoted: promotedCount },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
