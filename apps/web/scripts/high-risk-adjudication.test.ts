/**
 * high-risk-adjudication.ts(regexゲートのLLM二次判定)の単体テスト。
 * generateText を注入して決定論的に検証する(実LLM/DB不要)。
 * `npm run eval:high-risk-adjudication:test` で実行。
 *
 * 安全契約の検証が主目的: どの経路でも throw しないこと、benign_mention の明示判定
 * 以外は全て「hold維持」側(ok:false または verdict!==benign_mention)に落ちること。
 */
import assert from "node:assert/strict";
import {
  adjudicateHighRiskEvidence,
  buildHighRiskAdjudicationPrompt,
  highRiskAdjudicationEnabled,
  parseAdjudicationResponse,
  MAX_ADJUDICATION_REASONING_LENGTH,
} from "./high-risk-adjudication";
import { collectHighRiskMatchExcerpts } from "./prompt-eval-metrics";

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    });
  }
  passed += 1;
  console.log(`PASS ${name}`);
  return Promise.resolve();
};

// 2026-07-16 実例(a) ReadyRucksack 相当: 機能説明文の「住所」でpersonal_dataにヒットする証跡。
const READY_RUCKSACK_EVIDENCE = {
  title: "ReadyRucksack",
  oneLiner: "自宅の住所と家族構成を登録すると、災害時にネットが無くても使える避難計画を保存できる",
  concept: "ローカルAIが状況に応じた次の行動を提案する防災デモ。ハザードマップAPIは全てモック。",
  readmeContent: "静的サンプルデータのみで動作します。外部通信はありません。",
  metadata: { knownRisks: [], sourceProvenance: null },
  publisherResponse: null,
};

const SAFE_EVIDENCE = {
  title: "Static Board",
  oneLiner: "サンプル行を並べ替えるだけの静的デモ",
  readmeContent: "fictional rows only.",
};

const fakeGenerate =
  (response: string | Error) =>
  async (_prompt: string, _options: { temperature: number; timeoutMs: number; operation: string }) => {
    if (response instanceof Error) throw response;
    return response;
  };

const run = async () => {
  // ---- parseAdjudicationResponse ----
  await check("パーサ: 素のJSONを受理する", () => {
    const result = parseAdjudicationResponse('{"verdict":"benign_mention","reasoning":"mock demo"}');
    assert.deepEqual(result, { ok: true, verdict: "benign_mention", reasoning: "mock demo" });
  });

  await check("パーサ: ```jsonフェンス付きを受理する", () => {
    const result = parseAdjudicationResponse('```json\n{"verdict":"actual_risk","reasoning":"advice"}\n```');
    assert.deepEqual(result, { ok: true, verdict: "actual_risk", reasoning: "advice" });
  });

  await check("パーサ: 未知のverdictはparse_error", () => {
    const result = parseAdjudicationResponse('{"verdict":"maybe","reasoning":"?"}');
    assert.deepEqual(result, { ok: false, fallbackReason: "parse_error" });
  });

  await check("パーサ: 非JSONはparse_error", () => {
    assert.deepEqual(parseAdjudicationResponse("benign, probably"), {
      ok: false,
      fallbackReason: "parse_error",
    });
  });

  await check("パーサ: 長すぎるreasoningは切り詰める", () => {
    const long = "り".repeat(MAX_ADJUDICATION_REASONING_LENGTH * 2);
    const result = parseAdjudicationResponse(
      JSON.stringify({ verdict: "uncertain", reasoning: long }),
    );
    assert.ok(result.ok);
    assert.ok(result.ok && result.reasoning.length <= MAX_ADJUDICATION_REASONING_LENGTH);
  });

  // ---- prompt builder ----
  await check("プロンプト: 抜粋とカテゴリが載る", () => {
    const excerpts = collectHighRiskMatchExcerpts(READY_RUCKSACK_EVIDENCE);
    assert.ok(excerpts.some((item) => item.category === "personal_data" && item.match === "住所"));
    const prompt = buildHighRiskAdjudicationPrompt({
      categories: ["personal_data"],
      title: READY_RUCKSACK_EVIDENCE.title,
      oneLiner: READY_RUCKSACK_EVIDENCE.oneLiner,
      concept: READY_RUCKSACK_EVIDENCE.concept,
      knownRisks: [],
      excerpts,
    });
    assert.ok(prompt.includes("personal_data"));
    assert.ok(prompt.includes("ReadyRucksack"));
    assert.ok(prompt.includes('matched "住所"'));
  });

  // ---- adjudicateHighRiskEvidence: 判定経路 ----
  await check("benign_mention判定は ok:true で返る", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      title: READY_RUCKSACK_EVIDENCE.title,
      oneLiner: READY_RUCKSACK_EVIDENCE.oneLiner,
      generateText: fakeGenerate('{"verdict":"benign_mention","reasoning":"static mock demo, no real PII"}'),
    });
    assert.ok(result.ok);
    assert.equal(result.ok && result.verdict, "benign_mention");
  });

  await check("actual_risk判定はverdictそのまま返る(呼び出し側でhold)", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate('{"verdict":"actual_risk","reasoning":"collects real PII"}'),
    });
    assert.ok(result.ok);
    assert.equal(result.ok && result.verdict, "actual_risk");
  });

  await check("uncertain判定はverdictそのまま返る(呼び出し側でhold)", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate('{"verdict":"uncertain","reasoning":"cannot decide"}'),
    });
    assert.ok(result.ok);
    assert.equal(result.ok && result.verdict, "uncertain");
  });

  // ---- adjudicateHighRiskEvidence: フォールバック経路(全てthrowしない) ----
  await check("パース不能は ok:false parse_error", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate("sorry, I cannot answer in JSON"),
    });
    assert.deepEqual(result, { ok: false, fallbackReason: "parse_error" });
  });

  await check("タイムアウトは ok:false timeout", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate(timeoutError),
    });
    assert.deepEqual(result, { ok: false, fallbackReason: "timeout" });
  });

  await check("予算cap超過は ok:false budget_exhausted", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate(new Error("Gemini daily cost cap reached: $10.00")),
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.fallbackReason, "budget_exhausted");
  });

  await check("その他の生成エラーは ok:false generation_error", async () => {
    const result = await adjudicateHighRiskEvidence({
      evidence: READY_RUCKSACK_EVIDENCE,
      generateText: fakeGenerate(new Error("Gemini generateContent failed: 500")),
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.fallbackReason, "generation_error");
  });

  await check("regex未ヒットの証跡は ok:false no_categories (LLM未呼び出し)", async () => {
    let called = false;
    const result = await adjudicateHighRiskEvidence({
      evidence: SAFE_EVIDENCE,
      generateText: async () => {
        called = true;
        return '{"verdict":"benign_mention","reasoning":"x"}';
      },
    });
    assert.deepEqual(result, { ok: false, fallbackReason: "no_categories" });
    assert.equal(called, false);
  });

  await check("env無効化(PRODIA_HIGH_RISK_LLM_ADJUDICATION=0)は ok:false disabled (LLM未呼び出し)", async () => {
    const previous = process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION;
    process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION = "0";
    try {
      assert.equal(highRiskAdjudicationEnabled(), false);
      let called = false;
      const result = await adjudicateHighRiskEvidence({
        evidence: READY_RUCKSACK_EVIDENCE,
        generateText: async () => {
          called = true;
          return '{"verdict":"benign_mention","reasoning":"x"}';
        },
      });
      assert.deepEqual(result, { ok: false, fallbackReason: "disabled" });
      assert.equal(called, false);
    } finally {
      if (previous === undefined) delete process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION;
      else process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION = previous;
    }
  });

  await check("env既定は有効", () => {
    const previous = process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION;
    delete process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION;
    try {
      assert.equal(highRiskAdjudicationEnabled(), true);
    } finally {
      if (previous !== undefined) process.env.PRODIA_HIGH_RISK_LLM_ADJUDICATION = previous;
    }
  });

  console.log(`\nAll ${passed} high-risk adjudication checks passed.`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
