import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultResearchCachePath } from "./research-cache";
import "./load-local-env";

const execFileAsync = promisify(execFile);

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item.startsWith("--")) {
      values.set(item.slice(2), raw[index + 1] ?? "");
      index += 1;
    }
  }

  return {
    cache: values.get("cache") ?? defaultResearchCachePath,
    planner: values.get("planner") ?? "deterministic",
    limit: values.get("limit") ?? "8",
    projectCount: values.get("project-count") ?? "1",
    agentSelection: values.get("agent-selection") ?? "rotation",
  };
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const runNpm = async (args: string[]) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const commandArgs =
    process.platform === "win32" ? ["/d", "/c", [npmCommand, ...args].join(" ")] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  return stdout;
};

async function main() {
  const args = parseArgs();
  await runNpm(["run", "research:cache:check", "--", "--cache", args.cache]);

  const stdout = await runNpm([
    "run",
    "pipeline:signals",
    "--",
    "--source",
    "cache",
    "--cache",
    args.cache,
    "--planner",
    args.planner,
    "--limit",
    args.limit,
    "--project-count",
    args.projectCount,
    "--agent-selection",
    args.agentSelection,
    "--generate",
    "true",
  ]);
  const runId = stdout.match(/Pipeline run: (run_[^\s]+)/)?.[1];

  if (!runId) {
    throw new Error("pipeline:signals did not return a run id.");
  }

  console.log(`Demo run: ${runId}`);
  console.log(`Open: http://localhost:3000/runs/${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
