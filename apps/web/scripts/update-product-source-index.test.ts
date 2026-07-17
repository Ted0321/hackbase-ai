import assert from "node:assert/strict";
import {
  validateSourceProductCards,
  type LoadedExplorationResponse,
} from "./update-product-source-index";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// A minimal primary_source_core card. Other fields are intentionally left thin;
// they surface unrelated validation issues, but the card still reaches the
// canonicalKey aggregation, which is what these tests assert on (we filter to
// field === "canonicalKey"). usePolicy must be primary_source_core because only
// writable cards participate in duplicate detection.
const card = (name: string) =>
  ({
    name,
    productUrl: `https://devpost.com/software/${name.toLowerCase()}`,
    usePolicy: "primary_source_core",
    evidenceLevel: "A",
    observedFields: [],
    inferredFields: [],
    missingFields: [],
  }) as never;

const response = (filePath: string, names: string[]): LoadedExplorationResponse =>
  ({
    filePath,
    payload: { sourceProductCards: names.map(card) },
  }) as unknown as LoadedExplorationResponse;

const canonicalKeyIssues = (responses: LoadedExplorationResponse[]) =>
  validateSourceProductCards(responses, []).filter((issue) => issue.field === "canonicalKey");

run("same product across base and enrichment files is not flagged as duplicate", () => {
  // base とその _enrichment に同じ product が出るのは想定内。別ファイル間の再掲で
  // TSV 書き込みを止めない(2026-06-27 の devpost enrichment 恒常 failed の再発防止)。
  const issues = canonicalKeyIssues([
    response("research_explore_devpost_ai/response.json", ["AudioNova"]),
    response("research_explore_devpost_ai_enrichment/response.json", ["AudioNova"]),
  ]);
  assert.deepEqual(issues, []);
});

run("same product listed twice within one file is still flagged", () => {
  const issues = canonicalKeyIssues([
    response("research_explore_devpost_ai/response.json", ["AudioNova", "AudioNova"]),
  ]);
  assert.equal(issues.length, 2);
  for (const issue of issues) {
    assert.match(issue.message, /within a single research response file/);
    assert.equal(issue.filePath, "research_explore_devpost_ai/response.json");
  }
});

run("distinct products across files produce no canonicalKey issues", () => {
  const issues = canonicalKeyIssues([
    response("a/response.json", ["AudioNova"]),
    response("b/response.json", ["Fireflai"]),
  ]);
  assert.deepEqual(issues, []);
});

console.log("All update-product-source-index checks passed.");
