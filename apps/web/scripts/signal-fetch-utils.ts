export type FeedItem = {
  title: string;
  link: string;
  pubDate: string;
  description: string;
};

export const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item.startsWith("--")) {
      values.set(item.slice(2), raw[index + 1] ?? "");
      index += 1;
    }
  }

  return values;
};

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

export const stripTags = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const decodeXml = (value: string) =>
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

export const parseFeedItems = (xml: string): FeedItem[] => {
  const itemBlocks = [...xml.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]);

  return itemBlocks
    .map((block) => {
      const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";

      return {
        title: extractTag(block, "title"),
        link: extractTag(block, "link") || atomLink,
        pubDate: extractTag(block, "pubDate") || extractTag(block, "updated") || extractTag(block, "published"),
        description: extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content"),
      };
    })
    .filter((item) => item.title && item.link);
};

export const fetchText = async (url: string, userAgent: string) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status}`);
  }

  return response.text();
};

export const absoluteUrl = (baseUrl: string, value: string) => {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
};

export const parseHtmlLinks = (html: string, baseUrl: string, pathPattern: RegExp, limit: number) => {
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      url: absoluteUrl(baseUrl, match[1]),
      title: decodeXml(match[2]),
    }))
    .filter((item) => item.title && pathPattern.test(item.url));
  const unique = new Map<string, FeedItem>();

  for (const item of links) {
    if (!unique.has(item.url)) {
      unique.set(item.url, {
        title: item.title,
        link: item.url,
        pubDate: "",
        description: item.title,
      });
    }
  }

  return [...unique.values()].slice(0, limit);
};

export const daysBetween = (left: Date, right: Date) =>
  Number.isNaN(right.getTime())
    ? 0
    : Math.max(0, Math.round((left.getTime() - right.getTime()) / 1000 / 60 / 60 / 24));
