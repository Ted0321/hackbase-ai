import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ResearchCacheSignal = {
  id: string;
  sourceType: string;
  sourceName: string;
  title: string;
  summary: string;
  url: string;
  observedAt: string;
  topics: string[];
  audience: string[];
  whyItMatters: string;
  researchNote: string;
  riskNotes: string;
  sourceFile: string;
  score?: number;
  scoreReasons?: string[];
};

export type ResearchCache = {
  version: 1;
  lastRefreshedAt: string;
  generatedBy: {
    script: string;
    mode: "local-cache" | "live-fetch";
    cwd: string;
  };
  sources: Array<{
    id: string;
    type: "signal_file" | "research_input" | "source_catalog" | "topic_radar" | "source_product_index";
    path: string;
    status: "loaded" | "missing" | "stale_reference";
    itemCount: number;
    updatedAt?: string | null;
    note?: string;
  }>;
  signals: ResearchCacheSignal[];
  trendSummary: {
    signalCount: number;
    sourceTypes: string[];
    topTopics: Array<{ topic: string; count: number }>;
    highlights: Array<{
      id: string;
      title: string;
      sourceType: string;
      summary: string;
      whyItMatters: string;
    }>;
    coverageGaps: string[];
  };
  sourceProductIndex: {
    path: string;
    status: "loaded" | "missing";
    updatedAt: string | null;
    entryCount: number;
    sourceArchiveIndexCount: number;
    valueKnowledgeCardCount: number;
    purpose?: string;
  };
  cachePolicy: {
    cadence: "daily";
    maxAgeHours: number;
    minimumSignals: number;
    minimumSources: number;
    fallbackMode: string;
    intendedConsumers: string[];
  };
};

type ResearchCollectorInput = {
  generatedAt?: string;
  collectedSignalSummary?: {
    loadedFiles?: string[];
    missingFiles?: string[];
    signalCount?: number;
    sourceTypes?: string[];
  };
  sourceCatalog?: {
    updatedAt?: string;
    sourceGroups?: Array<unknown>;
  };
  sourceCoverage?: Array<unknown>;
  collectedSignals?: Array<Partial<ResearchCacheSignal> & { metrics?: Record<string, unknown> }>;
  editorShortlist?: Array<Partial<ResearchCacheSignal> & { metrics?: Record<string, unknown> }>;
  coverageGaps?: string[];
};

type SourceProductIndex = {
  updatedAt?: string;
  purpose?: string;
  entries?: Array<unknown>;
  sourceArchiveIndex?: Array<unknown>;
  valueKnowledgeCards?: Array<unknown>;
};

type TopicRadar = {
  generatedAt?: string;
  topicCards?: Array<{
    id?: string;
    title?: string;
    summary?: string;
    category?: string;
    evidenceRefs?: string[];
  }>;
};

export const defaultResearchCachePath = "data/research-cache/current.json";
export const defaultResearchInputPath = "data/research-collector-input.json";
export const defaultSourceProductIndexPath = "data/product-research/source-product-index.json";
export const defaultTopicRadarPath = "data/topic-research/current-topic-radar.json";

export const defaultSignalFiles = [
  "data/github-signals.json",
  "data/hn-signals.json",
  "data/ai-release-signals.json",
  "data/anthropic-signals.json",
  "data/google-ai-signals.json",
  "data/product-market-signals.json",
  "data/japan-trend-signals.json",
];

export const resolveWorkspacePath = (filePath: string) => path.resolve(process.cwd(), filePath);

export const readJsonOptional = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(resolveWorkspacePath(filePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const toStringArray = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

const normalizeSignal = (
  signal: Partial<ResearchCacheSignal> & { metrics?: Record<string, unknown> },
  fallbackIndex: number,
): ResearchCacheSignal => ({
  id: signal.id ?? `signal_${fallbackIndex + 1}`,
  sourceType: signal.sourceType ?? "unknown",
  sourceName: signal.sourceName ?? signal.sourceType ?? "unknown",
  title: signal.title ?? "Untitled signal",
  summary: signal.summary ?? "",
  url: signal.url ?? "",
  observedAt: signal.observedAt ?? new Date(0).toISOString(),
  topics: toStringArray(signal.topics),
  audience: toStringArray(signal.audience),
  whyItMatters: signal.whyItMatters ?? "",
  researchNote: signal.researchNote ?? "",
  riskNotes: signal.riskNotes ?? "",
  sourceFile: signal.sourceFile ?? "",
  score: typeof signal.score === "number" ? signal.score : undefined,
  scoreReasons: toStringArray(signal.scoreReasons),
});

const countTopics = (signals: ResearchCacheSignal[]) => {
  const counts = new Map<string, number>();

  for (const signal of signals) {
    for (const topic of signal.topics) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([topic, count]) => ({ topic, count }));
};

const sourceTypes = (signals: ResearchCacheSignal[]) =>
  [...new Set(signals.map((signal) => signal.sourceType).filter(Boolean))].sort();

const summarizeProductIndex = (index: SourceProductIndex | null) => ({
  path: defaultSourceProductIndexPath,
  status: index ? ("loaded" as const) : ("missing" as const),
  updatedAt: index?.updatedAt ?? null,
  entryCount: index?.entries?.length ?? 0,
  sourceArchiveIndexCount: index?.sourceArchiveIndex?.length ?? 0,
  valueKnowledgeCardCount: index?.valueKnowledgeCards?.length ?? 0,
  purpose: index?.purpose,
});

export const buildResearchCache = async (options?: {
  mode?: ResearchCache["generatedBy"]["mode"];
  maxAgeHours?: number;
  minimumSignals?: number;
  minimumSources?: number;
}) => {
  const input = await readJsonOptional<ResearchCollectorInput>(defaultResearchInputPath);
  const productIndex = await readJsonOptional<SourceProductIndex>(defaultSourceProductIndexPath);
  const topicRadar = await readJsonOptional<TopicRadar>(defaultTopicRadarPath);
  const signals = (input?.editorShortlist?.length ? input.editorShortlist : input?.collectedSignals ?? [])
    .map(normalizeSignal)
    .slice(0, 24);
  const loadedFiles = input?.collectedSignalSummary?.loadedFiles ?? [];
  const missingFiles = input?.collectedSignalSummary?.missingFiles ?? [];
  const loadedSignalSources = new Set(loadedFiles);
  const sources: ResearchCache["sources"] = [
    {
      id: "research_collector_input",
      type: "research_input",
      path: defaultResearchInputPath,
      status: input ? "loaded" : "missing",
      itemCount: input?.collectedSignalSummary?.signalCount ?? input?.collectedSignals?.length ?? 0,
      updatedAt: input?.generatedAt ?? null,
      note: "Normalized local research input used as the primary daily trend cache source.",
    },
    {
      id: "source_catalog",
      type: "source_catalog",
      path: "scripts/llm-pipeline/fixtures/research-source-catalog.json",
      status: input?.sourceCatalog ? "loaded" : "missing",
      itemCount: input?.sourceCatalog?.sourceGroups?.length ?? 0,
      updatedAt: input?.sourceCatalog?.updatedAt ?? null,
    },
    {
      id: "topic_radar",
      type: "topic_radar",
      path: defaultTopicRadarPath,
      status: topicRadar ? "loaded" : "missing",
      itemCount: topicRadar?.topicCards?.length ?? 0,
      updatedAt: topicRadar?.generatedAt ?? null,
      note: "Optional local topic radar for pairing broad trends with source product mechanisms.",
    },
    {
      id: "source_product_index",
      type: "source_product_index",
      path: defaultSourceProductIndexPath,
      status: productIndex ? "loaded" : "missing",
      itemCount: productIndex?.entries?.length ?? 0,
      updatedAt: productIndex?.updatedAt ?? null,
      note: "Persistent hackathon/product source material for generation.",
    },
    ...defaultSignalFiles.map((filePath) => ({
      id: filePath.replace(/^data\//, "").replace(/\.json$/, ""),
      type: "signal_file" as const,
      path: filePath,
      status: loadedSignalSources.has(filePath) ? ("loaded" as const) : ("missing" as const),
      itemCount: signals.filter((signal) => signal.sourceFile === filePath).length,
      updatedAt: null,
    })),
  ];
  const cache: ResearchCache = {
    version: 1,
    lastRefreshedAt: new Date().toISOString(),
    generatedBy: {
      script: "scripts/refresh-research-cache.ts",
      mode: options?.mode ?? "local-cache",
      cwd: process.cwd(),
    },
    sources,
    signals,
    trendSummary: {
      signalCount: signals.length,
      sourceTypes: sourceTypes(signals),
      topTopics: countTopics(signals),
      highlights: signals.slice(0, 8).map((signal) => ({
        id: signal.id,
        title: signal.title,
        sourceType: signal.sourceType,
        summary: signal.summary,
        whyItMatters: signal.whyItMatters,
      })),
      coverageGaps: [
        ...(input ? [] : [`Missing ${defaultResearchInputPath}. Run npm run research:collect or use refresh fallback.`]),
        ...missingFiles.map((filePath) => `Missing signal file: ${filePath}`),
        ...(input?.coverageGaps ?? []),
      ],
    },
    sourceProductIndex: summarizeProductIndex(productIndex),
    cachePolicy: {
      cadence: "daily",
      maxAgeHours: options?.maxAgeHours ?? 36,
      minimumSignals: options?.minimumSignals ?? 5,
      minimumSources: options?.minimumSources ?? 2,
      fallbackMode:
        "If live collectors are unavailable, refresh uses existing local signal files, research-collector-input, topic radar, and source-product-index.",
      intendedConsumers: [
        "judge demo generation",
        "scheduled product generation",
        "LLM pipeline research input",
        "submission readiness checks",
      ],
    },
  };

  return cache;
};

export const writeResearchCache = async (cache: ResearchCache, outputPath = defaultResearchCachePath) => {
  const resolved = resolveWorkspacePath(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
};

export const readResearchCache = async (cachePath = defaultResearchCachePath) =>
  readJsonOptional<ResearchCache>(cachePath);
