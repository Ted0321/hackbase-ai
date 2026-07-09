/**
 * Unit checks for the product-icon pattern-family system.
 * Run with `npm run visuals:icons:test`.
 *
 * The headline guarantee is the frameless guardrail: a naked/outline container
 * must never render a `simple` inner mark.
 */
import assert from "node:assert/strict";
import { buildProductIconSvg, selectIconPlan } from "./select";
import { INNERS } from "./inners";
import { SHAPES } from "./shapes";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const seeds = Array.from({ length: 600 }, (_, i) => ({ title: `Product ${i}`, category: ["Research", "Automation", "Writing", "Utility", "Scoring"][i % 5] }));

check("frameless/outline shapes NEVER carry a simple mark (guardrail)", () => {
  for (const s of seeds) {
    const plan = selectIconPlan(s.title, s.category);
    if (plan.shapeClass === "frameless" || plan.shapeClass === "outline") {
      assert.equal(plan.complexity, "rich", `${s.title}: ${plan.shapeId} got simple mark ${plan.innerKey}`);
    }
  }
});

check("selection is deterministic for a given product", () => {
  const a = buildProductIconSvg({ title: "Signal Sifter", category: "Research" });
  const b = buildProductIconSvg({ title: "Signal Sifter", category: "Research" });
  assert.equal(a, b);
});

check("every shape and every inner renders without throwing", () => {
  for (const inner of INNERS) {
    const out = inner.render("#ffffff", "#f59e0b", { letter: "A" });
    assert.ok(out.length > 0, `inner ${inner.key} produced empty output`);
  }
  for (const shape of SHAPES) {
    const out = shape.bg({ fill: "#0f766e", stroke: "#0f766e" });
    assert.equal(typeof out, "string", `shape ${shape.id} bg is not a string`);
  }
});

check("output is a well-formed single SVG with an aria-label", () => {
  const svg = buildProductIconSvg({ title: "Node<Nest>", category: "Utility" });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.equal(svg.split("<svg ").length, 2, "should contain exactly one <svg>");
  assert.match(svg, /aria-label="Node&lt;Nest&gt; concept logo"/);
});

check("shape and inner both vary across products (not a single template)", () => {
  const shapeIds = new Set<string>();
  const innerKeys = new Set<string>();
  let frameless = 0;
  for (const s of seeds) {
    const plan = selectIconPlan(s.title, s.category);
    shapeIds.add(plan.shapeId);
    innerKeys.add(plan.innerKey);
    if (plan.shapeClass === "frameless") frameless += 1;
  }
  assert.ok(shapeIds.size >= 5, `expected many shapes, saw ${shapeIds.size}`);
  assert.ok(innerKeys.size >= 8, `expected many inners, saw ${innerKeys.size}`);
  assert.ok(frameless > 0, "frameless shape should appear at least sometimes");
});

check("palettes vary and framed icons are gradient-heavy (bright look)", () => {
  const paletteStarts = new Set<string>();
  let framed = 0;
  let framedGradient = 0;
  for (const s of seeds) {
    const plan = selectIconPlan(s.title, s.category);
    paletteStarts.add(plan.palette.a);
    if (plan.shapeClass === "framed") {
      framed += 1;
      if (plan.useGradient) framedGradient += 1;
    }
  }
  assert.ok(paletteStarts.size >= 8, `expected many palettes, saw ${paletteStarts.size}`);
  assert.ok(framedGradient / framed > 0.6, `framed icons should be mostly gradient, got ${Math.round((framedGradient / framed) * 100)}%`);
});

check("frameless icon has no background rect/circle (transparent)", () => {
  const framelessSeed = seeds.find((s) => selectIconPlan(s.title, s.category).shapeClass === "frameless");
  assert.ok(framelessSeed, "expected at least one frameless product in the sample");
  const svg = buildProductIconSvg({ ...framelessSeed });
  assert.ok(!/rx="114"/.test(svg), "frameless icon should not draw the framed background");
});

console.log(`\n${passed} checks passed.`);
