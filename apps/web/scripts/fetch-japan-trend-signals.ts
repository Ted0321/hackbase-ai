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
    type: "japan_social_trend";
    urls: string[];
    note: string;
  };
  signals: Array<{
    id: string;
    sourceType: "japan_social_trend";
    sourceName: string;
    title: string;
    summary: string;
    url: string;
    observedAt: string;
    topics: string[];
    audience: string[];
    metrics: {
      trendMentions: number;
    };
    whyItMatters: string;
    researchNote: string;
    riskNotes: string;
    rawExcerpt: string;
  }>;
};

const defaultUrls = [
  "https://www3.nhk.or.jp/rss/news/cat0.xml",
  "https://news.yahoo.co.jp/topics",
  "https://prtimes.jp/",
];

const inferTopics = (item: FeedItem) => {
  const text = `${item.title} ${item.description} ${item.link}`.toLowerCase();
  const topics = new Set<string>(["japan", "social-trend"]);

  if (text.includes("ai") || text.includes("ＡＩ") || text.includes("人工知能")) topics.add("ai");
  if (text.includes("スポーツ") || text.includes("サッカー") || text.includes("野球")) topics.add("sports");
  if (text.includes("教育") || text.includes("学校") || text.includes("学習")) topics.add("education");
  if (text.includes("防災") || text.includes("地震") || text.includes("災害")) topics.add("civic");
  if (text.includes("観光") || text.includes("旅行")) topics.add("travel");
  if (text.includes("商品") || text.includes("発売") || text.includes("キャンペーン")) topics.add("consumer");
  if (text.includes("ゲーム") || text.includes("アニメ") || text.includes("映画")) topics.add("entertainment");
  if (text.includes("経済") || text.includes("物価")) topics.add("economy");

  return [...topics].slice(0, 8);
};

const sourceNameFor = (url: string) => {
  if (url.includes("nhk.or.jp")) return "NHK News";
  if (url.includes("yahoo.co.jp")) return "Yahoo! Japan Topics";
  if (url.includes("prtimes.jp")) return "PR TIMES";
  return "Japan Trend Source";
};

const makeSignal = (item: FeedItem, index: number, now: Date) => {
  const topics = inferTopics(item);
  const summary = item.description || item.title;

  return {
    id: `sig_japan_trend_${slugify(item.title)}_${index + 1}`,
    sourceType: "japan_social_trend" as const,
    sourceName: sourceNameFor(item.link),
    title: item.title,
    summary,
    url: item.link,
    observedAt: now.toISOString(),
    topics,
    audience: ["general-public", "curator", "educator", "builder"],
    metrics: {
      trendMentions: 1,
    },
    whyItMatters:
      "Japan social trend sources provide timely cultural, civic, education, sports, and consumer contexts that can diversify Hackbase.ai beyond technical tools.",
    researchNote:
      "Record what is happening, who is affected, visible public behavior, regional/seasonal context, and uncertainty. Do not decide the final product concept.",
    riskNotes:
      "Use public headline and summary metadata only. Avoid long article text, legal/medical advice, disaster misinformation, or claims without source context.",
    rawExcerpt: summary.slice(0, 500),
  };
};

const fetchItems = async (url: string, limit: number) => {
  const text = await fetchText(url, "Prodia-japan-trend-signal-fetcher");
  const feedItems = parseFeedItems(text);

  if (feedItems.length > 0) {
    return feedItems;
  }

  return parseHtmlLinks(text, url, /(nhk\.or\.jp\/news|news\.yahoo\.co\.jp|prtimes\.jp\/main\/html)/i, limit);
};

async function main() {
  const values = parseArgs();
  const output = values.get("output") ?? "data/japan-trend-signals.json";
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
    throw new Error(`No Japan trend items could be fetched. ${failures.join(" / ")}`);
  }

  const now = new Date();
  const uniqueItems = [...new Map(fetched.map((item) => [item.link, item])).values()].slice(0, limit);
  const payload: SignalOutput = {
    version: `japan-social-trend.${now.toISOString()}`,
    fetchedAt: now.toISOString(),
    source: {
      type: "japan_social_trend",
      urls,
      note:
        failures.length > 0
          ? `Fetched Japan trend signals with fallback failures: ${failures.join(" / ")}`
          : "Fetched Japan trend signals from configured public URLs.",
    },
    signals: uniqueItems.map((item, index) => makeSignal(item, index, now)),
  };
  const outputPath = path.resolve(process.cwd(), output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${payload.signals.length} Japan trend signals to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
