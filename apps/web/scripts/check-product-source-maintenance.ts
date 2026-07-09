import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildIndexFromTables } from "./source-product-index-tables";
import { defaultResearchCachePath, readResearchCache } from "./research-cache";

type CheckStatus = "pass" | "warn" | "fail";

type CheckResult = {
  status: CheckStatus;
  label: string;
  detail: string;
};

type ProductSourceIndex = {
  updatedAt?: string;
  entries?: Array<{
    id?: string;
    name?: string;
    sourceCategory?: string;
    canonicalKey?: string;
    coreMechanism?: string;
    whyItGotAttention?: string;
    transferableStructure?: string;
    antiCloneBoundary?: string;
    attentionProof?: string[];
    evidenceRefs?: string[];
    evidenceStrength?: string;
    evidenceLevel?: string;
    observedFields?: string[];
    inferredFields?: string[];
    missingFields?: string[];
    usePolicy?: string;
  }>;
  sourceArchiveIndex?: unknown[];
  valueKnowledgeCards?: unknown[];
};

type SchedulerState = {
  lastCompletedAt?: string;
  lastStatus?: string;
  nextDueAt?: string;
  history?: Array<{
    status?: string;
    sourceProductEntryCount?: number;
    completedAt?: string;
  }>;
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
    index: String(values.get("index") ?? "data/product-research/source-product-index.json"),
    tablesDir: String(values.get("tables-dir") ?? "data/product-research/index-tables"),
    cache: String(values.get("cache") ?? defaultResearchCachePath),
    schedulerState: String(values.get("scheduler-state") ?? "data/scheduler/research-cache-daily.json"),
    minEntries: Number.parseInt(String(values.get("min-entries") ?? "30"), 10),
    maxIndexAgeDays: Number.parseFloat(String(values.get("max-index-age-days") ?? "14")),
    json: values.get("json") === true || values.get("json") === "true",
  };
};

const readJsonOptional = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const result = (status: CheckStatus, label: string, detail: string): CheckResult => ({
  status,
  label,
  detail,
});

const ageDays = (isoString: string | undefined) => {
  const time = Date.parse(isoString ?? "");
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / (1000 * 60 * 60 * 24);
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const checkProductRows = (index: ProductSourceIndex | null) => {
  const entries = index?.entries ?? [];
  const missingRequired = entries.filter(
    (entry) =>
      !text(entry.id) ||
      !text(entry.name) ||
      !text(entry.sourceCategory) ||
      !text(entry.coreMechanism) ||
      !text(entry.whyItGotAttention) ||
      !text(entry.transferableStructure) ||
      !text(entry.antiCloneBoundary),
  );
  const weakEvidence = entries.filter(
    (entry) =>
      !Array.isArray(entry.evidenceRefs) ||
      entry.evidenceRefs.length === 0 ||
      !Array.isArray(entry.attentionProof) ||
      entry.attentionProof.length === 0,
  );
  const highEvidence = entries.filter((entry) => entry.evidenceStrength === "high").length;
  const missingProvenance = entries.filter(
    (entry) =>
      !["A", "B", "C", "D"].includes(text(entry.evidenceLevel)) ||
      !Array.isArray(entry.observedFields) ||
      !Array.isArray(entry.inferredFields) ||
      !Array.isArray(entry.missingFields) ||
      !["primary_source_core", "weak_context", "candidate_only", "exclude"].includes(text(entry.usePolicy)),
  );
  const nonPrimaryInIndex = entries.filter((entry) => text(entry.usePolicy) && text(entry.usePolicy) !== "primary_source_core");
  const weakPrimaryEvidence = entries.filter(
    (entry) => text(entry.usePolicy) === "primary_source_core" && ["C", "D"].includes(text(entry.evidenceLevel)),
  );

  return { missingRequired, weakEvidence, highEvidence, missingProvenance, nonPrimaryInIndex, weakPrimaryEvidence };
};

const main = async () => {
  const args = parseArgs();
  const checks: CheckResult[] = [];
  let builtIndex: ProductSourceIndex | null = null;

  try {
    builtIndex = (await buildIndexFromTables(args.tablesDir, args.index, true, false)) as ProductSourceIndex;
    checks.push(result("pass", "TSV source of truth builds", `${args.tablesDir} -> ${builtIndex.entries?.length ?? 0} entries`));
  } catch (error) {
    checks.push(
      result(
        "fail",
        "TSV source of truth builds",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const index = await readJsonOptional<ProductSourceIndex>(args.index);
  const indexEntries = index?.entries?.length ?? 0;
  const cache = await readResearchCache(args.cache);
  const schedulerState = await readJsonOptional<SchedulerState>(args.schedulerState);
  const rowChecks = checkProductRows(index);
  const indexAge = ageDays(index?.updatedAt);
  const archiveCount = index?.sourceArchiveIndex?.length ?? 0;
  const cacheEntryCount = cache?.sourceProductIndex.entryCount ?? 0;
  const latestSchedulerEntryCount = schedulerState?.history?.find((item) => item.status === "completed")?.sourceProductEntryCount;

  checks.push(
    result(index ? "pass" : "fail", "Generated JSON exists", index ? args.index : `${args.index} is missing or invalid`),
    result(
      indexEntries >= args.minEntries ? "pass" : "fail",
      "Source product entry floor",
      `entries=${indexEntries} min=${args.minEntries}`,
    ),
    result(
      Number.isFinite(indexAge) && indexAge <= args.maxIndexAgeDays ? "pass" : "warn",
      "Source product index freshness",
      `updatedAt=${index?.updatedAt ?? "missing"} ageDays=${Number.isFinite(indexAge) ? indexAge.toFixed(2) : "invalid"} max=${args.maxIndexAgeDays}`,
    ),
    result(
      archiveCount >= indexEntries ? "pass" : "warn",
      "Evidence coverage",
      `sourceArchiveIndex=${archiveCount} entries=${indexEntries}`,
    ),
    result(
      rowChecks.missingRequired.length === 0 ? "pass" : "fail",
      "Required source-card fields",
      rowChecks.missingRequired.length === 0
        ? "all entries have core mechanism, attention reason, transfer structure, and anti-clone boundary"
        : `${rowChecks.missingRequired.length} entries are missing required fields: ${rowChecks.missingRequired.slice(0, 5).map((entry) => entry.id ?? entry.name).join(", ")}`,
    ),
    result(
      rowChecks.weakEvidence.length === 0 ? "pass" : "warn",
      "Evidence refs and attention proof",
      rowChecks.weakEvidence.length === 0
        ? "all entries include evidenceRefs and attentionProof"
        : `${rowChecks.weakEvidence.length} entries need stronger evidence metadata: ${rowChecks.weakEvidence.slice(0, 5).map((entry) => entry.id ?? entry.name).join(", ")}`,
    ),
    result(
      rowChecks.highEvidence > 0 ? "pass" : "warn",
      "High-confidence source cards",
      `highEvidence=${rowChecks.highEvidence}`,
    ),
    result(
      rowChecks.missingProvenance.length === 0 ? "pass" : "warn",
      "Evidence provenance metadata",
      rowChecks.missingProvenance.length === 0
        ? "all entries declare evidenceLevel, observedFields, inferredFields, missingFields, and usePolicy"
        : `${rowChecks.missingProvenance.length} entries need P0 provenance metadata: ${rowChecks.missingProvenance.slice(0, 5).map((entry) => entry.id ?? entry.name).join(", ")}`,
    ),
    result(
      rowChecks.nonPrimaryInIndex.length === 0 ? "pass" : "warn",
      "Index usePolicy scope",
      rowChecks.nonPrimaryInIndex.length === 0
        ? "all indexed entries are primary_source_core or legacy-unclassified"
        : `${rowChecks.nonPrimaryInIndex.length} non-primary entries are present in the main index: ${rowChecks.nonPrimaryInIndex.slice(0, 5).map((entry) => entry.id ?? entry.name).join(", ")}`,
    ),
    result(
      rowChecks.weakPrimaryEvidence.length === 0 ? "pass" : "fail",
      "Primary source evidence level",
      rowChecks.weakPrimaryEvidence.length === 0
        ? "primary_source_core entries are not marked C/D evidence"
        : `${rowChecks.weakPrimaryEvidence.length} primary entries are marked C/D evidence: ${rowChecks.weakPrimaryEvidence.slice(0, 5).map((entry) => entry.id ?? entry.name).join(", ")}`,
    ),
    result(
      cache?.sourceProductIndex.status === "loaded" ? "pass" : "fail",
      "Research cache includes source index",
      cache ? `${cache.sourceProductIndex.status} entries=${cacheEntryCount}` : `${args.cache} is missing`,
    ),
    result(
      cacheEntryCount === indexEntries ? "pass" : "fail",
      "Cache/index entry count match",
      `cache=${cacheEntryCount} index=${indexEntries}`,
    ),
    result(
      schedulerState ? "pass" : "warn",
      "Research scheduler state exists",
      schedulerState
        ? `lastStatus=${schedulerState.lastStatus ?? "unknown"} nextDueAt=${schedulerState.nextDueAt ?? "unknown"}`
        : `${args.schedulerState} is missing`,
    ),
    result(
      latestSchedulerEntryCount === undefined || latestSchedulerEntryCount === indexEntries ? "pass" : "warn",
      "Scheduler history entry count",
      latestSchedulerEntryCount === undefined
        ? "no completed scheduler history with sourceProductEntryCount yet"
        : `latestSchedulerEntryCount=${latestSchedulerEntryCount} currentIndex=${indexEntries}`,
    ),
  );

  const failed = checks.filter((check) => check.status === "fail");

  if (args.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
    }
    console.log(`Product source maintenance check: ${checks.length - failed.length}/${checks.length} non-failing`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
