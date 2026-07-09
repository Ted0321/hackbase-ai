import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type FeedItem = {
  title: string;
  link: string;
  pubDate: string;
  description: string;
};

type SignalOutput = {
  version: string;
  fetchedAt: string;
  source: {
    type: "official_ai_release";
    feeds: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "official_ai_release";
    sourceName: string;
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      releaseMentions: number;
      developerDocsUpdated: number;
      daysSincePublished: number;
    };
    whyItMatters: string;
    prototypeHint: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const defaultFeeds = ["https://openai.com/news/rss.xml", "https://openai.com/blog/rss.xml"];

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
    output: values.get("output") ?? "data/ai-release-signals.json",
    limit: Number.parseInt(values.get("limit") ?? "8", 10),
    feeds: (values.get("feeds") ?? defaultFeeds.join(","))
      .split(",")
      .map((feed) => feed.trim())
      .filter(Boolean),
  };
};

const stripTags = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const decodeXml = (value: string) =>
  stripTags(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const extractTag = (block: string, tag: string) => {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
};

const parseRssItems = (xml: string): FeedItem[] => {
  const itemBlocks = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);

  return itemBlocks
    .map((block) => ({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      pubDate: extractTag(block, "pubDate"),
      description: extractTag(block, "description"),
    }))
    .filter((item) => item.title && item.link);
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const daysBetween = (left: Date, right: Date) =>
  Math.max(0, Math.round((left.getTime() - right.getTime()) / 1000 / 60 / 60 / 24));

const inferTopics = (item: FeedItem) => {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const topics = new Set<string>(["official-release", "ai"]);

  if (text.includes("agent")) topics.add("agent");
  if (text.includes("model")) topics.add("model");
  if (text.includes("api")) topics.add("api");
  if (text.includes("developer")) topics.add("developer");
  if (text.includes("code") || text.includes("coding")) topics.add("coding");
  if (text.includes("voice") || text.includes("audio")) topics.add("voice");
  if (text.includes("image") || text.includes("video")) topics.add("multimodal");
  if (text.includes("eval") || text.includes("benchmark")) topics.add("eval");
  if (text.includes("safety")) topics.add("safety");

  return [...topics].slice(0, 8);
};

const makeSignal = (item: FeedItem, index: number, now: Date) => {
  const publishedAt = item.pubDate ? new Date(item.pubDate) : now;
  const topics = inferTopics(item);
  const summary = item.description || item.title;

  return {
    id: `sig_official_ai_release_${slugify(item.title)}_${index + 1}`,
    sourceType: "official_ai_release" as const,
    sourceName: "OpenAI News",
    title: item.title,
    summary,
    url: item.link,
    observedAt: now.toISOString(),
    topics,
    audience: topics.includes("api") || topics.includes("developer")
      ? ["developer", "agent-builder", "operator"]
      : ["operator", "curator", "agent-builder"],
    metrics: {
      releaseMentions: 1,
      developerDocsUpdated: topics.includes("api") || topics.includes("developer") ? 1 : 0,
      daysSincePublished: daysBetween(now, publishedAt),
    },
    whyItMatters:
      "Official AI product and model releases can become timely Hackbase.ai prompts when they expose a new workflow, capability, or operational question.",
    prototypeHint: topics.includes("agent")
      ? "Create a small run inspector, agent capability card, or workflow comparison around the release."
      : "Create a concise explainer, decision board, or capability map that turns the release into a buildable product question.",
    riskNotes:
      "Use official release metadata only. Do not call paid APIs, require accounts, claim unsupported benchmarks, or copy proprietary UI.",
    rawExcerpt: summary.slice(0, 500),
  };
};

async function fetchFeed(feed: string) {
  const response = await fetch(feed, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": "Prodia-release-signal-fetcher",
    },
  });

  if (!response.ok) {
    throw new Error(`${feed} failed: ${response.status}`);
  }

  return response.text();
}

async function main() {
  const args = parseArgs();
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(args.limit, 20)) : 8;
  const fetched: FeedItem[] = [];
  const failures: string[] = [];

  for (const feed of args.feeds) {
    try {
      const xml = await fetchFeed(feed);
      fetched.push(...parseRssItems(xml));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (fetched.length === 0) {
    throw new Error(`No official AI release feed items could be fetched. ${failures.join(" / ")}`);
  }

  const now = new Date();
  const uniqueItems = [...new Map(fetched.map((item) => [item.link, item])).values()]
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, limit);
  const output: SignalOutput = {
    version: `official-ai-release.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "official_ai_release",
      feeds: args.feeds,
      note:
        failures.length > 0
          ? `Fetched official release signals with fallback failures: ${failures.join(" / ")}`
          : "Fetched official release signals from configured official feeds.",
    },
    signals: uniqueItems.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), args.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(`Wrote ${output.signals.length} official AI release signals to ${args.output}`);
  console.log(`Feeds: ${args.feeds.join(", ")}`);
  if (failures.length > 0) {
    console.log(`Fallback failures: ${failures.join(" / ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
