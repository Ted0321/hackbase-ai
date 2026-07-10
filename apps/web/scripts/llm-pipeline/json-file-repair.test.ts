import assert from "node:assert/strict";
import { repairJsonFileContent } from "./json-file-repair";

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

console.log("All json-file-repair checks passed.");
