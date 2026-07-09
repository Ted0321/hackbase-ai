/**
 * Unit checks for LLM response text quality guards.
 *
 * Run:
 *   npx tsx scripts/llm-response-quality.test.ts
 */
import assert from "node:assert/strict";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("passes ordinary Japanese and English text", () => {
  const issues = findMojibakeLikeTextIssues({
    title: "地域の環境スコアボード",
    oneLiner: "Adjust weights and see the score change.",
  });
  assert.deepEqual(issues, []);
});

check("detects mojibake-like text in nested LLM responses", () => {
  const issues = findMojibakeLikeTextIssues({
    files: [
      {
        path: "README.md",
        content: "陜ｨ・ｰ陜捺ｺｽ閻ｸ陟・・縺帷ｹｧ・ｳ郢ｧ・｢郢晄㈱繝ｻ郢昴・",
      },
    ],
  });
  assert.ok(issues.length > 0);
  assert.equal(issues[0].path, "$.files[0].content");
});

check("detects common UTF-8 read as CP932 fragments", () => {
  const issues = findMojibakeLikeTextIssues({
    title: "AI郢ｧ・ｻ郢ｧ・ｭ郢晢ｽ･郢晢ｽｪ郢昴・縺・ｹ晢ｽｬ郢晁侭ﾎ礼ｹ晢ｽｼ",
  });
  assert.ok(issues.length > 0);
  assert.equal(issues[0].path, "$.title");
});

check("detects common CP932 read as UTF-8 fragments", () => {
  const issues = findMojibakeLikeTextIssues({
    readiness: "IT\u7e67\u7e3a\u8811 public copy",
  });
  assert.ok(issues.length > 0);
  assert.equal(issues[0].path, "$.readiness");
});

check("respects maxIssues", () => {
  const issues = findMojibakeLikeTextIssues("\u7e67 \u7e3a \u87c6 \u8b5b", { maxIssues: 2 });
  assert.equal(issues.length, 2);
});

console.log(`\nAll ${passed} LLM response quality checks passed.`);
