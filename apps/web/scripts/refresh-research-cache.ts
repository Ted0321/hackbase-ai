import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildResearchCache,
  defaultResearchCachePath,
  defaultResearchInputPath,
  readJsonOptional,
  writeResearchCache,
} from "./research-cache";
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
    output: String(values.get("output") ?? defaultResearchCachePath),
    fetch: values.get("fetch") === true || values.get("fetch") === "true",
    skipCollect: values.get("skip-collect") === true || values.get("skip-collect") === "true",
    limit: String(values.get("limit") ?? "8"),
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

  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
};

async function main() {
  const args = parseArgs();
  let mode: "local-cache" | "live-fetch" = "local-cache";

  if (args.fetch) {
    mode = "live-fetch";
    try {
      await runNpm(["run", "research:fetch", "--", "--limit", args.limit]);
    } catch (error) {
      mode = "local-cache";
      console.warn(`Live research fetch failed; falling back to local cache material. ${(error as Error).message}`);
    }
  }

  const currentInput = await readJsonOptional<unknown>(defaultResearchInputPath);
  if (!args.skipCollect && (!currentInput || args.fetch)) {
    try {
      await runNpm(["run", "research:collect"]);
    } catch (error) {
      console.warn(`Research collection failed; using available local material. ${(error as Error).message}`);
    }
  }

  const cache = await buildResearchCache({ mode });
  await writeResearchCache(cache, args.output);

  console.log(`Wrote research cache to ${args.output}`);
  console.log(`Signals: ${cache.signals.length}`);
  console.log(`Loaded sources: ${cache.sources.filter((source) => source.status === "loaded").length}`);
  console.log(`Source product entries: ${cache.sourceProductIndex.entryCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
