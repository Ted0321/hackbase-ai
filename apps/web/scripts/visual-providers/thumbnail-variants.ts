/**
 * Nano Banana Pro thumbnail prompt library (DOC / phase-2 visual rework).
 *
 * Unlike the Imagen showcase prompt (types.ts buildShowcasePrompt) which forbids
 * ALL in-image text because Imagen mangles it, these prompts ASK for the exact
 * title/tagline/category to be rendered IN the image — text rendering (incl.
 * Japanese) is a headline capability of gemini-3-pro-image (Nano Banana Pro), so
 * no post-compositing is needed.
 *
 * A stability sweep (10 variants × 3 seeds, phase B) confirmed all variants keep
 * the title/tagline/category correct; ROTATION_POOL is the approved subset used
 * by the production pipeline. "isometric-float" is kept in the library for the
 * lab tool but excluded from the pool: its axonometric panels garble the small
 * in-panel UI text.
 *
 * Pure module: prompt builders only, no network I/O.
 */
import type { PromptFields } from "./types";

export type ThumbnailVariantId =
  | "hero-left"
  | "slide-stack"
  | "tile-collage"
  | "dark-brand"
  | "phone-hero"
  | "big-stat"
  | "split-diagonal"
  | "browser-banner"
  | "isometric-float"
  | "before-after";

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/**
 * The exact strings to render in-image. The tagline is clipped generously (88)
 * so full one-liners fit without the trailing "…" seen at shorter limits.
 */
const exactTextBlock = (fields: PromptFields) => `Render these exact Japanese/English strings, verbatim, with correct kanji/kana and clean modern sans-serif typography (bold geometric sans for the title):
- Product title (large, dominant): 「${clip(fields.title, 40)}」
- Tagline (smaller, one line, under the title): 「${clip(fields.oneLiner, 88)}」
- Category label (small caps pill or eyebrow text): ${clip(fields.category.toUpperCase(), 24)}
Do not add any other readable sentences. Small incidental UI labels inside the product screenshot are acceptable if they look plausible and clean.`;

const productUiBlock = (fields: PromptFields) => {
  const lines = [
    fields.screenshotDescription && `Main screen: ${clip(fields.screenshotDescription, 300)}`,
    fields.coreInteraction && `Core user action: ${clip(fields.coreInteraction, 180)}`,
    fields.primaryAction && `Primary button: ${clip(fields.primaryAction, 60)}`,
    fields.stateChange && `Result shown: ${clip(fields.stateChange, 180)}`,
    fields.inspectableOutput && `Output panel: ${clip(fields.inspectableOutput, 140)}`,
  ].filter(Boolean);
  return lines.length
    ? `The product UI shown must depict THIS product's actual working screen (not a generic dashboard):\n${lines.join("\n")}`
    : "";
};

const qualityBlock = `Overall: premium startup launch-gallery aesthetic (Product Hunt featured image quality), crisp vector-like rendering, balanced composition with generous negative space, subtle soft shadows, high colour harmony. 16:9. No watermark, no photo of people, no hands, no gibberish text, no lorem ipsum.`;

export const THUMBNAIL_VARIANTS: Record<ThumbnailVariantId, (fields: PromptFields) => string> = {
  /** Gamma / FunBlocks style: text block left, one floating product window right. */
  "hero-left": (fields) => `Design a polished SaaS product launch thumbnail (16:9).

Layout:
- Background: smooth diagonal gradient from deep indigo to violet-blue, with a very subtle star-dust/noise texture.
- Left 40%: a clean text block, vertically centered.
- Right 55%: ONE large rounded desktop-browser window, floating with a soft drop shadow, slightly overlapping the right edge, showing the product UI in active use.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Chronicle style: light background, diagonal cascade of screen cards. */
  "slide-stack": (fields) => `Design a premium product launch thumbnail (16:9) in the style of a modern design-tool announcement.

Layout:
- Background: warm off-white / very light gray, minimal.
- Top-left: the text block (title, tagline, category eyebrow), left-aligned, dark near-black text.
- Right two-thirds: a diagonal cascade of 4 overlapping rounded screen-cards (like fanned slides), receding into depth toward the top-right, each card showing a different screen of the product UI; give the cards varied but harmonious accent colours (deep blue, orange, dark green, light violet), soft shadows between layers.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Beautiful.ai style: bold left text, playful angled collage of UI tiles right. */
  "tile-collage": (fields) => `Design an energetic product launch thumbnail (16:9).

Layout:
- Background: very light cool gray.
- Left 45%: large bold near-black title text block with the tagline beneath in medium gray, and a small round logo dot above.
- Right 55%: a lively collage of 6-8 small UI cards/tiles at slight random angles (charts, panels, buttons, stat cards from the product), in a bold flat colour palette (orange, navy, yellow, teal), overlapping playfully with slight shadows.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Hackbase brand (H案): dark masthead + single cyan accent. */
  "dark-brand": (fields) => `Design a sleek dark-theme product launch thumbnail (16:9) for an AI developer platform brand.

Layout:
- Background: near-black deep navy (#050816) with a faint blueprint grid and a soft cyan glow rising from the bottom edge.
- Left 42%: text block — a short cyan (#22d3ee) accent bar above the category eyebrow, then the large white bold title, then the tagline in light gray.
- Right 55%: one rounded dark-UI desktop window with thin light borders, showing the product UI, edges catching a subtle cyan rim-light.
- Exactly ONE accent colour: cyan. Everything else monochrome navy/white/gray.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** App-store style: portrait phone mockup with a floating callout pill. */
  "phone-hero": (fields) => `Design a modern consumer-app launch thumbnail (16:9).

Layout:
- Background: smooth vertical gradient from violet to indigo, clean.
- Left 45%: white/light text block — a small rounded category pill, then the large bold white title, then the tagline in soft lavender-white.
- Right 55%: ONE realistic portrait smartphone mockup, floating with a soft shadow, tilted very slightly, showing the product's mobile screen in active use. Add exactly ONE small floating rounded "callout" pill overlapping the phone edge that highlights the key action, with a subtle check or arrow.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Metric-hero: one dominant number/score as the visual anchor. */
  "big-stat": (fields) => `Design a bold metric-driven product thumbnail (16:9).

Layout:
- Background: clean light background with one large soft-coloured rounded panel occupying the right half.
- Left 45%: text block — category eyebrow, large bold near-black title, tagline beneath.
- Right 55%: ONE dominant hero metric — a very large number / gauge / score ring drawn from the product (e.g. a percentage, a count, a progress dial), rendered big and confident with a supporting mini-chart or a couple of small stat chips beneath it. The number is the visual hero.

${exactTextBlock(fields)}

${productUiBlock(fields)}
If the product has a natural headline metric (a score, percentage, count), feature it as the giant number; otherwise invent a plausible clean KPI consistent with the product.

${qualityBlock}`,

  /** Diagonal split: solid brand colour panel + full-bleed product UI. */
  "split-diagonal": (fields) => `Design a striking split-screen product thumbnail (16:9).

Layout:
- A bold diagonal split from top-left to bottom-right divides the frame.
- Upper-left triangle: a solid rich brand colour (deep blue or teal) holding the text block — category eyebrow, large white bold title, tagline in a lighter tint.
- Lower-right triangle: a full-bleed close-up of the product UI (a real working screen), bright and detailed, meeting the colour panel along the clean diagonal edge with a thin accent seam.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Screenshot-forward: one large centered browser window + overlay banner. */
  "browser-banner": (fields) => `Design a screenshot-forward product launch thumbnail (16:9).

Layout:
- Background: soft neutral gradient (light gray to pale blue).
- Center: ONE large rounded desktop-browser window that fills roughly 78% of the frame, floating with a generous soft shadow, showing the product's main working screen in rich detail.
- Across the bottom (or top) of the frame, a clean semi-transparent banner strip holds the text: category eyebrow + bold title on the left, tagline on the right.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Isometric: floating 3D UI panels arranged in depth (lab only; not in pool). */
  "isometric-float": (fields) => `Design a modern tech product thumbnail (16:9) with an isometric composition.

Layout:
- Background: deep gradient (midnight blue to purple) with faint floating particles.
- Top-left: text block — category eyebrow, large bold white title, tagline in light gray.
- Center-right: several of the product's UI panels/cards rendered as clean isometric 3D tiles floating at matching angles in layered depth, connected by thin glowing lines, casting soft shadows — like an exploded axonometric view of the app.

${exactTextBlock(fields)}

${productUiBlock(fields)}

${qualityBlock}`,

  /** Transformation: two panels showing input -> output with an arrow. */
  "before-after": (fields) => `Design a transformation-focused product thumbnail (16:9) that shows input turning into output.

Layout:
- Background: clean light background.
- Top strip: the text block, left-aligned — category eyebrow, bold near-black title, tagline beneath.
- Lower two-thirds: TWO rounded UI panels side by side of equal size — the LEFT labelled as the "before/input" state and the RIGHT as the "after/result" state — with a bold rounded arrow (or a small AI spark badge) between them showing the transformation. Each panel shows the product's actual content in that state.

${exactTextBlock(fields)}

${productUiBlock(fields)}
Make the contrast between the left (input) and right (result) panels clear and legible.

${qualityBlock}`,
};

/** Every variant, including lab-only ones. */
export const ALL_THUMBNAIL_VARIANT_IDS = Object.keys(THUMBNAIL_VARIANTS) as ThumbnailVariantId[];

/**
 * Production rotation pool: the variants approved by the phase-B stability sweep.
 * Excludes "isometric-float" (garbled in-panel UI text under axonometric skew).
 */
export const ROTATION_POOL: ThumbnailVariantId[] = ALL_THUMBNAIL_VARIANT_IDS.filter(
  (id) => id !== "isometric-float",
);

/**
 * Deterministically pick a variant for a work from its title, so a given work
 * always renders in the same style (stable across re-runs) while the set of
 * works spreads across the pool — the "random rotation" the feed shows is really
 * a stable per-work hash. Pass the approved `pool` to restrict the choice.
 */
export const pickVariantForWork = (
  title: string,
  pool: ThumbnailVariantId[] = ROTATION_POOL,
): ThumbnailVariantId => {
  let hash = 2166136261;
  for (const char of title) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return pool[(hash >>> 0) % pool.length];
};

export const buildThumbnailPrompt = (variant: ThumbnailVariantId, fields: PromptFields): string =>
  THUMBNAIL_VARIANTS[variant](fields);
