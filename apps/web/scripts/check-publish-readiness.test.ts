import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type FixtureOptions = {
  missingPublisher?: boolean;
  reviewerNeedsRevision?: boolean;
  withRewriterResolution?: boolean;
  missingRequiredFile?: boolean;
  publicCopyMojibake?: boolean;
  artifactSourceMojibake?: boolean;
};

const root = path.join(process.cwd(), "artifacts", "llm-pipeline-runs");
const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const run = (args: string[]) =>
  spawnSync(process.execPath, [tsxCli, "scripts/check-publish-readiness.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
  });

const runPublishDryRun = (args: string[]) =>
  spawnSync(process.execPath, [tsxCli, "scripts/publish-llm-pipeline-artifact.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
  });

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createFixture = async (runId: string, options: FixtureOptions = {}) => {
  const runRoot = path.join(root, runId);
  const artifactDir = path.join(runRoot, "materialized", "artifact");
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(path.join(artifactDir, "source", "app"), { recursive: true });
  await mkdir(path.join(artifactDir, "validation"), { recursive: true });

  await writeFile(
    path.join(artifactDir, "README.md"),
    "# Readiness Test\n\nThis MVP runs on static sample data.\n",
    "utf8",
  );
  await writeJson(path.join(artifactDir, "metadata.json"), {
    version: 1,
    artifactId: "artifact",
    generatedAt: "2026-06-29T00:00:00.000Z",
    generatedFrom: {
      input: "fixture",
      requirementSpecId: "req_fixture",
      framework: "next",
    },
    sourceFiles: [
      {
        relativePath: "source/app/page.tsx",
        purpose: "Primary UI",
        sizeBytes: 64,
        checksum: "fixture",
      },
    ],
    demo: {
      path: "demo-placeholder.md",
      purpose: "Fixture demo",
    },
    mvpContract: {
      firstScreenValue: options.publicCopyMojibake
        ? "IT\u7e67\u7e3a public copy"
        : "Shows a useful first screen",
      coreInteraction: "Clicking the button changes visible state",
      stateChange: "The status changes from idle to selected",
      inspectableOutput: "Visible status text",
      staticDataBoundary: "Uses local fixture data only",
      requiredFiles: options.missingRequiredFile ? ["source/app/missing.tsx"] : ["source/app/page.tsx"],
      nonGoals: ["No external API"],
      forbiddenDependencies: ["No secrets"],
    },
    sourceProvenance: {
      sourceProductUsed: "fixture_source",
      sourceProductUse: "inspiration",
      sourceBoundary: "Use as inspiration only",
    },
    interactionProofPlan: {
      primaryAction: "Pick",
      initialState: "idle",
      expectedState: "selected",
      visibleEvidence: ["selected"],
      proofSelectors: ["button", "p"],
      requiredSourceFiles: ["source/app/page.tsx"],
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
  await writeFile(
    path.join(artifactDir, "source", "app", "page.tsx"),
    options.artifactSourceMojibake
      ? `"use client";\nexport default function Page() { return <main><button>Pick</button><p data-proof="status">selected \u7e67\u7e3a</p></main>; }\n`
      : `"use client";\nimport { useState } from "react";\n\nexport default function Page() { const [status, setStatus] = useState("idle"); return <main><button onClick={() => setStatus("selected")}>Pick</button><p data-proof="status">{status}</p></main>; }\n`,
    "utf8",
  );
  await writeJson(path.join(runRoot, "validation-summary.json"), {
    version: 1,
    runId,
    status: options.missingRequiredFile ? "fail" : "pass",
    validator: "check-mvp-artifact",
  });

  if (!options.missingPublisher) {
    await writeJson(path.join(runRoot, "publisher", "response.json"), {
      status: "publish",
      reason: "Fixture passes",
      publishSummary: options.publicCopyMojibake ? "\u7e67\u7e3a public summary" : "Fixture publish",
      requiredArtifactsPresent: true,
      reviewPass: true,
      validationPass: !options.missingRequiredFile,
      mvpContractPass: !options.missingRequiredFile,
      safetyBlockers: [],
    });
  }

  await writeJson(path.join(runRoot, "reviewer", "response.json"), {
    status: options.reviewerNeedsRevision ? "needs_revision" : "pass",
    reviewerAgentId: "fixture_reviewer",
    problems: options.reviewerNeedsRevision
      ? [
          {
            id: "rev-001",
            severity: "medium",
            issue: "Needs visible state change",
            requiredChange: "Add a visible state change",
          },
        ]
      : [],
  });

  if (options.withRewriterResolution) {
    await writeJson(path.join(runRoot, "rewriter", "response.json"), {
      status: "revised",
      changedFiles: [
        {
          path: "source/app/page.tsx",
          changeSummary: "Added state change",
          addressedReviewIssueIds: ["rev-001"],
        },
      ],
      addressedReviewIssues: ["rev-001"],
      issueResolutions: [
        {
          issueId: "rev-001",
          outcome: "changed",
          changedFiles: ["source/app/page.tsx"],
          reason: "The fixture now has a visible state change",
        },
      ],
      remainingRisks: [],
    });
  }

  return {
    runRoot,
    artifactDir,
    artifactPath: path.relative(process.cwd(), artifactDir).replace(/\\/g, "/"),
  };
};

const expectExit = (label: string, code: number | null, expected: number) => {
  if (code !== expected) {
    throw new Error(`${label}: expected exit ${expected}, got ${code}`);
  }
};

async function main() {
  const positive = await createFixture("__readiness_test_positive");
  const positiveRun = run(["--path", positive.artifactPath, "--run", "__readiness_test_positive", "--write"]);
  expectExit("positive", positiveRun.status, 0);
  const positivePublishDryRun = runPublishDryRun([
    "--path",
    positive.artifactPath,
    "--run",
    "__readiness_test_positive",
    "--auto-publish",
  ]);
  expectExit("positive publish dry-run", positivePublishDryRun.status, 0);

  const missingPublisher = await createFixture("__readiness_test_missing_publisher", {
    missingPublisher: true,
  });
  const missingPublisherRun = run([
    "--path",
    missingPublisher.artifactPath,
    "--run",
    "__readiness_test_missing_publisher",
    "--write",
  ]);
  expectExit("missing publisher", missingPublisherRun.status, 1);

  const unresolvedReview = await createFixture("__readiness_test_unresolved_review", {
    reviewerNeedsRevision: true,
  });
  const unresolvedReviewRun = run([
    "--path",
    unresolvedReview.artifactPath,
    "--run",
    "__readiness_test_unresolved_review",
    "--write",
  ]);
  expectExit("unresolved review", unresolvedReviewRun.status, 1);

  const resolvedReview = await createFixture("__readiness_test_resolved_review", {
    reviewerNeedsRevision: true,
    withRewriterResolution: true,
  });
  const resolvedReviewRun = run([
    "--path",
    resolvedReview.artifactPath,
    "--run",
    "__readiness_test_resolved_review",
    "--write",
  ]);
  expectExit("resolved review", resolvedReviewRun.status, 0);

  const strictMvp = await createFixture("__readiness_test_strict_mvp", {
    missingRequiredFile: true,
  });
  const strictMvpRun = run(["--path", strictMvp.artifactPath, "--run", "__readiness_test_strict_mvp", "--write"]);
  expectExit("strict MVP", strictMvpRun.status, 1);

  const publicCopyMojibake = await createFixture("__readiness_test_public_copy_mojibake", {
    publicCopyMojibake: true,
  });
  const publicCopyMojibakeRun = run([
    "--path",
    publicCopyMojibake.artifactPath,
    "--run",
    "__readiness_test_public_copy_mojibake",
    "--write",
  ]);
  expectExit("public copy mojibake", publicCopyMojibakeRun.status, 1);
  if (!publicCopyMojibakeRun.stdout.includes("public_copy.text_quality")) {
    throw new Error("public copy mojibake: expected public_copy.text_quality blocker");
  }

  const artifactSourceMojibake = await createFixture("__readiness_test_artifact_source_mojibake", {
    artifactSourceMojibake: true,
  });
  const artifactSourceMojibakeRun = run([
    "--path",
    artifactSourceMojibake.artifactPath,
    "--run",
    "__readiness_test_artifact_source_mojibake",
    "--write",
  ]);
  expectExit("artifact source mojibake", artifactSourceMojibakeRun.status, 1);
  if (!artifactSourceMojibakeRun.stdout.includes("mvp.artifact_text_quality")) {
    throw new Error("artifact source mojibake: expected mvp.artifact_text_quality blocker");
  }

  for (const fixture of [
    positive,
    missingPublisher,
    unresolvedReview,
    resolvedReview,
    strictMvp,
    publicCopyMojibake,
    artifactSourceMojibake,
  ]) {
    await rm(fixture.runRoot, { recursive: true, force: true });
  }

  console.log("publish readiness tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
