import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const run = (
  label: string,
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  expectedStatus: number,
) => {
  const resolvedCommand = process.platform === "win32" && command.endsWith(".cmd") ? "cmd.exe" : command;
  const resolvedArgs = process.platform === "win32" && command.endsWith(".cmd") ? ["/c", command, ...args] : args;
  const result = spawnSync(resolvedCommand, resolvedArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${label}: expected exit ${expectedStatus}, got ${result.status}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

async function createArtifactFixture(runId: string, artifactId: string) {
  const artifactDir = path.join(
    process.cwd(),
    "artifacts",
    "llm-pipeline-runs",
    runId,
    "materialized",
    artifactId,
  );
  await rm(path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId), {
    recursive: true,
    force: true,
  });
  await mkdir(path.join(artifactDir, "source", "app"), { recursive: true });
  await mkdir(path.join(artifactDir, "validation"), { recursive: true });
  await writeFile(
    path.join(artifactDir, "README.md"),
    "# Rollback Fixture\n\nThis fixture verifies transaction rollback.\n",
    "utf8",
  );
  await writeFile(
    path.join(artifactDir, "source", "app", "page.tsx"),
    "export default function Page() { return <main>rollback fixture</main>; }\n",
    "utf8",
  );
  await writeJson(path.join(artifactDir, "metadata.json"), {
    version: 1,
    artifactId,
    generatedAt: "2026-07-04T00:00:00.000Z",
    generatedFrom: {
      input: "rollback fixture",
      requirementSpecId: "rollback_fixture",
      framework: "next",
    },
    sourceFiles: [
      {
        relativePath: "source/app/page.tsx",
        purpose: "Primary UI",
        sizeBytes: 72,
        checksum: "fixture",
      },
    ],
    demo: {
      path: "demo-placeholder.md",
      purpose: "Rollback fixture",
    },
    mvpContract: {
      firstScreenValue: "Shows a rollback fixture",
      coreInteraction: "Open the page",
      stateChange: "The page renders static text",
      inspectableOutput: "rollback fixture",
      staticDataBoundary: "Uses local fixture data only",
      requiredFiles: ["source/app/page.tsx"],
      nonGoals: ["No external API"],
      forbiddenDependencies: ["No secrets"],
    },
    sourceProvenance: {
      sourceProductUsed: "fixture_source",
      sourceProductUse: "inspiration",
      sourceBoundary: "Use as inspiration only",
    },
  });
  await writeJson(path.join(artifactDir, "manifest.json"), {
    entrypoint: "source/app/page.tsx",
    files: ["source/app/page.tsx"],
  });
  await writeJson(path.join(artifactDir, "validation", "self-review.json"), {
    status: "pass",
    checks: {},
  });
  return artifactDir;
}

async function main() {
  const tempDbName = `publish-rollback-${Date.now()}-${process.pid}.db`;
  const dbPath = path.join(process.cwd(), "prisma", tempDbName);
  const databaseUrl = `file:./prisma/${tempDbName}`;
  const sourceDbPath = path.join(process.cwd(), "prisma", "dev.db");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  const runId = "__publish_transaction_rollback_test";
  const artifactId = "rollback_artifact";
  const projectId = "proj_llm_rollback_artifact";
  const artifactDir = await createArtifactFixture(runId, artifactId);
  const env = { DATABASE_URL: databaseUrl };

  try {
    await copyFile(sourceDbPath, dbPath);

    const { createPrismaClient } = await import("./prisma-client");
    const seedPrisma = createPrismaClient();
    try {
      await seedPrisma.category.upsert({
        where: { id: "cat_operations" },
        update: {
          description: "Rollback fixture category",
        },
        create: {
          id: "cat_operations",
          name: "Rollback fixture operations",
          description: "Rollback fixture category",
        },
      });
      await seedPrisma.agent.upsert({
        where: { id: "agent_builder_v1" },
        update: {
          code: "agent_builder_v1",
          name: "Builder Fixture",
          oneLiner: "Builds rollback fixtures",
          primaryCategoryId: "cat_operations",
        },
        create: {
          id: "agent_builder_v1",
          code: "agent_builder_v1",
          name: "Builder Fixture",
          oneLiner: "Builds rollback fixtures",
          primaryValue: "fixture",
          primaryCategoryId: "cat_operations",
          themeDiscoveryPolicy: "{}",
          prototypingPolicy: "{}",
        },
      });
    } finally {
      await seedPrisma.$disconnect();
    }

    const publish = run(
      "publish rollback",
      process.execPath,
      [
        tsxCli,
        "scripts/publish-llm-pipeline-artifact.ts",
        "--path",
        path.relative(process.cwd(), artifactDir),
        "--run",
        runId,
        "--write",
      ],
      {
        ...env,
        PRODIA_PUBLISH_TEST_FAIL_AFTER_PROJECT_CREATE: projectId,
      },
      1,
    );
    if (!publish.stderr.includes("Test failure after Project create")) {
      throw new Error(`publish rollback: expected test failure hook\n${publish.stdout}\n${publish.stderr}`);
    }

    const verifyPrisma = createPrismaClient();
    try {
      const project = await verifyPrisma.project.findUnique({ where: { id: projectId } });
      if (project) {
        throw new Error(`rollback failed: Project ${projectId} remained after transaction failure`);
      }
    } finally {
      await verifyPrisma.$disconnect();
    }
  } finally {
    await rm(path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId), {
      recursive: true,
      force: true,
    });
    await rm(dbPath, { force: true });
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  console.log("publish transaction rollback tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
