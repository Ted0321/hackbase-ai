import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defaultResearchCachePath, readResearchCache } from "./research-cache";
import "./load-local-env";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type PackageJson = {
  scripts?: Record<string, string>;
};

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
    cache: String(values.get("cache") ?? defaultResearchCachePath),
    generate: values.get("generate") === true || values.get("generate") === "true",
  };
};

const runNpm = async (args: string[]) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const commandArgs = process.platform === "win32" ? ["/d", "/c", [npmCommand, ...args].join(" ")] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
    maxBuffer: 1024 * 1024 * 12,
  });

  if (stderr.trim()) console.error(stderr.trim());
  if (stdout.trim()) console.log(stdout.trim());

  return stdout;
};

const readPackageJson = async () =>
  JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as PackageJson;

const hasText = async (filePath: string, pattern: RegExp) => {
  try {
    return pattern.test(await readFile(path.resolve(process.cwd(), filePath), "utf8"));
  } catch {
    return false;
  }
};

async function main() {
  const args = parseArgs();
  const packageJson = await readPackageJson();
  const scripts = packageJson.scripts ?? {};
  const cache = await readResearchCache(args.cache);
  const results: CheckResult[] = [];

  results.push({
    name: "cache_exists",
    ok: Boolean(cache),
    detail: args.cache,
  });

  if (cache) {
    const loadedSources = cache.sources.filter((source) => source.status === "loaded").length;
    results.push({
      name: "cache_freshness",
      ok:
        Number.isFinite(Date.parse(cache.lastRefreshedAt)) &&
        (Date.now() - Date.parse(cache.lastRefreshedAt)) / (1000 * 60 * 60) <= cache.cachePolicy.maxAgeHours,
      detail: `lastRefreshedAt=${cache.lastRefreshedAt} maxAgeHours=${cache.cachePolicy.maxAgeHours}`,
    });
    results.push({
      name: "cache_generation_inputs",
      ok:
        cache.signals.length >= cache.cachePolicy.minimumSignals &&
        loadedSources >= cache.cachePolicy.minimumSources &&
        cache.sourceProductIndex.status === "loaded" &&
        cache.sourceProductIndex.entryCount > 0,
      detail: `signals=${cache.signals.length} sources=${loadedSources} sourceProducts=${cache.sourceProductIndex.entryCount}`,
    });
  }

  for (const scriptName of [
    "research:cache:refresh",
    "research:cache:check",
    "demo:generate",
    "templates:diversity:check",
    "scheduler:research:daily",
    "scheduler:generate:daily",
  ]) {
    results.push({
      name: `script_${scriptName}`,
      ok: Boolean(scripts[scriptName]),
      detail: scripts[scriptName] ?? "missing",
    });
  }

  results.push({
    name: "operator_demo_generation",
    ok:
      await hasText("src/app/actions.ts", /runJudgeDemoGeneration/) &&
      Boolean(scripts["demo:generate"]) &&
      Boolean(scripts["llm:pipeline:run-gemini"]) &&
      Boolean(scripts["publish:evidence:prepare"]),
    detail: "operator/CLI generation path exists; judge-facing UI trigger is intentionally absent",
  });

  results.push({
    name: "template_pattern_evidence_visible",
    ok:
      (await hasText("../../docs/operations/DOC-103_Codex_Claude_Product_Generation_Runbook.md", /materialized artifact/)) &&
      (await hasText("scripts/plan-from-signals.ts", /templatePatternId/)) &&
      (await hasText("scripts/generate-from-briefs.ts", /templatePatternId/)),
    detail: "operator runbook and generation artifacts",
  });

  results.push({
    name: "template_pattern_pipeline",
    ok:
      (await hasText("scripts/plan-from-signals.ts", /chooseTemplatePatterns/)) &&
      (await hasText("scripts/generate-from-briefs.ts", /templatePatternId/)),
    detail: "planner and generator",
  });

  await runNpm(["run", "templates:diversity:check"]);

  if (args.generate) {
    const stdout = await runNpm(["run", "demo:generate"]);
    const runId =
      stdout.match(/Demo run: (run_[^\s]+)/)?.[1] ??
      stdout.match(/Pipeline run: (run_[^\s]+)/)?.[1];

    results.push({
      name: "demo_generate",
      ok: Boolean(runId),
      detail: runId ?? "run id missing",
    });
  }

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  console.log(`Judge demo check: ${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
