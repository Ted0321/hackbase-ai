import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";
import {
  buildAntidupSteering,
  buildSemanticDupPrompt,
  findVerbatimClone,
  judgeSemanticDuplicateWithLlm,
  parseSemanticDupResponse,
  renderAntiDupSection,
  selectedConceptOf,
  semanticDupGateEnabled,
  MAX_SEMANTIC_DUP_REASON_LENGTH,
} from "./antidup-steering";

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

  // -------------------------------------------------------------------------
  // semantic dup gate (judgeSemanticDuplicateWithLlm, 2026-07-17導入)
  // 2026-07-16 実例の回帰: 「猛暑レスキューシート」はHeatShield Routeの改題クローンとして
  // 逐語ゲートを素通りした。fake generateText で全経路を決定論検証する。
  // -------------------------------------------------------------------------
  const heatProducts = [
    { title: "HeatShield Route", oneLiner: "猛暑の不安を家族専用のやることリストに" },
    { title: "マイ避難コンパス", oneLiner: "自宅周辺の災害情報を個人向け行動タイムラインに変換" },
  ];
  const fakeGenerate =
    (response: string | Error) =>
    async (_prompt: string, _options: { temperature: number; timeoutMs: number; operation: string }) => {
      if (response instanceof Error) throw response;
      return response;
    };

  // selectedConceptOf: extraction refactor keeps findVerbatimClone behavior (checked above);
  // direct contract here.
  const extracted = selectedConceptOf(conceptResponse("タイトルA", "ワンライナーA"));
  assert.strictEqual(extracted?.title, "タイトルA");
  assert.strictEqual(selectedConceptOf({ candidates: [], selectedConcept: { id: "zz" } }), null);
  assert.strictEqual(selectedConceptOf(null), null);

  // 改題クローンは逐語ゲートでは検出されない(=semantic gateの担当範囲の確認)。
  assert.strictEqual(
    findVerbatimClone(
      conceptResponse("猛暑レスキューシート", "家族の情報を入力すると猛暑日のやることを時間割にする"),
      heatProducts,
    ),
    null,
  );

  // parseSemanticDupResponse: plain / fenced / invalid / reason cap.
  assert.deepStrictEqual(
    parseSemanticDupResponse('{"verdict":"duplicate","closestExistingTitle":"HeatShield Route","reason":"入出力が同型"}'),
    { ok: true, verdict: "duplicate", closestExistingTitle: "HeatShield Route", reason: "入出力が同型" },
  );
  const fenced = parseSemanticDupResponse(
    '```json\n{"verdict":"related","closestExistingTitle":"","reason":"同ジャンル別体験"}\n```',
  );
  assert.ok(fenced.ok && fenced.verdict === "related");
  assert.deepStrictEqual(parseSemanticDupResponse('{"verdict":"maybe"}'), { ok: false, fallbackReason: "parse_error" });
  assert.deepStrictEqual(parseSemanticDupResponse("probably fine"), { ok: false, fallbackReason: "parse_error" });
  const longReason = parseSemanticDupResponse(
    JSON.stringify({ verdict: "distinct", closestExistingTitle: "", reason: "重".repeat(MAX_SEMANTIC_DUP_REASON_LENGTH * 2) }),
  );
  assert.ok(longReason.ok && longReason.reason.length <= MAX_SEMANTIC_DUP_REASON_LENGTH);

  // buildSemanticDupPrompt: selected concept + feed list + claimed difference all present.
  const dupPrompt = buildSemanticDupPrompt({
    selected: { title: "猛暑レスキューシート", oneLiner: "猛暑日のやることを時間割に", whyDifferent: "高齢者特化" },
    products: heatProducts,
  });
  assert.ok(dupPrompt.includes("猛暑レスキューシート"));
  assert.ok(dupPrompt.includes("HeatShield Route"));
  assert.ok(dupPrompt.includes("高齢者特化"));

  // duplicate → ok:true verdict=duplicate (caller re-rolls via guided retry).
  const dupResult = await judgeSemanticDuplicateWithLlm({
    conceptResponse: conceptResponse("猛暑レスキューシート", "家族情報から猛暑日の時間割を作る"),
    products: heatProducts,
    generateText: fakeGenerate(
      '{"verdict":"duplicate","closestExistingTitle":"HeatShield Route","reason":"題材・入力・出力・価値提案が同型"}',
    ),
  });
  assert.ok(dupResult.ok && dupResult.verdict === "duplicate");
  assert.ok(dupResult.ok && dupResult.closestExistingTitle === "HeatShield Route");
  assert.ok(dupResult.ok && dupResult.selectedTitle === "猛暑レスキューシート");

  // related / distinct → pass (3値verdictで過剰block抑制)。
  const relatedResult = await judgeSemanticDuplicateWithLlm({
    conceptResponse: conceptResponse("暑さ指数ビジュアライザ", "地域の暑さ指数の推移を可視化する"),
    products: heatProducts,
    generateText: fakeGenerate('{"verdict":"related","closestExistingTitle":"HeatShield Route","reason":"同テーマ別体験"}'),
  });
  assert.ok(relatedResult.ok && relatedResult.verdict === "related");
  const distinctResult = await judgeSemanticDuplicateWithLlm({
    conceptResponse: conceptResponse("色の由来図鑑", "身近な色の名前の由来を巡る"),
    products: heatProducts,
    generateText: fakeGenerate('{"verdict":"distinct","closestExistingTitle":"","reason":"近い既存作なし"}'),
  });
  assert.ok(distinctResult.ok && distinctResult.verdict === "distinct");

  // フォールバック経路: 全てthrowせず ok:false (呼び出し側はpassに倒す)。
  assert.deepStrictEqual(
    await judgeSemanticDuplicateWithLlm({
      conceptResponse: conceptResponse("t", "o"),
      products: heatProducts,
      generateText: fakeGenerate("cannot answer"),
    }),
    { ok: false, fallbackReason: "parse_error" },
  );
  const timeoutError = new Error("aborted due to timeout");
  timeoutError.name = "TimeoutError";
  assert.deepStrictEqual(
    await judgeSemanticDuplicateWithLlm({
      conceptResponse: conceptResponse("t", "o"),
      products: heatProducts,
      generateText: fakeGenerate(timeoutError),
    }),
    { ok: false, fallbackReason: "timeout" },
  );
  const budgetResult = await judgeSemanticDuplicateWithLlm({
    conceptResponse: conceptResponse("t", "o"),
    products: heatProducts,
    generateText: fakeGenerate(new Error("Gemini daily cost cap reached: $10.00")),
  });
  assert.ok(!budgetResult.ok && budgetResult.fallbackReason === "budget_exhausted");
  const genErrorResult = await judgeSemanticDuplicateWithLlm({
    conceptResponse: conceptResponse("t", "o"),
    products: heatProducts,
    generateText: fakeGenerate(new Error("Gemini generateContent failed: 500")),
  });
  assert.ok(!genErrorResult.ok && genErrorResult.fallbackReason === "generation_error");

  // LLMを呼ばない早期return経路。
  let llmCalled = false;
  const spyGenerate = async () => {
    llmCalled = true;
    return '{"verdict":"distinct","closestExistingTitle":"","reason":"x"}';
  };
  assert.deepStrictEqual(
    await judgeSemanticDuplicateWithLlm({
      conceptResponse: conceptResponse("t", "o"),
      products: [],
      generateText: spyGenerate,
    }),
    { ok: false, fallbackReason: "no_products" },
  );
  assert.deepStrictEqual(
    await judgeSemanticDuplicateWithLlm({
      conceptResponse: { candidates: [], selectedConcept: { id: "missing" } },
      products: heatProducts,
      generateText: spyGenerate,
    }),
    { ok: false, fallbackReason: "no_selected_concept" },
  );
  assert.strictEqual(llmCalled, false, "early-return paths must not call the LLM");

  // env無効化 → disabled (LLM未呼び出し)。既定は有効。
  const previousGateEnv = process.env.PRODIA_SEMANTIC_DUP_GATE;
  process.env.PRODIA_SEMANTIC_DUP_GATE = "off";
  try {
    assert.strictEqual(semanticDupGateEnabled(), false);
    assert.deepStrictEqual(
      await judgeSemanticDuplicateWithLlm({
        conceptResponse: conceptResponse("t", "o"),
        products: heatProducts,
        generateText: spyGenerate,
      }),
      { ok: false, fallbackReason: "disabled" },
    );
    assert.strictEqual(llmCalled, false);
  } finally {
    if (previousGateEnv === undefined) delete process.env.PRODIA_SEMANTIC_DUP_GATE;
    else process.env.PRODIA_SEMANTIC_DUP_GATE = previousGateEnv;
  }
  assert.strictEqual(semanticDupGateEnabled(), true, "gate defaults to enabled");

  console.log("antidup steering tests passed (verbatim + semantic dup gate)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
