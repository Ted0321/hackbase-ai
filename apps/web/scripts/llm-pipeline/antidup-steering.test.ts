import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";
import { buildAntidupSteering, findVerbatimClone, renderAntiDupSection } from "./antidup-steering";

const products = [
  { title: "Stressor Storylines", oneLiner: "宇宙のストレス要因を選ぶと、遺伝子への影響を例え話付きのビジュアルストーリーで学べます。" },
  { title: "天候ガチャ", oneLiner: "土地・天候・農法のカードをガチャで引き、収穫量を予想して遊ぶ農業シミュレーション。" },
];

const conceptResponse = (title: string, oneLiner: string) => ({
  candidates: [
    { id: "c1", title: "Fresh Idea", oneLiner: "全く新しい何か" },
    { id: "c2", title, oneLiner },
  ],
  selectedConcept: { id: "c2" },
});

async function main() {
  // findVerbatimClone: exact title copy is detected (the 2026-07-08 agent_c incident shape).
  const exact = findVerbatimClone(conceptResponse("Stressor Storylines", "別の説明文"), products);
  assert.ok(exact, "exact title copy should be detected");
  assert.strictEqual(exact?.matchedTitle, "Stressor Storylines");

  // Whitespace/punctuation variants still match (normalization).
  const variant = findVerbatimClone(conceptResponse("stressor  storylines!", "違う説明"), products);
  assert.ok(variant, "normalized title variant should be detected");

  // oneLiner copy with a different title is also a clone.
  const byOneLiner = findVerbatimClone(
    conceptResponse("新しいタイトル", "宇宙のストレス要因を選ぶと、遺伝子への影響を例え話付きのビジュアルストーリーで学べます。"),
    products,
  );
  assert.ok(byOneLiner, "verbatim oneLiner should be detected");

  // A fresh concept passes; only the SELECTED candidate is checked.
  assert.strictEqual(findVerbatimClone(conceptResponse("Molecule Gauntlet", "創薬候補を2軸で評価する"), products), null);
  const unselectedClone = {
    candidates: [
      { id: "c1", title: "Stressor Storylines", oneLiner: "コピー" },
      { id: "c2", title: "Fresh Pick", oneLiner: "新規" },
    ],
    selectedConcept: { id: "c2" },
  };
  assert.strictEqual(findVerbatimClone(unselectedClone, products), null, "unselected candidates are not blocked");

  // Malformed input never throws.
  assert.strictEqual(findVerbatimClone(null, products), null);
  assert.strictEqual(findVerbatimClone({}, products), null);
  assert.strictEqual(findVerbatimClone(conceptResponse("x", "y"), []), null);

  // renderAntiDupSection: rules appear BEFORE the product list (anchoring countermeasure).
  const section = renderAntiDupSection(products);
  const rulesIndex = section.indexOf("アンチ重複ルール");
  const listIndex = section.indexOf("公開済み・審査保留プロダクト一覧");
  assert.ok(rulesIndex >= 0 && listIndex > rulesIndex, "rules must precede the exclusion list");
  assert.ok(section.includes("審査保留(held)中"), "intro mentions held items are excluded too");
  assert.ok(section.includes("Stressor Storylines"), "products are listed");

  // buildAntidupSteering: writes prompts dir with appended section + products file.
  const runId = "run_test_antidup_steering";
  const result = await buildAntidupSteering(products, runId);
  try {
    const conceptPrompt = await readFile(path.join(result.promptsDir, "concept-strategist.md"), "utf8");
    assert.ok(conceptPrompt.includes("アンチ重複ルール"), "concept prompt has the injected section");
    const written = JSON.parse(await readFile(result.productsFile, "utf8"));
    assert.strictEqual(written.length, 2);
    assert.strictEqual(result.publishedCount, 2);
  } finally {
    await rm(result.promptsDir, { recursive: true, force: true });
  }

  console.log("antidup steering tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
