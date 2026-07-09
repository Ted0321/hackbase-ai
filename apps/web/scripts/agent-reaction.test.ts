/**
 * Local tests for agent-reaction.ts.
 *
 * Run:
 *   npx tsx scripts/agent-reaction.test.ts
 */
import assert from "node:assert/strict";
import { defaultComment } from "./agent-interaction-policy";
import { readAgentRegistry } from "./agent-registry";
import {
  buildAgentReactionPrompt,
  formatReactionProjectionForPrompt,
  validateGeneratedReactionComment,
} from "./agent-reaction";
import { buildReactionProjection } from "./agent-profile-projection";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const project = {
  title: "\u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9",
  oneLiner: "\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc\u3092\u52d5\u304b\u3059\u3068\u9806\u4f4d\u304c\u5165\u308c\u66ff\u308f\u308b",
};

async function main() {
  const registry = await readAgentRegistry();
  const agent = registry.agents.find((entry) => entry.agentId === "agent_a");
  if (!agent) throw new Error("agent_a not found");

  const projection = buildReactionProjection(agent);

  check("formatReactionProjectionForPrompt includes reaction-specific guidance", () => {
    const text = formatReactionProjectionForPrompt(projection);
    assert.ok(text.includes("\u91cd\u8996\u3059\u308b\u89b3\u70b9"));
    assert.ok(text.includes("\u53ef\u80fd\u306a\u53cd\u5fdc\u30bf\u30a4\u30d7"));
    assert.ok(text.includes("\u30b3\u30e1\u30f3\u30c8\u5883\u754c"));
    assert.equal(text.includes("propensity"), false);
    assert.equal(text.includes("schedulingPolicy"), false);
    assert.equal(text.includes("qualityStats"), false);
  });

  check("buildAgentReactionPrompt uses ReactionProjection and project context", () => {
    const prompt = buildAgentReactionPrompt(
      "# Agent Reaction Prompt\nUse the ReactionProjection as natural-language guidance.",
      { ...agent, reactionProjection: projection },
      {
        title: "Signal Triage Board",
        oneLiner: "Sort incident signals by risk and next action.",
        concept: "An operations decision board for teams.",
        categoryName: "Operations",
        agentName: "mugi99",
      },
      "agent_critique",
    );

    assert.ok(prompt.includes("ReactionProjection"));
    assert.ok(prompt.includes("Signal Triage Board"));
    assert.ok(prompt.includes("agent_critique"));
    assert.ok(prompt.includes("operational clarity"));
  });

  check("validateGeneratedReactionComment accepts warm project-specific praise", () => {
    const quality = validateGeneratedReactionComment(
      "\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc\u3092\u52d5\u304b\u3059\u3068\u9806\u4f4d\u304c\u5909\u308f\u308b\u70b9\u304c\u3044\u3044\u3067\u3059\u306d\u3002\u5224\u65ad\u306e\u7406\u7531\u307e\u3067\u898b\u3048\u308b\u306e\u3067\u3001\u521d\u898b\u3067\u3082\u89e6\u3063\u3066\u307f\u305f\u304f\u306a\u308a\u307e\u3059\u3002",
      "agent_like",
      project,
    );

    assert.equal(quality.ok, true);
  });

  check("validateGeneratedReactionComment accepts concrete improvement feedback", () => {
    const quality = validateGeneratedReactionComment(
      "\u6700\u521d\u306b\u3069\u3053\u3092\u89e6\u308b\u304b\u3067\u5c11\u3057\u8ff7\u3044\u307e\u3057\u305f\u3002\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc\u306e\u5165\u529b\u4f8b\u30921\u3064\u7f6e\u304f\u3068\u3001\u4fa1\u5024\u304c\u3059\u3050\u4f1d\u308f\u308a\u305d\u3046\u3067\u3059\u3002",
      "agent_critique",
      project,
    );

    assert.equal(quality.ok, true);
  });

  check("validateGeneratedReactionComment rejects comments that open with the project title", () => {
    const quality = validateGeneratedReactionComment(
      "\u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9\u306f\u6700\u521d\u306b\u3069\u3053\u3092\u89e6\u308b\u304b\u304c\u5c11\u3057\u8ff7\u3044\u305d\u3046\u3067\u3059\u3002\u5165\u529b\u4f8b\u30921\u3064\u7f6e\u304f\u3068\u3001\u4fa1\u5024\u304c\u3059\u3050\u4f1d\u308f\u308a\u307e\u3059\u3002",
      "agent_critique",
      project,
    );

    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "title_opening");
  });

  check("validateGeneratedReactionComment rejects bracketed title openings (template-style)", () => {
    const quality = validateGeneratedReactionComment(
      "\u300c\u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9\u300d\u306f\u3001\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc\u3092\u52d5\u304b\u3059...\u3068\u3044\u3046\u5165\u53e3\u304c\u3042\u308a\u3001\u826f\u3055\u304c\u3059\u3050\u4f1d\u308f\u308a\u307e\u3059\u3002",
      "agent_like",
      project,
    );

    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "title_opening");
  });

  check("validateGeneratedReactionComment accepts natural comparison phrasing (widened cues)", () => {
    const quality = validateGeneratedReactionComment(
      "\u9806\u4f4d\u304c\u52d5\u304f\u7406\u7531\u307e\u3067\u898b\u305b\u308b\u4f5c\u308a\u306f\u3001\u7d50\u679c\u3060\u3051\u4e26\u3079\u308b\u4ed6\u306e\u30b9\u30b3\u30a2\u7cfb\u3068\u9055\u3063\u3066\u7d0d\u5f97\u611f\u304c\u3042\u308a\u307e\u3059\u306d\u3002\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc\u306e\u4f4d\u7f6e\u3065\u3051\u3082\u660e\u5feb\u3067\u3059\u3002",
      "agent_compare_note",
      project,
    );

    assert.equal(quality.ok, true);
  });

  check("validateGeneratedReactionComment preserves a leading quoted phrase (no bracket stripping)", () => {
    const quality = validateGeneratedReactionComment(
      "「重みスライダー」を触った瞬間に順位が動くのが気持ちいいですね。判断の理由まで見えるので触ってみたくなります。",
      "agent_like",
      project,
    );

    assert.equal(quality.ok, true);
    assert.ok(quality.comment?.startsWith("「重みスライダー」"));
  });

  check("validateGeneratedReactionComment strips quotes only when they wrap the whole comment", () => {
    const quality = validateGeneratedReactionComment(
      "「重みスライダーを動かすと順位が入れ替わるのが気持ちよくて、つい何度も触ってしまいました。」",
      "agent_like",
      project,
    );

    assert.equal(quality.ok, true);
    assert.equal(quality.comment?.includes("「"), false);
  });

  check("validateGeneratedReactionComment rejects generic praise", () => {
    const quality = validateGeneratedReactionComment("\u9762\u767d\u3044\u3067\u3059\u306d\u3002", "agent_like", project);

    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "too_short");
  });

  check("validateGeneratedReactionComment rejects unsafe internal field names", () => {
    const quality = validateGeneratedReactionComment(
      "\u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9 is useful, but it should not expose creationPolicy directly in the UI.",
      "agent_critique",
      project,
    );

    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "unsafe_reference");
  });

  check("validateGeneratedReactionComment rejects old log-like fallback text", () => {
    const quality = validateGeneratedReactionComment(
      "Triage marked \u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9 as useful, with the next improvement point kept explicit for the creator.",
      "agent_like",
      project,
    );

    assert.equal(quality.ok, false);
    assert.equal(quality.reason, "log_like_fallback");
  });

  check("defaultComment returns Japanese public-facing fallback with project context", () => {
    const comment = defaultComment(
      "agent_like",
      "Triage",
      project.title,
      project.oneLiner,
    );

    assert.ok(comment.includes("\u5929\u79e4\u30b9\u30b3\u30a2\u30dc\u30fc\u30c9"));
    assert.ok(comment.includes("\u91cd\u307f\u30b9\u30e9\u30a4\u30c0\u30fc"));
    assert.equal(/marked|recommends|flagged|suggests|notes how/i.test(comment), false);
  });

  console.log(`\nAll ${passed} agent-reaction checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
