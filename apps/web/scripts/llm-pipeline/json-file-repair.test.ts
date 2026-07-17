import assert from "node:assert/strict";
import {
  coerceParseableJsonContent,
  isReservedPipelineMetadataFile,
  repairJsonFileContent,
} from "./json-file-repair";

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run("valid JSON is returned unchanged", () => {
  const content = `{"status":"ok","score":3}\n`;
  assert.equal(repairJsonFileContent("validation/self-review.json", content), content);
});

run("trailing garbage after the closing brace is stripped (2026-07-10 incident shape)", () => {
  const valid = JSON.stringify({
    version: 1,
    artifactId: "selfdirected_agent_e_test",
    status: "needs_review",
    checks: { firstScreenValue: "declared" },
  });
  const broken = `${valid} status: needs_review }\n`;
  assert.throws(() => JSON.parse(broken));
  const repaired = repairJsonFileContent("source/validation/self-review.json", broken);
  const parsed = JSON.parse(repaired) as { artifactId: string };
  assert.equal(parsed.artifactId, "selfdirected_agent_e_test");
  assert.ok(repaired.endsWith("}\n"));
});

run("markdown fence prefix before the object is stripped too", () => {
  const broken = '```json\n{"title":"demo"}\n```\n';
  const repaired = repairJsonFileContent("manifest.json", broken);
  assert.deepEqual(JSON.parse(repaired), { title: "demo" });
});

run("unrepairable content is returned as-is for the strict gate to catch", () => {
  const broken = `{"title": "demo`;
  assert.equal(repairJsonFileContent("manifest.json", broken), broken);
});

run("coerceParseableJsonContent returns valid content unchanged", () => {
  const content = `{"a":1}\n`;
  assert.equal(coerceParseableJsonContent(content), content);
});

run("coerceParseableJsonContent repairs trailing garbage", () => {
  const repaired = coerceParseableJsonContent(`{"a":1} trailing junk`);
  assert.ok(repaired);
  assert.deepEqual(JSON.parse(repaired as string), { a: 1 });
});

run("coerceParseableJsonContent rejects mid-document truncation (2026-07-14 ClearCut shape)", () => {
  // 実事故の形: files 配列の途中でオブジェクトは閉じたが、配列と外側の括弧が無いまま終端。
  const truncated = `{"requirementSpecId":"x","files":[{"path":"a.ts","content":"export {}"}`;
  assert.equal(coerceParseableJsonContent(truncated), null);
});

run("coerceParseableJsonContent rejects bad control characters it cannot repair (2026-07-13 shape)", () => {
  // 実事故の形: 文字列リテラル内に生の制御文字が混入し、平衡抽出しても parse できない。
  const badControl = `{"note":"line1\nline2"}`;
  assert.equal(coerceParseableJsonContent(badControl), null);
});

run("isReservedPipelineMetadataFile matches buildPlan.json anywhere in the tree", () => {
  assert.equal(isReservedPipelineMetadataFile("buildPlan.json"), true);
  assert.equal(isReservedPipelineMetadataFile("source/buildPlan.json"), true);
  assert.equal(isReservedPipelineMetadataFile("source\\buildPlan.json"), true);
  assert.equal(isReservedPipelineMetadataFile("buildplan.json"), true);
  assert.equal(isReservedPipelineMetadataFile("metadata.json"), false);
  assert.equal(isReservedPipelineMetadataFile("source/data/plan.json"), false);
});

console.log("All json-file-repair checks passed.");
