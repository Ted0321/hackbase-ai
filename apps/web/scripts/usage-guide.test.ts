/**
 * src/lib/usage-guide.ts の単体テスト。
 * リポジトリにテストランナーが無いため、assertion で exit する tsx スクリプトとして実装
 * （prompt-eval-metrics.test.ts と同じ流儀）。`npm run eval:usage-guide:test` で実行。
 */
import assert from "node:assert/strict";
import {
  normalizeUsageGuide,
  parseStoredUsageGuide,
  serializeUsageGuide,
  usageSentenceKey,
  USAGE_GUIDE_MAX_STEPS,
} from "../src/lib/usage-guide";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const validGuide = {
  intro: "レポート下書きの改善指摘を試せます。",
  steps: [
    { action: "「再生」ボタンを押す", result: "結果エリアに各ステップの分析が順に表示される。" },
    { action: "指摘ごとのヒントを読む", result: "各指摘に理由と書き直し案が付く。" },
  ],
  checkPoint: "指摘が具体的な修正案まで踏み込んでいるか。",
};

check("usageSentenceKey normalizes whitespace and trailing punctuation", () => {
  assert.equal(usageSentenceKey("  結果を  確認する。 "), "結果を 確認する");
  assert.equal(usageSentenceKey("結果を確認する"), usageSentenceKey("結果を確認する！"));
});

check("normalizeUsageGuide keeps a valid guide intact", () => {
  const guide = normalizeUsageGuide(validGuide);
  assert.ok(guide);
  assert.equal(guide.intro, validGuide.intro);
  assert.equal(guide.steps.length, 2);
  assert.equal(guide.steps[0].action, "「再生」ボタンを押す");
  assert.equal(guide.checkPoint, validGuide.checkPoint);
});

check("normalizeUsageGuide rejects non-object and structural failures", () => {
  assert.equal(normalizeUsageGuide(null), null);
  assert.equal(normalizeUsageGuide("テキスト"), null);
  assert.equal(normalizeUsageGuide([]), null);
  assert.equal(normalizeUsageGuide({}), null);
  // 使えるステップが2件未満は棄却。
  assert.equal(normalizeUsageGuide({ steps: [validGuide.steps[0]] }), null);
});

check("normalizeUsageGuide drops steps whose action equals result", () => {
  assert.equal(
    normalizeUsageGuide({
      steps: [
        { action: "同じ文。", result: "同じ文。" },
        validGuide.steps[0],
      ],
    }),
    null,
  );
});

check("normalizeUsageGuide dedupes repeated sentences across steps", () => {
  const guide = normalizeUsageGuide({
    steps: [
      validGuide.steps[0],
      { action: "別の操作をする", result: "結果エリアに各ステップの分析が順に表示される。" },
      validGuide.steps[1],
    ],
  });
  assert.ok(guide);
  // 2番目のステップは result が1番目と重複するため落ちる。
  assert.equal(guide.steps.length, 2);
  assert.equal(guide.steps[1].action, validGuide.steps[1].action);
});

check("normalizeUsageGuide caps steps at USAGE_GUIDE_MAX_STEPS", () => {
  const guide = normalizeUsageGuide({
    steps: Array.from({ length: 7 }, (_, i) => ({
      action: `操作${i + 1}をする`,
      result: `画面に変化${i + 1}が起きる。`,
    })),
  });
  assert.ok(guide);
  assert.equal(guide.steps.length, USAGE_GUIDE_MAX_STEPS);
});

check("normalizeUsageGuide keeps multi-sentence results up to 3 sentences", () => {
  const guide = normalizeUsageGuide({
    steps: [
      {
        action: "AIが資料を読み解く",
        result: "資料を横断して危険源を抽出します。出力は名前と説明の構造化データに固定してあります。サンプルでは高圧ガス配管が抽出されます。4文目は捨てられます。",
      },
      validGuide.steps[1],
    ],
  });
  assert.ok(guide);
  // 3文まで保持し、4文目は落ちる。
  assert.equal(
    guide.steps[0].result,
    "資料を横断して危険源を抽出します。出力は名前と説明の構造化データに固定してあります。サンプルでは高圧ガス配管が抽出されます。",
  );
});

check("normalizeUsageGuide rejects over-length lines instead of truncating", () => {
  // action 上限超過のステップは落ちる → 残り1件で構造欠陥 → null。
  assert.equal(
    normalizeUsageGuide({
      steps: [
        { action: "あ".repeat(61), result: "画面が変わる。" },
        validGuide.steps[0],
      ],
    }),
    null,
  );
  // result 全体(3文以内でも221字以上)超過のステップも切断せず落ちる。
  assert.equal(
    normalizeUsageGuide({
      steps: [
        { action: "長すぎる本文のステップ", result: `${"あ".repeat(120)}。${"い".repeat(120)}。` },
        validGuide.steps[0],
      ],
    }),
    null,
  );
});

check("normalizeUsageGuide detects intro/checkPoint duplicating one sentence inside a result", () => {
  const guide = normalizeUsageGuide({
    intro: "サンプルでは高圧ガス配管が抽出されます。",
    steps: [
      {
        action: "AIが資料を読み解く",
        result: "資料を横断して危険源を抽出します。サンプルでは高圧ガス配管が抽出されます。",
      },
      validGuide.steps[1],
    ],
    checkPoint: "資料を横断して危険源を抽出します。",
  });
  assert.ok(guide);
  // 本文中の1文と同じ intro / checkPoint はフィールド単位で落ち、ガイドは生きる。
  assert.equal(guide.intro, undefined);
  assert.equal(guide.checkPoint, undefined);
  assert.equal(guide.steps.length, 2);
});

check("normalizeUsageGuide strips enclosures and takes first sentence of action", () => {
  const guide = normalizeUsageGuide({
    steps: [
      { action: "『「再生」ボタンを押す。続けて確認する。』", result: "結果が出る。" },
      validGuide.steps[1],
    ],
  });
  assert.ok(guide);
  // 全体囲みを剥がし、第1文のみ採用し、末尾句点を除去する。
  assert.equal(guide.steps[0].action, "「再生」ボタンを押す");
});

check("normalizeUsageGuide drops intro/checkPoint duplicating a step (guide survives)", () => {
  const guide = normalizeUsageGuide({
    intro: validGuide.steps[0].result,
    steps: validGuide.steps,
    checkPoint: validGuide.steps[1].result,
  });
  assert.ok(guide);
  assert.equal(guide.intro, undefined);
  assert.equal(guide.checkPoint, undefined);
  assert.equal(guide.steps.length, 2);
});

check("parseStoredUsageGuide is defensive against bad JSON", () => {
  assert.equal(parseStoredUsageGuide(null), null);
  assert.equal(parseStoredUsageGuide(undefined), null);
  assert.equal(parseStoredUsageGuide(""), null);
  assert.equal(parseStoredUsageGuide("{not json"), null);
  assert.equal(parseStoredUsageGuide('"just a string"'), null);
});

check("serialize -> parse round-trip preserves the guide", () => {
  const guide = normalizeUsageGuide(validGuide);
  assert.ok(guide);
  const parsed = parseStoredUsageGuide(serializeUsageGuide(guide));
  assert.deepEqual(parsed, guide);
});

console.log(`\nusage-guide tests passed: ${passed}`);
