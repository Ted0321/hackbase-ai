import { spawn } from "node:child_process";
import path from "node:path";
import "./load-local-env";

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasFlag = (flag: string) => process.argv.includes(flag);

const pad = (value: number) => String(value).padStart(2, "0");

const stamp = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
};

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
        },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });

async function main() {
  const agentId = arg("--agent");
  if (!agentId) {
    throw new Error("Usage: tsx scripts/run-one-agent-manual-trigger.ts --agent <agentId> [--run <runId>] [--steps research,combination,concept,requirements,builder] [--write] [--publish]");
  }

  const write = hasFlag("--write");
  const publish = hasFlag("--publish");
  const steps = arg("--steps") ?? "research,combination,concept,requirements,builder";
  const runId = arg("--run") ?? `run_manual_${agentId}_${stamp()}`;

  const args = [
    "--agent",
    agentId,
    "--run",
    runId,
    "--steps",
    steps,
    ...(!write ? ["--dry-run", "--skip-learning-refresh"] : []),
    ...(publish ? ["--publish"] : []),
  ];

  console.log(`[manual-agent-trigger] agent=${agentId} run=${runId} write=${write} publish=${publish}`);
  console.log(
    write
      ? "[manual-agent-trigger] write mode: this may call the LLM and create local run artifacts; publish mode may write DB rows after gates pass."
      : "[manual-agent-trigger] dry-run mode: prepares prompts only; no LLM call, no publish, no scheduler resume.",
  );
  console.log(`[manual-agent-trigger] command: tsx scripts/run-agent-self-directed.ts ${args.join(" ")}`);

  if (write) {
    await runTsx("scripts/check-one-agent-manual-go.ts", [
      "--agent",
      agentId,
      "--run",
      runId,
      "--write",
      ...(publish ? ["--publish"] : []),
    ]);
  }

  await runTsx("scripts/run-agent-self-directed.ts", args);

  console.log("");
  console.log(`[manual-agent-trigger] done: /runs/${runId}`);
  console.log(`[manual-agent-trigger] artifacts: artifacts/llm-pipeline-runs/${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
