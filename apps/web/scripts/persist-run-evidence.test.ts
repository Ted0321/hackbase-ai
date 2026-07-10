import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { persistRunEvidence } from "./persist-run-evidence";

const writeText = async (filePath: string, content: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
};

async function main() {
  // Case 1: happy path — every run-root evidence file is written through, with
  // nested paths (publisher/response.json) preserved and content round-tripped.
  {
    const base = await mkdtemp(path.join(tmpdir(), "persist-run-evidence-"));
    try {
      const runId = "run_test_hold_01";
      const runRoot = path.join(base, runId);
      await writeText(
        path.join(runRoot, "publisher", "response.json"),
        '{"status":"revise","reason":"first-screen value is unclear"}',
      );
      await writeText(path.join(runRoot, "reviewer", "response.json"), '{"status":"pass"}');
      await writeText(path.join(runRoot, "rewriter", "response.json"), '{"issueResolutions":[]}');
      await writeText(path.join(runRoot, "review-loop.json"), '{"held":true}');
      await writeText(path.join(runRoot, "publish-readiness.json"), '{"result":"fail"}');

      const calls: Array<{ rel: string; content: string }> = [];
      const result = await persistRunEvidence(runId, {
        baseDir: base,
        writeFn: async (rel, content) => {
          calls.push({ rel, content: content.toString("utf8") });
        },
      });

      assert.equal(result.persisted, 5, "all 5 evidence files persisted");
      assert.equal(result.failed, 0, "no failures");

      const keys = calls.map((c) => c.rel).sort();
      assert.deepEqual(
        keys,
        [
          `llm-pipeline-runs/${runId}/publish-readiness.json`,
          `llm-pipeline-runs/${runId}/publisher/response.json`,
          `llm-pipeline-runs/${runId}/review-loop.json`,
          `llm-pipeline-runs/${runId}/reviewer/response.json`,
          `llm-pipeline-runs/${runId}/rewriter/response.json`,
        ],
        "artifacts-root-relative keys match run-root files (nested paths preserved)",
      );

      const publisher = calls.find((c) => c.rel.endsWith("publisher/response.json"));
      assert.ok(publisher, "publisher response.json was written through");
      assert.match(publisher.content, /revise/, "revise reason content is preserved verbatim");
      assert.ok(
        !keys.some((k) => k.endsWith("validation-summary.json")),
        "files that do not exist are not fabricated",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  // Case 2: best-effort — a single write failure is isolated; the function never
  // throws and keeps persisting the remaining files.
  {
    const base = await mkdtemp(path.join(tmpdir(), "persist-run-evidence-"));
    try {
      const runId = "run_test_hold_02";
      const runRoot = path.join(base, runId);
      await writeText(path.join(runRoot, "publisher", "response.json"), '{"status":"revise"}');
      await writeText(path.join(runRoot, "reviewer", "response.json"), '{"status":"pass"}');
      await writeText(path.join(runRoot, "review-loop.json"), '{"held":true}');

      const persistedKeys: string[] = [];
      const result = await persistRunEvidence(runId, {
        baseDir: base,
        writeFn: async (rel) => {
          if (rel.endsWith("reviewer/response.json")) {
            throw new Error("simulated GCS failure");
          }
          persistedKeys.push(rel);
        },
      });

      assert.equal(result.persisted, 2, "the two healthy files still persist");
      assert.equal(result.failed, 1, "the failing file is counted as failed");
      assert.ok(
        persistedKeys.some((k) => k.endsWith("publisher/response.json")),
        "publisher persisted despite the reviewer failure (isolation)",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  // Case 3: missing run root — returns zero counts and does not throw.
  {
    const base = await mkdtemp(path.join(tmpdir(), "persist-run-evidence-"));
    try {
      const result = await persistRunEvidence("run_does_not_exist", { baseDir: base });
      assert.deepEqual(result, { persisted: 0, failed: 0 }, "missing run root is a no-op");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  console.log("persist-run-evidence tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
