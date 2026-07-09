import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  aiPlanForKind,
  buildPromptForKind,
  providerForPlan,
  readVisualAiConfig,
  type ProductVisualKind,
} from "./visual-providers";
import { buildProductIconSvg } from "./visual-providers/icon-families/select";
import { composeThumbnailText } from "./visual-providers/compose-thumbnail";
import {
  buildThumbnailPrompt,
  pickVariantForWork,
  ROTATION_POOL,
} from "./visual-providers/thumbnail-variants";
import { writeStoredArtifactFile } from "../src/lib/artifact-store";

type VisualIdentity = {
  logoPrompt?: string;
  logoDescription?: string;
  thumbnailPrompt?: string;
  thumbnailDescription?: string;
  screenshotDescription?: string;
  visualReadiness?: string;
};

type ArtifactMetadata = {
  title?: string;
  label?: string;
  oneLiner?: string;
  category?: string;
  categoryName?: string;
  generatedOutput?: {
    title?: string;
    oneLiner?: string;
  };
  visualIdentity?: VisualIdentity;
  mvpContract?: { coreInteraction?: string; stateChange?: string; inspectableOutput?: string };
  interactionProofPlan?: { primaryAction?: string };
};

export type VisualImageMimeType = "image/svg+xml" | "image/png" | "image/webp";

export type VisualManifest = {
  version: 1 | 2;
  generationMode: "local_svg" | "ai_image";
  isConceptOnly: true;
  notImplementedAsSource: true;
  generatedAt: string;
  sourceFields: {
    title: string;
    oneLiner: string;
    category: string;
    screenshotDescription?: string;
    coreInteraction?: string;
    primaryAction?: string;
    stateChange?: string;
    inspectableOutput?: string;
  };
  logo: VisualAssetEntry;
  thumbnail: VisualAssetEntry;
  productShowcase: VisualAssetEntry;
  uiPreview?: VisualAssetEntry;
  /** Present only when at least one asset was produced by an AI provider. */
  provider?: string;
  model?: string;
  prompt?: string;
  /** local_svg is always kept as the deterministic fallback. */
  fallbackGenerationMode?: "local_svg";
  /** True when an AI provider was requested but generation fell back to local_svg. */
  fallbackUsed?: boolean;
  /** True when the title/category/one-liner were composited onto the AI image as real text (Imagen legacy path). */
  textComposited?: boolean;
  /** Nano Banana Pro thumbnail variant chosen for this work (rotation). */
  thumbnailVariant?: string;
};

type VisualAssetEntry = {
  label: string;
  path: string;
  mimeType: VisualImageMimeType;
  prompt: string;
  conceptOnly: true;
  alt: string;
};

export type GeneratedVisualFile = {
  relativePath: string;
  content: string;
  mimeType: "application/json" | "image/svg+xml";
  type: "visual_manifest" | "product_logo" | "product_thumbnail" | "product_showcase";
};

export type GeneratedVisualAssets = {
  manifest: VisualManifest;
  files: GeneratedVisualFile[];
};

const parseArgs = () => {
  const values = new Map<string, string | boolean>();
  const raw = process.argv.slice(2);
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return {
    artifactDir: typeof values.get("path") === "string" ? String(values.get("path")) : "",
    dryRun: values.get("dry-run") === true,
  };
};

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const hashString = (value: string) => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const paletteFor = (seed: string) => {
  const palettes = [
    ["#0f766e", "#2dd4bf", "#f59e0b", "#042f2e"],
    ["#4f46e5", "#38bdf8", "#fb923c", "#1e1b4b"],
    ["#be123c", "#fda4af", "#0ea5e9", "#4c0519"],
    ["#166534", "#a3e635", "#0284c7", "#052e16"],
    ["#7c2d12", "#fdba74", "#0891b2", "#431407"],
    ["#581c87", "#d8b4fe", "#10b981", "#2e1065"],
    ["#0f172a", "#94a3b8", "#ef4444", "#020617"],
    ["#155e75", "#67e8f9", "#eab308", "#083344"],
  ] as const;
  return palettes[hashString(seed) % palettes.length];
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}...` : value;

const titleFrom = (metadata: ArtifactMetadata) =>
  metadata.title ?? metadata.label ?? metadata.generatedOutput?.title ?? "Generated product";

const oneLinerFrom = (metadata: ArtifactMetadata) =>
  metadata.oneLiner ?? metadata.generatedOutput?.oneLiner ?? "Concept-only product visual";

const categoryFrom = (metadata: ArtifactMetadata) =>
  metadata.category ?? metadata.categoryName ?? "Product";

// Open-Launch style app icon. The icon is chosen from a pattern-family system
// (shape × inner mark × palette × gradient) so products vary in silhouette, not
// just color, while a naked/outline container is guarded to only carry a rich
// mark. Deterministic per product; see ./visual-providers/icon-families.
const logoSvg = (input: { title: string; category: string; colors: readonly string[] }) =>
  buildProductIconSvg({ title: input.title, category: input.category });

const thumbnailSvg = (input: { title: string; oneLiner: string; category: string; colors: readonly string[] }) => {
  const [primary, secondary, accent, dark] = input.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(input.title)} concept thumbnail">
  <rect width="1280" height="720" fill="${dark}"/>
  <rect x="70" y="64" width="1140" height="592" rx="42" fill="#ffffff"/>
  <rect x="104" y="104" width="250" height="250" rx="62" fill="${primary}"/>
  <path d="M150 272c42-70 96-106 162-108" stroke="#ffffff" stroke-width="28" stroke-linecap="round" fill="none"/>
  <circle cx="294" cy="160" r="35" fill="${accent}"/>
  <text x="410" y="170" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="${primary}">${escapeXml(clip(input.category.toUpperCase(), 28))}</text>
  <text x="410" y="248" font-family="Inter, Arial, sans-serif" font-size="68" font-weight="850" fill="#0f172a">${escapeXml(clip(input.title, 30))}</text>
  <text x="414" y="314" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="500" fill="#526173">${escapeXml(clip(input.oneLiner, 76))}</text>
  <rect x="410" y="416" width="196" height="22" rx="11" fill="${secondary}"/>
  <rect x="410" y="468" width="336" height="22" rx="11" fill="#cbd5e1"/>
  <rect x="410" y="520" width="268" height="22" rx="11" fill="#cbd5e1"/>
  <rect x="844" y="396" width="246" height="176" rx="36" fill="${accent}" opacity="0.16"/>
  <path d="M884 514c34-48 78-74 132-78 28-2 56 4 84 18" fill="none" stroke="${accent}" stroke-width="18" stroke-linecap="round"/>
</svg>`;
};

const productShowcaseSvg = (input: { title: string; oneLiner: string; category: string; description: string; colors: readonly string[] }) => {
  const [primary, secondary, accent, dark] = input.colors;
  const pattern = hashString(`${input.title}:${input.category}:showcase`) % 5;
  const headline = escapeXml(clip(input.title, 32));
  const headlineTight = escapeXml(clip(input.title, 14));
  const subhead = escapeXml(clip(input.oneLiner, 78));
  const subheadTight = escapeXml(clip(input.oneLiner, 32));
  const category = escapeXml(clip(input.category.toUpperCase(), 28));
  const description = escapeXml(clip(input.description || input.oneLiner, 46));
  const patterns = [
    `<rect width="1280" height="720" fill="#050816"/>
     <path d="M0 560c180-130 368-188 564-174 162 12 306 74 432 186" stroke="${primary}" stroke-width="96" stroke-linecap="round" opacity="0.22" fill="none"/>
     <rect x="96" y="74" width="1088" height="572" rx="30" fill="#0b1020" stroke="#263248" filter="url(#softShadow)"/>
     <rect x="96" y="74" width="1088" height="52" rx="30" fill="#111827"/>
     <circle cx="132" cy="100" r="7" fill="#ef4444"/><circle cx="156" cy="100" r="7" fill="#f59e0b"/><circle cx="180" cy="100" r="7" fill="#22c55e"/>
     <rect x="216" y="91" width="250" height="18" rx="9" fill="#263248"/>
     <rect x="116" y="126" width="204" height="500" fill="#0f172a"/>
     <text x="144" y="174" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="850" fill="${accent}">${category}</text>
     <rect x="144" y="222" width="132" height="16" rx="8" fill="#475569"/><rect x="144" y="268" width="110" height="16" rx="8" fill="#334155"/>
     <rect x="144" y="314" width="144" height="16" rx="8" fill="#334155"/><rect x="144" y="558" width="104" height="38" rx="14" fill="${primary}"/>
     <text x="356" y="184" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="900" fill="#f8fafc">${headlineTight}</text>
     <text x="358" y="224" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="500" fill="#93a4ba">${subheadTight}</text>
     <rect x="356" y="268" width="238" height="134" rx="22" fill="#111827" stroke="#273449"/>
     <rect x="626" y="268" width="238" height="134" rx="22" fill="#111827" stroke="#273449"/>
     <rect x="896" y="268" width="218" height="134" rx="22" fill="#111827" stroke="#273449"/>
     <rect x="386" y="306" width="134" height="16" rx="8" fill="${secondary}"/><rect x="386" y="346" width="168" height="16" rx="8" fill="#475569"/>
     <path d="M660 360c42-60 88-92 138-96 34-2 62 8 84 30" stroke="${accent}" stroke-width="14" stroke-linecap="round" fill="none"/>
     <circle cx="998" cy="340" r="44" fill="${primary}"/><circle cx="1048" cy="316" r="28" fill="${accent}"/>
     <rect x="356" y="438" width="758" height="132" rx="22" fill="#0f172a" stroke="#273449"/>
     <rect x="386" y="476" width="650" height="12" rx="6" fill="#263248"/><rect x="386" y="516" width="520" height="12" rx="6" fill="#263248"/>
     <rect x="386" y="476" width="310" height="12" rx="6" fill="${primary}"/><rect x="386" y="516" width="420" height="12" rx="6" fill="${secondary}"/>`,
    `<rect width="1280" height="720" fill="#eef3f8"/>
     <rect x="88" y="70" width="1104" height="580" rx="32" fill="#ffffff" stroke="#d9e2ec" filter="url(#softShadow)"/>
     <rect x="88" y="70" width="1104" height="58" rx="32" fill="#f8fafc"/>
     <circle cx="126" cy="99" r="7" fill="#ef4444"/><circle cx="150" cy="99" r="7" fill="#f59e0b"/><circle cx="174" cy="99" r="7" fill="#22c55e"/>
     <rect x="244" y="88" width="524" height="22" rx="11" fill="#e2e8f0"/>
     <rect x="112" y="154" width="212" height="454" rx="24" fill="#f8fafc" stroke="#e2e8f0"/>
     <rect x="146" y="194" width="104" height="18" rx="9" fill="${primary}"/><rect x="146" y="250" width="130" height="14" rx="7" fill="#cbd5e1"/>
     <rect x="146" y="292" width="96" height="14" rx="7" fill="#cbd5e1"/><rect x="146" y="334" width="126" height="14" rx="7" fill="#cbd5e1"/>
     <text x="370" y="190" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="850" fill="${primary}">${category}</text>
     <text x="368" y="258" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="900" fill="#0f172a">${headline}</text>
     <text x="372" y="306" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="500" fill="#526173">${subhead}</text>
     <rect x="370" y="374" width="218" height="116" rx="24" fill="#ffffff" stroke="#dbe3ea"/><rect x="624" y="374" width="218" height="116" rx="24" fill="#ffffff" stroke="#dbe3ea"/><rect x="878" y="374" width="218" height="116" rx="24" fill="#ffffff" stroke="#dbe3ea"/>
     <rect x="400" y="414" width="108" height="15" rx="7" fill="${secondary}"/><rect x="400" y="450" width="150" height="14" rx="7" fill="#cbd5e1"/>
     <rect x="654" y="414" width="118" height="15" rx="7" fill="${accent}"/><rect x="654" y="450" width="146" height="14" rx="7" fill="#cbd5e1"/>
     <path d="M912 462c28-42 64-66 108-72 26-4 52 0 78 12" stroke="${primary}" stroke-width="13" stroke-linecap="round" fill="none"/>
     <rect x="370" y="532" width="726" height="48" rx="18" fill="#0f172a"/><rect x="402" y="550" width="244" height="12" rx="6" fill="${accent}"/>`,
    `<rect width="1280" height="720" fill="#0f172a"/>
     <rect x="100" y="76" width="1080" height="568" rx="30" fill="#f8fafc" filter="url(#softShadow)"/>
     <rect x="136" y="114" width="1008" height="74" rx="24" fill="#020617"/>
     <text x="176" y="160" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="850" fill="#ffffff">${headline}</text>
     <rect x="890" y="140" width="204" height="18" rx="9" fill="${accent}"/>
     <rect x="154" y="228" width="288" height="334" rx="28" fill="#ffffff" stroke="#dbe3ea"/>
     <text x="186" y="276" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="850" fill="#0f172a">Signals</text>
     <rect x="186" y="320" width="188" height="15" rx="7" fill="${primary}" opacity="0.35"/><rect x="186" y="368" width="218" height="15" rx="7" fill="#cbd5e1"/><rect x="186" y="416" width="154" height="15" rx="7" fill="#cbd5e1"/>
     <rect x="494" y="228" width="294" height="334" rx="28" fill="#ffffff" stroke="#dbe3ea"/>
     <text x="526" y="276" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="850" fill="#0f172a">${category}</text>
     <circle cx="636" cy="384" r="76" fill="#e2e8f0"/><circle cx="592" cy="352" r="31" fill="${dark}"/><circle cx="704" cy="344" r="31" fill="${accent}"/><circle cx="706" cy="446" r="31" fill="#94a3b8"/>
     <path d="M616 366 676 352M684 426 660 396" stroke="#64748b" stroke-width="12" stroke-linecap="round"/>
     <rect x="840" y="228" width="286" height="334" rx="28" fill="#ffffff" stroke="#dbe3ea"/>
     <text x="872" y="276" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="850" fill="#0f172a">Output</text>
     <rect x="872" y="326" width="190" height="18" rx="9" fill="${accent}" opacity="0.32"/><rect x="872" y="386" width="218" height="15" rx="7" fill="#cbd5e1"/><rect x="872" y="434" width="152" height="15" rx="7" fill="#cbd5e1"/>
     <text x="156" y="612" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="750" fill="#526173">${description}</text>`,
    `<rect width="1280" height="720" fill="#f2f0eb"/>
     <rect x="112" y="78" width="1056" height="564" rx="34" fill="#fffaf3" stroke="#e7dccf" filter="url(#softShadow)"/>
     <rect x="150" y="120" width="980" height="72" rx="24" fill="#ffffff"/>
     <rect x="184" y="146" width="168" height="20" rx="10" fill="${primary}"/><rect x="870" y="146" width="196" height="20" rx="10" fill="#d8ccc0"/>
     <text x="182" y="260" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="850" fill="${primary}">${category}</text>
     <text x="182" y="326" font-family="Inter, Arial, sans-serif" font-size="48" font-weight="900" fill="${dark}">${headlineTight}</text>
     <text x="184" y="374" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="500" fill="#6b5f52">${subheadTight}</text>
     <rect x="184" y="468" width="240" height="62" rx="20" fill="${primary}"/><text x="222" y="508" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="850" fill="#ffffff">Open preview</text>
     <rect x="650" y="236" width="360" height="330" rx="34" fill="#ffffff" stroke="#e7dccf"/>
     <rect x="700" y="292" width="192" height="18" rx="9" fill="${secondary}"/><rect x="700" y="352" width="230" height="17" rx="8" fill="#d8ccc0"/><rect x="700" y="410" width="168" height="17" rx="8" fill="#d8ccc0"/>
     <circle cx="798" cy="500" r="62" fill="#cdebf2"/><path d="M742 522c48-60 104-92 170-96" stroke="#0891b2" stroke-width="18" stroke-linecap="round" fill="none"/>`,
    `<rect width="1280" height="720" fill="${primary}"/>
     <path d="M0 110c170-88 340-114 510-78 170 34 310 124 420 268" stroke="#ffffff" stroke-width="72" opacity="0.14" fill="none"/>
     <rect x="104" y="86" width="1072" height="548" rx="34" fill="#f8fafc" filter="url(#softShadow)"/>
     <rect x="146" y="132" width="172" height="172" rx="42" fill="${dark}"/>
     <circle cx="274" cy="182" r="28" fill="${accent}"/><path d="M188 258c34-46 74-70 120-72" stroke="#ffffff" stroke-width="22" stroke-linecap="round" fill="none"/>
     <text x="366" y="174" font-family="Inter, Arial, sans-serif" font-size="23" font-weight="850" fill="${primary}">${category}</text>
     <text x="364" y="254" font-family="Inter, Arial, sans-serif" font-size="62" font-weight="900" fill="#0f172a">${headline}</text>
     <text x="368" y="308" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="500" fill="#526173">${subhead}</text>
     <rect x="150" y="390" width="282" height="142" rx="26" fill="#ffffff" stroke="#dbe3ea"/><rect x="472" y="390" width="282" height="142" rx="26" fill="#ffffff" stroke="#dbe3ea"/><rect x="794" y="390" width="282" height="142" rx="26" fill="#ffffff" stroke="#dbe3ea"/>
     <rect x="188" y="430" width="154" height="18" rx="9" fill="${secondary}"/><rect x="188" y="482" width="204" height="15" rx="7" fill="#cbd5e1"/>
     <rect x="510" y="430" width="154" height="18" rx="9" fill="${accent}"/><rect x="510" y="482" width="204" height="15" rx="7" fill="#cbd5e1"/>
     <rect x="832" y="430" width="154" height="18" rx="9" fill="${primary}" opacity="0.5"/><path d="M832 498c40-46 86-66 138-60" stroke="${primary}" stroke-width="12" stroke-linecap="round" fill="none"/>`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(input.title)} product showcase">
  <defs>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#0f172a" flood-opacity="0.20"/>
    </filter>
  </defs>
  ${patterns[pattern]}
</svg>`;
};

export const generateVisualAssetFiles = (metadata: ArtifactMetadata): GeneratedVisualAssets => {
  const title = titleFrom(metadata);
  const oneLiner = oneLinerFrom(metadata);
  const category = categoryFrom(metadata);
  const visualIdentity = metadata.visualIdentity ?? {};
  const colors = paletteFor(`${title}:${category}`);

  const logoPath = "mockups/product-logo.svg";
  const thumbnailPath = "mockups/product-thumbnail.svg";
  const productShowcasePath = "mockups/product-showcase.svg";
  const manifestPath = "mockups/visual-manifest.json";
  const productShowcase: VisualAssetEntry = {
    label: "Product showcase",
    path: productShowcasePath,
    mimeType: "image/svg+xml",
    prompt: visualIdentity.screenshotDescription ?? `${title} Product Hunt style product showcase`,
    conceptOnly: true,
    alt: `${title} product showcase`,
  };

  const manifest: VisualManifest = {
    version: 1,
    generationMode: "local_svg",
    isConceptOnly: true,
    notImplementedAsSource: true,
    generatedAt: new Date().toISOString(),
    sourceFields: {
      title,
      oneLiner,
      category,
      // Imagen が"その作品固有の作業画面"を描けるよう、実UIコンテキストを渡す。
      screenshotDescription: visualIdentity.screenshotDescription,
      coreInteraction: metadata.mvpContract?.coreInteraction,
      primaryAction: metadata.interactionProofPlan?.primaryAction,
      stateChange: metadata.mvpContract?.stateChange,
      inspectableOutput: metadata.mvpContract?.inspectableOutput,
    },
    logo: {
      label: "Product logo",
      path: logoPath,
      mimeType: "image/svg+xml",
      prompt: visualIdentity.logoPrompt ?? visualIdentity.logoDescription ?? `${title} product logo`,
      conceptOnly: true,
      alt: `${title} concept logo`,
    },
    thumbnail: {
      label: "Product thumbnail",
      path: thumbnailPath,
      mimeType: "image/svg+xml",
      prompt: visualIdentity.thumbnailPrompt ?? visualIdentity.thumbnailDescription ?? `${title} product thumbnail`,
      conceptOnly: true,
      alt: `${title} concept thumbnail`,
    },
    productShowcase,
    uiPreview: productShowcase,
  };
  return {
    manifest,
    files: [
      {
        relativePath: logoPath,
        content: logoSvg({ title, category, colors }),
        mimeType: "image/svg+xml",
        type: "product_logo",
      },
      {
        relativePath: thumbnailPath,
        content: thumbnailSvg({ title, oneLiner, category, colors }),
        mimeType: "image/svg+xml",
        type: "product_thumbnail",
      },
      {
        relativePath: productShowcasePath,
        content: productShowcaseSvg({
          title,
          oneLiner,
          category,
          description: visualIdentity.screenshotDescription ?? "",
          colors,
        }),
        mimeType: "image/svg+xml",
        type: "product_showcase",
      },
      {
        relativePath: manifestPath,
        content: `${JSON.stringify(manifest, null, 2)}\n`,
        mimeType: "application/json",
        type: "visual_manifest",
      },
    ],
  };
};

const AI_KINDS: ProductVisualKind[] = ["product_showcase", "product_icon"];

/** Manifest key + mockups-relative SVG fallback path each AI kind augments. */
const AI_KIND_TARGET: Record<ProductVisualKind, { manifestKey: "productShowcase" | "logo"; svgPath: string }> = {
  product_showcase: { manifestKey: "productShowcase", svgPath: "mockups/product-showcase.svg" },
  product_icon: { manifestKey: "logo", svgPath: "mockups/product-logo.svg" },
};

/**
 * Attempt env-gated AI image generation for the given artifact, mutating the
 * manifest in place to point at any successfully generated PNG. Never throws:
 * any provider failure (including the PR1 not-enabled scaffold) is logged and
 * the deterministic local SVG asset is kept as the fallback.
 *
 * Returns whether any AI asset was actually produced.
 */
// Persist a generated file so a separate web instance can read it. Under
// artifacts/, writeStoredArtifactFile mirrors to GCS when ARTIFACT_BUCKET is set
// (production Cloud Run) and always writes local FS; outside artifacts/ (e.g. a
// test --path) it stays local-only.
const persistArtifactFile = async (absPath: string, content: string | Buffer): Promise<void> => {
  const relFromCwd = path.relative(process.cwd(), absPath).replaceAll("\\", "/");
  if (relFromCwd.startsWith("artifacts/")) {
    await writeStoredArtifactFile(relFromCwd, content);
  } else {
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
  }
};

const applyAiVisuals = async (args: {
  resolvedArtifactDir: string;
  manifest: VisualManifest;
  fields: VisualManifest["sourceFields"];
}): Promise<boolean> => {
  const config = readVisualAiConfig();
  let anyAi = false;
  let anyFallback = false;

  for (const kind of AI_KINDS) {
    const plan = aiPlanForKind(kind, config);
    if (!plan.aiRequested) continue;

    const provider = providerForPlan(plan);
    // Nano Banana Pro renders the title/tagline in-image, so the showcase uses a
    // rotation-picked variant prompt (stable per work); every other case keeps
    // the default kind prompt. product_icon always uses the icon prompt.
    const useNanoBananaShowcase = kind === "product_showcase" && plan.providerId === "nano_banana";
    const chosenVariant = useNanoBananaShowcase
      ? pickVariantForWork(args.fields.title, ROTATION_POOL)
      : undefined;
    const prompt =
      chosenVariant !== undefined
        ? buildThumbnailPrompt(chosenVariant, args.fields)
        : buildPromptForKind(kind, args.fields);
    const target = AI_KIND_TARGET[kind];
    const outputRel = `mockups/${plan.aiOutputBasename}`;
    const outputPath = path.join(args.resolvedArtifactDir, outputRel);

    if (!provider) {
      console.warn(
        `[visual-ai] ${kind}: provider "${plan.providerId}" is not available yet; keeping ${target.svgPath}.`,
      );
      anyFallback = true;
      continue;
    }

    try {
      const result = await provider.generate({
        kind,
        title: args.fields.title,
        oneLiner: args.fields.oneLiner,
        category: args.fields.category,
        prompt,
        outputPath,
      });
      let generatedBytes = await readFile(result.path);
      if (useNanoBananaShowcase) {
        // Nano Banana Pro already rendered the correct title/tagline in-image;
        // record which rotation variant produced this thumbnail.
        args.manifest.thumbnailVariant = chosenVariant;
      } else if (
        kind === "product_showcase" &&
        plan.providerId === "imagen" &&
        result.mimeType !== "image/svg+xml"
      ) {
        // Legacy Imagen path: the illustration is text-free (see buildShowcasePrompt),
        // so composite the real title/category/one-liner on top instead of relying
        // on Imagen to render it (known mojibake risk).
        generatedBytes = Buffer.from(
          await composeThumbnailText(generatedBytes, {
            title: args.fields.title,
            oneLiner: args.fields.oneLiner,
            category: args.fields.category,
          }),
        );
        await writeFile(result.path, generatedBytes);
        args.manifest.textComposited = true;
      }
      // Mirror the generated bytes to GCS (prod) so the web instance can read
      // them; the provider only wrote local FS.
      await persistArtifactFile(result.path, generatedBytes);
      const entry = args.manifest[target.manifestKey];
      entry.path = path.relative(args.resolvedArtifactDir, result.path).replaceAll("\\", "/");
      entry.mimeType = result.mimeType;
      entry.prompt = prompt;
      if (kind === "product_showcase") {
        args.manifest.uiPreview = entry;
      }
      args.manifest.provider = plan.providerId;
      args.manifest.model = result.model ?? plan.model;
      args.manifest.prompt = prompt;
      anyAi = true;
      console.log(`[visual-ai] ${kind}: generated ${entry.path} via ${plan.providerId}.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[visual-ai] ${kind}: generation failed (${reason}); falling back to ${target.svgPath}.`);
      anyFallback = true;
    }
  }

  if (anyAi) {
    args.manifest.version = 2;
    args.manifest.generationMode = "ai_image";
    args.manifest.fallbackGenerationMode = "local_svg";
  }
  if (anyFallback) {
    args.manifest.fallbackUsed = true;
  }
  return anyAi;
};

export const generateVisualAssetsForArtifactDir = async (artifactDir: string): Promise<GeneratedVisualAssets> => {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const metadata = await readJson<ArtifactMetadata>(path.join(resolvedArtifactDir, "metadata.json"));
  const generated = generateVisualAssetFiles(metadata);
  await mkdir(path.join(resolvedArtifactDir, "mockups"), { recursive: true });

  // Write the deterministic local SVG set first — it is always the fallback.
  for (const file of generated.files) {
    if (file.type === "visual_manifest") continue;
    await persistArtifactFile(path.join(resolvedArtifactDir, file.relativePath), file.content);
  }

  // Optionally augment with env-gated AI images (local_svg stays on disk).
  await applyAiVisuals({
    resolvedArtifactDir,
    manifest: generated.manifest,
    fields: generated.manifest.sourceFields,
  });

  // Write the (possibly AI-augmented) manifest last so it reflects final paths.
  // Mirrored to GCS too, else the web instance would read the stale local_svg
  // manifest and never see the AI image.
  await persistArtifactFile(
    path.join(resolvedArtifactDir, "mockups/visual-manifest.json"),
    `${JSON.stringify(generated.manifest, null, 2)}\n`,
  );

  return generated;
};

async function main() {
  const args = parseArgs();
  if (!args.artifactDir) {
    console.error("Usage: tsx scripts/generate-visual-assets.ts --path <artifact-dir> [--dry-run]");
    process.exit(1);
  }

  if (args.dryRun) {
    const resolvedArtifactDir = path.resolve(args.artifactDir);
    const metadata = await readJson<ArtifactMetadata>(path.join(resolvedArtifactDir, "metadata.json"));
    const { manifest } = generateVisualAssetFiles(metadata);
    const config = readVisualAiConfig();
    console.log(`Visual assets DRY-RUN (no files written, no provider API calls) for ${args.artifactDir}`);
    for (const kind of AI_KINDS) {
      const plan = aiPlanForKind(kind, config);
      const target = AI_KIND_TARGET[kind];
      if (!plan.aiRequested) {
        console.log(`  ${kind}: provider=local_svg → writes ${target.svgPath} (AI disabled)`);
        continue;
      }
      // Mirror applyAiVisuals: nano_banana showcase uses a rotation-picked variant prompt.
      const previewVariant =
        kind === "product_showcase" && plan.providerId === "nano_banana"
          ? pickVariantForWork(manifest.sourceFields.title, ROTATION_POOL)
          : undefined;
      const prompt =
        previewVariant !== undefined
          ? buildThumbnailPrompt(previewVariant, manifest.sourceFields)
          : buildPromptForKind(kind, manifest.sourceFields);
      const available = providerForPlan(plan) !== null;
      console.log(`  ${kind}: provider=${plan.providerId} model=${plan.model ?? "(default)"}${previewVariant ? ` variant=${previewVariant}` : ""}`);
      console.log(`    output      : mockups/${plan.aiOutputBasename}`);
      console.log(`    fallback    : ${target.svgPath}${available ? "" : " (provider not enabled yet → local_svg)"}`);
      console.log(`    prompt (${prompt.length} chars):`);
      for (const line of prompt.split("\n")) console.log(`      | ${line}`);
    }
    console.log("Re-run without --dry-run to write assets (paid APIs only run when explicitly enabled).");
    return;
  }

  const generated = await generateVisualAssetsForArtifactDir(args.artifactDir);
  const mockupDir = path.join(path.resolve(args.artifactDir), "mockups");
  console.log(`Visual assets written to ${path.relative(process.cwd(), mockupDir)}`);
  console.log(`Files: ${generated.files.map((file) => file.relativePath).join(", ")}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
