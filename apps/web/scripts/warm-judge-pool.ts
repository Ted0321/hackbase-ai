/**
 * 審査員デモの「温めプール」を事前に積むウォーマー。
 *
 * ランダムな active creator を1体選び、その preferredInputs から1つをトリガーとして
 * run-agent-self-directed.ts --publish を実行し、生成された run/project を
 * data/judge-demo/warm-pool.json に追記する（最新 KEEP 件を保持）。
 *
 * これは「審査員がボタンを押す前」に回しておくもの（demo 時のライブ生成は避ける）。
 * 生成は実Geminiなので OOM/JSON失敗で落ち得るが、その場合はプールに積まないだけで安全。
 *
 *   npm run demo:warm            # 1体ぶん温める
 *   npm run demo:warm -- --count 3
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import "./load-local-env";
import { ROSTER } from "./agent-roster";

const POOL_PATH = path.join(process.cwd(), "data", "judge-demo", "warm-pool.json");
const KEEP = 10;

type WarmEntry = { projectId: string; runId: string; agentId: string; handle: string; trigger: string; at: string };

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// self-directed を実行し、出力から実際の projectId を取り出す（projectId は内部 stamp で決まり予測不可）。
const runSelfDirected = (agentId: string, runId: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    const child = spawn(
      process.execPath,
      [
        path.join("node_modules", "tsx", "dist", "cli.mjs"),
        path.join("scripts", "run-agent-self-directed.ts"),
        "--agent",
        agentId,
        "--run",
        runId,
        "--publish",
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["inherit", "pipe", "inherit"] },
    );
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      out += text;
      process.stdout.write(text);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`self-directed exited ${code}`));
        return;
      }
      const projectId =
        out.match(/Created Project:\s*(proj_[^\s]+)/)?.[1] ??
        out.match(/Feed\s*:\s*\S*\/projects\/(proj_[^\s]+)/)?.[1];
      if (!projectId) {
        reject(new Error("could not parse projectId from self-directed output"));
        return;
      }
      resolve(projectId);
    });
  });

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

async function readPool(): Promise<WarmEntry[]> {
  try {
    return JSON.parse(await readFile(POOL_PATH, "utf8")) as WarmEntry[];
  } catch {
    return [];
  }
}

async function main() {
  const count = Number(arg("--count") ?? "1");
  const actives = ROSTER; // すべて active creator
  const pool = await readPool();

  for (let i = 0; i < count; i += 1) {
    const spec = actives[Math.floor(Math.random() * actives.length)];
    const trigger =
      spec.preferredInputs[Math.floor(Math.random() * spec.preferredInputs.length)] ?? "today's signals";
    const runId = `run_warm_${spec.id}_${stamp()}`;
    console.log(`[warm] ${spec.handle} (${spec.id}) trigger="${trigger}" run=${runId}`);
    try {
      const projectId = await runSelfDirected(spec.id, runId);
      pool.unshift({
        projectId,
        runId,
        agentId: spec.id,
        handle: spec.handle,
        trigger,
        at: new Date().toISOString(),
      });
      console.log(`[warm] added ${projectId} to pool`);
    } catch (error) {
      console.warn(`[warm] skipped (generation failed): ${(error as Error).message}`);
    }
  }

  await mkdir(path.dirname(POOL_PATH), { recursive: true });
  await writeFile(POOL_PATH, `${JSON.stringify(pool.slice(0, KEEP), null, 2)}\n`, "utf8");
  console.log(`[warm] pool now holds ${Math.min(pool.length, KEEP)} entr(ies): ${POOL_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
