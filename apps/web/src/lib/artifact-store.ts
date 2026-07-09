import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredArtifactMetadata = {
  label: string;
  sourcePath: string;
  demoPath: string;
  readmePath: string;
  generatedBy: string;
  generatedAt: string;
};

const artifactBaseDir = () => path.join(process.cwd(), "artifacts");

const normalizeArtifactRoot = (artifactRoot: string) =>
  artifactRoot.replace(/^artifacts[\\/]/, "").replaceAll("\\", "/");

// artifacts ルート配下に収まる絶対FSパスだけを返す。`..` やドライブ文字などで
// ルートの外へ出る指定は拒否する（破損・不正な Artifact.path から artifacts の外の
// 任意ファイルを読ませない/書かせないためのパストラバーサル防御）。
const artifactFsPath = (normalized: string) => {
  const base = artifactBaseDir();
  const resolved = path.resolve(base, normalized);
  const rel = path.relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Unsafe artifact path rejected: ${normalized}`);
  }
  return resolved;
};

export const resolveArtifactPath = (artifactRoot: string, fileName: string) =>
  artifactFsPath(`${normalizeArtifactRoot(artifactRoot)}/${fileName}`);

// 読み取り用: 安全なら絶対FSパス、危険なら null（＝not found 扱いにしてフィード全体を
// 落とさない）。書き込み/削除側は artifactFsPath を直接使い、throw で不正を表面化する。
const safeArtifactFsPath = (relPath: string): string | null => {
  try {
    return artifactFsPath(normalizeArtifactRoot(relPath));
  } catch {
    return null;
  }
};

const safeResolveArtifactPath = (artifactRoot: string, fileName: string): string | null => {
  try {
    return resolveArtifactPath(artifactRoot, fileName);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// GCS backend（本番のみ）。
//
// Cloud Run の web と日次Jobは別インスタンス/揮発FSのため、日次生成物(materialized
// artifact)はFSだけでは公開URLに出ない。`ARTIFACT_BUCKET` 設定時に GCS をミラー先とし、
// 書き手(materialize)はFS＋GCSへ、読み手(web)はFS優先→GCSフォールバックで解決する。
// コミット済みのseed/evidenceはイメージのFSに同梱されているのでFSで即ヒットする。
// `ARTIFACT_BUCKET` 未設定（ローカル開発）では完全にFSのみで従来通り。
// ---------------------------------------------------------------------------

const artifactBucketName = () => process.env.ARTIFACT_BUCKET;
const artifactPrefix = () => (process.env.ARTIFACT_PREFIX ?? "artifacts").replace(/\/+$/, "");

export const isGcsArtifactStoreEnabled = () => Boolean(artifactBucketName());

const gcsObjectKey = (normalized: string) => `${artifactPrefix()}/${normalized}`;

type GcsBucket = import("@google-cloud/storage").Bucket;
let bucketPromise: Promise<GcsBucket | null> | null = null;

async function getBucket(): Promise<GcsBucket | null> {
  const name = artifactBucketName();
  if (!name) return null;
  if (!bucketPromise) {
    bucketPromise = import("@google-cloud/storage")
      .then(({ Storage }) => new Storage().bucket(name))
      .catch((error) => {
        console.error("[artifact-store] failed to initialise GCS client:", error);
        return null;
      });
  }
  return bucketPromise;
}

async function readFsText(filePath: string): Promise<string | null> {
  try {
    await stat(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readFsBuffer(filePath: string): Promise<Buffer | null> {
  try {
    await stat(filePath);
    return await readFile(filePath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GCS読み取りキャッシュ（プロセス内）。
//
// フィード/詳細ページは1リクエストで数十〜百件超のGCSダウンロード（レビュー・画像の
// base64化）を行い、作品数の増加とともにTTFBが数秒〜十秒級まで悪化した（2026-07-08、
// 512MiB OOMの主因でもある）。公開済み作品の生成物は artifactRoot ごとに事実上不変
// （再生成は新しいRun=別パスになる）ため、ヒットをTTL付きで保持して往復を省く。
// 見つからないオブジェクト（マニフェスト未生成の旧作品など）も短TTLで負キャッシュし、
// レンダリング毎の無駄な404往復を防ぐ。FSヒット（ローカル開発・同梱seed）はこの層を
// 通らないので、ローカルの生成し直しが古い表示になることはない。
// 上限超過時は挿入の古い順に落とす（サイズ上限で1Giインスタンスのメモリを守る）。
// ---------------------------------------------------------------------------

const GCS_CACHE_HIT_TTL_MS = 10 * 60 * 1000;
const GCS_CACHE_MISS_TTL_MS = 60 * 1000;
const GCS_CACHE_MAX_BYTES = 128 * 1024 * 1024;

type GcsCacheEntry = { value: Buffer | null; expiresAt: number; bytes: number };
const gcsReadCache = new Map<string, GcsCacheEntry>();
let gcsReadCacheBytes = 0;

function gcsCacheGet(key: string): Buffer | null | undefined {
  const entry = gcsReadCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    gcsReadCache.delete(key);
    gcsReadCacheBytes -= entry.bytes;
    return undefined;
  }
  return entry.value;
}

function gcsCacheSet(key: string, value: Buffer | null) {
  const bytes = value?.byteLength ?? 0;
  if (bytes > GCS_CACHE_MAX_BYTES) return;
  const existing = gcsReadCache.get(key);
  if (existing) {
    gcsReadCache.delete(key);
    gcsReadCacheBytes -= existing.bytes;
  }
  while (gcsReadCacheBytes + bytes > GCS_CACHE_MAX_BYTES && gcsReadCache.size > 0) {
    const oldestKey = gcsReadCache.keys().next().value as string;
    const oldest = gcsReadCache.get(oldestKey);
    gcsReadCache.delete(oldestKey);
    gcsReadCacheBytes -= oldest?.bytes ?? 0;
  }
  gcsReadCache.set(key, {
    value,
    bytes,
    expiresAt: Date.now() + (value === null ? GCS_CACHE_MISS_TTL_MS : GCS_CACHE_HIT_TTL_MS),
  });
  gcsReadCacheBytes += bytes;
}

async function readGcsBufferCached(normalized: string): Promise<Buffer | null> {
  const cached = gcsCacheGet(normalized);
  if (cached !== undefined) return cached;

  const bucket = await getBucket();
  if (!bucket) return null;
  try {
    const [buffer] = await bucket.file(gcsObjectKey(normalized)).download();
    gcsCacheSet(normalized, buffer);
    return buffer;
  } catch {
    gcsCacheSet(normalized, null);
    return null;
  }
}

async function readGcsText(normalized: string): Promise<string | null> {
  const buffer = await readGcsBufferCached(normalized);
  return buffer === null ? null : buffer.toString("utf8");
}

async function readGcsBuffer(normalized: string): Promise<Buffer | null> {
  return readGcsBufferCached(normalized);
}

export async function readStoredArtifactMetadata(artifactRoot: string) {
  const fsPath = safeResolveArtifactPath(artifactRoot, "metadata.json");
  if (fsPath === null) return null;

  const raw =
    (await readFsText(fsPath)) ??
    (await readGcsText(`${normalizeArtifactRoot(artifactRoot)}/metadata.json`));

  if (raw === null) return null;

  try {
    return JSON.parse(raw) as StoredArtifactMetadata;
  } catch {
    return null;
  }
}

export async function readStoredArtifactFile(artifactRoot: string, fileName: string) {
  const fsPath = safeResolveArtifactPath(artifactRoot, fileName);
  if (fsPath === null) return null;

  const fsText = await readFsText(fsPath);
  if (fsText !== null) return fsText;

  return readGcsText(`${normalizeArtifactRoot(artifactRoot)}/${fileName}`);
}

export async function readStoredArtifactPath(artifactPath: string) {
  const fsPath = safeArtifactFsPath(artifactPath);
  if (fsPath === null) return null;

  const fsText = await readFsText(fsPath);
  if (fsText !== null) return fsText;

  return readGcsText(normalizeArtifactRoot(artifactPath));
}

export async function readStoredArtifactBuffer(artifactPath: string) {
  const fsPath = safeArtifactFsPath(artifactPath);
  if (fsPath === null) return null;

  const fsBuffer = await readFsBuffer(fsPath);
  if (fsBuffer !== null) return fsBuffer;

  return readGcsBuffer(normalizeArtifactRoot(artifactPath));
}

/**
 * 生成物を永続化する。ローカルFS（書き手プロセス内の後続処理がFSから読むため）に書き、
 * `ARTIFACT_BUCKET` 設定時は GCS にもミラーする（別インスタンスのweb表示用）。
 *
 * @param relPath artifacts ルートからの相対パス（先頭の `artifacts/` は任意）
 */
export async function writeStoredArtifactFile(
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  const normalized = normalizeArtifactRoot(relPath);

  const filePath = artifactFsPath(normalized);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);

  const bucket = await getBucket();
  if (bucket) {
    await bucket.file(gcsObjectKey(normalized)).save(content, { resumable: false });
  }
}

/**
 * 生成物ツリー（artifactRoot 配下）を FS と GCS から丸ごと削除する。
 * 公開取り下げ（withdraw-artifact）で demo/source の直URLを確実に断つために使う。
 * `writeStoredArtifactFile` の逆操作。存在しなくてもエラーにしない（best-effort）。
 *
 * @param artifactRoot artifacts ルートからの相対パス（先頭の `artifacts/` は任意）
 */
export async function deleteStoredArtifactTree(
  artifactRoot: string,
): Promise<{ fsDeleted: boolean; gcsDeleted: boolean }> {
  const normalized = normalizeArtifactRoot(artifactRoot);

  let fsDeleted = false;
  try {
    await rm(artifactFsPath(normalized), { recursive: true, force: true });
    fsDeleted = true;
  } catch (error) {
    console.error("[artifact-store] failed to delete FS artifact tree:", error);
  }

  let gcsDeleted = false;
  const bucket = await getBucket();
  if (bucket) {
    try {
      await bucket.deleteFiles({ prefix: `${gcsObjectKey(normalized)}/` });
      gcsDeleted = true;
    } catch (error) {
      console.error("[artifact-store] failed to delete GCS artifact tree:", error);
    }
  }

  return { fsDeleted, gcsDeleted };
}
