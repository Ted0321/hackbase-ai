import { spawn } from "node:child_process";
import path from "node:path";
import "./load-local-env";

/**
 * Daily production scheduler orchestrator.
 *
 * Lane1A+1B: refresh research cache, prepare source-product candidates, update index.
 * Lane2: wake due creator agents and publish only when MVP validation passes.
 * Lane3: create bounded agent reactions for under-interacted projects.
 * Lane4: generate advisory Steward evidence for human review.
 * Lane5: sync console observability (Incident/QualityReport) from the lanes above.
 *        Lane4 writes governance reports to the Job's volatile FS; running the sync
 *        in the same Job execution (same container) is what makes them readable.
 *
 * Each lane keeps its own due gate. The orchestrator continues after a lane
 * failure so later lanes can still run, then exits non-zero if any lane failed.
 *
 * Soft failures: Lane2/Lane3 swallow per-agent errors and still exit 0 (printing
 * "failed (continuing)"). Unattended, those would look green. We tee each lane's
 * output, detect that marker, and escalate to a non-zero exit so the GCP failure
 * alert (DOC-67) fires. See DOC-69 trial-run runbook.
 *
 * Usage: tsx scripts/run-all-schedulers.ts [--dry-run] [--force] [--creation-limit N] [--interaction-limit N] [--llm]
 * Production entrypoint: Cloud Run Job + Cloud Scheduler runs `npm run scheduler:all`.
 *
 * Lane3 のコメント生成をLLM(Gemini・人格反映)にするには --llm、または env
 * PRODIA_INTERACTION_LLM=1 を渡す（既定はテンプレ生成でGemini非課金）。本番で
 * 人格付きコメントを出すには Cloud Run Job `prodia-scheduler-all` に env を設定する。
 */

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);
const envTruthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test((value ?? "").trim());

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Lane2/Lane3 print this when a sub-task (one agent) fails but the lane keeps
// going and still exits 0. Lane scripts may also print an explicit SOFT_FAILURE.
const SOFT_FAILURE_MARKER = /failed \(continuing\)|SOFT_FAILURE/;

const runTsx = (script: string, args: string[]) =>
  new Promise<{ ok: boolean; softFail: boolean }>((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
        // pipe stdout/stderr so we can tee to the parent AND scan for soft-failure
        // markers; stdin stays inherited.
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    let captured = "";
    const tee = (chunk: Buffer, sink: NodeJS.WriteStream) => {
      sink.write(chunk);
      captured += chunk.toString();
    };
    child.stdout?.on("data", (chunk: Buffer) => tee(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer) => tee(chunk, process.stderr));
    child.on("exit", (code) =>
      resolve({ ok: code === 0, softFail: SOFT_FAILURE_MARKER.test(captured) }),
    );
  });

async function main() {
  const dryRun = hasFlag("--dry-run");
  const force = hasFlag("--force");
  const creationLimit = parsePositiveInt(
    arg("--creation-limit") ?? process.env.PRODIA_DAILY_CREATION_LIMIT,
    5,
  );
  const creationPerRunLimit = parsePositiveInt(
    arg("--creation-per-run-limit") ?? process.env.PRODIA_CREATION_PER_RUN_LIMIT,
    creationLimit,
  );
  // いいね/コメントは独立の日次目標(既定6/6)。run-agent-interactions-scheduler.ts側の
  // env直読みフォールバックと重複するデフォルトだが、ここでの--like-limit/--comment-limit
  // オーバーライドとログ表示のために明示的に持つ。
  const likeLimit = parsePositiveInt(arg("--like-limit") ?? process.env.PRODIA_DAILY_LIKE_LIMIT, 6);
  const commentLimit = parsePositiveInt(arg("--comment-limit") ?? process.env.PRODIA_DAILY_COMMENT_LIMIT, 6);
  // Lane3 のコメントをLLM生成にするか。--llm か env PRODIA_INTERACTION_LLM=1 でON（既定OFF=テンプレ）。
  const interactionLlm = hasFlag("--llm") || envTruthy(process.env.PRODIA_INTERACTION_LLM);
  const common = [...(dryRun ? ["--dry-run"] : []), ...(force ? ["--force"] : [])];

  const lanes: Array<{ name: string; script: string; args: string[] }> = [
    {
      name: "Lane1A+1B research/product collection",
      script: "scripts/run-research-cache-scheduler.ts",
      args: ["--fetch", "--prepare-sources", "--update-index", ...common],
    },
    {
      name: `Lane2 agent creation (cap ${creationLimit})`,
      script: "scripts/run-agent-daily-scheduler.ts",
      args: ["--limit", String(creationLimit), "--per-run-limit", String(creationPerRunLimit), ...common],
    },
    {
      name: `Lane3 agent communication (like ${likeLimit}, comment ${commentLimit}, llm=${interactionLlm})`,
      script: "scripts/run-agent-interactions-scheduler.ts",
      args: [
        "--like-limit",
        String(likeLimit),
        "--comment-limit",
        String(commentLimit),
        ...(interactionLlm ? ["--llm"] : []),
        ...common,
      ],
    },
    {
      name: "Lane4 steward monitoring",
      // Steward does not accept --force; pass only --dry-run.
      script: "scripts/run-steward-daily.ts",
      args: [...(dryRun ? ["--dry-run"] : [])],
    },
    // Lane5 runs unconditionally after every lane (the loop below continues past
    // failures), so Incident/QualityReport sync happens even when a lane failed.
    // console:sync has no dry-run mode and always writes to the DB, so skip it on
    // --dry-run (same policy as the other lanes: dry-run writes nothing).
    ...(dryRun
      ? []
      : [
          {
            name: "Lane5 console observability sync",
            script: "scripts/sync-console-observability.ts",
            args: [],
          },
        ]),
  ];

  console.log(
    `=== scheduler:all start (dryRun=${dryRun} force=${force} creationLimit=${creationLimit} creationPerRunLimit=${creationPerRunLimit} likeLimit=${likeLimit} commentLimit=${commentLimit} interactionLlm=${interactionLlm}) ===`,
  );
  if (dryRun) {
    console.log("[scheduler:all] dry-run: Lane5 console observability sync is skipped (no dry-run mode; it always writes to the DB).");
  }
  const results: Array<{ name: string; ok: boolean; softFail: boolean }> = [];
  for (const lane of lanes) {
    console.log(`\n--- ${lane.name} ---`);
    const { ok, softFail } = await runTsx(lane.script, lane.args);
    results.push({ name: lane.name, ok, softFail });
    if (!ok) {
      console.error(`[scheduler:all] ${lane.name} reported a non-zero exit (continuing).`);
    } else if (softFail) {
      console.error(
        `[scheduler:all] ERROR soft failure: ${lane.name} exited 0 but reported "failed (continuing)" (a sub-task failed). Escalating to non-zero exit.`,
      );
    }
  }

  console.log(`\n=== scheduler:all summary ===`);
  for (const result of results) {
    const tag = !result.ok ? "FAIL" : result.softFail ? "SOFT" : "ok ";
    console.log(`  ${tag}  ${result.name}`);
  }
  const hardFailures = results.filter((result) => !result.ok).length;
  const softFailures = results.filter((result) => result.ok && result.softFail).length;
  console.log(
    `Lanes: ${results.length}, failures: ${hardFailures}, soft failures: ${softFailures}`,
  );
  if (hardFailures > 0 || softFailures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
