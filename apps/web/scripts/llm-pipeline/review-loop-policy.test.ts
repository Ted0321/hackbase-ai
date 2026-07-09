import assert from "node:assert/strict";
import { decideAfterReview, decideAfterRewrite, statusValue } from "./review-loop-policy";

const check = (name: string, fn: () => void) => {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

check("statusValue reads status strings and ignores invalid payloads", () => {
  assert.equal(statusValue({ status: "needs_revision" }), "needs_revision");
  assert.equal(statusValue({ status: 1 }), "");
  assert.equal(statusValue(null), "");
});

check("review pass exits the loop without holding", () => {
  assert.deepEqual(decideAfterReview("pass", 1, 2), {
    action: "finish",
    outcome: {
      result: "pass",
      hold: false,
      reason: "reviewer_pass",
      attempts: 1,
      reviewerStatus: "pass",
      rewriterStatus: null,
    },
  });
});

check("review block holds before rewrite", () => {
  assert.deepEqual(decideAfterReview("block", 0, 2), {
    action: "finish",
    outcome: {
      result: "hold",
      hold: true,
      reason: "reviewer_block",
      attempts: 0,
      reviewerStatus: "block",
      rewriterStatus: null,
    },
  });
});

check("needs_revision rewrites while budget remains", () => {
  assert.deepEqual(decideAfterReview("needs_revision", 1, 2), { action: "rewrite" });
});

check("needs_revision holds after max rewrite budget", () => {
  assert.deepEqual(decideAfterReview("needs_revision", 2, 2), {
    action: "finish",
    outcome: {
      result: "hold",
      hold: true,
      reason: "max_rewrites_exhausted",
      attempts: 2,
      reviewerStatus: "needs_revision",
      rewriterStatus: null,
    },
  });
});

check("rewriter terminal statuses hold", () => {
  assert.equal(decideAfterRewrite("needs_revision", "blocked", 1).action, "finish");
  assert.deepEqual(decideAfterRewrite("needs_revision", "needs_human", 1), {
    action: "finish",
    outcome: {
      result: "hold",
      hold: true,
      reason: "rewriter_needs_human",
      attempts: 1,
      reviewerStatus: "needs_revision",
      rewriterStatus: "needs_human",
    },
  });
});

check("rewriter revised continues to reviewer re-check", () => {
  assert.deepEqual(decideAfterRewrite("needs_revision", "revised", 1), {
    action: "review_again",
  });
});

console.log("review loop policy tests passed");

