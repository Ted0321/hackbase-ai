import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import "./load-local-env";
import { conceptDiversity, requirementsQuality, reviewerWeightedTotal } from "./prompt-eval-metrics";

/**
 * Golden 評価セットの baseline / 反復スコアリング（DOC-71 §3/§4）。
 *
 * 各シナリオで、凍結済み上流（pinned/<id>）を run dir に再注入し
 *   concept -> requirements -> builder を実行 -> materialize -> reviewer(judge)
 * を回し、ルーブリック次元を採点して scorecard を出す。
 *
 * 計器:
 *   - 新規性: reviewer judge の novelty/notObviousInsight/differenceFromRecentArtifacts + conceptDiversity 補助
 *   - 確実性: requirementsQuality（requirements）+ check-mvp-artifact / check-interaction-proof（builder成果物）
 *
 * Usage:
 *   tsx scripts/score-golden-baseline.ts                 # core 6本を採点（tag=baseline）
 *   tsx scripts/score-golden-baseline.ts --dry-run       # 段取りのみ（Gemini呼び出し無し）
 *   tsx scripts/score-golden-baseline.ts --ids g1,g2 --tag iter1
 *   tsx scripts/score-golden-baseline.ts --skip-reviewer # judge を省く
 *
 * 実行は実 Gemini（concept+requirements+builder[+reviewer]）×対象数。コストガード(B-1)内。
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const cwd = process.cwd();
const SCENARIOS_PATH = path.join(cwd, "data", "eval", "golden", "scenarios.json");
const PINNED_DIR = path.join(cwd, "data", "eval", "golden", "pinned");
const runDir = (runId: string) => path.join(cwd, "artifacts", "llm-pipeline-runs", runId);
const rel = (p: string) => path.relative(cwd, p);

const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 生成系: 進捗を見せたいので inherit。失敗は throw。
const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      { cwd, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" }, stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });

// チェック系: exit code が pass/fail。出力は捨てて code だけ取る。
const runExit = (script: string, args: string[]) =>
  new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      { cwd, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" }, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });

type Scenario = { id: string; agentId: string; handle?: string; themeHint?: string; core?: boolean };

const REVIEW_DIMS = [
  "novelty",
  "notObviousInsight",
  "differenceFromRecentArtifacts",
  "codeFeasibility",
  "artifactCompleteness",
] as const;

type Row = {
  scenario: string;
  agentId: string;
  handle: string;
  runId: string;
  ok: boolean;
  builderOk?: boolean;
  error?: string;
  conceptTitle?: string;
  notObviousInsight?: string;
  candidates?: Array<{ title: string; source: string; theme: string; notObvious: string }>;
  diversity?: { candidates: number; distinctTemplates: number; pairwiseTitleJaccard: number };
  requirements?: { ok: boolean; score: number; issueCount: number; issues: string[] };
  mvpPass?: boolean;
  interactionProofPass?: boolean;
  reviewer?: { weightedTotal: number | null; scores: Record<string, number | null> } | null;
  paths?: { runDir: string; materializedDir: string };
};

const selectedConcept = (concept: Record<string, unknown> | null) => {
  if (!concept) return { title: "", notObvious: "" };
  const candidates = Array.isArray(concept.candidates) ? (concept.candidates as Record<string, unknown>[]) : [];
  const sel = concept.selectedConcept as Record<string, unknown> | undefined;
  const chosen =
    candidates.find((c) => sel && str(c.id) === str(sel.id)) ?? candidates[0] ?? null;
  return { title: str(chosen?.title), notObvious: str(chosen?.notObviousInsight) };
};

async function scoreScenario(s: Scenario, tag: string, dryRun: boolean, skipReviewer: boolean, conceptOnly: boolean): Promise<Row> {
  const runId = `golden_${s.id}_${tag}`;
  const pinDir = path.join(PINNED_DIR, s.id);
  const artifactId = `${tag}_${s.id}`;
  const materializedDir = path.join(runDir(runId), "materialized", artifactId);
  const base: Row = {
    scenario: s.id,
    agentId: s.agentId,
    handle: s.handle ?? "",
    runId,
    ok: false,
    paths: { runDir: rel(runDir(runId)), materializedDir: rel(materializedDir) },
  };

  if (dryRun) {
    console.log(
      conceptOnly
        ? `[concept-only] ${s.id} (${s.agentId}): WOULD reinject pinned -> run-gemini concept -> score 3 candidates (run=${runId})`
        : `[baseline] ${s.id} (${s.agentId}): WOULD reinject pinned -> run-gemini concept,requirements,builder -> materialize -> ${
            skipReviewer ? "(skip reviewer)" : "reviewer"
          } -> score (run=${runId})`,
    );
    return { ...base, ok: true };
  }

  // 1. 凍結上流を run dir に再注入（無ければこのシナリオは hard error）
  try {
    if (!(await exists(path.join(pinDir, "research.response.json")))) {
      throw new Error(`pinned upstream missing for ${s.id} (run eval:golden:pin first)`);
    }
    await mkdir(path.join(runDir(runId), "research"), { recursive: true });
    await mkdir(path.join(runDir(runId), "combination"), { recursive: true });
    await copyFile(path.join(pinDir, "research.response.json"), path.join(runDir(runId), "research", "response.json"));
    await copyFile(path.join(pinDir, "combination.response.json"), path.join(runDir(runId), "combination", "response.json"));
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // concept-only モード: concept だけ実行し、3候補と多様性を採点して返す（軽いループ用）。
  if (conceptOnly) {
    console.log(`[concept-only] ${s.id}: run-gemini concept (run=${runId})`);
    try {
      await runTsx("scripts/llm-pipeline/run-gemini.ts", ["--run", runId, "--agent", s.agentId, "--steps", "concept"]);
    } catch (error) {
      console.log(`[concept-only] ${s.id}: concept stage failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const concept = await readJson(path.join(runDir(runId), "concept", "response.json"));
    if (!concept) {
      return { ...base, ok: false, error: "concept not produced" };
    }
    const div = conceptDiversity(concept);
    const cands = (Array.isArray(concept.candidates) ? (concept.candidates as Record<string, unknown>[]) : []).map((c) => ({
      title: str(c.title),
      source: str(c.sourceProductUsed),
      theme: str(c.surfaceTheme) || str(c.newThemeApplied),
      notObvious: str(c.notObviousInsight),
    }));
    const { title, notObvious } = selectedConcept(concept);
    return {
      ...base,
      ok: true,
      conceptTitle: title,
      notObviousInsight: notObvious,
      candidates: cands,
      diversity: { candidates: div.candidateCount, distinctTemplates: div.distinctTemplatePatternIds, pairwiseTitleJaccard: div.pairwiseTitleJaccard },
    };
  }

  // 2. concept -> requirements -> builder（builder は JSON 不安定。失敗しても concept/requirements は採点する）
  console.log(`[baseline] ${s.id}: run-gemini concept,requirements,builder (run=${runId})`);
  let builderOk = true;
  let genError = "";
  try {
    await runTsx("scripts/llm-pipeline/run-gemini.ts", ["--run", runId, "--agent", s.agentId, "--steps", "concept,requirements,builder"]);
  } catch (error) {
    builderOk = false;
    genError = error instanceof Error ? error.message : String(error);
    console.log(`[baseline] ${s.id}: builder stage failed (concept/requirements may still exist): ${genError}`);
  }

  // 3. concept / requirements を読む（builder 失敗でも書かれている）
  const concept = await readJson(path.join(runDir(runId), "concept", "response.json"));
  const requirements = await readJson(path.join(runDir(runId), "requirements", "response.json"));
  if (!concept) {
    return { ...base, ok: false, error: `concept not produced${genError ? `: ${genError}` : ""}` };
  }
  const div = conceptDiversity(concept);
  const rq = requirementsQuality(requirements);
  const { title, notObvious } = selectedConcept(concept);

  // 4. builder 成果物の採点（builderOk のときだけ）
  let mvpPass: boolean | undefined;
  let proofPass: boolean | undefined;
  let reviewerRow: Row["reviewer"] = null;
  if (builderOk) {
    try {
      console.log(`[baseline] ${s.id}: materialize`);
      await runTsx("scripts/materialize-llm-plan.ts", [
        "--input", `artifacts/llm-pipeline-runs/${runId}/builder/response.json`,
        "--run", runId, "--agent", s.agentId, "--artifact", artifactId, "--write",
      ]);
      if (!skipReviewer) {
        console.log(`[baseline] ${s.id}: reviewer (judge)`);
        try {
          await runTsx("scripts/llm-pipeline/run-gemini.ts", ["--run", runId, "--agent", s.agentId, "--steps", "reviewer"]);
        } catch (e) {
          console.log(`[baseline] ${s.id}: reviewer skipped (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      mvpPass = (await runExit("scripts/check-mvp-artifact.ts", ["--path", rel(materializedDir), "--strict-auto-publish", "--json-only"])) === 0;
      proofPass = (await runExit("scripts/check-interaction-proof.ts", ["--path", rel(materializedDir)])) === 0;
      const reviewer = skipReviewer ? null : await readJson(path.join(runDir(runId), "reviewer", "response.json"));
      if (reviewer) {
        const scores = (reviewer.scores ?? {}) as Record<string, unknown>;
        reviewerRow = { weightedTotal: reviewerWeightedTotal(reviewer), scores: Object.fromEntries(REVIEW_DIMS.map((d) => [d, num(scores[d])])) };
      }
    } catch (error) {
      builderOk = false;
      genError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...base,
    ok: true,
    builderOk,
    error: builderOk ? undefined : genError || "builder stage failed",
    conceptTitle: title,
    notObviousInsight: notObvious,
    diversity: { candidates: div.candidateCount, distinctTemplates: div.distinctTemplatePatternIds, pairwiseTitleJaccard: div.pairwiseTitleJaccard },
    requirements: { ok: rq.ok, score: rq.score, issueCount: rq.issues.length, issues: rq.issues.map((i) => i.detail) },
    mvpPass,
    interactionProofPass: proofPass,
    reviewer: reviewerRow,
  };
}

const fmtScore = (v: number | null | undefined) => (v == null ? "-" : String(v));
const yn = (v: boolean | undefined) => (v === undefined ? "-" : v ? "✓" : "✗");

function toMarkdown(rows: Row[], tag: string): string {
  const lines: string[] = [];
  lines.push(`# Golden baseline scorecard (tag: ${tag})`);
  lines.push("");
  lines.push("| # | agent | concept title | nov | notObv | diff | codeFeas | artComp | req(score) | MVP | proof |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    if (!r.ok) {
      lines.push(`| ${r.scenario} | ${r.agentId} | **ERROR**: ${r.error ?? "?"} | | | | | | | | |`);
      continue;
    }
    const rv = r.reviewer?.scores ?? {};
    lines.push(
      `| ${r.scenario} | ${r.handle || r.agentId} | ${r.conceptTitle ?? ""} | ${fmtScore(rv.novelty)} | ${fmtScore(rv.notObviousInsight)} | ${fmtScore(rv.differenceFromRecentArtifacts)} | ${fmtScore(rv.codeFeasibility)} | ${fmtScore(rv.artifactCompleteness)} | ${r.requirements ? `${yn(r.requirements.ok)} ${r.requirements.score}` : "-"} | ${yn(r.mvpPass)} | ${yn(r.interactionProofPass)} |`,
    );
  }
  lines.push("");
  lines.push("## 詳細（テイスト較正用）");
  for (const r of rows) {
    lines.push("");
    lines.push(`### ${r.scenario} — ${r.handle || r.agentId}`);
    if (!r.ok) {
      lines.push(`- ERROR: ${r.error}`);
      continue;
    }
    lines.push(`- concept: **${r.conceptTitle}**`);
    lines.push(`- notObviousInsight: ${r.notObviousInsight || "(なし)"}`);
    if (r.builderOk === false) lines.push(`- ⚠ builder失敗（concept/requirements のみ採点）: ${r.error}`);
    if (r.requirements && r.requirements.issueCount > 0) {
      lines.push(`- requirements issues: ${r.requirements.issues.join(" / ")}`);
    }
    lines.push(`- run: ${r.paths?.runDir}  / materialized: ${r.paths?.materializedDir}`);
    lines.push(`- ここに good/違う/こう寄せたい を記入 → rubric v2 へ:`);
  }
  return lines.join("\n") + "\n";
}

function toConceptOnlyMarkdown(rows: Row[], tag: string): string {
  const lines: string[] = [];
  lines.push(`# Concept-only scorecard (tag: ${tag})`);
  lines.push("");
  lines.push("| # | agent | distinctTemplates | pairwiseJaccard | selected |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    if (!r.ok) {
      lines.push(`| ${r.scenario} | ${r.agentId} | **ERROR**: ${r.error ?? "?"} | | |`);
      continue;
    }
    lines.push(`| ${r.scenario} | ${r.handle || r.agentId} | ${r.diversity?.distinctTemplates ?? "-"} | ${r.diversity?.pairwiseTitleJaccard ?? "-"} | ${r.conceptTitle ?? ""} |`);
  }
  lines.push("");
  lines.push("## 候補3本（多様性＋テーマ確認）");
  for (const r of rows) {
    lines.push("");
    lines.push(`### ${r.scenario} — ${r.handle || r.agentId}`);
    if (!r.ok) {
      lines.push(`- ERROR: ${r.error}`);
      continue;
    }
    lines.push(`- diversity: candidates=${r.diversity?.candidates}, distinctTemplates=${r.diversity?.distinctTemplates}, pairwiseTitleJaccard=${r.diversity?.pairwiseTitleJaccard}`);
    (r.candidates ?? []).forEach((c, i) => {
      const selMark = c.title === r.conceptTitle ? " ★selected" : "";
      lines.push(`  ${i + 1}. **${c.title}**${selMark}  [src:${c.source || "?"}] [theme:${c.theme || "?"}]`);
      if (c.notObvious) lines.push(`     - notObvious: ${c.notObvious}`);
    });
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const skipReviewer = hasFlag("--skip-reviewer");
  const conceptOnly = hasFlag("--concept-only");
  const tag = arg("--tag") ?? "baseline";
  const idsArg = arg("--ids");
  const onlyIds = idsArg ? new Set(idsArg.split(",").map((s) => s.trim())) : null;

  const data = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as { scenarios: Scenario[] };
  const scenarios = data.scenarios.filter((s) => (onlyIds ? onlyIds.has(s.id) : s.core));
  if (scenarios.length === 0) {
    console.log("[baseline] no matching scenarios.");
    return;
  }

  console.log(`[baseline] tag=${tag} scenarios=${scenarios.map((s) => s.id).join(",")} dryRun=${dryRun} skipReviewer=${skipReviewer}`);

  const rows: Row[] = [];
  for (const s of scenarios) {
    rows.push(await scoreScenario(s, tag, dryRun, skipReviewer, conceptOnly));
  }

  if (dryRun) {
    console.log("[baseline] dry-run done (no scorecard written).");
    return;
  }

  const md = conceptOnly ? toConceptOnlyMarkdown(rows, tag) : toMarkdown(rows, tag);
  const mdName = conceptOnly ? "concept-scorecard.md" : "scorecard.md";
  const outDir = path.join(cwd, "data", "eval", "baseline", tag);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "scorecard.json"), `${JSON.stringify({ tag, scoredAt: new Date().toISOString(), rows }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, mdName), md, "utf8");
  console.log(`\n[baseline] scorecard -> ${rel(path.join(outDir, mdName))}`);
  console.log(md);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
