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
    type: "google_ai_release";
    feeds: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "google_ai_release";
    sourceName: string;
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
    prototypeHint: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const defaultFeeds = ["https://blog.google/technology/ai/rss/"];

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
    output: values.get("output") ?? "data/google-ai-signals.json",
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
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const extractTag = (block: string, tag: string) => {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
};

const parseFeedItems = (xml: string): FeedItem[] => {
  const itemBlocks = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const entryBlocks = [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  const rssItems = itemBlocks.map((block) => ({
    title: extractTag(block, "title"),
    link: extractTag(block, "link"),
    pubDate: extractTag(block, "pubDate"),
    description: extractTag(block, "description"),
  }));
  const atomItems = entryBlocks.map((block) => {
    const href = block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? extractTag(block, "link");

    return {
      title: extractTag(block, "title"),
      link: href,
      pubDate: extractTag(block, "updated") || extractTag(block, "published"),
      description: extractTag(block, "summary") || extractTag(block, "content"),
    };
  });

  return [...rssItems, ...atomItems].filter((item) => item.title && item.link);
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
  const topics = new Set<string>(["official-release", "google", "ai"]);

  if (text.includes("agent")) topics.add("agent");
  if (text.includes("gemini")) topics.add("gemini");
  if (text.includes("model")) topics.add("model");
  if (text.includes("developer") || text.includes("api")) topics.add("developer");
  if (text.includes("search")) topics.add("search");
  if (text.includes("android")) topics.add("android");
  if (text.includes("workspace")) topics.add("workspace");
  if (text.includes("video") || text.includes("image") || text.includes("multimodal")) {
    topics.add("multimodal");
  }

  return [...topics].slice(0, 8);
};

const makeSignal = (item: FeedItem, index: number, now: Date) => {
  const publishedAt = item.pubDate ? new Date(item.pubDate) : now;
  const topics = inferTopics(item);
  const summary = item.description || item.title;

  return {
    id: `sig_google_ai_${slugify(item.title)}_${index + 1}`,
    sourceType: "google_ai_release" as const,
    sourceName: "Google AI Blog",
    title: item.title,
    summary,
    url: item.link,
    observedAt: now.toISOString(),
    topics,
    audience: ["operator", "developer", "agent-builder"],
    metrics: {
      releaseMentions: 1,
      daysSincePublished: daysBetween(now, publishedAt),
    },
    whyItMatters:
      "Google AI releases and product updates often reveal new user workflows that can be turned into small Hackbase.ai artifacts.",
    prototypeHint:
      "Create a capability map, workflow explainer, comparison board, or adoption checklist inspired by the release.",
    riskNotes:
      "Use public release metadata only. Do not require Google account access, paid APIs, secrets, or live product integration.",
    rawExcerpt: summary.slice(0, 500),
  };
};

const fetchFeed = async (feed: string) => {
  const response = await fetch(feed, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "Prodia-google-ai-signal-fetcher",
    },
  });

  if (!response.ok) {
    throw new Error(`${feed} failed: ${response.status}`);
  }

  return response.text();
};

async function main() {
  const args = parseArgs();
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(args.limit, 20)) : 8;
  const fetched: FeedItem[] = [];
  const failures: string[] = [];

  for (const feed of args.feeds) {
    try {
      fetched.push(...parseFeedItems(await fetchFeed(feed)));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (fetched.length === 0) {
    throw new Error(`No Google AI feed items could be fetched. ${failures.join(" / ")}`);
  }

  const now = new Date();
  const items = [...new Map(fetched.map((item) => [item.link, item])).values()]
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, limit);
  const output: SignalOutput = {
    version: `google-ai.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "google_ai_release",
      feeds: args.feeds,
      note:
        failures.length > 0
          ? `Fetched Google AI signals with fallback failures: ${failures.join(" / ")}`
          : "Fetched Google AI release signals from configured feeds.",
    },
    signals: items.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), args.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(`Wrote ${output.signals.length} Google AI signals to ${args.output}`);
  console.log(`Feeds: ${args.feeds.join(", ")}`);
  if (failures.length > 0) {
    console.log(`Fallback failures: ${failures.join(" / ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
