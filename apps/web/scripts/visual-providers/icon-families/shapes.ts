/**
 * Container-shape catalog for product icons.
 *
 * The shape is the outer silhouette: rounded squares at different radii, a
 * circle, an organic blob, an outline-only frame, or no frame at all. Varying
 * the shape (not just the inner mark) is what stops every icon reading as "the
 * same colored rounded square" (DOC-105 icon direction / review feedback).
 *
 * `weight` biases selection so framed shapes stay the common case and the
 * naked/outline shapes are an occasional accent. `allow` lists which inner
 * complexities may sit inside this shape — frameless/outline permit `rich`
 * only, which is the guardrail against lonely single marks.
 */
import type { Complexity } from "./inners";

export type ShapeClass = "framed" | "frameless" | "outline";

export type Shape = {
  id: string;
  weight: number;
  klass: ShapeClass;
  allow: Complexity[];
  /** Background element(s); `fill` is a solid color or gradient url, `stroke` a color. */
  bg: (colors: { fill: string; stroke: string }) => string;
};

export const SHAPES: Shape[] = [
  {
    id: "square",
    weight: 24,
    klass: "framed",
    allow: ["simple", "rich"],
    bg: ({ fill }) => `<rect width="512" height="512" rx="114" fill="${fill}"/>`,
  },
  {
    id: "circle",
    weight: 18,
    klass: "framed",
    allow: ["simple", "rich"],
    bg: ({ fill }) => `<circle cx="256" cy="256" r="248" fill="${fill}"/>`,
  },
  {
    id: "squircle",
    weight: 12,
    klass: "framed",
    allow: ["simple", "rich"],
    bg: ({ fill }) => `<rect width="512" height="512" rx="200" fill="${fill}"/>`,
  },
  {
    id: "sharp",
    weight: 12,
    klass: "framed",
    allow: ["simple", "rich"],
    bg: ({ fill }) => `<rect width="512" height="512" rx="40" fill="${fill}"/>`,
  },
  {
    id: "blob",
    weight: 8,
    klass: "framed",
    allow: ["simple", "rich"],
    bg: ({ fill }) =>
      `<path d="M256 44 C 360 40 470 118 468 250 C 470 372 372 478 248 470 C 138 464 42 372 44 256 C 46 144 150 48 256 44 Z" fill="${fill}"/>`,
  },
  {
    id: "outline",
    weight: 12,
    klass: "outline",
    allow: ["rich"],
    bg: ({ stroke }) => `<rect x="26" y="26" width="460" height="460" rx="110" fill="none" stroke="${stroke}" stroke-width="26"/>`,
  },
  {
    id: "frameless",
    weight: 14,
    klass: "frameless",
    allow: ["rich"],
    bg: () => "",
  },
];
