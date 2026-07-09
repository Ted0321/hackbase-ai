import { spawn } from "node:child_process";
import path from "node:path";
import { createRunId, ensureRun } from "./shared";
import { pipelineSteps } from "./types";

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", script, ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} exited with ${code}`));
      }
    });
  });

async function main() {
  const runId = createRunId();
  await ensureRun(runId);

  for (const step of pipelineSteps) {
    await runTsx(path.join("scripts", "llm-pipeline", "prepare-step.ts"), [
      "--run",
      runId,
      "--step",
      step,
    ]);
  }

  console.log("");
  console.log("LLM pipeline demo drive prepared.");
  console.log(`Run: ${runId}`);
  console.log(`Root: artifacts/llm-pipeline-runs/${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
