import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type GitHubRepo = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  updated_at: string;
  language: string | null;
  topics?: string[];
};

type GitHubSearchResponse = {
  items: GitHubRepo[];
};

type SignalOutput = {
  version: string;
  fetchedAt: string;
  source: {
    type: "github_trending";
    query: string;
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "github_trending";
    sourceName: "GitHub Search";
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      stars: number;
      forks: number;
      openIssues: number;
      updatedWithinDays: number;
      starDelta7d: number;
      starVelocityScore: number;
      activityScore: number;
      categoryNoveltyScore: number;
    };
    whyItMatters: string;
    researchNote: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

type RepoObservation = {
  observedAt: string;
  stars: number;
  forks: number;
  openIssues: number;
};

type RepoHistory = {
  version: string;
  updatedAt: string;
  repos: Record<
    string,
    {
      fullName: string;
      url: string;
      observations: RepoObservation[];
    }
  >;
};

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
    output: values.get("output") ?? "data/github-signals.json",
    history: values.get("history") ?? "data/signal-history/github-repos.json",
    limit: Number.parseInt(values.get("limit") ?? "8", 10),
    query: values.get("query") ?? "",
  };
};

const daysAgo = (days: number) => {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 10);
};

const daysBetween = (left: Date, right: Date) =>
  Math.max(0, Math.round((left.getTime() - right.getTime()) / 1000 / 60 / 60 / 24));

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const buildQueries = (override: string) => {
  if (override) return [override];

  // Diverse query lanes so the signal file is not dominated by agent/devtool repos.
  return [
    `agent ai stars:>100 pushed:>${daysAgo(30)}`,
    `ai education learning stars:>30 pushed:>${daysAgo(45)}`,
    `ai music audio stars:>30 pushed:>${daysAgo(45)}`,
    `ai visualization stars:>30 pushed:>${daysAgo(45)}`,
    `ai game stars:>30 pushed:>${daysAgo(45)}`,
    `ai science biology stars:>30 pushed:>${daysAgo(60)}`,
    `ai accessibility stars:>20 pushed:>${daysAgo(60)}`,
    `ai creative art generation stars:>30 pushed:>${daysAgo(45)}`,
  ];
};

const inferTopics = (repo: GitHubRepo) => {
  const text = `${repo.full_name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
  const topics = new Set<string>(["github", "oss"]);

  if (text.includes("agent")) topics.add("agent");
  if (text.includes("workflow")) topics.add("workflow");
  if (text.includes("eval")) topics.add("eval");
  if (text.includes("mcp")) topics.add("mcp");
  if (text.includes("tool")) topics.add("tool-use");
  if (repo.language) topics.add(repo.language.toLowerCase());

  return [...topics].slice(0, 8);
};

const categoryNoveltyScore = (repo: GitHubRepo, topics: string[]) => {
  const text = `${repo.full_name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
  let score = 1;

  if (topics.includes("agent")) score += 1;
  if (topics.includes("workflow") || topics.includes("tool-use")) score += 1;
  if (topics.includes("eval") || text.includes("benchmark") || text.includes("trace")) score += 1;
  if (text.includes("browser") || text.includes("extension") || text.includes("mcp")) score += 1;

  return Math.min(5, score);
};

const readHistory = async (historyPath: string): Promise<RepoHistory> => {
  try {
    const raw = await readFile(historyPath, "utf8");
    return JSON.parse(raw) as RepoHistory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      version: "github-repo-history.v1",
      updatedAt: new Date(0).toISOString(),
      repos: {},
    };
  }
};

const starDeltaSince = (
  observations: RepoObservation[],
  currentStars: number,
  now: Date,
  days: number,
) => {
  const target = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidates = observations
    .filter((observation) => new Date(observation.observedAt).getTime() <= target)
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
  const baseline = candidates[0];

  return baseline ? Math.max(0, currentStars - baseline.stars) : 0;
};

const starVelocityScore = (stars: number, starDelta7d: number) => {
  if (starDelta7d >= 500) return 5;
  if (starDelta7d >= 100) return 4;
  if (starDelta7d >= 25) return 3;
  if (starDelta7d > 0) return 2;
  if (stars >= 10000) return 2;
  return 1;
};

const activityScore = (updatedWithinDays: number, openIssues: number) => {
  let score = updatedWithinDays <= 3 ? 4 : updatedWithinDays <= 14 ? 3 : updatedWithinDays <= 30 ? 2 : 1;

  if (openIssues > 20) score += 1;

  return Math.min(5, score);
};

const appendObservation = (history: RepoHistory, repo: GitHubRepo, now: Date) => {
  const existing = history.repos[repo.full_name] ?? {
    fullName: repo.full_name,
    url: repo.html_url,
    observations: [],
  };
  const latest = existing.observations[existing.observations.length - 1];

  if (
    !latest ||
    now.getTime() - new Date(latest.observedAt).getTime() > 60 * 60 * 1000 ||
    latest.stars !== repo.stargazers_count
  ) {
    existing.observations.push({
      observedAt: now.toISOString(),
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
    });
  }

  existing.observations = existing.observations
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())
    .slice(-90);
  history.repos[repo.full_name] = existing;
};

const makeSignal = (repo: GitHubRepo, index: number, now: Date, starDelta7d: number) => {
  const updatedWithinDays = daysBetween(now, new Date(repo.pushed_at));
  const topics = inferTopics(repo);
  const description = repo.description ?? "No repository description provided.";
  const isAgent = topics.includes("agent");
  const isWorkflow = topics.includes("workflow") || topics.includes("tool-use");
  const velocityScore = starVelocityScore(repo.stargazers_count, starDelta7d);
  const repoActivityScore = activityScore(updatedWithinDays, repo.open_issues_count);
  const noveltyScore = categoryNoveltyScore(repo, topics);

  return {
    id: `sig_github_${slugify(repo.full_name)}_${index + 1}`,
    sourceType: "github_trending" as const,
    sourceName: "GitHub Search" as const,
    title: isAgent
      ? `${repo.full_name} is an active AI/agent repository`
      : `${repo.full_name} is a rising AI-related repository`,
    summary: description,
    url: repo.html_url,
    observedAt: now.toISOString(),
    topics,
    audience: ["developer", "operator", "agent-builder"],
    metrics: {
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      updatedWithinDays,
      starDelta7d,
      starVelocityScore: velocityScore,
      activityScore: repoActivityScore,
      categoryNoveltyScore: noveltyScore,
    },
    whyItMatters: isAgent
      ? "Agent-related repositories with strong attention can reveal workflow patterns that Hackbase.ai can turn into inspectable artifacts."
      : "Active AI repositories can reveal developer pain points and patterns worth turning into small Hackbase.ai artifacts.",
    researchNote: [
      isWorkflow
        ? "Research angle: workflow/tool-use mechanism, debugging surface, and operator pain."
        : "Research angle: technical mechanism, adoption proof, and developer pain behind the repository.",
      `Velocity: starDelta7d=${starDelta7d}, starVelocityScore=${velocityScore}.`,
      `Activity: pushed ${updatedWithinDays} days ago, activityScore=${repoActivityScore}.`,
      `Novelty: categoryNoveltyScore=${noveltyScore}; inspect whether this is a new capability, new workflow, or known category repackaging.`,
    ].join(" "),
    riskNotes:
      "Use public metadata only. Do not clone the repository, require GitHub authentication, call external services, or copy project branding.",
    rawExcerpt: description,
  };
};

const searchRepositories = async (query: string, perPage: number): Promise<GitHubRepo[]> => {
  const params = new URLSearchParams({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: String(perPage),
  });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Prodia-signal-fetcher",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as GitHubSearchResponse;
  return payload.items;
};

async function main() {
  const args = parseArgs();
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(args.limit, 20)) : 8;
  const queries = buildQueries(args.query);
  const query = queries.join(" | ");

  // Fetch each query lane, then round-robin merge (dedup by repo) so no single
  // lane dominates the final signal set.
  // Unauthenticated GitHub search allows 10 requests/min; space out multi-lane
  // queries so a full default run stays under the limit.
  const interQueryDelayMs = process.env.GITHUB_TOKEN || queries.length === 1 ? 0 : 7000;
  const lanes: GitHubRepo[][] = [];
  for (const laneQuery of queries) {
    if (lanes.length > 0 && interQueryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, interQueryDelayMs));
    }
    try {
      lanes.push(await searchRepositories(laneQuery, Math.min(limit, 10)));
    } catch (error) {
      console.warn(`GitHub query failed, skipping lane "${laneQuery}": ${(error as Error).message}`);
      lanes.push([]);
    }
  }

  // Catalog/list repositories (awesome lists, interview guides, book collections)
  // are attention magnets but not product-shaped idea sources.
  const looksLikeCatalogRepo = (repo: GitHubRepo) => {
    const text = `${repo.full_name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
    return /awesome[-_ ]|curated list|book|interview|面试|书籍|roadmap|curriculum|cheat[- ]?sheet|collection of/.test(
      text,
    );
  };

  const seen = new Set<string>();
  const merged: GitHubRepo[] = [];
  const cursors = lanes.map(() => 0);
  let exhausted = false;
  while (merged.length < limit && !exhausted) {
    exhausted = true;
    for (let laneIndex = 0; laneIndex < lanes.length && merged.length < limit; laneIndex += 1) {
      const lane = lanes[laneIndex];
      while (cursors[laneIndex] < lane.length) {
        const repo = lane[cursors[laneIndex]];
        cursors[laneIndex] += 1;
        if (seen.has(repo.full_name) || looksLikeCatalogRepo(repo)) continue;
        seen.add(repo.full_name);
        merged.push(repo);
        exhausted = false;
        break;
      }
    }
  }

  const now = new Date();
  const historyPath = path.resolve(process.cwd(), args.history);
  const history = await readHistory(historyPath);
  const repos = merged.slice(0, limit);
  const starDeltaByRepo = new Map(
    repos.map((repo) => [
      repo.full_name,
      starDeltaSince(history.repos[repo.full_name]?.observations ?? [], repo.stargazers_count, now, 7),
    ]),
  );

  for (const repo of repos) {
    appendObservation(history, repo, now);
  }

  history.updatedAt = now.toISOString();

  const output: SignalOutput = {
    version: `github.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "github_trending",
      query,
      note: `Unauthenticated GitHub Search signal. starDelta7d is calculated from ${args.history} when a 7-day baseline exists.`,
    },
    signals: repos.map((repo, index) =>
      makeSignal(repo, index, now, starDeltaByRepo.get(repo.full_name) ?? 0),
    ),
  };
  const outputPath = path.resolve(process.cwd(), args.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  await writeFile(historyPath, JSON.stringify(history, null, 2));

  console.log(`Wrote ${output.signals.length} GitHub signals to ${args.output}`);
  console.log(`Updated GitHub signal history at ${args.history}`);
  console.log(`Query: ${query}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
