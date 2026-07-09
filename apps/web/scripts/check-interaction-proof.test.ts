import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type FixtureOptions = {
  omitProof?: boolean;
  missingEvidence?: boolean;
  missingSourceFile?: boolean;
  omitSelectors?: boolean;
};

const root = path.join(process.cwd(), "artifacts", "llm-pipeline-runs");
const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const run = (args: string[]) =>
  spawnSync(process.execPath, [tsxCli, "scripts/check-interaction-proof.ts", ...args], {
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

  const proof = options.omitProof
    ? {}
    : {
        interactionProofPlan: {
          primaryAction: "Pick route",
          initialState: "idle",
          expectedState: "selected route",
          visibleEvidence: ["selected route", "Priority lane"],
          ...(options.omitSelectors
            ? {}
            : { proofSelectors: ["button[data-proof='pick-route']", "[data-proof='result']"] }),
          requiredSourceFiles: [
            options.missingSourceFile ? "source/app/missing.tsx" : "source/app/page.tsx",
          ],
        },
      };

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
    ...proof,
  });

  const source = options.missingEvidence
    ? "export default function Page() { return <main><button>Pick route</button><p>idle</p></main>; }\n"
    : "export default function Page() { return <main><button data-proof='pick-route'>Pick route</button><p data-proof='initial'>idle</p><p data-proof='result'>selected route</p><span>Priority lane</span></main>; }\n";
  await writeFile(path.join(artifactDir, "source", "app", "page.tsx"), source, "utf8");

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
  const positive = await createFixture("__interaction_proof_test_positive");
  const positiveRun = run(["--path", positive.artifactPath, "--write"]);
  expectExit("positive", positiveRun.status, 0);
  if (!existsSync(path.join(positive.artifactDir, "validation", "interaction-proof.json"))) {
    throw new Error("positive: expected validation/interaction-proof.json to be written");
  }

  const noSelectors = await createFixture("__interaction_proof_test_no_selectors", {
    omitSelectors: true,
  });
  const noSelectorsRun = run(["--path", noSelectors.artifactPath]);
  expectExit("no selectors warning", noSelectorsRun.status, 0);
  if (!noSelectorsRun.stdout.includes('"result": "warn"')) {
    throw new Error("no selectors warning: expected result=warn");
  }

  const missingProof = await createFixture("__interaction_proof_test_missing_proof", {
    omitProof: true,
  });
  const missingProofRun = run(["--path", missingProof.artifactPath]);
  expectExit("missing proof", missingProofRun.status, 1);

  const missingEvidence = await createFixture("__interaction_proof_test_missing_evidence", {
    missingEvidence: true,
  });
  const missingEvidenceRun = run(["--path", missingEvidence.artifactPath]);
  expectExit("missing evidence", missingEvidenceRun.status, 1);

  const missingSourceFile = await createFixture("__interaction_proof_test_missing_source_file", {
    missingSourceFile: true,
  });
  const missingSourceFileRun = run(["--path", missingSourceFile.artifactPath]);
  expectExit("missing source file", missingSourceFileRun.status, 1);

  for (const fixture of [
    positive,
    noSelectors,
    missingProof,
    missingEvidence,
    missingSourceFile,
  ]) {
    await rm(fixture.runRoot, { recursive: true, force: true });
  }

  console.log("interaction proof tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
