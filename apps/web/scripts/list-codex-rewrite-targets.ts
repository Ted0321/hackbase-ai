import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import "./load-local-env";

type CodexReview = {
  status?: string;
  totalScore?: number;
  maxScore?: number;
  summary?: string;
};

const prisma = createPrismaClient();

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Number(limitArg?.split("=")[1] ?? 12));
const onlyMissing = process.argv.includes("--only-missing");
const lowScoreFirst = process.argv.includes("--low-score");
const maxScoreArg = process.argv.find((arg) => arg.startsWith("--max-score="));
const maxScoreFilter = maxScoreArg ? Number(maxScoreArg.split("=")[1]) : null;

const readReview = async (artifactPath: string | undefined): Promise<CodexReview | null> => {
  if (!artifactPath) {
    return null;
  }

  try {
    const fullPath = path.join(process.cwd(), "artifacts", artifactPath);
    return JSON.parse(await readFile(fullPath, "utf8")) as CodexReview;
  } catch {
    return null;
  }
};

const main = async () => {
  const projects = await prisma.project.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: Math.max(limit * 4, limit),
    include: {
      agent: true,
      run: true,
      artifacts: {
        where: {
          type: {
            in: ["codex_task", "codex_output", "codex_review"],
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      },
    },
  });

  const rows = (
    await Promise.all(
    projects.map(async (project) => {
      const reviewArtifact = project.artifacts.find((artifact) => artifact.type === "codex_review");
      const review = await readReview(reviewArtifact?.path);
      const numericScore = typeof review?.totalScore === "number" ? review.totalScore : null;

      return {
        projectId: project.id,
        title: project.title,
        agent: project.agent.code,
        trigger: project.run.triggerType,
        codexTask: project.artifacts.some((artifact) => artifact.type === "codex_task"),
        codexOutput: project.artifacts.some((artifact) => artifact.type === "codex_output"),
        codexReview: Boolean(reviewArtifact),
        numericScore,
        score:
          typeof numericScore === "number"
            ? `${numericScore}/${review?.maxScore ?? 35}`
            : "-",
        status: review?.status ?? "-",
      };
    }),
    )
  )
    .filter((row) => !onlyMissing || !row.codexReview)
    .filter(
      (row) =>
        maxScoreFilter === null ||
        (typeof row.numericScore === "number" && row.numericScore <= maxScoreFilter),
    )
    .sort((a, b) => {
      if (!lowScoreFirst) {
        return 0;
      }
      const left = typeof a.numericScore === "number" ? a.numericScore : Number.POSITIVE_INFINITY;
      const right = typeof b.numericScore === "number" ? b.numericScore : Number.POSITIVE_INFINITY;
      return left - right;
    })
    .slice(0, limit)
    .map((row) => ({
      projectId: row.projectId,
      title: row.title,
      agent: row.agent,
      trigger: row.trigger,
      codexTask: row.codexTask,
      codexOutput: row.codexOutput,
      codexReview: row.codexReview,
      score: row.score,
      status: row.status,
    }));

  console.table(rows);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
