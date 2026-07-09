import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defaultResearchCachePath, readResearchCache, type ResearchCacheSignal } from "./research-cache";
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
    source: values.get("source") ?? "github",
    input: values.get("input") ?? "",
    cache: values.get("cache") ?? defaultResearchCachePath,
    planner: values.get("planner") ?? "deterministic",
    limit: values.get("limit") ?? "8",
    projectCount: values.get("project-count") ?? "",
    agentSelection: values.get("agent-selection") ?? "rotation",
    generate: values.get("generate") !== "false",
  };
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const runNpm = async (args: string[]) => {
  const command = process.platform === "win32" ? "cmd.exe" : npmCommand;
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/c", [npmCommand, ...args].join(" ")]
      : args;
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

  return stdout;
};

const sourceToInput = (source: string, explicitInput: string) => {
  if (explicitInput) {
    return explicitInput;
  }

  switch (source) {
    case "cache":
      return "artifacts/research-cache/demo-signals.json";
    case "openai":
      return "data/ai-release-signals.json";
    case "google":
      return "data/google-ai-signals.json";
    case "hn":
      return "data/hn-signals.json";
    case "mock":
      return "data/mock-signals.json";
    case "github":
    default:
      return "data/github-signals.json";
  }
};

const fetchSource = async (source: string, limit: string) => {
  switch (source) {
    case "github":
      await runNpm(["run", "fetch:github-signals", "--", "--limit", limit]);
      break;
    case "openai":
      await runNpm(["run", "fetch:ai-release-signals", "--", "--limit", limit]);
      break;
    case "google":
      await runNpm(["run", "fetch:google-ai-signals", "--", "--limit", limit]);
      break;
    case "hn":
      await runNpm(["run", "fetch:hn-signals", "--", "--limit", limit]);
      break;
    case "mock":
    case "file":
    case "cache":
      break;
    default:
      throw new Error(`Unknown source: ${source}`);
  }
};

const toSignalFileItem = (signal: ResearchCacheSignal) => ({
  id: signal.id,
  sourceType: signal.sourceType,
  sourceName: signal.sourceName,
  title: signal.title,
  summary: signal.summary,
  url: signal.url || null,
  observedAt: signal.observedAt,
  topics: signal.topics,
  audience: signal.audience,
  metrics: {
    cachedScore: signal.score ?? 0,
    sourceReasonCount: signal.scoreReasons?.length ?? 0,
  },
  whyItMatters: signal.whyItMatters,
  prototypeHint:
    signal.researchNote ||
    `Turn this cached ${signal.sourceType} signal into a one-screen, inspectable Hackbase.ai artifact.`,
  riskNotes: signal.riskNotes,
  rawExcerpt: signal.researchNote,
});

const materializeCacheSignals = async (cachePath: string, outputPath: string, limit: string) => {
  const cache = await readResearchCache(cachePath);

  if (!cache) {
    throw new Error(`Research cache not found: ${cachePath}. Run npm run research:cache:refresh first.`);
  }

  const refreshedAt = new Date(cache.lastRefreshedAt);
  const maxAgeMs = cache.cachePolicy.maxAgeHours * 60 * 60 * 1000;
  const ageMs = Date.now() - refreshedAt.getTime();

  if (Number.isNaN(refreshedAt.getTime())) {
    throw new Error(`Research cache has an invalid lastRefreshedAt: ${cache.lastRefreshedAt}`);
  }

  if (ageMs > maxAgeMs) {
    throw new Error(
      `Research cache is stale: lastRefreshedAt=${cache.lastRefreshedAt}, maxAgeHours=${cache.cachePolicy.maxAgeHours}. Run npm run research:cache:refresh first.`,
    );
  }

  if (cache.sourceProductIndex.status !== "loaded" || cache.sourceProductIndex.entryCount < 1) {
    throw new Error("Research cache must include a loaded sourceProductIndex with at least one entry.");
  }

  const count = Math.max(1, Number.parseInt(limit, 10) || cache.signals.length);
  const signals = cache.signals.slice(0, count).map(toSignalFileItem);

  if (signals.length < cache.cachePolicy.minimumSignals) {
    throw new Error(
      `Research cache has too few signals for demo generation: ${signals.length}/${cache.cachePolicy.minimumSignals}.`,
    );
  }

  const output = {
    version: "1",
    generatedAt: new Date().toISOString(),
    generatedFrom: {
      cachePath,
      lastRefreshedAt: cache.lastRefreshedAt,
      sourceProductIndex: cache.sourceProductIndex,
      trendSummary: cache.trendSummary,
    },
    signals,
  };
  const resolved = path.resolve(process.cwd(), outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Materialized cached research signals: ${outputPath}`);
  console.log(`Research cache: ${cachePath}`);
  console.log(`Cached signals: ${signals.length}`);
};

async function main() {
  const args = parseArgs();
  const input = sourceToInput(args.source, args.input);

  if (args.source === "cache") {
    await materializeCacheSignals(args.cache, input, args.limit);
  }

  await fetchSource(args.source, args.limit);

  if (args.planner === "llm") {
    try {
      await runNpm(["run", "plan:signals:llm", "--", "--input", input, "--output", "data/llm-plan-output.json"]);

      if (process.env.OPENAI_API_KEY) {
        const materializeStdout = await runNpm([
          "run",
          "plan:signals:llm:materialize",
          "--",
          "--input",
          "data/llm-plan-output.json",
        ]);
        const llmRunId = materializeStdout.match(/Materialized LLM planning run (run_[^\s]+)/)?.[1];

        if (!llmRunId) {
          throw new Error("LLM materialization did not return a run id.");
        }

        if (args.generate) {
          await runNpm(["run", "generate:briefs", "--", "--run", llmRunId]);
        }

        console.log(`Pipeline run: ${llmRunId}`);
        console.log(`Open: http://localhost:3000/runs/${llmRunId}`);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`LLM planner failed; falling back to deterministic planner. ${message}`);
    }

    if (!process.env.OPENAI_API_KEY) {
      console.log("OPENAI_API_KEY is not set; wrote LLM dry-run prompt and falling back to deterministic planner.");
    }
  }

  const planArgs = ["run", "plan:signals", "--", "--input", input];
  if (args.projectCount) {
    planArgs.push("--project-count", args.projectCount);
  }
  if (args.agentSelection) {
    planArgs.push("--agent-selection", args.agentSelection);
  }
  const planStdout = await runNpm(planArgs);
  const runId = planStdout.match(/Created planning run (run_[^\s]+)/)?.[1];

  if (!runId) {
    throw new Error("plan:signals did not return a run id.");
  }

  if (args.generate) {
    await runNpm(["run", "generate:briefs", "--", "--run", runId]);
  }

  console.log(`Pipeline run: ${runId}`);
  console.log(`Open: http://localhost:3000/runs/${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
