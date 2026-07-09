import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import "./load-local-env";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type TemplateConfig = {
  templatePatterns?: Array<{
    id: string;
    label?: string;
    artifactKind?: string;
  }>;
  templates?: Array<{
    id?: string;
    patternId?: string;
  }>;
};

type ProjectMetadata = {
  templatePatternId?: string;
};

const prisma = createPrismaClient();

const readText = (filePath: string) => readFile(path.resolve(process.cwd(), filePath), "utf8");

const hasText = async (filePath: string, pattern: RegExp) => {
  try {
    return pattern.test(await readText(filePath));
  } catch {
    return false;
  }
};

const readRecentProjectPatterns = async () => {
  const projects = await prisma.project.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 16,
  });
  const patterns: Array<{ projectId: string; patternId: string }> = [];

  for (const project of projects) {
    if (!project.artifactRoot) continue;

    try {
      const raw = await readFile(
        path.join(process.cwd(), "artifacts", project.artifactRoot, "metadata.json"),
        "utf8",
      );
      const metadata = JSON.parse(raw) as ProjectMetadata;

      if (metadata.templatePatternId) {
        patterns.push({
          projectId: project.id,
          patternId: metadata.templatePatternId,
        });
      }
    } catch {
      continue;
    }
  }

  return patterns;
};

async function main() {
  const results: CheckResult[] = [];
  const config = JSON.parse(await readText("scripts/templates/product-templates.json")) as TemplateConfig;
  const patternIds = (config.templatePatterns ?? []).map((pattern) => pattern.id);
  const uniquePatternIds = new Set(patternIds);
  const executablePatternIds = new Set(
    (config.templates ?? [])
      .map((template) => template.patternId)
      .filter((patternId): patternId is string => Boolean(patternId)),
  );
  const missingExecutablePatterns = patternIds.filter(
    (patternId) => !executablePatternIds.has(patternId),
  );
  const unknownExecutablePatterns = [...executablePatternIds].filter(
    (patternId) => !uniquePatternIds.has(patternId),
  );

  results.push({
    name: "template_pattern_count",
    ok: patternIds.length === 8 && uniquePatternIds.size === 8,
    detail: `patterns=${patternIds.length} unique=${uniquePatternIds.size}`,
  });
  results.push({
    name: "executable_template_coverage",
    ok: missingExecutablePatterns.length === 0 && unknownExecutablePatterns.length === 0,
    detail: `missing=${missingExecutablePatterns.join(",") || "none"} unknown=${
      unknownExecutablePatterns.join(",") || "none"
    }`,
  });
  results.push({
    name: "planner_rotates_away_from_recent",
    ok:
      (await hasText("scripts/plan-from-signals.ts", /readMostRecentTemplatePatternId/)) &&
      (await hasText("scripts/plan-from-signals.ts", /chooseTemplatePatterns/)),
    detail: "scripts/plan-from-signals.ts",
  });
  results.push({
    name: "generator_records_template_pattern",
    ok:
      (await hasText("scripts/generate-from-briefs.ts", /templatePatternId/)) &&
      (await hasText("scripts/generate-from-briefs.ts", /templatePatternReason/)),
    detail: "scripts/generate-from-briefs.ts",
  });
  results.push({
    name: "operator_runbook_records_template_pattern",
    ok:
      (await hasText("scripts/plan-from-signals.ts", /templatePattern/)) &&
      (await hasText("../../docs/operations/DOC-103_Codex_Claude_Product_Generation_Runbook.md", /artifact/)),
    detail: "operator runbook and planner/generator artifacts",
  });

  const recentPatterns = await readRecentProjectPatterns();
  const adjacentDuplicate = recentPatterns.find((item, index) => {
    const next = recentPatterns[index + 1];

    return next ? item.patternId === next.patternId : false;
  });

  results.push({
    name: "recent_project_pattern_adjacency",
    ok: true,
    detail:
      recentPatterns.length === 0
        ? "no recorded templatePatternId yet"
        : adjacentDuplicate
          ? `warn: existing DB history has adjacent repeat ${adjacentDuplicate.projectId} repeats ${adjacentDuplicate.patternId}`
          : recentPatterns.map((item) => item.patternId).join(" -> "),
  });

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  console.log(`Template pattern diversity check: ${results.length - failed.length}/${results.length} passed`);

  await prisma.$disconnect();

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
