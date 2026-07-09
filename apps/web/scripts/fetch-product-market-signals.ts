import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
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
    type: "product_market_watch";
    urls: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "product_market_watch";
    sourceName: string;
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      launchMentions: number;
      daysSincePublished: number | null;
      titleQualityScore: number;
      reactionSignalScore: number;
    };
    whyItMatters: string;
    researchNote: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const defaultUrls = [
  "https://www.producthunt.com/feed",
  "https://www.producthunt.com/",
  "https://devpost.com/hackathons",
];

const inferTopics = (item: FeedItem) => {
  const text = `${item.title} ${item.description} ${item.link}`.toLowerCase();
  const topics = new Set<string>(["product", "market", "launch"]);

  if (text.includes("ai")) topics.add("ai");
  if (text.includes("agent")) topics.add("agent");
  if (text.includes("producthunt")) topics.add("product-hunt");
  if (text.includes("devpost") || text.includes("hackathon")) topics.add("hackathon");
  if (text.includes("education")) topics.add("education");
  if (text.includes("design") || text.includes("figma")) topics.add("creator-tool");
  if (text.includes("browser") || text.includes("extension")) topics.add("extension");
  if (text.includes("game")) topics.add("game");

  return [...topics].slice(0, 8);
};

const sourceNameFor = (url: string) => {
  if (url.includes("producthunt.com")) return "Product Hunt";
  if (url.includes("devpost.com")) return "Devpost";
  return "Product/Maker Source";
};

const daysSince = (dateText: string, now: Date) => {
  const date = new Date(dateText);

  if (Number.isNaN(date.getTime())) return null;

  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000 / 60 / 60 / 24));
};

const titleQualityScore = (item: FeedItem) => {
  const title = item.title.trim();
  let score = 3;

  if (/^\d+\.\s/.test(title)) score -= 2;
  if (title.length < 8) score -= 1;
  if (item.description && item.description !== item.title) score += 1;
  if (/ai|agent|browser|extension|workflow|education|game|design|figma/i.test(`${title} ${item.description}`)) {
    score += 1;
  }

  return Math.max(1, Math.min(5, score));
};

const reactionSignalScore = (item: FeedItem) => {
  const text = `${item.title} ${item.description}`.toLowerCase();
  let score = 1;

  if (item.pubDate) score += 1;
  if (text.includes("comment") || text.includes("review") || text.includes("users")) score += 1;
  if (text.includes("launch") || text.includes("show hn") || text.includes("hackathon")) score += 1;
  if (text.includes("waitlist") || text.includes("beta") || text.includes("open source")) score += 1;

  return Math.max(1, Math.min(5, score));
};

const makeSignal = (item: FeedItem, index: number, now: Date) => {
  const topics = inferTopics(item);
  const summary = item.description || item.title;
  const sourceName = sourceNameFor(item.link);
  const publishedAge = daysSince(item.pubDate, now);
  const qualityScore = titleQualityScore(item);
  const reactionScore = reactionSignalScore(item);

  return {
    id: `sig_product_market_${slugify(item.title)}_${index + 1}`,
    sourceType: "product_market_watch" as const,
    sourceName,
    title: item.title,
    summary,
    url: item.link,
    observedAt: now.toISOString(),
    topics,
    audience: ["maker", "product-researcher", "builder", "curator"],
    metrics: {
      launchMentions: 1,
      daysSincePublished: publishedAge,
      titleQualityScore: qualityScore,
      reactionSignalScore: reactionScore,
    },
    whyItMatters:
      "Product and maker launch surfaces reveal interface patterns, positioning, user behavior shifts, and small demoable mechanisms.",
    researchNote:
      [
        "Record the interface pattern, user behavior, confusion/excitement signal, and market gap. Do not propose a clone.",
        `Launch evidence: source=${sourceName}, daysSincePublished=${publishedAge ?? "unknown"}, titleQualityScore=${qualityScore}, reactionSignalScore=${reactionScore}.`,
        "Treat this as launch visibility, not proof of sustained demand unless comments, ranking movement, installs, or usage evidence are present.",
      ].join(" "),
    riskNotes:
      "Use public launch metadata only. Do not scrape private comments, require accounts, copy branding, or treat votes as proof of user value.",
    rawExcerpt: summary.slice(0, 500),
  };
};

const fetchItems = async (url: string, limit: number) => {
  const text = await fetchText(url, "Prodia-product-market-signal-fetcher");
  const feedItems = parseFeedItems(text);

  if (feedItems.length > 0) {
    return feedItems;
  }

  return parseHtmlLinks(text, url, /(producthunt\.com\/(products|posts)|devpost\.com\/software|devpost\.com\/hackathons)/i, limit);
};

async function main() {
  const values = parseArgs();
  const output = values.get("output") ?? "data/product-market-signals.json";
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
    throw new Error(`No product market items could be fetched. ${failures.join(" / ")}`);
  }

  const now = new Date();
  const uniqueItems = [...new Map(fetched.map((item) => [item.link, item])).values()].slice(0, limit);
  const payload: SignalOutput = {
    version: `product-market.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "product_market_watch",
      urls,
      note:
        failures.length > 0
          ? `Fetched product market signals with fallback failures: ${failures.join(" / ")}`
          : "Fetched product market signals from configured public URLs.",
    },
    signals: uniqueItems.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${payload.signals.length} product market signals to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
