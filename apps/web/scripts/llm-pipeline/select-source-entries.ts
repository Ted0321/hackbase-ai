/**
 * Injection-time selection for the product source index.
 *
 * The canonical index (data/product-research/source-product-index.json) keeps
 * every promoted entry, but injecting all of them into research/combination/
 * concept prompts grows unbounded: at ~100 entries the concept step already
 * crosses Gemini 2.5-pro's 200k-token pricing tier, and around ~500 entries the
 * research step would exceed the 1M-token context window entirely.
 *
 * This module picks a bounded, run-seeded subset for prompt injection:
 * - recency-biased (fresh sources first) with deterministic per-run jitter, so
 *   different runs rotate through different subsets (which also fights concept
 *   duplication),
 * - round-robin across sourceCategory groups so no source family dominates,
 * - deterministic for a given seed (retries within one run see the same set).
 */

type SourceIndexEntry = {
  id?: string;
  name?: string;
  sourceCategory?: string;
  observedAt?: string;
  lastUpdatedAt?: string;
  [key: string]: unknown;
};

type SourceIndexLike = {
  entries?: SourceIndexEntry[];
  [key: string]: unknown;
};

const hashSeed = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

// mulberry32: tiny deterministic PRNG (no Math.random so runs are replayable).
const seededRandom = (seed: number) => {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const entryTimestamp = (entry: SourceIndexEntry) => {
  const raw = entry.lastUpdatedAt ?? entry.observedAt ?? "";
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const DEFAULT_SOURCE_INDEX_INJECT_LIMIT = 110;

// The concept step runs on gemini-2.5-pro, where prompts above 200k tokens are
// billed at double rate — so it gets a smaller subset. Because the selection
// sequence is deterministic per seed, a smaller limit yields a strict prefix of
// the larger selection: concept always sees a subset of what research saw, and
// the sources behind combination's selected remixes still arrive in full via
// research's own response.
export const DEFAULT_SOURCE_INDEX_INJECT_LIMIT_CONCEPT = 40;

export const resolveInjectLimit = (rawEnvValue: string | undefined, fallback = DEFAULT_SOURCE_INDEX_INJECT_LIMIT) => {
  if (rawEnvValue === undefined || rawEnvValue.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed)) return fallback;
  // 0 or negative disables the cap (inject everything).
  return parsed;
};

export const selectSourceEntriesForInjection = <T extends SourceIndexLike | null | undefined>(
  index: T,
  options: { limit: number; seed: string },
): T => {
  const entries = index?.entries;
  if (!index || !Array.isArray(entries)) return index;
  if (options.limit <= 0 || entries.length <= options.limit) return index;

  const random = seededRandom(hashSeed(options.seed));

  // Group by sourceCategory, order each group recency-first with seeded jitter
  // (jitter lets older entries rotate in across runs instead of never surfacing).
  const groups = new Map<string, SourceIndexEntry[]>();
  for (const entry of entries) {
    const key = String(entry.sourceCategory ?? "uncategorized");
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const orderedGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const byRecency = [...group].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
      return byRecency
        .map((entry, recencyRank) => ({
          entry,
          sortKey: recencyRank + random() * group.length * 0.5,
        }))
        .sort((a, b) => a.sortKey - b.sortKey)
        .map(({ entry }) => entry);
    });

  const selected: SourceIndexEntry[] = [];
  for (let round = 0; selected.length < options.limit; round += 1) {
    let picked = false;
    for (const group of orderedGroups) {
      const entry = group[round];
      if (!entry) continue;
      selected.push(entry);
      picked = true;
      if (selected.length >= options.limit) break;
    }
    if (!picked) break;
  }

  return {
    ...index,
    entries: selected,
    injectionPolicy: {
      note: "Rotating subset selected for prompt injection; the full canonical index lives in data/product-research/source-product-index.json.",
      selectedEntryCount: selected.length,
      totalEntryCount: entries.length,
      seed: options.seed,
    },
  } as T;
};
