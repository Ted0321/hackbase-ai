export type ReviewLoopReason =
  | "reviewer_pass"
  | "reviewer_block"
  | "rewriter_blocked"
  | "rewriter_needs_human"
  | "max_rewrites_exhausted"
  | "dry_run";

export type ReviewLoopOutcome = {
  result: "pass" | "hold" | "dry_run_prepared";
  hold: boolean;
  reason: ReviewLoopReason;
  attempts: number;
  reviewerStatus: string | null;
  rewriterStatus: string | null;
};

export type ReviewLoopDecision =
  | { action: "finish"; outcome: ReviewLoopOutcome }
  | { action: "rewrite" }
  | { action: "review_again" };

export const statusValue = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== "object") return "";
  const status = (parsed as Record<string, unknown>).status;
  return typeof status === "string" ? status : "";
};

export const decideAfterReview = (
  reviewerStatus: string,
  attempts: number,
  maxRewrites: number,
): ReviewLoopDecision => {
  if (reviewerStatus === "block") {
    return {
      action: "finish",
      outcome: {
        result: "hold",
        hold: true,
        reason: "reviewer_block",
        attempts,
        reviewerStatus,
        rewriterStatus: null,
      },
    };
  }
  if (reviewerStatus === "pass") {
    return {
      action: "finish",
      outcome: {
        result: "pass",
        hold: false,
        reason: "reviewer_pass",
        attempts,
        reviewerStatus,
        rewriterStatus: null,
      },
    };
  }
  if (attempts >= maxRewrites) {
    return {
      action: "finish",
      outcome: {
        result: "hold",
        hold: true,
        reason: "max_rewrites_exhausted",
        attempts,
        reviewerStatus,
        rewriterStatus: null,
      },
    };
  }
  return { action: "rewrite" };
};

export const decideAfterRewrite = (
  reviewerStatus: string,
  rewriterStatus: string,
  attempts: number,
): ReviewLoopDecision => {
  if (rewriterStatus === "blocked") {
    return {
      action: "finish",
      outcome: {
        result: "hold",
        hold: true,
        reason: "rewriter_blocked",
        attempts,
        reviewerStatus,
        rewriterStatus,
      },
    };
  }
  if (rewriterStatus === "needs_human") {
    return {
      action: "finish",
      outcome: {
        result: "hold",
        hold: true,
        reason: "rewriter_needs_human",
        attempts,
        reviewerStatus,
        rewriterStatus,
      },
    };
  }
  return { action: "review_again" };
};

