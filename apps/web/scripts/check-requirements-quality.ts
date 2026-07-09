import { readFileSync } from "node:fs";
import path from "node:path";
import { requirementsQuality } from "./prompt-eval-metrics";

/**
 * requirements（RequirementSpec）の確実性＝buildable契約の品質を測る CLI（DOC-71 §6）。
 * baseline / 反復で各シナリオの requirements/response.json を採点するのに使う。
 *
 * Usage:
 *   tsx scripts/check-requirements-quality.ts --path artifacts/llm-pipeline-runs/<run>/requirements/response.json
 *   tsx scripts/check-requirements-quality.ts --run <runId>
 *   [--max-screens N] [--json]
 *
 * exit 0 = pass, 1 = fail（品質不足）, 2 = usage/IO エラー。
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const pathArg = arg("--path");
const runId = arg("--run");
const maxScreensArg = arg("--max-screens");
const asJson = hasFlag("--json");

const file =
  pathArg ??
  (runId
    ? path.join("artifacts", "llm-pipeline-runs", runId, "requirements", "response.json")
    : undefined);

if (!file) {
  console.error(
    "Usage: --path <requirements/response.json> | --run <runId> [--max-screens N] [--json]",
  );
  process.exit(2);
}

let spec: unknown;
try {
  spec = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Failed to read/parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const maxScreens = maxScreensArg !== undefined ? Number(maxScreensArg) : undefined;
const result = requirementsQuality(spec, maxScreens && Number.isFinite(maxScreens) ? { maxScreens } : {});

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `requirements quality: ${result.ok ? "PASS" : "FAIL"}  score=${result.score} (${result.passed}/${result.total})  file=${file}`,
  );
  for (const issue of result.issues) {
    console.log(`  - [${issue.check}] ${issue.detail}`);
  }
}

process.exit(result.ok ? 0 : 1);
