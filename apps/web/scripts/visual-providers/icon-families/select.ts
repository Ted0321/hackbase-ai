/**
 * Deterministic icon selection + rendering (DOC-105 icon direction).
 *
 * An icon = shape (weighted) × inner mark (from the complexity-allowed pool for
 * that shape) × palette × optional same-family gradient. Each axis hashes a
 * separately-salted seed so shape, mark, and gradient vary independently, giving
 * broad variety while the same product always renders the same icon.
 *
 * The frameless guardrail lives here: the inner pool is filtered by the shape's
 * allowed complexities, so frameless/outline shapes can only draw `rich` marks.
 */
import { INNERS, type Complexity, type Inner } from "./inners";
import { PALETTES, type IconPalette } from "./palettes";
import { SHAPES, type Shape, type ShapeClass } from "./shapes";

const hashString = (value: string) => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const weightedPick = <T extends { weight: number }>(items: T[], hash: number): T => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let remainder = hash % total;
  for (const item of items) {
    if (remainder < item.weight) return item;
    remainder -= item.weight;
  }
  return items[items.length - 1];
};

const initialOf = (title: string): string => {
  const alnum = title.toUpperCase().match(/[A-Z0-9]/);
  return escapeXml(alnum ? alnum[0] : (title.trim()[0] ?? "A"));
};

type Resolved = { shape: Shape; inner: Inner; palette: IconPalette; useGradient: boolean };

const resolve = (seed: string): Resolved => {
  const shape = weightedPick(SHAPES, hashString(`${seed}:shape`));
  const pool = INNERS.filter((inner) => shape.allow.includes(inner.complexity));
  const inner = pool[hashString(`${seed}:inner`) % pool.length];
  const palette = PALETTES[hashString(`${seed}:palette`) % PALETTES.length];
  // Framed shapes are gradient most of the time (brighter); a solid quarter
  // keeps variety. Frameless/outline never fill, so gradient is irrelevant.
  const useGradient = shape.klass === "framed" && hashString(`${seed}:grad`) % 4 !== 0;
  return { shape, inner, palette, useGradient };
};

export type IconPlan = {
  shapeId: string;
  shapeClass: ShapeClass;
  innerKey: string;
  complexity: Complexity;
  palette: IconPalette;
  useGradient: boolean;
  letter: string;
};

/** Inspect the deterministic selection without rendering (used by tests). */
export const selectIconPlan = (title: string, category: string): IconPlan => {
  const { shape, inner, palette, useGradient } = resolve(`${title}:${category}`);
  return {
    shapeId: shape.id,
    shapeClass: shape.klass,
    innerKey: inner.key,
    complexity: inner.complexity,
    palette,
    useGradient,
    letter: initialOf(title),
  };
};

/**
 * Build the full concept-logo SVG for a product. Colors come from the bright
 * icon palette catalog (not the muted thumbnail palette). Framed shapes carry a
 * white mark on a solid or same-family gradient fill; frameless/outline shapes
 * draw the mark in the palette's vivid primary so it reads on a transparent
 * background.
 */
export const buildProductIconSvg = (input: { title: string; category: string }): string => {
  const { title, category } = input;
  const seed = `${title}:${category}`;
  const { shape, inner, palette, useGradient } = resolve(seed);

  const markColor = shape.klass === "framed" ? "#ffffff" : palette.a;
  const accentColor = palette.accent;
  const gradId = `ig${hashString(seed) % 100000}`;
  const bgFill = useGradient ? `url(#${gradId})` : palette.a;
  const defs = useGradient
    ? `\n  <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.a}"/><stop offset="1" stop-color="${palette.b}"/></linearGradient></defs>`
    : "";
  const bg = shape.bg({ fill: bgFill, stroke: palette.a });
  const mark = inner.render(markColor, accentColor, { letter: initialOf(title) });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${escapeXml(title)} concept logo">${defs}
  ${bg}
  ${mark}
</svg>`;
};
