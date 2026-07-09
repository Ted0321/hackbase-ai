/**
 * Thumbnail Lab — standalone prompt-quality harness for Nano Banana Pro
 * (gemini-3-pro-image) product thumbnails.
 *
 * Renders a launch-page quality 16:9 thumbnail — exact Japanese title + tagline
 * IN the image — from an EXISTING work's metadata.json. Used to iterate on the
 * prompt library before/independently of the production pipeline; it writes only
 * to branding/thumbnail-lab/.
 *
 * The variant prompt library and the generateContent call are shared with the
 * production pipeline (visual-providers/thumbnail-variants.ts and
 * visual-providers/nano-banana.ts) so the lab and prod never drift.
 *
 * Usage:
 *   tsx scripts/thumbnail-lab.ts --source <materialized-artifact-dir> \
 *     [--variant <name[,name]>|all|rotate] [--model gemini-3-pro-image] \
 *     [--size 2K] [--count 1] [--out branding/thumbnail-lab] [--dry-run]
 *
 * Spend guard: uses the same daily Gemini budget gate as the rest of the
 * pipeline (enforceGeminiBudget) and logs cost via logModelUsage.
 */
import "./load-local-env";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { enforceGeminiBudget } from "./llm-pipeline/rate-guard";
import { logModelUsage } from "./observability";
import type { PromptFields } from "./visual-providers/types";
import {
  ALL_THUMBNAIL_VARIANT_IDS,
  ROTATION_POOL,
  THUMBNAIL_VARIANTS,
  ThumbnailVariantId,
  pickVariantForWork,
} from "./visual-providers/thumbnail-variants";
import { generateNanoBananaImage } from "./visual-providers/nano-banana";

type ArtifactMetadata = {
  title?: string;
  label?: string;
  oneLiner?: string;
  category?: string;
  categoryName?: string;
  generatedOutput?: { title?: string; oneLiner?: string };
  visualIdentity?: { screenshotDescription?: string; thumbnailDescription?: string };
  mvpContract?: { coreInteraction?: string; stateChange?: string; inspectableOutput?: string };
  interactionProofPlan?: { primaryAction?: string };
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9぀-ヿ一-龯]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "work";

const fieldsFrom = (metadata: ArtifactMetadata): PromptFields => ({
  title: metadata.title ?? metadata.label ?? metadata.generatedOutput?.title ?? "Generated product",
  oneLiner: metadata.oneLiner ?? metadata.generatedOutput?.oneLiner ?? "",
  category: metadata.category ?? metadata.categoryName ?? "Product",
  screenshotDescription: metadata.visualIdentity?.screenshotDescription,
  coreInteraction: metadata.mvpContract?.coreInteraction,
  primaryAction: metadata.interactionProofPlan?.primaryAction,
  stateChange: metadata.mvpContract?.stateChange,
  inspectableOutput: metadata.mvpContract?.inspectableOutput,
});

type CliArgs = {
  source: string;
  variants: ThumbnailVariantId[];
  /** When true, one variant is chosen per work via pickVariantForWork(title). */
  rotate: boolean;
  model: string;
  size: string;
  count: number;
  outDir: string;
  dryRun: boolean;
};

const parseArgs = (): CliArgs => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
    } else {
      values.set(key, next);
      index += 1;
    }
  }
  const variantArg = String(values.get("variant") ?? "all");
  const rotate = variantArg === "rotate";
  // In rotate mode `variants` is the pool to rotate over (the approved
  // ROTATION_POOL by default); main() picks one from it per work.
  const variants =
    rotate
      ? ROTATION_POOL
      : variantArg === "all"
        ? ALL_THUMBNAIL_VARIANT_IDS
        : (variantArg.split(",").map((v) => v.trim()) as ThumbnailVariantId[]).filter((v) =>
            ALL_THUMBNAIL_VARIANT_IDS.includes(v),
          );
  return {
    source: String(values.get("source") ?? ""),
    variants,
    rotate,
    model: String(values.get("model") ?? "gemini-3-pro-image"),
    size: String(values.get("size") ?? "2K"),
    count: Number.parseInt(String(values.get("count") ?? "1"), 10) || 1,
    outDir: String(values.get("out") ?? "branding/thumbnail-lab"),
    dryRun: values.get("dry-run") === true,
  };
};

async function main() {
  const args = parseArgs();
  if (!args.source) {
    console.error(
      `Usage: tsx scripts/thumbnail-lab.ts --source <materialized-artifact-dir> [--variant <name[,name]>|all|rotate] [--model gemini-3-pro-image] [--size 2K] [--count 1] [--out branding/thumbnail-lab] [--dry-run]\n  variants: ${ALL_THUMBNAIL_VARIANT_IDS.join(", ")}\n  rotation pool: ${ROTATION_POOL.join(", ")}`,
    );
    process.exit(1);
  }

  const metadataPath = path.join(path.resolve(args.source), "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactMetadata;
  const fields = fieldsFrom(metadata);
  const slug = slugify(fields.title);
  const outDir = path.resolve(args.outDir);
  await mkdir(outDir, { recursive: true });

  // rotate mode: this work renders in exactly one variant, chosen stably from
  // its title so the feed varies across works without a random draw per run.
  const variants: ThumbnailVariantId[] = args.rotate
    ? [pickVariantForWork(fields.title, args.variants)]
    : args.variants;

  console.log(`[thumbnail-lab] work="${fields.title}" slug=${slug}`);
  console.log(
    `[thumbnail-lab] model=${args.model} size=${args.size} variants=${variants.join(",")}${args.rotate ? " (rotate)" : ""} count=${args.count}`,
  );

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!args.dryRun && !apiKey) {
    console.error("[thumbnail-lab] GEMINI_API_KEY is not set.");
    process.exit(1);
  }

  const estimatedCostUsd = Number.parseFloat(process.env.PRODIA_NANO_BANANA_COST_USD ?? "") || 0.15;

  for (const variant of variants) {
    const prompt = THUMBNAIL_VARIANTS[variant](fields);
    const promptPath = path.join(outDir, `${slug}--${variant}.prompt.txt`);
    await writeFile(promptPath, `${prompt}\n`);

    if (args.dryRun) {
      console.log(
        `\n[thumbnail-lab] DRY-RUN ${variant}: prompt saved to ${path.relative(process.cwd(), promptPath)} (${prompt.length} chars)`,
      );
      continue;
    }

    for (let n = 1; n <= args.count; n += 1) {
      await enforceGeminiBudget({ operation: "thumbnail-lab" });
      const startedAt = Date.now();
      const suffix = args.count > 1 ? `-${n}` : "";
      const outPath = path.join(outDir, `${slug}--${variant}--${args.model}${suffix}.png`);
      try {
        const result = await generateNanoBananaImage({
          apiKey: apiKey!,
          model: args.model,
          prompt,
          aspectRatio: "16:9",
          size: args.size,
        });
        await writeFile(outPath, result.bytes);
        await logModelUsage({
          provider: "google-nano-banana",
          model: args.model,
          operation: "thumbnail-lab",
          status: "success",
          latencyMs: Date.now() - startedAt,
          estimatedCostUsd,
        });
        console.log(
          `[thumbnail-lab] ${variant}${suffix}: wrote ${path.relative(process.cwd(), outPath)} (${result.bytes.length} bytes, ${Date.now() - startedAt}ms)`,
        );
      } catch (error) {
        await logModelUsage({
          provider: "google-nano-banana",
          model: args.model,
          operation: "thumbnail-lab",
          status: "error",
          latencyMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(
          `[thumbnail-lab] ${variant}${suffix}: FAILED — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  console.log(`\n[thumbnail-lab] done. Output dir: ${path.relative(process.cwd(), outDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
