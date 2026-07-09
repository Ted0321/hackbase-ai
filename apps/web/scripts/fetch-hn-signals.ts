import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type HnItem = {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
};

type SignalOutput = {
  version: string;
  fetchedAt: string;
  source: {
    type: "hacker_news_discussion";
    endpoints: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "hacker_news_discussion";
    sourceName: "Hacker News";
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      points: number;
      comments: number;
      ageHours: number;
    };
    whyItMatters: string;
    prototypeHint: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const endpoints = [
  "https://hacker-news.firebaseio.com/v0/topstories.json",
  "https://hacker-news.firebaseio.com/v0/newstories.json",
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
    output: values.get("output") ?? "data/hn-signals.json",
    limit: Number.parseInt(values.get("limit") ?? "8", 10),
    scan: Number.parseInt(values.get("scan") ?? "60", 10),
  };
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const aiKeywords = [
  "ai",
  "agent",
  "agents",
  "llm",
  "openai",
  "google ai",
  "gemini",
  "claude",
  "model",
  "mcp",
  "automation",
  "robot",
  "eval",
  "prompt",
];

const inferTopics = (item: HnItem) => {
  const text = `${item.title ?? ""} ${item.url ?? ""}`.toLowerCase();
  const topics = new Set<string>(["hacker-news", "discussion"]);

  if (text.includes("agent")) topics.add("agent");
  if (text.includes("llm") || text.includes("model")) topics.add("model");
  if (text.includes("openai")) topics.add("openai");
  if (text.includes("google") || text.includes("gemini")) topics.add("google");
  if (text.includes("mcp")) topics.add("mcp");
  if (text.includes("eval")) topics.add("eval");
  if (text.includes("prompt")) topics.add("prompting");
  if (text.includes("developer") || text.includes("api")) topics.add("developer");
  if (text.includes("automation") || text.includes("workflow")) topics.add("workflow");

  return [...topics].slice(0, 8);
};

const isAiRelated = (item: HnItem) => {
  const text = `${item.title ?? ""} ${item.url ?? ""}`.toLowerCase();
  return aiKeywords.some((keyword) => text.includes(keyword));
};

const hostnameFor = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "external link";
  }
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Prodia-hn-signal-fetcher",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
};

const makeSignal = (item: HnItem, index: number, now: Date) => {
  const title = item.title ?? `Hacker News story ${item.id}`;
  const storyUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const ageHours = item.time
    ? Math.max(0, Math.round((now.getTime() - item.time * 1000) / 1000 / 60 / 60))
    : 0;
  const summary = item.url ? `${title} (${hostnameFor(item.url)})` : `${title} (Hacker News discussion)`;
  const topics = inferTopics(item);
  const points = item.score ?? 0;
  const comments = item.descendants ?? 0;

  return {
    id: `sig_hn_${item.id}_${slugify(title)}_${index + 1}`,
    sourceType: "hacker_news_discussion" as const,
    sourceName: "Hacker News" as const,
    title,
    summary,
    url: item.url || storyUrl,
    observedAt: now.toISOString(),
    topics,
    audience: ["developer", "operator", "agent-builder"],
    metrics: {
      points,
      comments,
      ageHours,
    },
    whyItMatters:
      "Hacker News metadata exposes which technical topics are drawing attention without reading or storing comment bodies.",
    prototypeHint:
      comments > 30
        ? "Create a debate map, trade-off board, or misconception explainer from the discussion shape."
        : "Create a small explainer, comparison card, or operator checklist based on the story topic.",
    riskNotes:
      "Use public story metadata only: title, URL, points, comment count, and age. Do not fetch comment bodies, story text, user profiles, or sentiment.",
    rawExcerpt: title,
  };
};

async function main() {
  const args = parseArgs();
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(args.limit, 20)) : 8;
  const scan = Number.isFinite(args.scan) ? Math.max(limit, Math.min(args.scan, 120)) : 60;
  const ids = new Set<number>();

  for (const endpoint of endpoints) {
    const list = await fetchJson<number[]>(endpoint);
    list.slice(0, scan).forEach((id) => ids.add(id));
  }

  const items = await Promise.all(
    [...ids]
      .slice(0, scan * endpoints.length)
      .map((id) => fetchJson<HnItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
  );
  const stories = items
    .filter((item) => item?.type === "story" && item.title)
    .sort((a, b) => (b.score ?? 0) + (b.descendants ?? 0) - ((a.score ?? 0) + (a.descendants ?? 0)));
  const aiStories = stories.filter(isAiRelated);
  const selected = (aiStories.length >= limit ? aiStories : [...aiStories, ...stories])
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, limit);
  const now = new Date();
  const output: SignalOutput = {
    version: `hn.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "hacker_news_discussion",
      endpoints,
      note:
        aiStories.length >= limit
          ? "Fetched AI-adjacent Hacker News stories from public Firebase endpoints. Only story metadata is used; comments and text bodies are not fetched."
          : "Fetched public Hacker News stories; AI-adjacent results were sparse, so high-signal general tech stories were included. Only story metadata is used; comments and text bodies are not fetched.",
    },
    signals: selected.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), args.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(`Wrote ${output.signals.length} Hacker News signals to ${args.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
