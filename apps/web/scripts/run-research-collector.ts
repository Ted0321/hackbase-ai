import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "./load-local-env";

const execFileAsync = promisify(execFile);

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return {
    limit: String(values.get("limit") ?? "8"),
    skipFetch: values.get("skip-fetch") === true || values.get("skip-fetch") === "true",
  };
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const runNpm = async (args: string[]) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const commandArgs = process.platform === "win32" ? ["/d", "/c", [npmCommand, ...args].join(" ")] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 1024 * 1024 * 5,
  });

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (stdout.trim()) {
    console.log(stdout.trim());
  }
};

async function main() {
  const args = parseArgs();

  if (!args.skipFetch) {
    await runNpm(["run", "fetch:github-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:hn-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:ai-release-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:anthropic-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:google-ai-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:product-market-signals", "--", "--limit", args.limit]);
    await runNpm(["run", "fetch:japan-trend-signals", "--", "--limit", args.limit]);
  }

  await runNpm(["run", "research:collect"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
