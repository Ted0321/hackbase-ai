import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultSourceProductIndexPath, readJsonOptional } from "./research-cache";

type SourceProductIndex = {
  entries?: Array<{
    name?: string;
    productUrl?: string | null;
    codeUrl?: string | null;
    url?: string;
    canonicalKey?: string;
  }>;
};

type SourceProductCard = {
  id: string;
  name: string;
  sourceType: string;
  sourceCategory: string;
  url: string;
  productUrl: string;
  codeUrl: string | null;
  observedAt: string;
  originalDomain: string;
  concept: string;
  oneLineDescription: string;
  problemSolved: string;
  targetUser: string;
  coreUserInput: string;
  coreOutput: string;
  outputArtifact: string;
  coreMechanism: string;
  interactionPattern: string;
  whyItIsInteresting: string;
  whyItGotAttention: string;
  adoptionOrAttentionProof: string[];
  attentionProof: string[];
  scaleClassification: string;
  reasonIncluded: string;
  reasonNotMajorProduct: string;
  transferableStructure: string;
  ideaKernel: string;
  noveltyKernel: string;
  transformationAxes: string[];
  cloneRisk: string;
  antiCloneBoundary: string;
  doNotCopy: string[];
  remixableThemes: string[];
  bestRemixTargets: string[];
  evidenceRefs: string[];
  evidenceStrength: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  evidenceLevel: "A" | "B" | "C" | "D";
  observedFields: string[];
  inferredFields: string[];
  missingFields: string[];
  usePolicy: "primary_source_core" | "weak_context" | "candidate_only" | "exclude";
};

type Candidate = {
  name: string;
  url: string;
  productUrl: string;
  codeUrl?: string | null;
  sourceType: "github_rising" | "hackathon_demo" | "hackathon_winner" | "huggingface_space" | "show_hn_demo";
  sourceCategory: "github_rising" | "hackathon_demo" | "hackathon_winner" | "product_gallery";
  summary: string;
  proof: string[];
  domain: string;
  tags: string[];
  evidenceStrength: "low" | "medium" | "high";
};

type GitHubSearchResponse = {
  items?: Array<{
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    pushed_at: string;
    created_at: string;
    homepage?: string | null;
    topics?: string[];
  }>;
};

type HuggingFaceSpace = {
  id: string;
  likes?: number;
  sdk?: string;
  createdAt?: string;
  tags?: string[];
};

type HackerNewsSearchResponse = {
  hits?: Array<{
    objectID: string;
    title?: string;
    url?: string;
    points?: number;
    num_comments?: number;
    created_at?: string;
  }>;
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return {
    outputDir: String(values.get("output-dir") ?? "data/research-exploration"),
    index: String(values.get("index") ?? defaultSourceProductIndexPath),
    perSource: Number.parseInt(String(values.get("per-source") ?? "5"), 10),
    githubQuery: String(values.get("github-query") ?? ""),
    devpostQuery: String(values.get("devpost-query") ?? "ai"),
    hnQuery: String(values.get("hn-query") ?? "AI"),
    hnSinceDays: Number.parseInt(String(values.get("hn-since-days") ?? "30"), 10),
    spaceAppsWinnersUrl: String(
      values.get("spaceapps-winners-url") ?? "https://www.spaceappschallenge.org/2025/meet-the-2025-global-winners/",
    ),
    includeGithub: values.get("github") !== "false",
    includeDevpost: values.get("devpost") !== "false",
    includeHuggingFace: values.get("huggingface") !== "false",
    includeShowHn: values.get("show-hn") !== "false",
    includeSpaceApps: values.get("spaceapps") !== "false",
  };
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);

const normalizeUrl = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\/+$/g, "").toLowerCase();

const stripHtml = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCandidateText = (value: string) =>
  value
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2013|\u2014/g, "-")
    .replace(/窶・/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const fetchText = async (url: string) => {
  const headers: Record<string, string> = {
    "User-Agent": "Prodia-product-source-refresh",
    Accept: "text/html,application/json",
  };
  // Auth only for the GitHub API host — never send the token to scraped sites.
  if (process.env.GITHUB_TOKEN && url.startsWith("https://api.github.com/")) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }

  return response.text();
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const text = await fetchText(url);
  return JSON.parse(text) as T;
};

const existingUrlSet = (index: SourceProductIndex | null) => {
  const urls = new Set<string>();

  for (const entry of index?.entries ?? []) {
    for (const value of [entry.productUrl, entry.codeUrl, entry.url]) {
      const normalized = normalizeUrl(value);
      if (normalized) urls.add(normalized);
    }
  }

  return urls;
};

const isoDaysAgo = (days: number) => {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 10);
};

// Diverse discovery lanes so daily candidates are not all agent/devtool repos.
// A single --github-query still overrides everything.
const defaultGithubDiscoveryQueries = () => [
  `topic:ai-agent created:>${isoDaysAgo(190)} pushed:>${isoDaysAgo(37)} stars:>50`,
  `ai education learning created:>${isoDaysAgo(365)} pushed:>${isoDaysAgo(45)} stars:>30`,
  `ai music audio created:>${isoDaysAgo(365)} pushed:>${isoDaysAgo(45)} stars:>30`,
  `ai visualization created:>${isoDaysAgo(365)} pushed:>${isoDaysAgo(45)} stars:>30`,
  `ai game created:>${isoDaysAgo(365)} pushed:>${isoDaysAgo(45)} stars:>30`,
  `ai science biology created:>${isoDaysAgo(450)} pushed:>${isoDaysAgo(60)} stars:>30`,
  `ai accessibility created:>${isoDaysAgo(450)} pushed:>${isoDaysAgo(60)} stars:>20`,
  `ai creative art generation created:>${isoDaysAgo(365)} pushed:>${isoDaysAgo(45)} stars:>30`,
];

// Catalog/list repositories (awesome lists, interview guides, book collections)
// are attention magnets but not product-shaped idea sources.
const looksLikeCatalogRepo = (repo: NonNullable<GitHubSearchResponse["items"]>[number]) => {
  const text = `${repo.full_name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
  return /awesome[-_ ]|curated list|book|interview|面试|书籍|roadmap|curriculum|cheat[- ]?sheet|collection of/.test(
    text,
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const candidateFromRepo = (
  repo: NonNullable<GitHubSearchResponse["items"]>[number],
  query: string,
): Candidate => ({
  name: repo.full_name.split("/").at(-1) ?? repo.full_name,
  url: repo.html_url,
  productUrl: repo.html_url,
  codeUrl: repo.html_url,
  sourceType: "github_rising",
  sourceCategory: "github_rising",
  summary: repo.description ?? "A recently active GitHub project with product-source potential.",
  proof: [
    `GitHub stars: ${repo.stargazers_count}`,
    `GitHub forks: ${repo.forks_count}`,
    `Created: ${repo.created_at}`,
    `Pushed: ${repo.pushed_at}`,
    `Query: ${query}`,
  ],
  domain: "GitHub OSS project",
  tags: repo.topics ?? [],
  evidenceStrength: repo.stargazers_count >= 1000 ? "medium" : "low",
});

const fetchGithubCandidates = async (queryOverride: string, limit: number): Promise<Candidate[]> => {
  const queries = queryOverride ? [queryOverride] : defaultGithubDiscoveryQueries();
  // Unauthenticated GitHub search allows 10 requests/min; space out multi-lane runs.
  const spacingMs = process.env.GITHUB_TOKEN || queries.length === 1 ? 0 : 7000;

  const lanes: Array<Array<{ repo: NonNullable<GitHubSearchResponse["items"]>[number]; query: string }>> = [];
  for (const [index, query] of queries.entries()) {
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);
    try {
      const params = new URLSearchParams({
        q: query,
        sort: "stars",
        order: "desc",
        per_page: String(Math.min(Math.max(limit, 3), 10)),
      });
      const payload = await fetchJson<GitHubSearchResponse>(
        `https://api.github.com/search/repositories?${params.toString()}`,
      );
      lanes.push(
        (payload.items ?? []).filter((repo) => !looksLikeCatalogRepo(repo)).map((repo) => ({ repo, query })),
      );
    } catch (error) {
      console.warn(
        `GitHub discovery lane failed, skipping "${query}": ${error instanceof Error ? error.message : String(error)}`,
      );
      lanes.push([]);
    }
  }

  // Round-robin across lanes so no single theme dominates the candidate set.
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  for (let round = 0; merged.length < limit; round += 1) {
    let picked = false;
    for (const lane of lanes) {
      const item = lane[round];
      if (!item || seen.has(item.repo.full_name)) continue;
      seen.add(item.repo.full_name);
      merged.push(candidateFromRepo(item.repo, item.query));
      picked = true;
      if (merged.length >= limit) break;
    }
    if (!picked) break;
  }

  return merged;
};

const devpostLinksFrom = (html: string, limit: number) =>
  [
    ...new Set(
      [...html.matchAll(/href="(https:\/\/devpost\.com\/software\/[^"#?]+)(?:[?#][^"]*)?"/g)]
        .map((match) => match[1])
        .filter((url) => !url.includes("/built-with/")),
    ),
  ].slice(0, limit);

const parseDevpostPage = (url: string, html: string): Candidate => {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? url.split("/").at(-1) ?? "Devpost project");
  const tagline = stripHtml(html.match(/<p class="large"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
  const plain = stripHtml(html);
  const builtWith =
    plain.match(/Built With\s+(.+?)\s+Try it out/)?.[1]?.trim() ??
    plain.match(/Built With\s+(.+?)\s+Submitted to/)?.[1]?.trim() ??
    "";
  const submittedTo =
    plain.match(/Submitted to\s+(.+?)(?:\s+Created by|\s+About|\s+Built With|\s+This project|$)/)?.[1]?.trim() ?? "";
  const codeUrl = [...html.matchAll(/https:\/\/github\.com\/[^"'<>\s]+/g)][0]?.[0]?.replace(/&amp;.*$/, "") ?? null;

  return {
    name: title,
    url,
    productUrl: url,
    codeUrl,
    sourceType: "hackathon_demo",
    sourceCategory: "hackathon_demo",
    summary: tagline || `Devpost hackathon project: ${title}.`,
    proof: [
      submittedTo ? `Submitted to: ${submittedTo}` : "Submitted to: Devpost hackathon project page",
      builtWith ? `Built With: ${builtWith}` : "Built With: not extracted",
      codeUrl ? `External code: ${codeUrl}` : "External code: not extracted",
    ],
    domain: "Devpost hackathon demo",
    tags: builtWith ? builtWith.split(/\s+/g).slice(0, 12) : ["devpost", "hackathon"],
    evidenceStrength: submittedTo.toLowerCase().includes("winner") ? "high" : "medium",
  };
};

const extractMetaContent = (html: string, property: string) => {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return stripHtml(pattern.exec(html)?.[1] ?? "");
};

const fetchDevpostCandidates = async (query: string, limit: number): Promise<Candidate[]> => {
  const searchUrl = `https://devpost.com/software?query=${encodeURIComponent(query)}&sort_by=recently_submitted`;
  const html = await fetchText(searchUrl);
  const links = devpostLinksFrom(html, limit);
  const pages = await Promise.all(
    links.map(async (url) => parseDevpostPage(url, await fetchText(url))),
  );

  return pages;
};

const fetchShowHnCandidates = async (query: string, sinceDays: number, limit: number): Promise<Candidate[]> => {
  const minCreatedAt = Math.floor((Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000) / 1000);
  const params = new URLSearchParams({
    tags: "show_hn",
    query,
    numericFilters: `created_at_i>${minCreatedAt}`,
    hitsPerPage: String(limit),
  });
  const payload = await fetchJson<HackerNewsSearchResponse>(
    `https://hn.algolia.com/api/v1/search_by_date?${params.toString()}`,
  );

  return (payload.hits ?? [])
    .filter((hit) => hit.title)
    .map((hit) => {
      const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const productUrl = hit.url || hnUrl;
      const proof = [
        `Show HN story: ${hit.objectID}`,
        `Points observed: ${hit.points ?? 0}`,
        `Comments observed: ${hit.num_comments ?? 0}`,
        `Posted: ${hit.created_at ?? "unknown"}`,
      ];

      return {
        name: normalizeCandidateText((hit.title ?? "Show HN project").replace(/^Show HN:\s*/i, "")),
        url: hnUrl,
        productUrl,
        codeUrl: productUrl.includes("github.com/") ? productUrl : null,
        sourceType: "show_hn_demo",
        sourceCategory: "hackathon_demo",
        summary: `A recent Show HN project: ${normalizeCandidateText(hit.title ?? "Show HN project")}.`,
        proof,
        domain: "Show HN public demo",
        tags: ["show_hn", "launch", query.toLowerCase()],
        evidenceStrength: (hit.points ?? 0) >= 50 || (hit.num_comments ?? 0) >= 20 ? "high" : "medium",
      } satisfies Candidate;
    });
};

const spaceAppsTeamLinksFrom = (html: string, limit: number) =>
  [
    ...new Set(
      [...html.matchAll(/href="(https:\/\/www\.spaceappschallenge\.org\/[^"]*\/find-a-team\/[^"#?]+\/?)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].slice(0, limit);

const parseSpaceAppsPage = (url: string, html: string): Candidate => {
  const title =
    stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    extractMetaContent(html, "og:title") ||
    url.split("/").filter(Boolean).at(-1)?.replace(/-/g, " ") ||
    "NASA Space Apps project";
  const description =
    extractMetaContent(html, "og:description") ||
    stripHtml(html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "") ||
    `NASA Space Apps project: ${title}.`;
  const plain = stripHtml(html);
  const award =
    plain.match(/Global Winner[^.]{0,120}/i)?.[0]?.trim() ??
    plain.match(/Award[^.]{0,120}/i)?.[0]?.trim() ??
    "NASA Space Apps official project page";

  return {
    name: title,
    url,
    productUrl: url,
    codeUrl: [...html.matchAll(/https:\/\/github\.com\/[^"'<>\s]+/g)][0]?.[0]?.replace(/&amp;.*$/, "") ?? null,
    sourceType: "hackathon_winner",
    sourceCategory: "hackathon_winner",
    summary: description,
    proof: [award, `Official team page: ${url}`],
    domain: "NASA Space Apps hackathon winner",
    tags: ["nasa", "spaceapps", "hackathon", "winner"],
    evidenceStrength: "high",
  };
};

const fetchSpaceAppsCandidates = async (winnersUrl: string, limit: number): Promise<Candidate[]> => {
  const html = await fetchText(winnersUrl);
  const links = spaceAppsTeamLinksFrom(html, limit);
  const pages = await Promise.all(links.map(async (url) => parseSpaceAppsPage(url, await fetchText(url))));
  return pages;
};

const fetchHuggingFaceCandidates = async (limit: number): Promise<Candidate[]> => {
  const payload = await fetchJson<{ value?: HuggingFaceSpace[] } | HuggingFaceSpace[]>(
    `https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=${limit}`,
  );
  const spaces = Array.isArray(payload) ? payload : (payload.value ?? []);

  return spaces.map((space) => ({
    name: space.id.split("/").at(-1) ?? space.id,
    url: `https://huggingface.co/spaces/${space.id}`,
    productUrl: `https://huggingface.co/spaces/${space.id}`,
    codeUrl: null,
    sourceType: "huggingface_space",
    sourceCategory: "product_gallery",
    summary: `A public Hugging Face Space with ${space.likes ?? 0} likes and ${space.sdk ?? "unknown"} SDK.`,
    proof: [
      `Hugging Face likes: ${space.likes ?? 0}`,
      `Created: ${space.createdAt ?? "unknown"}`,
      `SDK: ${space.sdk ?? "unknown"}`,
    ],
    domain: "Hugging Face public demo",
    tags: space.tags ?? ["huggingface", "space"],
    evidenceStrength: (space.likes ?? 0) >= 1000 ? "high" : "medium",
  }));
};

const cardFromCandidate = (candidate: Candidate, observedAt: string): SourceProductCard => {
  const themes = candidate.tags.slice(0, 4).length > 0 ? candidate.tags.slice(0, 4) : ["workflow", "artifact"];
  const readableTags = themes.join(", ");
  const name = normalizeCandidateText(candidate.name);
  const confidence = candidate.evidenceStrength === "high" || candidate.evidenceStrength === "medium" ? "medium" : "low";

  return {
    id: `${candidate.sourceType}_${slugify(name)}`,
    name,
    sourceType: candidate.sourceType,
    sourceCategory: candidate.sourceCategory,
    url: candidate.url,
    productUrl: candidate.productUrl,
    codeUrl: candidate.codeUrl ?? null,
    observedAt,
    originalDomain: candidate.domain,
    concept: candidate.summary,
    oneLineDescription: candidate.summary,
    problemSolved: `Users need a focused way to turn ${candidate.domain.toLowerCase()} inputs into a concrete output or decision without starting from a blank chat.`,
    targetUser: candidate.sourceType === "github_rising" ? "developers and agent builders" : "makers, judges, and early product users",
    coreUserInput: `Project-specific input, prompt, dataset, workflow context, or configuration from the ${candidate.domain.toLowerCase()} setting.`,
    coreOutput: "A visible demo artifact, workflow result, dashboard, generated output, or decision-support view.",
    outputArtifact: "demoable product-source artifact",
    coreMechanism: `The project packages ${readableTags} signals into a narrow input-to-output workflow, making the mechanism inspectable enough for Hackbase.ai to remix without copying the original product.`,
    interactionPattern: "User provides a narrow task or context, then reviews a concrete result, dashboard, preview, briefing, or generated artifact.",
    whyItIsInteresting: "It is product-shaped rather than a broad platform: the value can be studied as a transferable mechanism.",
    whyItGotAttention: `${candidate.proof.join(" ")} This gives enough public evidence to revisit the project and decide whether it belongs in the permanent source index.`,
    adoptionOrAttentionProof: candidate.proof,
    attentionProof: candidate.proof,
    scaleClassification: candidate.sourceType === "github_rising" ? "early_oss" : "hackathon",
    reasonIncluded: "Generated by the product-source refresh preparer as a reviewable candidate with public source evidence.",
    reasonNotMajorProduct: "This is a candidate from public project/demo surfaces and should still be reviewed before promotion if it resembles a major established product.",
    transferableStructure: `Transfer the pattern of turning ${candidate.domain.toLowerCase()} context into a concrete artifact, dashboard, or decision aid while changing the domain, audience, and branding.`,
    ideaKernel: `${candidate.domain} to concrete artifact`,
    noveltyKernel: "The useful seed is the narrow transformation pattern and visible proof, not the original product category.",
    transformationAxes: ["domain_shift", "output_form_shift", "workflow_translation", "evidence_review"],
    cloneRisk: `Copying ${name}'s name, positioning, source domain, visual identity, or implementation too directly.`,
    antiCloneBoundary: `Do not copy ${name}'s brand, exact workflow, domain claims, or implementation; use only the abstract value mechanism after review.`,
    doNotCopy: [`${name} name`, "exact product workflow", "source branding", "domain-specific claims"],
    remixableThemes: ["education", "civic", "creator workflow", "family life", "sports"],
    bestRemixTargets: ["learning artifact", "local decision helper", "creator workflow dashboard", "public explainer"],
    evidenceRefs: [...new Set([candidate.url, ...(candidate.codeUrl ? [candidate.codeUrl] : [])])],
    evidenceStrength: candidate.evidenceStrength,
    confidence,
    evidenceLevel: candidate.codeUrl ? "B" : "C",
    observedFields: [
      "name",
      "url",
      "productUrl",
      ...(candidate.codeUrl ? ["codeUrl"] : []),
      "attentionProof",
      "evidenceRefs",
    ],
    inferredFields: [
      "problemSolved",
      "targetUser",
      "coreUserInput",
      "coreOutput",
      "outputArtifact",
      "coreMechanism",
      "interactionPattern",
      "transferableStructure",
      "ideaKernel",
      "noveltyKernel",
      "antiCloneBoundary",
      "bestRemixTargets",
    ],
    missingFields: candidate.codeUrl ? [] : ["codeUrl"],
    usePolicy: "candidate_only",
  };
};

const writeHandoff = async (outputDir: string, responsePath: string) => {
  await writeFile(
    path.join(outputDir, "handoff.md"),
    [
      "# Product Source Refresh Handoff",
      "",
      "This directory was generated by `npm run research:product-index:prepare`.",
      "",
      "Review checklist:",
      "",
      "1. Open `response.json` and remove weak or duplicate candidates.",
      "2. Run `npm run research:product-index:review -- --exploration-dir <this-dir>` to see which candidates are promotable.",
      "3. Promote only well-evidenced cards by changing `usePolicy` from `candidate_only` to `primary_source_core`.",
      "4. Keep observed facts in `observedFields`, AI-derived transfer ideas in `inferredFields`, and unavailable facts in `missingFields`.",
      "5. Run `npm run research:index:update -- --dry-run --exploration-dir <this-dir>`.",
      "6. If the dry run is clean, run `npm run research:index:update -- --exploration-dir <this-dir>`.",
      "7. Run `npm run research:index:build`, `npm run research:cache:refresh`, and `npm run research:product-index:check`.",
      "",
      `Response: ${responsePath}`,
      "",
    ].join("\n"),
    "utf8",
  );
};

const main = async () => {
  const args = parseArgs();
  const perSource = Number.isFinite(args.perSource) ? Math.max(1, Math.min(args.perSource, 10)) : 5;
  const now = new Date();
  const runId = `research_product_refresh_${now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  const outputDir = path.resolve(process.cwd(), args.outputDir, runId);
  const index = await readJsonOptional<SourceProductIndex>(args.index);
  const knownUrls = existingUrlSet(index);
  const failures: string[] = [];
  const groups = await Promise.all([
    args.includeGithub
      ? fetchGithubCandidates(args.githubQuery, perSource).catch((error) => {
          failures.push(`github: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        })
      : [],
    args.includeDevpost
      ? fetchDevpostCandidates(args.devpostQuery, perSource).catch((error) => {
          failures.push(`devpost: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        })
      : [],
    args.includeHuggingFace
      ? fetchHuggingFaceCandidates(perSource).catch((error) => {
          failures.push(`huggingface: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        })
      : [],
    args.includeShowHn
      ? fetchShowHnCandidates(args.hnQuery, args.hnSinceDays, perSource).catch((error) => {
          failures.push(`show-hn: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        })
      : [],
    args.includeSpaceApps
      ? fetchSpaceAppsCandidates(args.spaceAppsWinnersUrl, perSource).catch((error) => {
          failures.push(`spaceapps: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        })
      : [],
  ]);
  const candidates = groups
    .flat()
    .filter((candidate) => !knownUrls.has(normalizeUrl(candidate.productUrl)) && !knownUrls.has(normalizeUrl(candidate.codeUrl)))
    .slice(0, perSource * 5);
  const response = {
    version: 1,
    explorationRunId: runId,
    sourceCategory: "product_source_refresh",
    generatedAt: now.toISOString(),
    explorationBrief:
      "Semi-automated product-source refresh draft. Review before accepting into the source-product index.",
    coverageStrategy: {
      targetSources: [
        args.includeGithub ? "GitHub Search API" : "",
        args.includeDevpost ? "Devpost software search and project pages" : "",
        args.includeHuggingFace ? "Hugging Face Spaces API" : "",
        args.includeShowHn ? "Hacker News Algolia Show HN search" : "",
        args.includeSpaceApps ? "NASA Space Apps official winner pages" : "",
      ].filter(Boolean),
      searchQueriesUsed: [
        args.includeGithub
          ? `GitHub: ${args.githubQuery || defaultGithubDiscoveryQueries().join(" | ")}`
          : "",
        args.includeDevpost ? `Devpost query: ${args.devpostQuery}` : "",
        args.includeHuggingFace ? "Hugging Face Spaces sort=likes" : "",
        args.includeShowHn ? `Show HN query: ${args.hnQuery}, sinceDays=${args.hnSinceDays}` : "",
        args.includeSpaceApps ? `NASA Space Apps winners: ${args.spaceAppsWinnersUrl}` : "",
      ].filter(Boolean),
      whyTheseSources:
        "They balance OSS momentum, hackathon submissions, public demo galleries, Show HN launches, and official winner pages so Step1 does not depend on one source family.",
    },
    sourceProductCards: candidates.map((candidate) => cardFromCandidate(candidate, now.toISOString())),
    sourceArchiveIndex: [],
    valueKnowledgeCards: [],
    explorationReports: [
      {
        id: `${runId}_report`,
        lane: "product_market_watch",
        title: "Semi-automated product source refresh",
        sources: candidates.map((candidate) => ({
          title: candidate.name,
          url: candidate.url,
          sourceType: candidate.sourceType,
          evidenceSummary: candidate.proof.join(" "),
        })),
        observedFacts: [
          `Generated ${candidates.length} candidate source cards.`,
          `Skipped candidates already present in ${args.index}.`,
          failures.length > 0 ? `Fetch failures: ${failures.join(" / ")}` : "All enabled source fetches completed.",
        ],
        interpretation:
          "This file is a draft response for existing index gates. It should be reviewed before update because metadata-only cards can be too generic.",
        trendSignal: "Candidate mechanisms should be judged by input-output clarity, public evidence, and remix safety.",
        audienceReaction: "Uses public stars, likes, hackathon submission metadata, or project-page evidence when available.",
        underlyingMechanism: "Metadata is converted into reviewable sourceProductCards for the protected TSV update gate.",
        possibleUseContexts: ["source-product index refresh", "manual curation", "Step1 material expansion"],
        conceptSeeds: candidates.slice(0, 8).map((candidate) => `${candidate.name}: ${candidate.domain}`),
        uncertainties: [
          "Generated fields are structured drafts and may need human tightening.",
          "Award status is only captured when visible in page text.",
          "Major-product exclusion still depends on the update gate and reviewer judgment.",
        ],
        riskNotes: [
          "Do not run the non-dry update until weak candidates are removed.",
          "Do not copy product names, domains, claims, or implementations.",
        ],
        scores: {
          freshness: 4,
          momentum: 3,
          evidenceStrengthScore: 3,
          technicalNovelty: 3,
          socialResonance: 3,
          marketSignal: 3,
          culturalEnergy: 3,
          riskLow: 3,
        },
        evidenceStrength: "medium",
      },
    ],
    coverageGaps: failures,
    editorNotes:
      "Generated response.json is intentionally conservative. Review and delete weak cards before accepting into the protected source-product index.",
  };
  const responsePath = path.join(outputDir, "response.json");

  await mkdir(outputDir, { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
  await writeHandoff(outputDir, path.relative(process.cwd(), responsePath));

  console.log(`Prepared product source refresh draft: ${path.relative(process.cwd(), outputDir)}`);
  console.log(`Candidates: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("No new source-product candidates found. This is a normal empty refresh when fetched candidates already exist or fail review filters.");
  }
  if (failures.length > 0) console.log(`Fetch failures: ${failures.join(" / ")}`);
  console.log(`Next: npm run research:index:update -- --dry-run --exploration-dir ${path.relative(process.cwd(), outputDir)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
