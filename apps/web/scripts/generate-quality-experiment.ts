import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import "./load-local-env";

const execFileAsync = promisify(execFile);
const prisma = createPrismaClient();

const systemActor = {
  actorType: "system",
  actorId: "quality_experiment_runner",
  actorName: "Quality Experiment Runner",
};

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const next = raw[index + 1];

    if (!item.startsWith("--") || !next || next.startsWith("--")) {
      continue;
    }

    values.set(item.slice(2), next);
    index += 1;
  }

  return {
    runId: values.get("run") ?? "",
    theme:
      values.get("theme") ??
      "Fresh AI and developer signals turned into inspectable micro-products",
  };
};

const runManualPipeline = async (theme: string) => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/c",
          `${npmCommand} run pipeline:manual -- --theme "${theme.replaceAll('"', '\\"')}" --agent all --count 4 --kinds board,roulette,explainer,map`,
        ]
      : [
          "run",
          "pipeline:manual",
          "--",
          "--theme",
          theme,
          "--agent",
          "all",
          "--count",
          "4",
          "--kinds",
          "board,roulette,explainer,map",
        ];
  const { stdout } = await execFileAsync(
    command,
    args,
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  const runId = stdout.match(/Created run (run_[^\s]+)/)?.[1];

  if (!runId) {
    throw new Error(`Could not parse run id from pipeline output:\n${stdout}`);
  }

  return runId;
};

const uiPlanMarkdown = (project: {
  title: string;
  oneLiner: string;
  useCase: string;
  whatWasTried: string;
  nextGrowth: string;
  category: { name: string };
  agent: { code: string; name: string; oneLiner: string };
}) => `# UI Plan: ${project.title}

## First viewport

- Show the product title, one-line value, agent identity, and one obvious primary action.
- Keep the page readable as a product post, not as an internal system dashboard.
- The viewer should understand the artifact in under 10 seconds.

## Primary interaction

${project.whatWasTried}

## Visual hierarchy

1. Product promise: ${project.oneLiner}
2. Agent angle: ${project.agent.name} / ${project.agent.oneLiner}
3. Artifact category: ${project.category.name}
4. Human feedback cue: like, comment, want_to_grow, report

## Data shown

- Theme/run context
- Agent interpretation
- The smallest useful interactive state
- Local mock data only

## Human feedback hook

Ask whether this artifact is worth growing, not whether it is a finished product.

## Screenshot target

Capture the first viewport after the primary interaction is visible.

## Next growth

${project.nextGrowth}
`;

const screenshotPlan = (project: {
  id: string;
  title: string;
  artifactRoot: string;
  agent: { code: string; name: string };
}) => ({
  projectId: project.id,
  title: project.title,
  agent: {
    code: project.agent.code,
    name: project.agent.name,
  },
  viewport: {
    width: 1440,
    height: 900,
  },
  source: `${project.artifactRoot}/demo.html`,
  targetFile: `${project.artifactRoot}/screenshots/desktop.png`,
  mustShow: [
    "product title",
    "one-line value",
    "agent identity",
    "primary interaction",
    "local data or sections",
  ],
  avoid: [
    "blank screen",
    "text overflow",
    "login prompt",
    "external API dependency",
    "unclear first action",
  ],
  fallback: "Use demo.html first viewport as the product page preview until Playwright screenshots are enabled.",
});

async function main() {
  const args = parseArgs();
  const runId = args.runId || (await runManualPipeline(args.theme));
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      projects: {
        include: {
          agent: true,
          category: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  for (const project of run.projects) {
    const artifactDir = path.join(process.cwd(), "artifacts", project.artifactRoot);
    const uiPlan = uiPlanMarkdown(project);
    const shotPlan = JSON.stringify(screenshotPlan(project), null, 2);
    const uiPath = `${project.artifactRoot}/UI_PLAN.md`;
    const screenshotPath = `${project.artifactRoot}/screenshot-plan.json`;

    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "UI_PLAN.md"), uiPlan);
    await writeFile(path.join(artifactDir, "screenshot-plan.json"), shotPlan);

    await prisma.artifact.upsert({
      where: { id: `artifact_${project.id}_ui_plan` },
      update: {
        path: uiPath,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(uiPlan),
        checksum: checksum(uiPlan),
      },
      create: {
        id: `artifact_${project.id}_ui_plan`,
        projectId: project.id,
        runId,
        type: "ui_plan",
        path: uiPath,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(uiPlan),
        checksum: checksum(uiPlan),
      },
    });

    await prisma.artifact.upsert({
      where: { id: `artifact_${project.id}_screenshot_plan` },
      update: {
        path: screenshotPath,
        mimeType: "application/json",
        sizeBytes: Buffer.byteLength(shotPlan),
        checksum: checksum(shotPlan),
      },
      create: {
        id: `artifact_${project.id}_screenshot_plan`,
        projectId: project.id,
        runId,
        type: "screenshot_plan",
        path: screenshotPath,
        mimeType: "application/json",
        sizeBytes: Buffer.byteLength(shotPlan),
        checksum: checksum(shotPlan),
      },
    });
  }

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "quality_experiment_documented",
      ...systemActor,
      summary:
        "Quality experiment added UI_PLAN.md and screenshot-plan.json to each generated project.",
      metadataJson: JSON.stringify({
        projects: run.projects.length,
        filesPerProject: ["UI_PLAN.md", "screenshot-plan.json"],
      }),
    },
  });

  console.log(`Quality experiment run: ${runId}`);
  console.log(`Projects documented: ${run.projects.length}`);
  console.log(`Open: http://localhost:3000/runs/${runId}`);
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
