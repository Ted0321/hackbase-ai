import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), "artifacts", "llm-pipeline-runs");
const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const run = (args: string[]) =>
  spawnSync(process.execPath, [tsxCli, "scripts/render-materialized-artifact.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
    timeout: 90_000,
  });

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createFixture = async (runId: string, source: string, proofSelectors = ["button[data-proof='primary-action']", "[data-proof='result']"]) => {
  const runRoot = path.join(root, runId);
  const artifactDir = path.join(runRoot, "materialized", "artifact");
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(path.join(artifactDir, "source", "app"), { recursive: true });

  await writeJson(path.join(artifactDir, "manifest.json"), {
    entrypoint: "source/app/page.tsx",
  });
  await writeJson(path.join(artifactDir, "metadata.json"), {
    version: 1,
    artifactId: "artifact",
    interactionProofPlan: {
      primaryAction: "Reveal result",
      initialState: "Before result",
      expectedState: "After result",
      visibleEvidence: ["After result"],
      proofSelectors,
      requiredSourceFiles: ["source/app/page.tsx"],
    },
  });
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
  const passing = await createFixture(
    "__render_artifact_test_passing",
    [
      '"use client";',
      'import { useState } from "react";',
      "export default function Page() {",
      '  const [open, setOpen] = useState(false);',
      "  return (",
      "    <main>",
      '      <button data-proof="primary-action" onClick={() => setOpen(true)}>Reveal result</button>',
      '      <p data-proof="result">{open ? "After result" : "Before result"}</p>',
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  const passingRun = run(["--path", passing.artifactPath, "--write"]);
  expectExit("passing render smoke", passingRun.status, 0);
  if (!passingRun.stdout.includes('"interaction.state_change"') || !passingRun.stdout.includes('"render.screenshot"')) {
    throw new Error("passing render smoke: expected interaction and screenshot checks in output");
  }
  if (!existsSync(path.join(passing.artifactDir, "validation", "render-verification.json"))) {
    throw new Error("passing render smoke: expected validation/render-verification.json");
  }

  const nonButtonClickable = await createFixture(
    "__render_artifact_test_non_button_clickable",
    [
      '"use client";',
      'import { useState } from "react";',
      "export default function Page() {",
      '  const [open, setOpen] = useState(false);',
      "  return (",
      "    <main>",
      '      <div data-proof="primary-action" role="button" tabIndex={0} onClick={() => setOpen(true)}>Open proof result</div>',
      '      <p data-proof="result">{open ? "After result" : "Before result"}</p>',
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
    ["[data-proof='primary-action']", "[data-proof='result']"],
  );
  const nonButtonClickableRun = run(["--path", nonButtonClickable.artifactPath, "--write"]);
  expectExit("non-button clickable render smoke", nonButtonClickableRun.status, 0);

  const failing = await createFixture(
    "__render_artifact_test_static",
    [
      "export default function Page() {",
      "  return (",
      "    <main>",
      '      <button data-proof="primary-action">Reveal result</button>',
      '      <p data-proof="result">Before result</p>',
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  const failingRun = run(["--path", failing.artifactPath]);
  expectExit("static render smoke", failingRun.status, 1);
  if (!failingRun.stdout.includes('"interaction.state_change"')) {
    throw new Error("static render smoke: expected interaction.state_change failure in output");
  }

  await rm(passing.runRoot, { recursive: true, force: true });
  await rm(nonButtonClickable.runRoot, { recursive: true, force: true });
  await rm(failing.runRoot, { recursive: true, force: true });

  console.log("render materialized artifact tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
