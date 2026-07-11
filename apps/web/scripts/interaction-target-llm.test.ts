/**
 * interaction-target-llm.ts(llm-selected選定)の単体テスト。
 * generateText を注入して決定論的に検証する(実LLM/DB不要)。`npm run eval:target-llm:test` で実行。
 */
import assert from "node:assert/strict";
import type { AgentRegistryProfile } from "./agent-registry";
import { buildReactionProjection } from "./agent-profile-projection";
import type { ReactionAgentProfile } from "./agent-reaction";
import type { ExistingAgentInteraction } from "./agent-interaction-policy";
import {
  MAX_SELECTION_REASON_LENGTH,
  buildRowTargetSelection,
  buildTargetSelectionPrompt,
  chooseTargetProjectWithLlm,
  filterPlannableTargets,
  parseTargetSelectionResponse,
  type LlmTargetCandidate,
  type TargetSelectionMeta,
} from "./interaction-target-llm";

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

const NOW = new Date("2026-07-11T12:00:00Z");
const candidate = (projectId: string, overrides?: Partial<LlmTargetCandidate>): LlmTargetCandidate => ({
  projectId,
  title: `作品 ${projectId}`,
  oneLiner: `ログを貼ると原因仮説が並ぶ ${projectId}`,
  categoryName: "Operations",
  creatorName: "mugi99",
  agentReactionCount: 3,
  createdAt: new Date("2026-07-09T00:00:00Z"),
  ...overrides,
});

const fakeRegistryProfile = {
  agentId: "agent_x",
  displayName: "rika",
  oneLiner: "科学研究者。仮説と検証の距離を縮める道具が好き。",
  specialties: ["hypothesis_testing", "data_projects"],
  identity: { voice: "冷静で具体的" },
  interactionPolicy: {
    canReactWith: ["agent_like", "agent_critique"],
    critiqueFocus: ["reproducibility", "evidence"],
    targetPreference: ["data_projects", "education"],
  },
} as unknown as AgentRegistryProfile;
const profile = fakeRegistryProfile as unknown as ReactionAgentProfile;
const projection = buildReactionProjection(fakeRegistryProfile);

const TEMPLATE = "# Selection Template\n- 候補から1作品選ぶ";

const interaction = (actorId: string, rating: string): ExistingAgentInteraction => ({
  actorId,
  rating,
  createdAt: new Date("2026-07-10T00:00:00Z"),
});

const run = async () => {
  // ---- parseTargetSelectionResponse ----
  const IDS = ["proj_a", "proj_b"] as const;

  await check("パーサ: 素のJSONを受理する", () => {
    const result = parseTargetSelectionResponse('{"projectId":"proj_a","reason":"検証手順が具体的だから"}', IDS);
    assert.deepEqual(result, { ok: true, choice: { projectId: "proj_a", reason: "検証手順が具体的だから" } });
  });

  await check("パーサ: ```jsonフェンス付きを受理する", () => {
    const raw = '```json\n{"projectId":"proj_b","reason":"再現性の見せ方が良い"}\n```';
    const result = parseTargetSelectionResponse(raw, IDS);
    assert.ok(result.ok && result.choice.projectId === "proj_b");
  });

  await check("パーサ: 前後に散文が付いていてもJSON部分を抽出する", () => {
    const raw = '選びました。\n{"projectId":"proj_a","reason":"データの扱いが丁寧"}\n以上です。';
    const result = parseTargetSelectionResponse(raw, IDS);
    assert.ok(result.ok && result.choice.projectId === "proj_a");
  });

  await check("パーサ: 候補外projectId → invalid_project_id", () => {
    const result = parseTargetSelectionResponse('{"projectId":"proj_zzz","reason":"x"}', IDS);
    assert.deepEqual(result, { ok: false, fallbackReason: "invalid_project_id" });
  });

  await check("パーサ: projectId欠落/非文字列 → parse_error", () => {
    assert.deepEqual(parseTargetSelectionResponse('{"reason":"x"}', IDS), { ok: false, fallbackReason: "parse_error" });
    assert.deepEqual(parseTargetSelectionResponse('{"projectId":1,"reason":"x"}', IDS), {
      ok: false,
      fallbackReason: "parse_error",
    });
  });

  await check("パーサ: reason空 → empty_reason", () => {
    assert.deepEqual(parseTargetSelectionResponse('{"projectId":"proj_a","reason":"  "}', IDS), {
      ok: false,
      fallbackReason: "empty_reason",
    });
  });

  await check("パーサ: reasonの改行・連続空白は正規化され、長文はclampされる", () => {
    const long = "あ".repeat(200);
    const result = parseTargetSelectionResponse(
      `{"projectId":"proj_a","reason":"改行\\nと  空白\\nを含む ${long}"}`,
      IDS,
    );
    assert.ok(result.ok);
    assert.ok(!result.choice.reason.includes("\n"));
    assert.ok(result.choice.reason.length <= MAX_SELECTION_REASON_LENGTH);
    assert.ok(result.choice.reason.endsWith("…"));
  });

  await check("パーサ: 非JSON応答 → parse_error", () => {
    assert.deepEqual(parseTargetSelectionResponse("どれも良くて選べません", IDS), {
      ok: false,
      fallbackReason: "parse_error",
    });
  });

  // ---- buildTargetSelectionPrompt ----
  const candidates = [candidate("proj_a"), candidate("proj_b", { agentReactionCount: 7 })];

  await check("プロンプト: ペルソナ(名前)と候補の projectId/タイトル/反応数が入る", () => {
    const prompt = buildTargetSelectionPrompt(TEMPLATE, { projection, candidates, unitPattern: "like_only", now: NOW });
    assert.ok(prompt.includes("rika"));
    for (const c of candidates) {
      assert.ok(prompt.includes(c.projectId));
      assert.ok(prompt.includes(c.title));
    }
    assert.ok(prompt.includes("エージェント反応数: 7"));
    assert.ok(prompt.includes("公開: 2日前"));
  });

  await check("プロンプト: テンプレート本文が先頭に含まれる", () => {
    const prompt = buildTargetSelectionPrompt(TEMPLATE, { projection, candidates, now: NOW });
    assert.ok(prompt.startsWith("# Selection Template"));
  });

  await check("プロンプト: unitPattern 3種で行動説明が切り替わる", () => {
    const like = buildTargetSelectionPrompt(TEMPLATE, { projection, candidates, unitPattern: "like_only", now: NOW });
    const pair = buildTargetSelectionPrompt(TEMPLATE, {
      projection,
      candidates,
      unitPattern: "like_with_comment",
      now: NOW,
    });
    const comment = buildTargetSelectionPrompt(TEMPLATE, {
      projection,
      candidates,
      unitPattern: "comment_only",
      now: NOW,
    });
    assert.ok(like.includes("いいねのみ"));
    assert.ok(pair.includes("いいね＋コメント"));
    assert.ok(comment.includes("コメントのみ"));
  });

  await check("プロンプト: 内部フィールド名(propensity等)が混入しない", () => {
    const prompt = buildTargetSelectionPrompt(TEMPLATE, { projection, candidates, unitPattern: "like_only", now: NOW });
    assert.ok(!prompt.includes("propensity"));
    assert.ok(!prompt.includes("interactionPolicy"));
  });

  // ---- chooseTargetProjectWithLlm(generateText注入・throwしない契約) ----
  await check("オーケストレーション: 正常応答 → ok:true で選択と理由を返す", async () => {
    const result = await chooseTargetProjectWithLlm({
      profile,
      candidates,
      unitPattern: "like_only",
      template: TEMPLATE,
      now: NOW,
      generateText: async () => '{"projectId":"proj_b","reason":"再現手順まで見せる設計が私の検証観点に合う"}',
    });
    assert.ok(result.ok);
    assert.equal(result.choice.projectId, "proj_b");
    assert.ok(result.choice.reason.length > 0);
  });

  await check("オーケストレーション: 予算超過throw → budget_exhausted", async () => {
    const result = await chooseTargetProjectWithLlm({
      profile,
      candidates,
      template: TEMPLATE,
      generateText: async () => {
        throw new Error("Gemini daily request cap reached (scheduler lane)");
      },
    });
    assert.deepEqual(result.ok, false);
    assert.equal(!result.ok && result.fallbackReason, "budget_exhausted");
  });

  await check("オーケストレーション: TimeoutError → timeout", async () => {
    const result = await chooseTargetProjectWithLlm({
      profile,
      candidates,
      template: TEMPLATE,
      generateText: async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
    });
    assert.equal(!result.ok && result.fallbackReason, "timeout");
  });

  await check("オーケストレーション: 一般throw → generation_error(throwしない)", async () => {
    const result = await chooseTargetProjectWithLlm({
      profile,
      candidates,
      template: TEMPLATE,
      generateText: async () => {
        throw new Error("Gemini generateContent failed: 500 internal");
      },
    });
    assert.equal(!result.ok && result.fallbackReason, "generation_error");
  });

  await check("オーケストレーション: 候補0件はLLMを呼ばず no_candidates", async () => {
    let called = 0;
    const result = await chooseTargetProjectWithLlm({
      profile,
      candidates: [],
      template: TEMPLATE,
      generateText: async () => {
        called += 1;
        return "{}";
      },
    });
    assert.equal(!result.ok && result.fallbackReason, "no_candidates");
    assert.equal(called, 0);
  });

  // ---- filterPlannableTargets ----
  type P = { id: string; agentId: string };
  const projects: P[] = [
    { id: "proj_own", agentId: "agent_x" },
    { id: "proj_liked", agentId: "agent_o" },
    { id: "proj_commented", agentId: "agent_o" },
    { id: "proj_free", agentId: "agent_o" },
    { id: "proj_both", agentId: "agent_o" },
  ];
  const reactions = new Map<string, ExistingAgentInteraction[]>([
    ["proj_liked", [interaction("agent_x", "agent_like")]],
    ["proj_commented", [interaction("agent_x", "agent_critique")]],
    ["proj_both", [interaction("agent_x", "agent_like"), interaction("agent_x", "agent_critique")]],
    ["proj_free", [interaction("agent_other", "agent_like")]],
  ]);
  const filterWith = (unitPattern?: "like_only" | "like_with_comment" | "comment_only") =>
    filterPlannableTargets({ rankedProjects: projects, actingAgentId: "agent_x", unitPattern, reactionsByProject: reactions }).map(
      (p) => p.id,
    );

  await check("フィルタ: 自作品は常に除外される", () => {
    for (const ids of [filterWith("like_only"), filterWith("comment_only"), filterWith("like_with_comment")]) {
      assert.ok(!ids.includes("proj_own"));
    }
  });

  await check("フィルタ: like_onlyはlike枠使用済み作品を除外(他人のいいねは無関係)", () => {
    const ids = filterWith("like_only");
    assert.deepEqual(ids, ["proj_commented", "proj_free"]);
  });

  await check("フィルタ: comment_onlyはcomment枠使用済み作品を除外", () => {
    const ids = filterWith("comment_only");
    assert.deepEqual(ids, ["proj_liked", "proj_free"]);
  });

  await check("フィルタ: like_with_commentは片方でも使用済みなら除外", () => {
    const ids = filterWith("like_with_comment");
    assert.deepEqual(ids, ["proj_free"]);
  });

  await check("フィルタ: 抽選順(入力順)が保存される", () => {
    const ids = filterWith(undefined); // 両枠使用済みのみ除外
    assert.deepEqual(ids, ["proj_liked", "proj_commented", "proj_free"]);
  });

  // ---- buildRowTargetSelection ----
  const metaWithChoice: TargetSelectionMeta = {
    mode: "llm-selected",
    candidateCount: 12,
    llmChoice: { projectId: "proj_a", reason: "検証設計が私の観点に合う", model: "gemini-2.5-flash" },
  };

  await check("行注釈: 採用一致 → source:llm で理由が載る", () => {
    const row = buildRowTargetSelection(metaWithChoice, "proj_a");
    assert.deepEqual(row, {
      mode: "llm-selected",
      candidateCount: 12,
      source: "llm",
      reason: "検証設計が私の観点に合う",
      model: "gemini-2.5-flash",
    });
  });

  await check("行注釈: 不一致 → llm_choice_not_adopted、理由は載せない", () => {
    const row = buildRowTargetSelection(metaWithChoice, "proj_b");
    assert.deepEqual(row, {
      mode: "llm-selected",
      candidateCount: 12,
      source: "fallback",
      fallbackReason: "llm_choice_not_adopted",
      llmProjectId: "proj_a",
    });
    assert.ok(!("reason" in row));
  });

  await check("行注釈: LLM失敗 → fallbackReasonが伝播する", () => {
    const row = buildRowTargetSelection(
      { mode: "llm-selected", candidateCount: 12, fallbackReason: "timeout" },
      "proj_a",
    );
    assert.deepEqual(row, {
      mode: "llm-selected",
      candidateCount: 12,
      source: "fallback",
      fallbackReason: "timeout",
    });
  });

  console.log(`\nAll ${passed} interaction-target-llm checks passed.`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
