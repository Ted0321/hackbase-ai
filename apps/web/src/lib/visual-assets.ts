import { readStoredArtifactBuffer, readStoredArtifactFile } from "@/lib/artifact-store";

export type VisualAssetEntry = {
  alt?: string;
  conceptOnly?: boolean;
  label?: string;
  mimeType?: string;
  path?: string;
  prompt?: string;
};

export type VisualManifest = {
  generatedAt?: string;
  generationMode?: string;
  isConceptOnly?: boolean;
  logo?: VisualAssetEntry;
  notImplementedAsSource?: boolean;
  sourceFields?: {
    category?: string;
    oneLiner?: string;
    title?: string;
  };
  productShowcase?: VisualAssetEntry;
  thumbnail?: VisualAssetEntry;
  uiPreview?: VisualAssetEntry;
  version?: number;
};

export type ResolvedVisualAsset = VisualAssetEntry & {
  dataUrl?: string;
};

export type ResolvedVisualAssets = {
  logo?: ResolvedVisualAsset;
  manifest: VisualManifest;
  manifestRaw: string;
  productShowcase?: ResolvedVisualAsset;
  thumbnail?: ResolvedVisualAsset;
  uiPreview?: ResolvedVisualAsset;
};

const manifestPath = "mockups/visual-manifest.json";

const toDataUrl = (content: string, mimeType = "image/svg+xml") =>
  `data:${mimeType};base64,${Buffer.from(content, "utf8").toString("base64")}`;

// Raster images (AI-generated PNG/WebP) must be read as raw bytes; decoding them
// as utf8 text would corrupt the data URL. SVG/JSON stay on the text path.
const isBinaryImage = (mimeType?: string) =>
  typeof mimeType === "string" && mimeType.startsWith("image/") && !mimeType.startsWith("image/svg");

const resolveAsset = async (
  artifactRoot: string,
  asset?: VisualAssetEntry,
): Promise<ResolvedVisualAsset | undefined> => {
  if (!asset?.path) return asset;

  if (isBinaryImage(asset.mimeType)) {
    const buffer = await readStoredArtifactBuffer(`${artifactRoot}/${asset.path}`);
    if (!buffer) return asset;
    return {
      ...asset,
      dataUrl: `data:${asset.mimeType};base64,${buffer.toString("base64")}`,
    };
  }

  const content = await readStoredArtifactFile(artifactRoot, asset.path);
  if (!content) return asset;
  return {
    ...asset,
    dataUrl: toDataUrl(content, asset.mimeType),
  };
};

type VisualAssetKind = "logo" | "productShowcase" | "thumbnail" | "uiPreview";

export const readVisualAssets = async (
  artifactRoot: string | null | undefined,
  options?: {
    /**
     * 解決(ダウンロード+base64化)するアセットを絞る。フィードのようにロゴしか使わない
     * 画面が、作品ごとに画像4種を毎回取得してしまうのを防ぐ。省略時は従来どおり全種。
     */
    only?: VisualAssetKind[];
  },
): Promise<ResolvedVisualAssets | null> => {
  if (!artifactRoot) return null;
  const manifestRaw = await readStoredArtifactFile(artifactRoot, manifestPath);
  if (!manifestRaw) return null;

  try {
    const manifest = JSON.parse(manifestRaw) as VisualManifest;
    const productShowcase = manifest.productShowcase ?? manifest.uiPreview;
    const wants = (kind: VisualAssetKind) => !options?.only || options.only.includes(kind);
    const resolveIf = (kind: VisualAssetKind, asset?: VisualAssetEntry) =>
      wants(kind) ? resolveAsset(artifactRoot, asset) : Promise.resolve(asset);
    // 各アセットは独立ファイルなので直列でawaitせず並列に取得する。
    const [logo, showcase, thumbnail, uiPreview] = await Promise.all([
      resolveIf("logo", manifest.logo),
      resolveIf("productShowcase", productShowcase),
      resolveIf("thumbnail", manifest.thumbnail),
      resolveIf("uiPreview", manifest.uiPreview ?? manifest.productShowcase),
    ]);
    return {
      manifest,
      manifestRaw,
      logo,
      productShowcase: showcase,
      thumbnail,
      uiPreview,
    };
  } catch {
    return null;
  }
};
