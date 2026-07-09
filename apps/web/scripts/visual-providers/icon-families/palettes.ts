/**
 * Bright, high-saturation palette catalog for product icons.
 *
 * Deliberately independent of the muted `paletteFor` used by thumbnails and
 * showcases: launch-directory icons read best when they pop (review feedback:
 * "the colors are too dark; the prototype used brighter, more saturated hues").
 *
 * Each palette is one hue family:
 *   a      = gradient start / solid fill / frameless mark color (vivid mid tone,
 *            kept dark enough that a white mark stays legible on top)
 *   b      = gradient end (a brighter tint of the same family)
 *   accent = a contrasting pop used by two-tone marks
 *
 * Extend by adding entries — selection is `hash(seed) % PALETTES.length`.
 */

export type IconPalette = {
  a: string;
  b: string;
  accent: string;
};

export const PALETTES: IconPalette[] = [
  { a: "#7c3aed", b: "#a855f7", accent: "#fde047" }, // violet
  { a: "#4f46e5", b: "#818cf8", accent: "#fde047" }, // indigo
  { a: "#2563eb", b: "#38bdf8", accent: "#fbbf24" }, // blue
  { a: "#0284c7", b: "#38bdf8", accent: "#fde047" }, // sky
  { a: "#0891b2", b: "#22d3ee", accent: "#fde047" }, // cyan
  { a: "#0d9488", b: "#2dd4bf", accent: "#fde047" }, // teal
  { a: "#059669", b: "#34d399", accent: "#fef08a" }, // emerald
  { a: "#16a34a", b: "#4ade80", accent: "#fde047" }, // green
  { a: "#d97706", b: "#fbbf24", accent: "#1d4ed8" }, // amber
  { a: "#ea580c", b: "#fb923c", accent: "#1e3a8a" }, // orange
  { a: "#e11d48", b: "#fb7185", accent: "#fde047" }, // rose
  { a: "#db2777", b: "#f472b6", accent: "#fde047" }, // pink
  { a: "#c026d3", b: "#e879f9", accent: "#fde047" }, // fuchsia
];
