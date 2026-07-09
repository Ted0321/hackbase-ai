import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  daysBetween,
  fetchText,
  parseArgs,
  parseFeedItems,
  parseHtmlLinks,
  slugify,
  type FeedItem,
} from "./signal-fetch-utils";

type SignalOutput = {
  version: string;
  fetchedAt: string;
  source: {
    type: "anthropic_release";
    urls: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "anthropic_release";
    sourceName: "Anthropic News";
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      releaseMentions: number;
      daysSincePublished: number;
    };
    whyItMatters: string;
    researchNote: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const defaultUrls = [
  "https://www.anthropic.com/news/rss.xml",
  "https://www.anthropic.com/rss.xml",
  "https://www.anthropic.com/news",
];

const inferTopics = (item: FeedItem) => {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const topics = new Set<string>(["anthropic", "official-release", "ai"]);

  if (text.includes("claude")) topics.add("claude");
  if (text.includes("code") || text.includes("coding")) topics.add("coding");
  if (text.includes("agent")) topics.add("agent");
  if (text.includes("tool")) topics.add("tool-use");
  if (text.includes("computer")) topics.add("computer-use");
  if (text.includes("safety")) topics.add("safety");
  if (text.includes("model")) topics.add("model");
  if (text.includes("enterprise")) topics.add("enterprise");

  return [...topics].slice(0, 8);
};

const makeSignal = (item: FeedItem, index: number, now: Date) => {
  const publishedAt = item.pubDate ? new Date(item.pubDate) : now;
  const topics = inferTopics(item);
  const summary = item.description || item.title;

  return {
    id: `sig_anthropic_${slugify(item.title)}_${index + 1}`,
    sourceType: "anthropic_release" as const,
    sourceName: "Anthropic News" as const,
    title: item.title,
    summary,
    url: item.link,
    observedAt: now.toISOString(),
    topics,
    audience: topics.includes("coding") || topics.includes("tool-use")
      ? ["developer", "agent-builder", "operator"]
      : ["operator", "researcher", "agent-builder"],
    metrics: {
      releaseMentions: 1,
      daysSincePublished: daysBetween(now, publishedAt),
    },
    whyItMatters:
      "Anthropic updates are useful research signals when they expose agent behavior, coding workflows, tool boundaries, enterprise adoption, or safety practices.",
    researchNote:
      "Record the mechanism, user audience, operational constraint, and unresolved question. Do not prescribe a Hackbase.ai concept from this signal alone.",
    riskNotes:
      "Use official public metadata only. Do not require Anthropic account access, paid APIs, secrets, or live product integration.",
    rawExcerpt: summary.slice(0, 500),
  };
};

const fetchItems = async (url: string, limit: number) => {
  const text = await fetchText(url, "Prodia-anthropic-signal-fetcher");
  const feedItems = parseFeedItems(text);

  if (feedItems.length > 0) {
    return feedItems;
  }

  return parseHtmlLinks(text, url, /anthropic\.com\/(news|research)\//i, limit);
};

async function main() {
  const values = parseArgs();
  const output = values.get("output") ?? "data/anthropic-signals.json";
  const limit = Math.max(1, Math.min(Number.parseInt(values.get("limit") ?? "8", 10), 20));
  const urls = (values.get("urls") ?? defaultUrls.join(","))
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const failures: string[] = [];
  const fetched: FeedItem[] = [];

  for (const url of urls) {
    try {
      fetched.push(...(await fetchItems(url, limit)));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (fetched.length === 0) {
    throw new Error(`No Anthropic items could be fetched. ${failures.join(" / ")}`);
  }

  const now = new Date();
  const uniqueItems = [...new Map(fetched.map((item) => [item.link, item])).values()].slice(0, limit);
  const payload: SignalOutput = {
    version: `anthropic.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "anthropic_release",
      urls,
      note:
        failures.length > 0
          ? `Fetched Anthropic signals with fallback failures: ${failures.join(" / ")}`
          : "Fetched Anthropic signals from configured public URLs.",
    },
    signals: uniqueItems.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${payload.signals.length} Anthropic signals to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
