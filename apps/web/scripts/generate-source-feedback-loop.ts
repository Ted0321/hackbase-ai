import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SourceProductEntry = {
  id?: string;
  name?: string;
  sourceCategory?: string;
  sourceType?: string;
  evidenceLevel?: string;
  usePolicy?: string;
  observedFields?: string[];
  inferredFields?: string[];
  missingFields?: string[];
  transformationAxes?: string[];
  remixableThemes?: string[];
  bestRemixTargets?: string[];
  reasonIncluded?: string;
};

type SourceProductIndex = {
  entries?: SourceProductEntry[];
};

type FeedbackGuidance = {
  generatedAt?: string;
  totals?: Record<string, number>;
  topProjects?: Array<{
    id?: string;
    title?: string;
    category?: string;
    agentId?: string;
    agentName?: string;
    score?: number;
    likeCount?: number;
    commentCount?: number;
    reportCount?: number;
  }>;
  weakPatterns?: string[];
  sourceLessons?: string[];
  nextRunGuidance?: string[];
};

type ExplorationResponse = {
  generatedAt?: string;
  explorationRunId?: string;
  sourceProductCards?: Array<{
    id?: string;
    name?: string;
    sourceCategory?: string;
    sourceType?: string;
    evidenceLevel?: string;
    usePolicy?: string;
    productUrl?: string;
    url?: string;
  }>;
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  return {
    index: values.get("index") ?? "data/product-research/source-product-index.json",
    feedback: values.get("feedback") ?? "data/feedback/latest-guidance.json",
    explorationDir: values.get("exploration-dir") ?? "data/research-exploration",
    output: values.get("output") ?? "data/product-research/source-feedback-loop.json",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
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

const countBy = <T>(items: T[], keyFor: (item: T) => string | undefined) =>
  items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFor(item) || "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const sumBy = <T>(items: T[], keyFor: (item: T) => string | undefined, valueFor: (item: T) => number) =>
  items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFor(item) || "unknown";
    acc[key] = (acc[key] ?? 0) + valueFor(item);
    return acc;
  }, {});

const keywordSetFor = (category: string) => {
  const value = category.toLowerCase();
  if (value.includes("work")) return ["workflow", "dashboard", "triage", "scorecard", "decision", "operations"];
  if (value.includes("learn")) return ["education", "learning", "student", "classroom", "explainer"];
  if (value.includes("map")) return ["map", "local", "civic", "geography", "evidence"];
  if (value.includes("game")) return ["game", "play", "challenge", "score"];
  return value.split(/[^a-z0-9]+/).filter(Boolean);
};

const entryText = (entry: SourceProductEntry) =>
  [
    entry.sourceCategory,
    entry.sourceType,
    entry.reasonIncluded,
    ...(entry.transformationAxes ?? []),
    ...(entry.remixableThemes ?? []),
    ...(entry.bestRemixTargets ?? []),
  ]
    .join(" ")
    .toLowerCase();

const topMatchesForCategory = (entries: SourceProductEntry[], category: string) => {
  const keywords = keywordSetFor(category);
  return entries
    .map((entry) => {
      const text = entryText(entry);
      const score = keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.name ?? "").localeCompare(b.entry.name ?? ""))
    .slice(0, 5)
    .map((item) => ({
      id: item.entry.id,
      name: item.entry.name,
      sourceCategory: item.entry.sourceCategory,
      evidenceLevel: item.entry.evidenceLevel,
      matchScore: item.score,
    }));
};

const collectDraftSummaries = async (explorationDir: string) => {
  const root = path.resolve(process.cwd(), explorationDir);
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const draftDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("research_product_refresh_"))
    .map((entry) => path.join(root, entry.name));
  const drafts = await Promise.all(
    draftDirs.map(async (dir) => {
      const response = await readJsonOptional<ExplorationResponse>(path.join(dir, "response.json"));
      const cards = response?.sourceProductCards ?? [];
      return {
        path: path.relative(process.cwd(), dir),
        generatedAt: response?.generatedAt,
        candidateCount: cards.length,
        byPolicy: countBy(cards, (card) => card.usePolicy),
        byEvidenceLevel: countBy(cards, (card) => card.evidenceLevel),
        promotableCount: cards.filter(
          (card) => card.usePolicy === "primary_source_core" || (card.usePolicy === "candidate_only" && ["A", "B"].includes(card.evidenceLevel ?? "")),
        ).length,
        latestCandidates: cards.slice(0, 5).map((card) => ({
          id: card.id,
          name: card.name,
          sourceCategory: card.sourceCategory,
          sourceType: card.sourceType,
          evidenceLevel: card.evidenceLevel,
          usePolicy: card.usePolicy,
          url: card.productUrl || card.url,
        })),
      };
    }),
  );

  return drafts
    .sort((a, b) => Date.parse(b.generatedAt ?? "") - Date.parse(a.generatedAt ?? ""))
    .slice(0, 8);
};

const main = async () => {
  const args = parseArgs();
  const [index, feedback, drafts] = await Promise.all([
    readJsonOptional<SourceProductIndex>(args.index),
    readJsonOptional<FeedbackGuidance>(args.feedback),
    collectDraftSummaries(args.explorationDir),
  ]);
  const entries = index?.entries ?? [];
  const topProjects = feedback?.topProjects ?? [];
  const topCategories = sumBy(topProjects, (project) => project.category, (project) => project.score ?? 0);
  const categories = Object.entries(topCategories)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 6);
  const recommendations = categories.map(([category, score]) => ({
    category,
    feedbackScore: score,
    suggestedSourceProducts: topMatchesForCategory(entries, category),
    rationale: `Recent feedback favors ${category}; prefer source products whose transfer themes match this surface before selecting fresh material.`,
  }));
  const sourceCategoryStats = Object.entries(countBy(entries, (entry) => entry.sourceCategory))
    .sort(([, left], [, right]) => right - left)
    .map(([sourceCategory, entryCount]) => ({
      sourceCategory,
      entryCount,
      evidenceLevels: countBy(
        entries.filter((entry) => (entry.sourceCategory || "unknown") === sourceCategory),
        (entry) => entry.evidenceLevel,
      ),
      missingFieldRows: entries.filter((entry) => (entry.sourceCategory || "unknown") === sourceCategory && (entry.missingFields?.length ?? 0) > 0).length,
    }));
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    inputs: {
      sourceProductIndex: args.index,
      feedbackGuidance: args.feedback,
      explorationDir: args.explorationDir,
      exactProjectToSourceAttribution: "not_available_yet",
    },
    totals: {
      sourceProductEntries: entries.length,
      feedbackTopProjects: topProjects.length,
      recentDrafts: drafts.length,
      pendingDraftCandidates: drafts.reduce((total, draft) => total + draft.candidateCount, 0),
    },
    sourceCategoryStats,
    feedbackCategoryScores: Object.fromEntries(categories),
    sourceRecommendations: recommendations,
    recentDrafts: drafts,
    guardrails: [
      "Do not auto-promote candidate_only cards from feedback alone.",
      "Use feedback to prioritize which source categories and transfer patterns to inspect next.",
      "Promotion still requires observed facts, A/B evidence, evidence refs, and no missing source-core fields.",
      "Exact source-to-project attribution should be added when generated projects persist sourceProductUsed metadata.",
    ],
    nextActions: [
      drafts.some((draft) => draft.candidateCount > 0)
        ? "Review latest source-product drafts and either delete weak cards or manually enrich promising ones before promotion."
        : "Run research:product-index:prepare when fresh external candidates are needed.",
      recommendations.length > 0
        ? `Prioritize source products matching ${recommendations[0].category} feedback patterns in the next Step2 combination pass.`
        : "Run feedback:digest:all to refresh feedback guidance before source prioritization.",
      "Add sourceProductUsed persistence to generated projects to make this loop exact rather than category-level.",
    ],
  };

  if (!args.dryRun) {
    await writeFile(path.resolve(process.cwd(), args.output), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  console.log(`Source feedback loop ${args.dryRun ? "dry run" : "written"}: ${args.output}`);
  console.log(`Source products: ${entries.length}`);
  console.log(`Recent drafts: ${drafts.length}`);
  console.log(`Top feedback categories: ${categories.map(([category, score]) => `${category}=${score}`).join(", ") || "none"}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
