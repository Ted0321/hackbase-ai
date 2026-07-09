import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type StepResult = {
  command: string[];
  exitCode: number | null;
  name: string;
  output: string;
  status: "pass" | "fail";
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const artifactPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  if (!artifactPath) {
    console.error(
      "Usage: tsx scripts/prepare-auto-publish-evidence.ts --path <artifact-dir> --run <runId> [--write]",
    );
    process.exit(1);
  }

  return {
    artifactPath,
    runId: typeof values.get("run") === "string" ? String(values.get("run")) : "",
    write: values.get("write") === true,
  };
};

const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const runStep = (name: string, args: string[]): StepResult => {
  const command = [process.execPath, tsxCli, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  process.stdout.write(output);
  if (output && !output.endsWith("\n")) process.stdout.write("\n");
  return {
    command,
    exitCode: result.status,
    name,
    output,
    status: result.status === 0 ? "pass" : "fail",
  };
};

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = async () => {
  const args = parseArgs();
  const runId = args.runId || path.basename(path.dirname(path.dirname(path.resolve(args.artifactPath))));
  const runRoot = path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId);
  const materializedDir = args.artifactPath.replace(/\\/g, "/");
  const writeFlag = args.write ? ["--write"] : [];
  const steps: StepResult[] = [];

  steps.push(
    runStep("mvp_artifact", [
      "scripts/check-mvp-artifact.ts",
      "--path",
      materializedDir,
      "--strict-auto-publish",
      "--json-only",
    ]),
  );
  steps.push(
    runStep("mvp_contract_v2", [
      "scripts/check-mvp-contract-v2.ts",
      "--path",
      materializedDir,
      ...writeFlag,
      "--json-only",
    ]),
  );
  steps.push(
    runStep("interaction_proof", [
      "scripts/check-interaction-proof.ts",
      "--path",
      materializedDir,
      ...writeFlag,
    ]),
  );
  steps.push(
    runStep("render_verification", [
      "scripts/render-materialized-artifact.ts",
      "--path",
      materializedDir,
      ...writeFlag,
    ]),
  );

  const validationStatus = steps.every((step) => step.status === "pass") ? "pass" : "fail";
  const summaryPath = path.join(runRoot, "validation-summary.json");
  if (args.write) {
    await writeJson(summaryPath, {
      version: 1,
      runId,
      generatedAt: new Date().toISOString(),
      validator: "prepare-auto-publish-evidence",
      status: validationStatus,
      materializedDir,
      checks: steps.map((step) => ({
        name: step.name,
        status: step.status,
        exitCode: step.exitCode,
        command: step.command.slice(1),
        output: step.output.slice(0, 6000),
      })),
    });
  }

  steps.push(
    runStep("publish_readiness", [
      "scripts/check-publish-readiness.ts",
      "--path",
      materializedDir,
      "--run",
      runId,
      ...writeFlag,
    ]),
  );

  const failed = steps.filter((step) => step.status === "fail");
  console.log("");
  console.log(
    `Auto-publish evidence preparation: ${failed.length === 0 ? "PASS" : "FAIL"} (${failed.length} failed step(s))`,
  );
  if (args.write) {
    console.log(`Validation summary: ${path.relative(process.cwd(), summaryPath).replace(/\\/g, "/")}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
