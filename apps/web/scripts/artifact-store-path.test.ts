import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveArtifactPath,
  readStoredArtifactPath,
  readStoredArtifactFile,
} from "../src/lib/artifact-store";

const base = path.join(process.cwd(), "artifacts");

async function main() {
// 1. 通常の相対パスは artifacts ルート配下に解決される
{
  const p = resolveArtifactPath("agent_a/run_1", "README.md");
  assert.ok(p.startsWith(base), "normal path must stay under the artifacts root");
  assert.ok(
    p.endsWith(path.join("agent_a", "run_1", "README.md")),
    "normal path must preserve the requested segments",
  );
}

// 2. 先頭の "artifacts/" は二重化されず正しく除去される（既存の正常挙動の維持）
{
  const p = resolveArtifactPath("artifacts/agent_a", "metadata.json");
  assert.ok(p.startsWith(base));
  assert.ok(
    !p.includes(path.join("artifacts", "artifacts")),
    "leading artifacts/ must be stripped, not doubled",
  );
}

// 3. Windows 風のバックスラッシュ区切りでもルート配下に収まる
{
  const p = resolveArtifactPath("agent_a\\run_1", "demo.html");
  assert.ok(p.startsWith(base));
}

// 4. fileName の `..` によるルート外アクセスは拒否する
assert.throws(
  () => resolveArtifactPath("agent_a", "../../../etc/passwd"),
  /Unsafe artifact path/,
  "`..` in fileName must be rejected",
);

// 5. artifactRoot の `..` も拒否する
assert.throws(
  () => resolveArtifactPath("../../secret", "notes.md"),
  /Unsafe artifact path/,
  "`..` in artifactRoot must be rejected",
);

// 6. 絶対パス指定は拒否する
assert.throws(
  () => resolveArtifactPath("/etc", "passwd"),
  /Unsafe artifact path/,
  "absolute paths must be rejected",
);

// 7. 読み取りAPIは危険なパスに対して throw せず null を返す（フィード全体を落とさない）
{
  const viaPath = await readStoredArtifactPath("../../../etc/passwd");
  assert.equal(viaPath, null, "readStoredArtifactPath must return null for unsafe input");

  const viaFile = await readStoredArtifactFile("agent_a", "../../secret");
  assert.equal(viaFile, null, "readStoredArtifactFile must return null for unsafe input");
}

  console.log("artifact-store path safety: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
