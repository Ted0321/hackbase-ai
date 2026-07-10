import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeStoredArtifactFile } from "../src/lib/artifact-store";

type WriteFn = (relPath: string, content: Buffer) => Promise<void>;

export type PersistRunEvidenceResult = { persisted: number; failed: number };

const defaultRunsDir = () => path.join(process.cwd(), "artifacts", "llm-pipeline-runs");

/**
 * 保留(hold)されたランの証跡を artifact store（FS＋GCS）へ write-through する。
 *
 * 対象は run root `artifacts/llm-pipeline-runs/<runId>/` 配下の全ファイル
 * （`publisher/response.json`＝revise理由本文, `reviewer/response.json`,
 *  `review-loop.json`, `publish-readiness.json`, `validation-summary.json` 等）。
 * 保留ランは DB登録前に return するため、これを呼ばないと本番（Cloud Run 揮発FS）では
 * これらの中間JSONがコンテナ終了と共に消え、「なぜ保留か」を事後に追えない。
 * `materialized/` は materialize 時に永続化済みだが、再アップロードは同一バイトの
 * 冪等上書きで無害なので、列挙漏れを避けるため run root を丸ごと走査する。
 *
 * ベストエフォート: ファイル単位で失敗を隔離し、関数全体は決して throw しない
 * （保留の後始末が persistence 失敗でクラッシュ＝スケジューラ会計を汚す事故を防ぐ）。
 * `ARTIFACT_BUCKET` 未設定（ローカル）では writeStoredArtifactFile がFSのみ書くため実質no-op。
 */
export async function persistRunEvidence(
  runId: string,
  opts: { baseDir?: string; writeFn?: WriteFn } = {},
): Promise<PersistRunEvidenceResult> {
  const runRoot = path.join(opts.baseDir ?? defaultRunsDir(), runId);
  const write = opts.writeFn ?? writeStoredArtifactFile;

  let files: string[];
  try {
    files = await listFilesRecursive(runRoot);
  } catch {
    // run root が存在しない/読めない場合は永続化対象なし。
    return { persisted: 0, failed: 0 };
  }

  let persisted = 0;
  let failed = 0;
  for (const rel of files) {
    const artifactsRel = `llm-pipeline-runs/${runId}/${rel}`;
    try {
      const content = await readFile(path.join(runRoot, rel));
      await write(artifactsRel, content);
      persisted += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[persist-run-evidence] failed to persist ${artifactsRel}:`, error);
    }
  }
  return { persisted, failed };
}

/**
 * ディレクトリ配下のファイルを再帰列挙し、root からの相対パス（`/`区切り）で返す。
 * check-llm-pipeline-late-stage.ts の同名パターンに準拠。
 */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  await walk(root, "");
  return out;
}
