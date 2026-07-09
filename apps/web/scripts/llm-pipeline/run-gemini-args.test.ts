/**
 * Unit checks for run-gemini execution mode boundaries.
 * Run with `npm run llm:pipeline:run-gemini:args:test`.
 */
import assert from "node:assert/strict";
import { resolveGeminiDryRunMode } from "./run-gemini";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("explicit dry-run is allowed without an API key", () => {
  assert.equal(resolveGeminiDryRunMode({ "dry-run": true }, undefined), true);
  assert.equal(resolveGeminiDryRunMode({ "dry-run": "true" }, undefined), true);
});

check("real Gemini run is allowed when an API key is present", () => {
  assert.equal(resolveGeminiDryRunMode({}, "test-key"), false);
});

check("missing API key does not silently become dry-run", () => {
  assert.throws(
    () => resolveGeminiDryRunMode({}, undefined),
    /GEMINI_API_KEY or GOOGLE_API_KEY is required/,
  );
});

check("dry-run=false still requires an API key", () => {
  assert.throws(
    () => resolveGeminiDryRunMode({ "dry-run": "false" }, undefined),
    /GEMINI_API_KEY or GOOGLE_API_KEY is required/,
  );
});

console.log(`\nAll ${passed} run-gemini arg checks passed.`);
