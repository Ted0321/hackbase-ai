import { defaultResearchCachePath, readResearchCache, type ResearchCache } from "./research-cache";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
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

  const path = values.get("path") ?? values.get("cache") ?? defaultResearchCachePath;

  return {
    path: String(path),
    maxAgeHours: Number.parseFloat(String(values.get("max-age-hours") ?? "36")),
    minSignals: Number.parseInt(String(values.get("min-signals") ?? "5"), 10),
    minSources: Number.parseInt(String(values.get("min-sources") ?? "2"), 10),
    json: values.get("json") === true || values.get("json") === "true",
  };
};

const hoursSince = (isoString: string) => {
  const time = Date.parse(isoString);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / (1000 * 60 * 60);
};

const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim().length > 0;

const validateSignalShape = (cache: ResearchCache) =>
  cache.signals.every(
    (signal) =>
      nonEmptyString(signal.id) &&
      nonEmptyString(signal.title) &&
      nonEmptyString(signal.sourceType) &&
      Array.isArray(signal.topics) &&
      Array.isArray(signal.audience),
  );

const checkCache = (cache: ResearchCache | null, args: ReturnType<typeof parseArgs>): CheckResult[] => {
  if (!cache) {
    return [
      {
        name: "cache_exists",
        ok: false,
        detail: `Research cache not found: ${args.path}`,
      },
    ];
  }

  const ageHours = hoursSince(cache.lastRefreshedAt);
  const loadedSourceCount = cache.sources.filter((source) => source.status === "loaded").length;

  return [
    {
      name: "cache_exists",
      ok: true,
      detail: args.path,
    },
    {
      name: "schema_version",
      ok: cache.version === 1,
      detail: `version=${cache.version}`,
    },
    {
      name: "last_refreshed_at",
      ok: nonEmptyString(cache.lastRefreshedAt) && Number.isFinite(Date.parse(cache.lastRefreshedAt)),
      detail: cache.lastRefreshedAt,
    },
    {
      name: "freshness",
      ok: ageHours <= args.maxAgeHours,
      detail: `ageHours=${ageHours.toFixed(2)} maxAgeHours=${args.maxAgeHours}`,
    },
    {
      name: "sources",
      ok: loadedSourceCount >= args.minSources,
      detail: `loaded=${loadedSourceCount} min=${args.minSources}`,
    },
    {
      name: "signals",
      ok: cache.signals.length >= args.minSignals,
      detail: `signals=${cache.signals.length} min=${args.minSignals}`,
    },
    {
      name: "signal_shape",
      ok: validateSignalShape(cache),
      detail: "signals require id, title, sourceType, topics, and audience",
    },
    {
      name: "trend_summary",
      ok:
        cache.trendSummary.signalCount === cache.signals.length &&
        Array.isArray(cache.trendSummary.sourceTypes) &&
        Array.isArray(cache.trendSummary.highlights),
      detail: `summarySignals=${cache.trendSummary.signalCount} highlights=${cache.trendSummary.highlights.length}`,
    },
    {
      name: "source_product_index",
      ok: cache.sourceProductIndex.status === "loaded" && cache.sourceProductIndex.entryCount > 0,
      detail: `${cache.sourceProductIndex.status} entries=${cache.sourceProductIndex.entryCount}`,
    },
    {
      name: "cache_policy",
      ok:
        cache.cachePolicy.cadence === "daily" &&
        cache.cachePolicy.maxAgeHours > 0 &&
        cache.cachePolicy.minimumSignals > 0,
      detail: `cadence=${cache.cachePolicy.cadence} maxAgeHours=${cache.cachePolicy.maxAgeHours}`,
    },
  ];
};

async function main() {
  const args = parseArgs();
  const cache = await readResearchCache(args.path);
  const results = checkCache(cache, args);
  const failed = results.filter((result) => !result.ok);

  if (args.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    }
    console.log(`Research cache check: ${results.length - failed.length}/${results.length} passed`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
