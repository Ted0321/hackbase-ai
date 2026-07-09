import assert from "node:assert";
import {
  DEFAULT_SOURCE_INDEX_INJECT_LIMIT,
  resolveInjectLimit,
  selectSourceEntriesForInjection,
} from "./select-source-entries";

const makeIndex = (count: number, categories: string[]) => ({
  version: 1,
  entries: Array.from({ length: count }, (_, i) => ({
    id: `entry_${i}`,
    name: `Entry ${i}`,
    sourceCategory: categories[i % categories.length],
    observedAt: new Date(Date.UTC(2026, 0, 1 + (i % 180))).toISOString(),
  })),
});

const main = () => {
  // resolveInjectLimit
  assert.strictEqual(resolveInjectLimit(undefined), DEFAULT_SOURCE_INDEX_INJECT_LIMIT);
  assert.strictEqual(resolveInjectLimit(""), DEFAULT_SOURCE_INDEX_INJECT_LIMIT);
  assert.strictEqual(resolveInjectLimit("50"), 50);
  assert.strictEqual(resolveInjectLimit("0"), 0);
  assert.strictEqual(resolveInjectLimit("garbage"), DEFAULT_SOURCE_INDEX_INJECT_LIMIT);

  // Small index passes through untouched (same reference).
  const small = makeIndex(10, ["a", "b"]);
  assert.strictEqual(selectSourceEntriesForInjection(small, { limit: 110, seed: "run_x" }), small);

  // Null/undefined/entries-less inputs pass through.
  assert.strictEqual(selectSourceEntriesForInjection(null, { limit: 10, seed: "s" }), null);
  const noEntries = { version: 1 } as { version: number; entries?: never[] };
  assert.strictEqual(selectSourceEntriesForInjection(noEntries, { limit: 10, seed: "s" }), noEntries);

  // limit<=0 disables the cap.
  const big = makeIndex(300, ["hackathon_winner", "github_rising", "product_gallery"]);
  assert.strictEqual(selectSourceEntriesForInjection(big, { limit: 0, seed: "run_x" }), big);

  // Caps to the limit, keeps metadata, does not mutate the original.
  const selected = selectSourceEntriesForInjection(big, { limit: 110, seed: "run_a" });
  assert.notStrictEqual(selected, big);
  assert.strictEqual(big.entries.length, 300);
  assert.strictEqual(selected.entries?.length, 110);
  const policy = (selected as unknown as { injectionPolicy: { totalEntryCount: number } }).injectionPolicy;
  assert.strictEqual(policy.totalEntryCount, 300);

  // No duplicate entries in the selection.
  const ids = new Set(selected.entries?.map((entry) => entry.id));
  assert.strictEqual(ids.size, 110);

  // Category diversity: round-robin means each of the 3 categories contributes ~1/3.
  const byCategory = new Map<string, number>();
  for (const entry of selected.entries ?? []) {
    byCategory.set(String(entry.sourceCategory), (byCategory.get(String(entry.sourceCategory)) ?? 0) + 1);
  }
  for (const [, count] of byCategory) {
    assert.ok(count >= 30 && count <= 40, `category share out of range: ${count}`);
  }

  // Deterministic for the same seed; rotates for a different seed.
  const again = selectSourceEntriesForInjection(big, { limit: 110, seed: "run_a" });
  assert.deepStrictEqual(
    again.entries?.map((entry) => entry.id),
    selected.entries?.map((entry) => entry.id),
  );
  const other = selectSourceEntriesForInjection(big, { limit: 110, seed: "run_b" });
  const otherIds = other.entries?.map((entry) => entry.id).join(",");
  assert.notStrictEqual(otherIds, selected.entries?.map((entry) => entry.id).join(","));

  // Recency bias: the newest entries should be much more likely to appear than the oldest.
  const newest = big.entries
    .slice()
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, 30)
    .map((entry) => entry.id);
  const selectedIds = new Set(selected.entries?.map((entry) => entry.id));
  const newestKept = newest.filter((id) => selectedIds.has(id)).length;
  assert.ok(newestKept >= 15, `expected recency bias, newest kept: ${newestKept}/30`);

  // Prefix property: a smaller limit with the same seed is a strict prefix of the
  // larger selection (concept subset ⊆ research subset).
  const broad = selectSourceEntriesForInjection(big, { limit: 110, seed: "run_prefix" });
  const narrow = selectSourceEntriesForInjection(big, { limit: 60, seed: "run_prefix" });
  assert.deepStrictEqual(
    narrow.entries?.map((entry) => entry.id),
    broad.entries?.slice(0, 60).map((entry) => entry.id),
  );

  console.log("select-source-entries tests passed");
};

main();
