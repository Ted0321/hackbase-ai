import { spawn } from "node:child_process";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import "./load-local-env";

/**
 * Golden 評価セットの上流ピン留め（DOC-71 §3 / data/eval/golden/README.md §4.1）。
 *
 * 各シナリオで research+combination だけを実行し、その `response.json` を
 * `data/eval/golden/pinned/<id>/` へ凍結する。以後のプロンプト磨きでは
 * concept→requirements→builder だけを凍結済み上流から再実行して比較する
 * （`prepare-step.ts` が前段 response.json を run dir から読むため成立）。
 *
 * Usage:
 *   tsx scripts/pin-golden-upstream.ts            # core=true の6本を凍結（未凍結のみ）
 *   tsx scripts/pin-golden-upstream.ts --dry-run  # 段取りだけ表示（Gemini呼び出し無し）
 *   tsx scripts/pin-golden-upstream.ts --ids g2,g4 # サブセット
 *   tsx scripts/pin-golden-upstream.ts --force     # 既に凍結済みでも作り直す
 *
 * 実行（--dry-run なし）は実 Gemini 呼び出し（research+combination × 対象数）。
 * コストガード（B-1, 日次 $10/500req, scripts/llm-pipeline/rate-guard.ts）内で動く。
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const SCENARIOS_PATH = path.join(process.cwd(), "data", "eval", "golden", "scenarios.json");
const PINNED_DIR = path.join(process.cwd(), "data", "eval", "golden", "pinned");
const runDir = (runId: string) => path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId);
const rel = (p: string) => path.relative(process.cwd(), p);

const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)),
    );
  });

type Scenario = {
  id: string;
  agentId: string;
  handle?: string;
  themeHint?: string;
  core?: boolean;
};

async function main() {
  const dryRun = hasFlag("--dry-run");
  const force = hasFlag("--force");
  const idsArg = arg("--ids");
  const onlyIds = idsArg ? new Set(idsArg.split(",").map((s) => s.trim())) : null;

  const data = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as { scenarios: Scenario[] };
  const scenarios = data.scenarios.filter((s) => (onlyIds ? onlyIds.has(s.id) : s.core));

  if (scenarios.length === 0) {
    console.log("[pin] no matching scenarios (use --ids or set core=true in scenarios.json).");
    return;
  }

  console.log(
    `[pin] scenarios=${scenarios.map((s) => s.id).join(",")} dryRun=${dryRun} force=${force}`,
  );

  for (const s of scenarios) {
    const runId = `golden_${s.id}`;
    const pinDir = path.join(PINNED_DIR, s.id);
    const researchPin = path.join(pinDir, "research.response.json");
    const combinationPin = path.join(pinDir, "combination.response.json");
    const already = (await exists(researchPin)) && (await exists(combinationPin));

    if (already && !force) {
      console.log(`[pin] ${s.id} (${s.agentId}): already pinned -> skip (use --force to refreeze)`);
      continue;
    }

    if (dryRun) {
      console.log(
        `[pin] ${s.id} (${s.agentId}): WOULD run-gemini --run ${runId} --steps research,combination -> copy to ${rel(pinDir)}/`,
      );
      continue;
    }

    console.log(`[pin] ${s.id} (${s.agentId}): running research+combination (run=${runId})`);
    await runTsx("scripts/llm-pipeline/run-gemini.ts", [
      "--run",
      runId,
      "--agent",
      s.agentId,
      "--steps",
      "research,combination",
    ]);

    const researchSrc = path.join(runDir(runId), "research", "response.json");
    const combinationSrc = path.join(runDir(runId), "combination", "response.json");
    if (!(await exists(researchSrc)) || !(await exists(combinationSrc))) {
      throw new Error(
        `[pin] ${s.id}: research/combination response.json missing after run (${rel(runDir(runId))}). Check run output above.`,
      );
    }

    await mkdir(pinDir, { recursive: true });
    await copyFile(researchSrc, researchPin);
    await copyFile(combinationSrc, combinationPin);
    await writeFile(
      path.join(pinDir, "meta.json"),
      `${JSON.stringify(
        {
          scenarioId: s.id,
          agentId: s.agentId,
          handle: s.handle ?? null,
          themeHint: s.themeHint ?? null,
          sourceRunId: runId,
          frozenAt: new Date().toISOString(),
          rubricVersion: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`[pin] ${s.id}: pinned -> ${rel(pinDir)}/`);
  }

  console.log("[pin] done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
