/**
 * rate-guard.ts precheckGeminiRunBudget の単体テスト。
 * リポジトリにテストランナーが無いため、assertion で exit する tsx スクリプトとして実装
 * （prompt-eval-metrics.test.ts と同じ流儀）。`npm run llm:rate-guard:test` で実行。
 */
import assert from "node:assert/strict";
import { precheckGeminiRunBudget } from "./rate-guard";

const ENV_KEYS = [
  "GEMINI_DAILY_MAX_REQUESTS",
  "GEMINI_DAILY_MAX_COST_USD",
  "PRODIA_MIN_RUN_BUDGET_HEADROOM_USD",
  "PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const setEnv = (values: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const usage = (requestCount: number, costUsd: number) => async () => ({ requestCount, costUsd });

const main = async () => {
  // 1) コスト残がヘッドルーム未満 → skip（07-13の「$2.09焼いて途中死に」パターン）
  setEnv({
    GEMINI_DAILY_MAX_REQUESTS: "120",
    GEMINI_DAILY_MAX_COST_USD: "10",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_USD: "2",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS: "12",
  });
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(50, 8.5) });
    assert.equal(result.skip, true, "cost headroom $1.5 < $2 must skip");
    assert.match(result.reason ?? "", /cost headroom/);
  }

  // 2) リクエスト残がヘッドルーム未満 → skip
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(110, 3) });
    assert.equal(result.skip, true, "request headroom 10 < 12 must skip");
    assert.match(result.reason ?? "", /request headroom/);
  }

  // 3) 両方に余裕 → skipしない
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(30, 3) });
    assert.equal(result.skip, false, "healthy headroom must not skip");
    assert.equal(result.reason, null);
  }

  // 4) ちょうど境界（残=ヘッドルーム）→ skipしない（< 判定）
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(108, 8) });
    assert.equal(result.skip, false, "remaining exactly at headroom must not skip");
  }

  // 5) fail-open相当（usage read失敗→{0,0}）→ skipしない
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(0, 0) });
    assert.equal(result.skip, false, "fail-open usage {0,0} must not skip");
  }

  // 6) ヘッドルームしきい値 0 → チェック無効（usage readすら呼ばない）
  setEnv({
    GEMINI_DAILY_MAX_REQUESTS: "120",
    GEMINI_DAILY_MAX_COST_USD: "10",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_USD: "0",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS: "0",
  });
  {
    let usageRead = false;
    const result = await precheckGeminiRunBudget({
      readUsage: async () => {
        usageRead = true;
        return { requestCount: 999, costUsd: 999 };
      },
    });
    assert.equal(result.skip, false, "headroom<=0 disables the check");
    assert.equal(usageRead, false, "disabled check must not read usage");
  }

  // 7) 上限自体が無制限（<=0）→ チェック無効
  setEnv({
    GEMINI_DAILY_MAX_REQUESTS: "0",
    GEMINI_DAILY_MAX_COST_USD: "0",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_USD: "2",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS: "12",
  });
  {
    const result = await precheckGeminiRunBudget({ readUsage: usage(999, 999) });
    assert.equal(result.skip, false, "unlimited caps disable the check");
  }

  // 8) 片側だけ有効（コスト上限のみ）→ コスト側だけで判定
  setEnv({
    GEMINI_DAILY_MAX_REQUESTS: "0",
    GEMINI_DAILY_MAX_COST_USD: "10",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_USD: "2",
    PRODIA_MIN_RUN_BUDGET_HEADROOM_REQUESTS: "12",
  });
  {
    const skipResult = await precheckGeminiRunBudget({ readUsage: usage(999, 9) });
    assert.equal(skipResult.skip, true, "cost-only mode must still skip on low cost headroom");
    assert.doesNotMatch(skipResult.reason ?? "", /request headroom/);
    const okResult = await precheckGeminiRunBudget({ readUsage: usage(999, 1) });
    assert.equal(okResult.skip, false, "cost-only mode ignores request count");
  }

  restoreEnv();
  console.log("rate-guard.test: all assertions passed");
};

main().catch((error) => {
  restoreEnv();
  console.error(error);
  process.exit(1);
});
