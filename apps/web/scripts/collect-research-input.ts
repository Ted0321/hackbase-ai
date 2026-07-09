import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SignalFile = {
  fetchedAt?: string;
  source?: {
    type?: string;
    note?: string;
    query?: string;
    feeds?: string[];
    endpoints?: string[];
  };
  signals?: Array<{
    id?: string;
    sourceType?: string;
    sourceName?: string;
    title?: string;
    summary?: string;
    url?: string;
    observedAt?: string;
    topics?: string[];
    audience?: string[];
    metrics?: Record<string, unknown>;
    whyItMatters?: string;
    prototypeHint?: string;
    researchNote?: string;
    riskNotes?: string;
    rawExcerpt?: string;
  }>;
};

type SourceCatalog = {
  version: number;
  updatedAt: string;
  sourceGroups: Array<{
    id: string;
    lane: string;
    priority: "must" | "should" | "could" | string;
    depth: string;
    sources: Array<{
      name: string;
      url: string;
      checkFor: string[];
      notes: string;
    }>;
  }>;
};

type ExplorationFile = {
  version?: number;
  explorationRunId?: string;
  sourceCategory?: string;
  generatedAt?: string;
  sourceProductCards?: Array<{
    id?: string;
    name?: string;
    sourceType?: string;
    url?: string | null;
    oneLineDescription?: string;
    whyItIsInteresting?: string;
    adoptionOrAttentionProof?: string[];
    scaleClassification?: string;
    reasonIncluded?: string;
    transferableStructure?: string;
    confidence?: "low" | "medium" | "high";
  }>;
  sourceArchiveIndex?: Array<{
    id?: string;
    sourceProductCardId?: string;
    sourceCategory?: string;
    sourceName?: string;
    sourceUrl?: string | null;
    storedEvidenceSummary?: string;
    evidenceStrength?: "low" | "medium" | "high";
  }>;
  valueKnowledgeCards?: Array<{
    id?: string;
    sourceProductCardId?: string;
    valueName?: string;
    whatIsValuable?: string;
    whyPeopleReact?: string;
    underlyingMechanism?: string;
    transferableRule?: string;
    confidence?: "low" | "medium" | "high";
  }>;
  explorationReports?: Array<{
    id?: string;
    lane?: string;
    title?: string;
    sources?: Array<{
      title?: string;
      url?: string;
      sourceType?: string;
      evidenceSummary?: string;
    }>;
    observedFacts?: string[];
    interpretation?: string;
    trendSignal?: string;
    audienceReaction?: string;
    underlyingMechanism?: string;
    possibleUseContexts?: string[];
    conceptSeeds?: string[];
    uncertainties?: string[];
    riskNotes?: string[];
    scores?: Record<string, number>;
    evidenceStrength?: "low" | "medium" | "high";
  }>;
  coverageGaps?: string[];
  editorNotes?: string;
};

const defaultSignalFiles = [
  "data/github-signals.json",
  "data/hn-signals.json",
  "data/ai-release-signals.json",
  "data/anthropic-signals.json",
  "data/google-ai-signals.json",
  "data/product-market-signals.json",
  "data/japan-trend-signals.json",
];

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
    output: values.get("output") ?? "data/research-collector-input.json",
    shortlistSize: Math.max(1, Math.min(Number.parseInt(values.get("shortlist") ?? "12", 10), 20)),
    explorationDir: values.get("exploration-dir") ?? "data/research-exploration",
    sourceCatalog:
      values.get("source-catalog") ?? "scripts/llm-pipeline/fixtures/research-source-catalog.json",
    signalFiles: (values.get("signals") ?? defaultSignalFiles.join(","))
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean),
  };
};

const readJsonOptional = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

// Weekly refresh runs add a new exploration batch every time, so bundling every
// batch forever grows the research input (and the research step's prompt tokens)
// without bound. Keep only the newest batches; promoted cards from older batches
// already live in the product source index and are not lost.
const DEFAULT_EXPLORATION_MAX_BATCHES = 8;

const resolveExplorationMaxBatches = () => {
  const raw = process.env.PRODIA_EXPLORATION_MAX_BATCHES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_EXPLORATION_MAX_BATCHES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPLORATION_MAX_BATCHES;
  // 0 or negative disables the cap.
  return parsed;
};

// Batch recency comes from the timestamp embedded in the directory name (e.g.
// research_product_refresh_20260708T014022, research_explore_manual_20260708).
// File mtimes are unusable here: a fresh CI checkout stamps every file alike.
const batchTimestamp = (batchDirName: string) => {
  const match = batchDirName.match(/(20\d{6})(?:T(\d{4,6}))?/);
  if (!match) return 0;
  const [, day, time] = match;
  return Number.parseInt(`${day}${(time ?? "").padEnd(6, "0")}`, 10);
};

const keepNewestBatches = (root: string, responseFiles: string[], maxBatches: number) => {
  if (maxBatches <= 0) return responseFiles;

  const byBatch = new Map<string, string[]>();
  for (const filePath of responseFiles) {
    const batch = path.relative(root, filePath).split(path.sep)[0] ?? "";
    const files = byBatch.get(batch) ?? [];
    files.push(filePath);
    byBatch.set(batch, files);
  }
  if (byBatch.size <= maxBatches) return responseFiles;

  const keptBatches = [...byBatch.keys()]
    .sort((a, b) => batchTimestamp(b) - batchTimestamp(a) || b.localeCompare(a))
    .slice(0, maxBatches);
  console.log(
    `Exploration batches capped: keeping ${keptBatches.length}/${byBatch.size} newest (adjust with PRODIA_EXPLORATION_MAX_BATCHES).`,
  );
  return keptBatches.flatMap((batch) => byBatch.get(batch) ?? []);
};

const readExplorationFiles = async (dirPath: string) => {
  const root = path.resolve(process.cwd(), dirPath);

  try {
    const collectResponseFiles = async (currentDir: string): Promise<string[]> => {
      const entries = await readdir(currentDir, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const entryPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            return collectResponseFiles(entryPath);
          }

          return entry.isFile() && entry.name === "response.json" ? [entryPath] : [];
        }),
      );

      return nested.flat();
    };
    const responseFiles = keepNewestBatches(
      root,
      await collectResponseFiles(root),
      resolveExplorationMaxBatches(),
    );
    const loaded = await Promise.all(
      responseFiles.map(async (filePath) => ({
        filePath: path.relative(process.cwd(), filePath),
        payload: await readJsonOptional<ExplorationFile>(filePath),
      })),
    );

    return loaded.filter((entry): entry is { filePath: string; payload: ExplorationFile } =>
      Boolean(entry.payload),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const compactSignal = (signal: NonNullable<SignalFile["signals"]>[number], sourceFile: SignalFile) => ({
  id: signal.id ?? `${signal.sourceType ?? sourceFile.source?.type ?? "unknown"}_${signal.title ?? "untitled"}`,
  sourceType: signal.sourceType ?? sourceFile.source?.type ?? "unknown",
  sourceName: signal.sourceName ?? sourceFile.source?.type ?? "unknown",
  title: signal.title ?? "Untitled signal",
  summary: signal.summary ?? signal.rawExcerpt ?? "",
  url: signal.url ?? "",
  observedAt: signal.observedAt ?? sourceFile.fetchedAt ?? new Date(0).toISOString(),
  topics: signal.topics ?? [],
  audience: signal.audience ?? [],
  metrics: signal.metrics ?? {},
  whyItMatters: signal.whyItMatters ?? "",
  researchNote: signal.researchNote ?? signal.prototypeHint ?? "",
  riskNotes: signal.riskNotes ?? "",
});

type ResearchCandidate = {
  id: string;
  layer: "baseline" | "exploration";
  lane: string;
  sourceType: string;
  sourceName: string;
  title: string;
  summary: string;
  url: string;
  observedAt: string;
  topics: string[];
  audience: string[];
  metrics: Record<string, unknown>;
  whyItMatters: string;
  researchNote: string;
  riskNotes: string;
  sourceFile: string;
  score: number;
  scoreReasons: string[];
};

const laneForSourceType = (sourceType: string) => {
  if (["github_trending", "hacker_news_discussion", "official_ai_release", "anthropic_release", "google_ai_release"].includes(sourceType)) {
    return "tech_frontier";
  }

  if (sourceType === "product_market_watch") return "product_market_watch";
  if (sourceType === "japan_social_trend") return "social_trend";
  return "other";
};

const numericMetric = (metrics: Record<string, unknown>, key: string) => {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const scoreBaselineSignal = (signal: ReturnType<typeof compactSignal> & { sourceFile: string }) => {
  const reasons: string[] = [];
  let score = 0;

  if (signal.url) {
    score += 2;
    reasons.push("has_url");
  }

  if (signal.summary.length > 40) {
    score += 2;
    reasons.push("has_summary");
  }

  if (signal.topics.length > 0) {
    score += Math.min(3, signal.topics.length);
    reasons.push("has_topics");
  }

  if (signal.whyItMatters) {
    score += 2;
    reasons.push("has_why_it_matters");
  }

  if (signal.researchNote) {
    score += 1;
    reasons.push("has_research_note");
  }

  const sourceType = signal.sourceType;
  if (["official_ai_release", "anthropic_release", "google_ai_release"].includes(sourceType)) {
    score += 2;
    reasons.push("official_source");
  }

  if (sourceType === "github_trending") {
    const stars = numericMetric(signal.metrics, "stars");
    const starDelta7d = numericMetric(signal.metrics, "starDelta7d");
    const starVelocityScore = numericMetric(signal.metrics, "starVelocityScore");
    const activityScore = numericMetric(signal.metrics, "activityScore");
    const categoryNoveltyScore = numericMetric(signal.metrics, "categoryNoveltyScore");
    if (stars > 1000) {
      score += 2;
      reasons.push("high_star_repo");
    }
    if (starDelta7d > 0) {
      score += 3;
      reasons.push("star_growth_observed");
    }
    if (starVelocityScore >= 4) {
      score += 2;
      reasons.push("high_star_velocity");
    }
    if (activityScore >= 4) {
      score += 1;
      reasons.push("recent_repo_activity");
    }
    if (categoryNoveltyScore >= 4) {
      score += 2;
      reasons.push("category_novelty");
    }
  }

  if (sourceType === "hacker_news_discussion") {
    const points = numericMetric(signal.metrics, "points");
    const comments = numericMetric(signal.metrics, "comments");
    if (points + comments > 50) {
      score += 2;
      reasons.push("hn_attention");
    }
  }

  if (sourceType === "product_market_watch") {
    score += 2;
    reasons.push("market_signal");

    const reactionSignalScore = numericMetric(signal.metrics, "reactionSignalScore");
    const titleQualityScore = numericMetric(signal.metrics, "titleQualityScore");
    const daysSincePublished = signal.metrics.daysSincePublished;

    if (reactionSignalScore >= 4) {
      score += 2;
      reasons.push("launch_reaction_signal");
    }
    if (titleQualityScore <= 2) {
      score -= 2;
      reasons.push("weak_launch_title");
    }
    if (typeof daysSincePublished === "number" && daysSincePublished <= 7) {
      score += 1;
      reasons.push("fresh_launch");
    }
  }

  if (sourceType === "japan_social_trend") {
    score += 2;
    reasons.push("social_trend_signal");
  }

  if (/^\d+\.\s/.test(signal.title)) {
    score -= 2;
    reasons.push("title_needs_cleanup");
  }

  if (signal.title.toLowerCase().includes("javaguide")) {
    score -= 4;
    reasons.push("weak_query_match");
  }

  return { score, reasons };
};

const explorationScore = (report: NonNullable<ExplorationFile["explorationReports"]>[number]) => {
  const scores = report.scores ?? {};
  const numericScores = Object.values(scores).filter((value) => typeof value === "number");
  const base = numericScores.length > 0 ? numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length : 3;
  const evidenceBoost = report.evidenceStrength === "high" ? 3 : report.evidenceStrength === "medium" ? 1 : 0;
  const sourceBoost = Math.min(3, report.sources?.length ?? 0);

  return Math.round(base * 2 + evidenceBoost + sourceBoost);
};

const makeEditorShortlist = (
  baselineSignals: Array<ReturnType<typeof compactSignal> & { sourceFile: string }>,
  explorations: Array<{ filePath: string; payload: ExplorationFile }>,
  size: number,
) => {
  const baselineCandidates: ResearchCandidate[] = baselineSignals.map((signal) => {
    const scored = scoreBaselineSignal(signal);

    return {
      ...signal,
      layer: "baseline",
      lane: laneForSourceType(signal.sourceType),
      score: scored.score,
      scoreReasons: scored.reasons,
    };
  });
  const explorationCandidates: ResearchCandidate[] = explorations.flatMap((entry) =>
    (entry.payload.explorationReports ?? []).map((report) => ({
      id: report.id ?? `${entry.payload.explorationRunId ?? "exploration"}_${report.title ?? "untitled"}`,
      layer: "exploration" as const,
      lane: report.lane ?? "other",
      sourceType: "research_exploration",
      sourceName: entry.payload.explorationRunId ?? "Research Exploration",
      title: report.title ?? "Untitled exploration report",
      summary: report.interpretation ?? report.trendSignal ?? "",
      url: report.sources?.[0]?.url ?? "",
      observedAt: entry.payload.generatedAt ?? new Date(0).toISOString(),
      topics: [report.lane ?? "other"],
      audience: report.audienceReaction ? [report.audienceReaction] : [],
      metrics: report.scores ?? {},
      whyItMatters: report.trendSignal ?? "",
      researchNote: report.underlyingMechanism ?? "",
      riskNotes: (report.riskNotes ?? []).join(" / "),
      sourceFile: entry.filePath,
      score: explorationScore(report),
      scoreReasons: ["exploration_report", `evidence_${report.evidenceStrength ?? "unknown"}`],
    })),
  );
  const all = [...baselineCandidates, ...explorationCandidates].sort((a, b) => b.score - a.score);
  const selected: ResearchCandidate[] = [];
  const seen = new Set<string>();
  const lanes = [...new Set(all.map((candidate) => candidate.lane))];
  const minimumPerLane = Math.max(1, Math.floor(size / Math.max(1, lanes.length + 1)));

  for (const lane of lanes) {
    const laneCandidates = all.filter((candidate) => candidate.lane === lane).slice(0, minimumPerLane);

    for (const candidate of laneCandidates) {
      selected.push(candidate);
      seen.add(candidate.id);
    }
  }

  for (const candidate of all) {
    if (selected.length >= size) break;
    if (seen.has(candidate.id)) continue;

    selected.push(candidate);
    seen.add(candidate.id);
  }

  return selected.sort((a, b) => b.score - a.score);
};

const sourceCoverage = (catalog: SourceCatalog, loadedSourceTypes: string[]) =>
  catalog.sourceGroups.map((group) => ({
    groupId: group.id,
    lane: group.lane,
    priority: group.priority,
    depth: group.depth,
    expectedSources: group.sources.map((source) => source.name),
    checkFor: [...new Set(group.sources.flatMap((source) => source.checkFor))],
    status: (() => {
      if (
        group.lane === "tech_frontier" &&
        loadedSourceTypes.some((type) =>
          [
            "github_trending",
            "hacker_news_discussion",
            "official_ai_release",
            "anthropic_release",
            "google_ai_release",
          ].includes(type),
        )
      ) {
        return "partially_collected";
      }

      if (group.lane === "product_market_watch" && loadedSourceTypes.includes("product_market_watch")) {
        return "partially_collected";
      }

      if (group.lane === "social_trend" && loadedSourceTypes.includes("japan_social_trend")) {
        return "partially_collected";
      }

      return "source_catalog_only";
    })(),
  }));

async function main() {
  const args = parseArgs();
  const catalog = await readJsonOptional<SourceCatalog>(args.sourceCatalog);

  if (!catalog) {
    throw new Error(`Source catalog not found: ${args.sourceCatalog}`);
  }

  const loadedFiles = await Promise.all(
    args.signalFiles.map(async (filePath) => ({
      filePath,
      payload: await readJsonOptional<SignalFile>(filePath),
    })),
  );
  const loaded = loadedFiles.filter((entry): entry is { filePath: string; payload: SignalFile } =>
    Boolean(entry.payload),
  );
  const missing = loadedFiles
    .filter((entry) => !entry.payload)
    .map((entry) => entry.filePath);
  const collectedSignals = loaded.flatMap((entry) =>
    (entry.payload.signals ?? []).map((signal) => ({
      ...compactSignal(signal, entry.payload),
      sourceFile: entry.filePath,
    })),
  );
  const explorationFiles = await readExplorationFiles(args.explorationDir);
  const loadedSourceTypes = [...new Set(collectedSignals.map((signal) => signal.sourceType))];
  const editorShortlist = makeEditorShortlist(collectedSignals, explorationFiles, args.shortlistSize);
  const now = new Date();
  const output = {
    version: 2,
    generatedAt: now.toISOString(),
    purpose:
      "Researcher-ready local input assembled from baseline signal files, optional LLM exploration reports, and the research source catalog. This is research material, not a product concept.",
    researchLayers: {
      baseline: {
        description: "Fixed recurring collectors for comparable daily coverage.",
        signalCount: collectedSignals.length,
      },
      exploration: {
        description: "Open-ended LLM/deep-research reports placed under data/research-exploration/*/response.json.",
        reportCount: explorationFiles.reduce(
          (count, entry) => count + (entry.payload.explorationReports?.length ?? 0),
          0,
        ),
        sourceProductCardCount: explorationFiles.reduce(
          (count, entry) => count + (entry.payload.sourceProductCards?.length ?? 0),
          0,
        ),
        sourceArchiveIndexCount: explorationFiles.reduce(
          (count, entry) => count + (entry.payload.sourceArchiveIndex?.length ?? 0),
          0,
        ),
        valueKnowledgeCardCount: explorationFiles.reduce(
          (count, entry) => count + (entry.payload.valueKnowledgeCards?.length ?? 0),
          0,
        ),
        loadedFiles: explorationFiles.map((entry) => entry.filePath),
      },
      editorShortlist: {
        description: "Heuristic shortlist for Research Editor / Concept Strategist. The LLM may override it but must explain why.",
        targetSize: args.shortlistSize,
        selectedCount: editorShortlist.length,
      },
    },
    sourceCatalog: catalog,
    collectedSignalSummary: {
      loadedFiles: loaded.map((entry) => entry.filePath),
      missingFiles: missing,
      signalCount: collectedSignals.length,
      sourceTypes: loadedSourceTypes,
    },
    sourceCoverage: sourceCoverage(catalog, loadedSourceTypes),
    baselineSignals: collectedSignals,
    collectedSignals,
    explorationReports: explorationFiles.map((entry) => ({
      sourceFile: entry.filePath,
      explorationRunId: entry.payload.explorationRunId ?? null,
      sourceCategory: entry.payload.sourceCategory ?? null,
      generatedAt: entry.payload.generatedAt ?? null,
      sourceProductCards: entry.payload.sourceProductCards ?? [],
      sourceArchiveIndex: entry.payload.sourceArchiveIndex ?? [],
      valueKnowledgeCards: entry.payload.valueKnowledgeCards ?? [],
      reports: entry.payload.explorationReports ?? [],
      coverageGaps: entry.payload.coverageGaps ?? [],
      editorNotes: entry.payload.editorNotes ?? "",
    })),
    editorShortlist,
    coverageGaps: [
      ...missing.map((filePath) => `Signal file missing: ${filePath}`),
      ...(explorationFiles.length === 0
        ? ["No exploration response files found. Run npm run research:explore:prepare and save an LLM response.json under data/research-exploration/..."]
        : []),
      "If Anthropic/Product Market/Japan trend signal files are missing, run npm run research:fetch in a network-enabled environment.",
      "Google Trends Japan and some marketplace ranking pages may require manual review or a separate collector if public feeds are unavailable.",
      "Social platform reactions such as X, Reddit, Discord, TikTok, and YouTube comments are not fetched by default.",
    ],
  };
  const outputPath = path.resolve(process.cwd(), args.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(`Wrote research collector input to ${args.output}`);
  console.log(`Signals: ${collectedSignals.length}`);
  console.log(`Loaded files: ${loaded.map((entry) => entry.filePath).join(", ") || "none"}`);

  if (missing.length > 0) {
    console.log(`Missing files: ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
