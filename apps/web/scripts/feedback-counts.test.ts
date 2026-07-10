/**
 * feedback-counts.ts のいいね/コメント集計ロジックの単体テスト。
 * Run with `npm run eval:feedback-counts:test`.
 */
import assert from "node:assert/strict";
import {
  countComments,
  countFeedbackByTarget,
  countLikes,
  isComment,
  isLike,
} from "../src/lib/feedback-counts";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const fb = (rating: string, comment: string | null = null) => ({ rating, comment });

check("agent_like はいいねに数えられる", () => {
  assert.equal(isLike(fb("agent_like")), true);
  assert.equal(countLikes([fb("like"), fb("want_to_grow"), fb("agent_like")]), 3);
});

check("agent 系コメント（本文あり）はコメントに数えられる", () => {
  assert.equal(isComment(fb("agent_critique", "いい観点です")), true);
  assert.equal(isComment(fb("agent_remix_suggestion", "改善案: ...")), true);
  assert.equal(
    countComments([
      fb("agent_critique", "講評"),
      fb("agent_remix_suggestion", "改善案"),
      fb("agent_risk_flag", "リスク"),
    ]),
    3,
  );
});

check("人間の rating=comment はコメントに数えられる", () => {
  assert.equal(isComment(fb("comment", "応援しています")), true);
  assert.equal(countComments([fb("comment", "コメント")]), 1);
});

check("本文の無い agent 系 rating はコメントに数えない", () => {
  assert.equal(isComment(fb("agent_critique", null)), false);
  assert.equal(isComment(fb("agent_critique", "   ")), false);
  assert.equal(countComments([fb("agent_critique", null)]), 0);
});

check("本文付きいいねは「いいね1＋コメント1」として両方に数える", () => {
  // 詳細ページのコメント欄は本文がある行を全て表示するため、件数集計もそれに揃える
  // (旧仕様のいいね排他はフィードのコメント数だけが詳細表示より少なくなる原因だった)。
  assert.equal(isComment(fb("agent_like", "素晴らしい")), true);
  const items = [fb("agent_like", "素晴らしい")];
  assert.equal(countLikes(items), 1);
  assert.equal(countComments(items), 1);
});

check("本文の無いいいねはコメントに数えない", () => {
  assert.equal(isComment(fb("agent_like")), false);
  assert.equal(isComment(fb("like")), false);
  assert.equal(countComments([fb("agent_like"), fb("like")]), 0);
});

check("反応ゼロで 0 を返す", () => {
  assert.equal(countLikes([]), 0);
  assert.equal(countComments([]), 0);
});

check("countFeedbackByTarget が targetId ごとに集計する", () => {
  const items = [
    { targetId: "p1", rating: "agent_like", comment: null },
    { targetId: "p1", rating: "like", comment: null },
    { targetId: "p1", rating: "agent_critique", comment: "講評" },
    { targetId: "p2", rating: "comment", comment: "コメント" },
    // 本文付きいいねは likes/comments の両方に計上される。
    { targetId: "p3", rating: "agent_like", comment: "この見せ方が良い" },
  ];
  const byTarget = countFeedbackByTarget(items);
  assert.deepEqual(byTarget.get("p1"), { likes: 2, comments: 1 });
  assert.deepEqual(byTarget.get("p2"), { likes: 0, comments: 1 });
  assert.deepEqual(byTarget.get("p3"), { likes: 1, comments: 1 });
  assert.equal(byTarget.get("p4"), undefined);
});

console.log(`\n${passed} checks passed.`);
