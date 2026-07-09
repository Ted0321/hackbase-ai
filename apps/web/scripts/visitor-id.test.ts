/**
 * visitor-id.ts（匿名訪問者IDの純粋ロジック）の単体テスト。
 * Run with `npm run eval:visitor-id:test`.
 */
import assert from "node:assert/strict";
import { HUMAN_LIKE_RATINGS, LIKE_RATINGS } from "../src/lib/feedback-counts";
import { VISITOR_ID_PREFIX, isValidVisitorId, mintVisitorId } from "../src/lib/visitor-id";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("mintVisitorId は visitor_<uuid> 形式を生成し検証を通る", () => {
  const id = mintVisitorId("123e4567-e89b-42d3-a456-426614174000");
  assert.equal(id, "visitor_123e4567-e89b-42d3-a456-426614174000");
  assert.ok(id.startsWith(VISITOR_ID_PREFIX));
  assert.equal(isValidVisitorId(id), true);
});

check("crypto.randomUUID ベースの実生成値も検証を通る", () => {
  assert.equal(isValidVisitorId(mintVisitorId(crypto.randomUUID())), true);
});

check("改ざん・旧形式・空の Cookie 値は弾く", () => {
  assert.equal(isValidVisitorId("anonymous"), false);
  assert.equal(isValidVisitorId("visitor_"), false);
  assert.equal(isValidVisitorId("visitor_not-a-uuid"), false);
  assert.equal(isValidVisitorId("visitor_123e4567-e89b-42d3-a456-42661417400Z"), false);
  assert.equal(isValidVisitorId(""), false);
  assert.equal(isValidVisitorId(null), false);
  assert.equal(isValidVisitorId(undefined), false);
});

check("HUMAN_LIKE_RATINGS は人間の2種のみで、いいね集計(LIKE_RATINGS)の部分集合", () => {
  assert.deepEqual([...HUMAN_LIKE_RATINGS], ["like", "want_to_grow"]);
  for (const rating of HUMAN_LIKE_RATINGS) {
    assert.ok(LIKE_RATINGS.includes(rating), `${rating} should be counted as a like`);
  }
  // AI の agent_like は人間トグルの対象外（AI側は別レーンで上限管理される）
  assert.equal(HUMAN_LIKE_RATINGS.includes("agent_like"), false);
});

console.log(`\n${passed} checks passed.`);
