import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import "./load-local-env";
import { createPrismaClient } from "./prisma-client";
import { readAdminAgentRegistryWithContracts } from "../src/lib/agent-operating-contract-store";
import { readAgentLearnings, getAgentLearning } from "./agent-learning";
import { archiveAgentSkill } from "./archive-agent-skill";
import { durationMs, errorMessageOf, logAgentRuntimeMetric } from "./observability";
import { assertPipelineResponsesWritten } from "./self-directed-response-guard";
import { buildAntidupSteering, fetchPublishedProducts } from "./llm-pipeline/antidup-steering";
import { persistRunEvidence } from "./persist-run-evidence";

/**
 * P1-C: エージェント主語の自走run。
 *
 * 「エージェントが起きて、今日のsignalと自分の学びを見て、自分で企画→要件→生成する」。
 *   1. agent-learnings を最新化（直近の反応を学びへ変換）
 *   2. self-directed plan をrun artifactへ保存
 *   3. run-gemini を --agent <id> で実行（concept/requirements が一人称＋学び反映になる）
 *
 * トピックは今日のsignal由来、学びは「どう作るか」に効く（設計原則）。
 *
 * Usage:
 *   tsx scripts/run-agent-self-directed.ts --agent agent_a [--run <id>] [--steps research,...] [--dry-run] [--skip-learning-refresh]
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);
const prisma = createPrismaClient();

const runTsx = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
        },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      // exit code を Error に載せる（review/rewrite ループの hold=3 を異常=1 と区別するため）。
      else reject(Object.assign(new Error(`${script} exited with ${code}`), { code }));
    });
  });

const runTsxCaptured = (script: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout.push(text);
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr.push(text);
      process.stderr.write(text);
    });
    child.on("exit", (code) => {
      const output = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error(`${script} exited with ${code}`), output));
    });
  });

const pad = (value: number) => String(value).padStart(2, "0");

async function writeSelfDirectedPlan(args: { agentId: string; runId: string }) {
  const registry = await readAdminAgentRegistryWithContracts(prisma);
  const profile = registry.agents.find((agent) => agent.agentId === args.agentId);
  if (!profile) {
    throw new Error(`Agent not found in operating contracts: ${args.agentId}`);
  }

  const learning = getAgentLearning(await readAgentLearnings(), args.agentId);
  const creationPolicy = profile.creationPolicy;
  const outputPath = path.join(
    process.cwd(),
    "artifacts",
    "llm-pipeline-runs",
    args.runId,
    "self-directed-plan.json",
  );
  const materialsRead = [
    "productSourceIndex",
    "currentTopicRadar",
    "recentArtifacts",
    "agentRegistry",
    "agentLearnings",
  ];

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        runId: args.runId,
        ownerAgentId: args.agentId,
        ownerAgentName: profile.displayName,
        generatedAt: new Date().toISOString(),
        selfSelectionReason:
          creationPolicy?.mission ??
          `${profile.displayName} is scheduled as the owner agent for this self-directed run.`,
        materialsRead,
        ignoredDirections: profile.avoid ?? [],
        learningApplied: learning
          ? [
              learning.nextStepGuidance,
              ...learning.constraints.requirementConstraints.slice(0, 3),
            ].filter(Boolean)
          : [],
        creationPolicySnapshot: creationPolicy ?? null,
        learningPolicySnapshot: profile.learningPolicy ?? null,
        boundarySnapshot: profile.structuredBoundaries ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path.relative(process.cwd(), outputPath);
}

async function writeValidationSummary(args: {
  runId: string;
  materializedDir: string;
  status: "pass" | "fail";
  output: string;
}) {
  const outputPath = path.join(
    process.cwd(),
    "artifacts",
    "llm-pipeline-runs",
    args.runId,
    "validation-summary.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        runId: args.runId,
        generatedAt: new Date().toISOString(),
        validator: "check-mvp-artifact",
        status: args.status,
        materializedDir: args.materializedDir,
        command: [
          "tsx",
          "scripts/check-mvp-artifact.ts",
          "--path",
          args.materializedDir,
          "--strict-auto-publish",
        ],
        output: args.output.slice(0, 12000),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path.relative(process.cwd(), outputPath);
}

async function main() {
  const agentId = arg("--agent");
  if (!agentId) {
    throw new Error("--agent <id> is required (e.g. --agent agent_a)");
  }
  const dryRun = hasFlag("--dry-run");
  const publishRequested = hasFlag("--publish");
  // --hold: 品質パイプライン(review/rewrite/MVP/publisher gate)は全て通すが、公開はせず
  // held_for_review(ops_review)でDB登録して止める。人手レビュー→ llm:approve で公開する運用。
  // --hold 省略時は従来どおり auto_published（gate通過で自動公開）。
  const holdForReview = hasFlag("--hold");
  const skipLearningRefresh = hasFlag("--skip-learning-refresh");
  // reviewer/rewriter/publisher は step3 では走らせない。
  // reviewer→rewriter は step3b の review/rewrite ループ、publisher は step5c で扱う。
  const steps = arg("--steps") ?? "research,combination,concept,requirements,builder";
  // runId は呼び出し側が制御（Date.now はlint上避け、ここはCLIなので new Date でOK）
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const runId = arg("--run") ?? `run_selfdirected_${agentId}_${stamp}`;
  const startedAt = new Date();

  const recordRuntime = async (status: "completed" | "failed", metadata?: Record<string, unknown>) => {
    if (dryRun) return;
    const completedAt = new Date();
    await logAgentRuntimeMetric({
      agentId,
      runId,
      eventType: "self_directed_run",
      status,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      metadata,
    });
  };

  try {

  console.log(`[self-directed] agent=${agentId} run=${runId} dryRun=${dryRun}`);
  if (skipLearningRefresh) {
    console.log(`[self-directed] step1: skip learning refresh`);
  } else {
    console.log(`[self-directed] step1: refresh agent learnings`);
    await runTsx("scripts/generate-agent-learnings.ts", ["--quiet"]);
    // step1b: 公開済みスキルに反応(人/AIコメント・いいね)を書き戻し promoted を更新。
    console.log(`[self-directed] step1b: refresh agent skills (feedback -> promoted)`);
    try {
      await runTsx("scripts/refresh-agent-skills.ts", ["--quiet"]);
    } catch (err) {
      console.log(`[self-directed] step1b: skill refresh skipped: ${String(err)}`);
    }
  }

  const planPath = await writeSelfDirectedPlan({ agentId, runId });
  console.log(`[self-directed] step2: write self-directed plan (${planPath})`);

  // step2b: アンチ重複ステアリング。公開済みプロダクト一覧をconceptプロンプトに注入し
  // (PRODIA_PROMPTS_DIR)、選択コンセプトの逐語複製をrun-gemini側で機械検出できるよう
  // 一覧ファイルも渡す(PRODIA_PUBLISHED_PRODUCTS_FILE)。researchコーパスは静的なため、
  // フィードが育つほどconceptが既公開作を再生産する(2026-07-07実測: 1runの3候補全部が
  // 既存作の焼き直し、別runは公開作の逐語コピーを選択)。呼び出し元が PRODIA_PROMPTS_DIR
  // を指定済みの場合(手動の作風ステア等)はそれを尊重し、--no-antidup で無効化できる。
  if (!hasFlag("--no-antidup") && !process.env.PRODIA_PROMPTS_DIR) {
    try {
      const products = await fetchPublishedProducts(prisma);
      if (products.length > 0) {
        const steering = await buildAntidupSteering(products, runId);
        process.env.PRODIA_PROMPTS_DIR = steering.promptsDir;
        process.env.PRODIA_PUBLISHED_PRODUCTS_FILE = steering.productsFile;
        console.log(
          `[self-directed] step2b: anti-dup steering (${steering.publishedCount} published/held products injected into concept prompt)`,
        );
      } else {
        console.log(`[self-directed] step2b: anti-dup steering skipped (no published products)`);
      }
    } catch (err) {
      // ステアリングは品質向上策であり、失敗しても生成自体は従来どおり進める。
      console.log(`[self-directed] step2b: anti-dup steering skipped: ${String(err)}`);
    }
  } else if (process.env.PRODIA_PROMPTS_DIR) {
    console.log(`[self-directed] step2b: anti-dup steering skipped (caller provided PRODIA_PROMPTS_DIR)`);
  }

  console.log(`[self-directed] step3: run pipeline as ${agentId} (steps: ${steps})`);
  await runTsx("scripts/llm-pipeline/run-gemini.ts", [
    "--run",
    runId,
    "--agent",
    agentId,
    "--steps",
    steps,
    ...(dryRun ? ["--dry-run"] : []),
  ]);
  if (!dryRun) {
    await assertPipelineResponsesWritten(runId, steps);
  }

  // step3b: reviewer -> (rewriter -> reviewer 再評価) のループ。最大2回。
  // pass で publish 経路へ。block / rewriter blocked|needs_human / 上限超過は hold=exit3 で publish せず停止。
  // dry-run では reviewer/rewriter を prepare するだけ（dry_run_prepared, exit0）。
  if (publishRequested) {
    console.log(`[self-directed] step3b: review/rewrite loop (max 2 rewrites)`);
    try {
      await runTsx("scripts/llm-pipeline/run-gemini.ts", [
        "--run",
        runId,
        "--agent",
        agentId,
        "--review-loop",
        "--max-rewrites",
        "2",
        ...(dryRun ? ["--dry-run"] : []),
      ]);
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 3) {
        await recordRuntime("completed", {
          publish: false,
          held: true,
          reason: "review_rewrite_hold",
        });
        console.log("");
        console.log(`[self-directed] held at review/rewrite loop (no publish). run=${runId}`);
        console.log(
          `[self-directed] review loop report: artifacts/llm-pipeline-runs/${runId}/review-loop.json`,
        );
        try {
          const ev = await persistRunEvidence(runId);
          console.log(
            `[self-directed] hold evidence persisted to artifact store (persisted=${ev.persisted}, failed=${ev.failed}). run=${runId}`,
          );
        } catch (persistError) {
          console.warn(`[self-directed] failed to persist hold evidence:`, persistError);
        }
        console.log(`[self-directed] run evidence: /runs/${runId}`);
        return;
      }
      throw error;
    }
  }

  if (publishRequested && !dryRun) {
    const builderResponse = `artifacts/llm-pipeline-runs/${runId}/builder/response.json`;
    const artifactId = `selfdirected_${agentId}_${stamp}`;
    const materializedDir = `artifacts/llm-pipeline-runs/${runId}/materialized/${artifactId}`;
    console.log(`[self-directed] step4: materialize builder output (--agent ${agentId})`);
    await runTsx("scripts/materialize-llm-plan.ts", [
      "--input",
      builderResponse,
      "--run",
      runId,
      "--agent",
      agentId,
      "--artifact",
      artifactId,
      "--write",
    ]);
    // Auto-publish only after strict MVP validation, AI publisher gate, and readiness proof pass.
    console.log(`[self-directed] step5: strict MVP validation`);
    let mvpPass = true;
    let mvpOutput = "";
    try {
      const result = await runTsxCaptured("scripts/check-mvp-artifact.ts", [
        "--path",
        materializedDir,
        "--strict-auto-publish",
      ]);
      mvpOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    } catch (error) {
      mvpPass = false;
      const captured = error as Error & { stdout?: string; stderr?: string };
      mvpOutput = [captured.stdout, captured.stderr, captured.message].filter(Boolean).join("\n");
      console.log(`[self-directed] strict MVP validation failed -> holding before publish`);
    }
    const validationSummaryPath = await writeValidationSummary({
      runId,
      materializedDir,
      status: mvpPass ? "pass" : "fail",
      output: mvpOutput,
    });
    console.log(`[self-directed] step5a: wrote validation summary (${validationSummaryPath})`);

    if (mvpPass) {
      console.log(`[self-directed] step5c: run AI publisher gate`);
      await runTsx("scripts/llm-pipeline/run-gemini.ts", [
        "--run",
        runId,
        "--agent",
        agentId,
        "--steps",
        "publisher",
      ]);
    } else {
      console.log(`[self-directed] step5c: skip AI publisher gate because strict MVP failed`);
    }

    console.log(`[self-directed] step5d: publish readiness check`);
    let readinessPass = true;
    let readinessOutput = "";
    try {
      const result = await runTsxCaptured("scripts/check-publish-readiness.ts", [
        "--path",
        materializedDir,
        "--run",
        runId,
        "--write",
      ]);
      readinessOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    } catch (error) {
      readinessPass = false;
      const captured = error as Error & { stdout?: string; stderr?: string };
      readinessOutput = [captured.stdout, captured.stderr, captured.message].filter(Boolean).join("\n");
      console.log(`[self-directed] publish readiness failed -> artifact held for ops inspection`);
    }

    if (!readinessPass) {
      await recordRuntime("completed", {
        publish: false,
        mvpPass,
        readinessPass,
        readinessOutput: readinessOutput.slice(0, 2000),
      });
      console.log("");
      console.log(`[self-directed] held before publish. run=${runId}`);
      console.log(`[self-directed] readiness report: artifacts/llm-pipeline-runs/${runId}/publish-readiness.json`);
      try {
        const ev = await persistRunEvidence(runId);
        console.log(
          `[self-directed] hold evidence persisted to artifact store (persisted=${ev.persisted}, failed=${ev.failed}). run=${runId}`,
        );
      } catch (persistError) {
        console.warn(`[self-directed] failed to persist hold evidence:`, persistError);
      }
      // Issue #100: 保留ランも held_for_review(ops_review) でDB登録し、/human から検分・
      // 承認(llm:approve)・却下できるようにする。publisher revise の理由や readiness の
      // blockers は publish スクリプト側が publishDecisionReason に取り込む。登録失敗は
      // run を落とさない(証跡はGCSに残っており、旧来の手動 llm:publish で救済可能)。
      try {
        await runTsx("scripts/publish-llm-pipeline-artifact.ts", [
          "--path",
          materializedDir,
          "--run",
          runId,
          "--write",
        ]);
        const heldProjectId = `proj_llm_${artifactId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
        console.log(`[self-directed] held run registered for ops review. project=${heldProjectId}`);
        console.log(`[self-directed] review: /human/projects/${heldProjectId}`);
        console.log(`[self-directed] approve with: npm run llm:approve -- --project ${heldProjectId} --write`);
      } catch (registerError) {
        console.warn(`[self-directed] failed to register held run for ops review:`, registerError);
      }
      console.log(`[self-directed] run evidence: /runs/${runId}`);
      return;
    }
    // A-4: MVP passのRunは「成功事例」として distill してスキルアーカイブ（ベストエフォート）。
    if (mvpPass) {
      try {
        const skillPath = await archiveAgentSkill({ materializedDir, agentId, runId });
        if (skillPath) console.log(`[self-directed] step5b: archived skill -> ${skillPath}`);
        else console.log(`[self-directed] step5b: skill archive skipped (no metadata)`);
      } catch (err) {
        console.log(`[self-directed] step5b: skill archive skipped: ${String(err)}`);
      }
    }
    console.log(
      `[self-directed] step6: publish materialized artifact to DB (autoPublish=${!holdForReview}${holdForReview ? ", HOLD for review" : ""})`,
    );
    const projectId = `proj_llm_${artifactId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    try {
      await runTsx("scripts/publish-llm-pipeline-artifact.ts", [
        "--path",
        materializedDir,
        "--run",
        runId,
        "--write",
        // --hold のときは --auto-publish を付けない → held_for_review(ops_review)で止まる
        ...(holdForReview ? [] : ["--auto-publish"]),
      ]);
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 5 && !holdForReview) {
        // high-risk topicゲートは意図した停止。auto-publishせず ops_review 登録へフォールバックする
        // (readiness-fail等と同じ「一旦heldで人間の目を通す」パターン)。
        console.log(
          `[self-directed] step6: high-risk topic gate blocked auto-publish -> registering for ops review`,
        );
        await runTsx("scripts/publish-llm-pipeline-artifact.ts", [
          "--path",
          materializedDir,
          "--run",
          runId,
          "--write",
        ]);
        await recordRuntime("completed", {
          publish: false,
          held: true,
          reason: "high_risk_topic_gate",
          mvpPass,
          readinessPass,
          projectId,
        });
        console.log("");
        console.log(`[self-directed] HELD for review: high-risk topic. run=${runId}`);
        console.log(`[self-directed] review: /human/projects/${projectId}`);
        console.log(`[self-directed] approve with: npm run llm:approve -- --project ${projectId} --write`);
        console.log(`[self-directed] run evidence: /runs/${runId}`);
        return;
      }
      throw error;
    }
    await recordRuntime("completed", { publish: true, hold: holdForReview, mvpPass, readinessPass, projectId });
    console.log("");
    if (holdForReview) {
      console.log(`[self-directed] HELD for review (not public). run=${runId}`);
      console.log(`[self-directed] review: /human/projects/${projectId}`);
      console.log(`[self-directed] approve with: npm run llm:approve -- --project ${projectId} --write`);
    } else {
      console.log(`[self-directed] published. run=${runId}`);
      console.log(`[self-directed] project: /projects/${projectId}`);
    }
    console.log(`[self-directed] run evidence: /runs/${runId}`);
    return;
  }

  await recordRuntime("completed", { publish: false, steps });
  console.log("");
  console.log(`[self-directed] done. run=${runId}`);
  console.log(
    `[self-directed] artifacts: artifacts/llm-pipeline-runs/${runId} ` +
      `(requirements/response.json の feedbackConstraints に学びが反映される)`,
  );
  console.log(
    `[self-directed] to publish a visible project: re-run with --publish ` +
      `(materialize + publish + self_directed_plan event)`,
  );
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 4) {
      // Gemini日次予算上限は意図した停止であり異常終了と区別する(review/rewrite hold=3と同じ考え方)。
      await recordRuntime("completed", {
        publish: false,
        held: true,
        reason: "gemini_budget_capped",
      });
      console.log("");
      console.log(`[self-directed] held: Gemini daily budget cap reached. run=${runId}`);
      try {
        const ev = await persistRunEvidence(runId);
        console.log(
          `[self-directed] hold evidence persisted to artifact store (persisted=${ev.persisted}, failed=${ev.failed}). run=${runId}`,
        );
      } catch (persistError) {
        console.warn(`[self-directed] failed to persist hold evidence:`, persistError);
      }
      console.log(`[self-directed] run evidence: /runs/${runId}`);
      return;
    }
    await recordRuntime("failed", { errorMessage: errorMessageOf(error), steps });
    throw error;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
