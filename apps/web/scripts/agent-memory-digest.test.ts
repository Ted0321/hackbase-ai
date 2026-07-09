/**
 * Unit checks for AgentMemoryDigest row aggregation.
 *
 * Run:
 *   npx tsx scripts/agent-memory-digest.test.ts
 */
import assert from "node:assert/strict";
import { buildAgentMemoryDigestFromRows } from "./agent-memory-digest";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("digest summarizes projects, feedback, validations, artifacts, and events", () => {
  const digest = buildAgentMemoryDigestFromRows(
    "agent_a",
    {
      projects: [
        {
          id: "project-1",
          runId: "run-1",
          title: "Decision Board",
          oneLiner: "Inspect a tradeoff before acting.",
          status: "published",
          validationStatus: "pass",
          artifactRoot: "artifacts/project-1",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      receivedFeedback: [
        {
          id: "feedback-1",
          targetType: "project",
          targetId: "project-1",
          rating: "like",
          comment: "The risk boundary is useful.",
          actorType: "human",
          actorId: "u1",
          createdAt: "2026-07-01T01:00:00.000Z",
        },
        {
          id: "feedback-2",
          targetType: "project",
          targetId: "project-1",
          rating: "critique",
          comment: "Needs a clearer before state.",
          actorType: "agent",
          actorId: "reviewer_v1",
          createdAt: "2026-07-01T02:00:00.000Z",
        },
      ],
      emittedFeedback: [
        {
          id: "reaction-1",
          targetType: "project",
          targetId: "project-2",
          rating: "agent_critique",
          comment: "Missing failure state.",
          actorType: "agent",
          actorId: "agent_a",
          createdAt: "2026-07-01T03:00:00.000Z",
        },
      ],
      validations: [
        {
          id: "validation-1",
          projectId: "project-1",
          runId: "run-1",
          status: "pass",
          summary: "OK",
          errorMessage: null,
          createdAt: "2026-07-01T04:00:00.000Z",
        },
        {
          id: "validation-2",
          projectId: "project-1",
          runId: "run-1",
          status: "fail",
          summary: "Primary action missing",
          errorMessage: null,
          createdAt: "2026-07-01T05:00:00.000Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          projectId: "project-1",
          runId: "run-1",
          type: "board",
          path: "source/app/page.tsx",
          createdAt: "2026-07-01T06:00:00.000Z",
        },
        {
          id: "artifact-2",
          projectId: "project-1",
          runId: "run-1",
          type: "board",
          path: "source/components/ProductWorkspace.tsx",
          createdAt: "2026-07-01T07:00:00.000Z",
        },
      ],
      runEvents: [
        {
          id: "event-1",
          runId: "run-1",
          projectId: "project-1",
          type: "tool_error",
          actorType: "system",
          summary: "Tool render failed",
          metadataJson: null,
          createdAt: "2026-07-01T08:00:00.000Z",
        },
      ],
    },
    { now: "2026-07-02T00:00:00.000Z" },
  );

  assert.equal(digest.agentId, "agent_a");
  assert.deepEqual(digest.episodicMemory.recentRunIds, ["run-1"]);
  assert.deepEqual(digest.episodicMemory.recentProjectIds, ["project-1"]);
  assert.deepEqual(digest.episodicMemory.recentReactionIds, ["reaction-1"]);
  assert.ok(digest.artifactMemory.successfulPatterns[0].includes("Decision Board"));
  assert.deepEqual(digest.artifactMemory.commonArtifactShapes, ["board"]);
  assert.equal(digest.artifactMemory.validationPassRate, 0.5);
  assert.ok(digest.feedbackMemory.praise[0].includes("risk boundary"));
  assert.ok(digest.feedbackMemory.critique[0].includes("before state"));
  assert.ok(digest.errorMemory.repeatedFailures.includes("Primary action missing"));
  assert.ok(digest.errorMemory.toolErrors.includes("Tool render failed"));
  assert.ok(digest.currentGuidance.length > 0);
});

check("japanese human comment is classified as critique and drives guidance", () => {
  // Regression: rating="comment" with Japanese free text matched no English keyword, so the
  // human's feedback used to be dropped from critique and currentGuidance entirely.
  const digest = buildAgentMemoryDigestFromRows(
    "agent_jp",
    {
      projects: [
        {
          id: "project-jp",
          runId: "run-jp",
          title: "見積もりダッシュボード",
          oneLiner: "コストを一目で確認する。",
          status: "published",
          validationStatus: "pass",
          artifactRoot: "artifacts/project-jp",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      receivedFeedback: [
        {
          id: "fb-jp-1",
          targetType: "project",
          targetId: "project-jp",
          rating: "comment",
          comment: "最初の画面で何をするか分かりにくいので、操作の起点を明確にしてほしい。",
          actorType: "human",
          actorId: "human-1",
          createdAt: "2026-07-01T01:00:00.000Z",
        },
        {
          id: "fb-jp-2",
          targetType: "project",
          targetId: "project-jp",
          rating: "like",
          comment: null,
          actorType: "human",
          actorId: "human-2",
          createdAt: "2026-07-01T02:00:00.000Z",
        },
      ],
    },
    { now: "2026-07-02T00:00:00.000Z" },
  );

  assert.ok(
    digest.feedbackMemory.critique.some((item) => item.includes("操作の起点")),
    "japanese human comment should be captured as critique",
  );
  assert.ok(
    digest.currentGuidance.some((item) => item.includes("操作の起点")),
    "current guidance should surface the japanese critique",
  );
});

check("retrieval flags suppress failures and positive signals; guidance cap honored", () => {
  const digest = buildAgentMemoryDigestFromRows(
    "agent_flags",
    {
      receivedFeedback: [
        {
          id: "fb-like",
          targetType: "project",
          targetId: "pr1",
          rating: "like",
          comment: "good work",
          actorType: "human",
          actorId: "h1",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "fb-crit",
          targetType: "project",
          targetId: "pr1",
          rating: "agent_critique",
          comment: "tighten the first screen",
          actorType: "agent",
          actorId: "a1",
          createdAt: "2026-07-01T01:00:00.000Z",
        },
      ],
      validations: [
        {
          id: "v-fail",
          projectId: "pr1",
          runId: "r1",
          status: "fail",
          summary: "primary action missing",
          errorMessage: null,
          createdAt: "2026-07-01T02:00:00.000Z",
        },
      ],
    },
    { now: "2026-07-02T00:00:00.000Z", includeFailures: false, includePositiveSignals: false, maxGuidanceItems: 1 },
  );

  assert.deepEqual(digest.feedbackMemory.praise, [], "positive signals suppressed by includePositiveSignals:false");
  assert.deepEqual(digest.errorMemory.repeatedFailures, [], "failures suppressed by includeFailures:false");
  assert.ok(digest.currentGuidance.length <= 1, "guidance capped by maxGuidanceItems");
  assert.ok(digest.feedbackMemory.critique.some((c) => c.includes("first screen")), "critique kept");
});

check("empty rows still produce a valid digest", () => {
  const digest = buildAgentMemoryDigestFromRows("agent_x", {}, { now: "2026-07-02T00:00:00.000Z" });

  assert.equal(digest.agentId, "agent_x");
  assert.deepEqual(digest.episodicMemory.recentRunIds, []);
  assert.deepEqual(digest.feedbackMemory.praise, []);
  assert.deepEqual(digest.currentGuidance, []);
});

console.log(`\nAll ${passed} AgentMemoryDigest checks passed.`);
