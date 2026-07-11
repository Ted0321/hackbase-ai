/**
 * Lane3 反応対象の「LLMによる理由付き選定」(llm-selected、2026-07-11導入)。
 *
 * engagement-weighted(interaction-target-ranking.ts)の抽選順上位からplannableな候補を
 * 絞り、acting agentのペルソナLLMに候補リストを読ませて {projectId, reason} を選ばせる。
 * 選定理由は RunEvent.metadataJson の targetSelection キーに記録し、
 * 「なぜこの作品が選ばれるか」の分析データにする(v1はデータ記録のみ・UI表示なし)。
 *
 * 安全契約(最重要): chooseTargetProjectWithLlm は絶対に throw しない。
 * 予算超過(enforceGeminiBudgetのthrow)・タイムアウト・APIキー未設定・パース不能・
 * 候補外IDなど全ての異常は ok:false に畳み、呼び出し側は engagement-weighted の
 * 抽選順を無加工で使う(=失敗時の挙動は従来と完全同一。ユニット実行は失敗させない)。
 *
 * 有効化は env PRODIA_TARGET_SELECTION=llm-selected(スケジューラ経由)。既定は
 * engagement-weighted のままなので、デプロイだけでは挙動は一切変わらない。
 * 候補数=PRODIA_LLM_SELECT_CANDIDATES(既定12)、タイムアウト=PRODIA_LLM_SELECT_TIMEOUT_MS(既定20000)。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatReactionProjectionForPrompt, type ReactionAgentProfile } from "./agent-reaction";
import { buildReactionProjection, type ReactionProjection } from "./agent-profile-projection";
import type { AgentRegistryProfile } from "./agent-registry";
import { usedReactionGroups, type ExistingAgentInteraction } from "./agent-interaction-policy";
import type { UnitPattern } from "./interaction-slot-planner";
import { generateGeminiText } from "./gemini-text";

export type LlmTargetCandidate = {
  projectId: string;
  title: string;
  oneLiner: string;
  categoryName?: string | null;
  creatorName?: string | null;
  agentReactionCount: number;
  createdAt: Date;
};

export type LlmSelectFallbackReason =
  | "no_acting_agent"
  | "no_candidates"
  | "budget_exhausted"
  | "timeout"
  | "generation_error"
  | "parse_error"
  | "invalid_project_id"
  | "empty_reason";

export type LlmTargetSelectionResult =
  | { ok: true; choice: { projectId: string; reason: string }; model: string }
  | { ok: false; fallbackReason: LlmSelectFallbackReason; detail?: string };

/** selectTargetProjects が返す選定メタ(バッチ全体で1つ)。 */
export type TargetSelectionMeta = {
  mode: "llm-selected";
  candidateCount: number;
  llmChoice?: { projectId: string; reason: string; model: string };
  fallbackReason?: LlmSelectFallbackReason;
};

/** RunEvent.metadataJson に載せる行単位の注釈。理由はLLM選択と採用作品が一致した行にだけ載せる。 */
export type RowTargetSelection =
  | {
      mode: "llm-selected";
      candidateCount: number;
      source: "llm";
      reason: string;
      model: string;
    }
  | {
      mode: "llm-selected";
      candidateCount: number;
      source: "fallback";
      fallbackReason: LlmSelectFallbackReason | "llm_choice_not_adopted";
      llmProjectId?: string;
    };

export const DEFAULT_LLM_SELECT_CANDIDATES = 12;
export const DEFAULT_LLM_SELECT_TIMEOUT_MS = 20_000;
export const MAX_SELECTION_REASON_LENGTH = 120;

export const llmSelectCandidateLimit = (): number => {
  const raw = Number.parseInt(process.env.PRODIA_LLM_SELECT_CANDIDATES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_SELECT_CANDIDATES;
};

export const llmSelectTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.PRODIA_LLM_SELECT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_SELECT_TIMEOUT_MS;
};

/**
 * 抽選順を保ったまま、このユニットで実際に反応できる作品だけ残す。
 * 自作品と、大前提ハードルール(同一agent×作品=いいね1回＋コメント系1回)で必要枠が
 * 使用済みの作品を除外する。無フィルタだと人気作ほど反応済み率が高く
 * 「LLMが選ぶ→planner不採用」が頻発して理由データが貯まらないための前処理。純関数。
 */
export const filterPlannableTargets = <T extends { id: string; agentId: string }>(args: {
  rankedProjects: T[];
  actingAgentId: string;
  unitPattern?: UnitPattern;
  reactionsByProject: Map<string, ExistingAgentInteraction[]>;
}): T[] =>
  args.rankedProjects.filter((project) => {
    if (project.agentId === args.actingAgentId) return false;
    const used = usedReactionGroups(
      args.reactionsByProject.get(project.id) ?? [],
      args.actingAgentId,
    );
    if (args.unitPattern === "like_only") return !used.has("like");
    if (args.unitPattern === "comment_only") return !used.has("comment");
    if (args.unitPattern === "like_with_comment") return used.size === 0;
    return used.size < 2;
  });

const unitPlanGuideJP: Record<UnitPattern, string> = {
  like_only: "これから行う反応: いいねのみ。素直に「良い」と感じて推したい作品を選ぶ。",
  like_with_comment:
    "これから行う反応: いいね＋コメント。称賛でき、かつ具体的に語れる作品を選ぶ。",
  comment_only:
    "これから行う反応: コメントのみ。具体的なフィードバックを一言書けそうな作品を選ぶ。",
};

const ageLabelJP = (createdAt: Date, now: Date): string => {
  const days = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
  return days === 0 ? "今日" : `${days}日前`;
};

export const buildTargetSelectionPrompt = (
  template: string,
  args: {
    projection: ReactionProjection;
    candidates: LlmTargetCandidate[];
    unitPattern?: UnitPattern;
    now?: Date;
  },
): string => {
  const now = args.now ?? new Date();
  const candidateBlocks = args.candidates.map((candidate, index) =>
    [
      `${index + 1}. projectId: ${candidate.projectId}`,
      `   - タイトル: ${candidate.title}`,
      `   - 紹介: ${candidate.oneLiner}`,
      `   - カテゴリー: ${candidate.categoryName ?? "不明"} / 作者: ${candidate.creatorName ?? "不明"}`,
      `   - エージェント反応数: ${candidate.agentReactionCount} / 公開: ${ageLabelJP(candidate.createdAt, now)}`,
    ].join("\n"),
  );
  return [
    template.trim(),
    "",
    "## Acting Agent / ReactionProjection",
    formatReactionProjectionForPrompt(args.projection),
    "",
    "## Planned Reaction",
    args.unitPattern
      ? unitPlanGuideJP[args.unitPattern]
      : "これから行う反応: いいねまたはコメント。いま最も反応したい作品を選ぶ。",
    "",
    "## Candidates",
    candidateBlocks.join("\n"),
    "",
    "## Output",
    "Return the JSON object now.",
  ].join("\n");
};

export const parseTargetSelectionResponse = (
  raw: string,
  candidateIds: readonly string[],
):
  | { ok: true; choice: { projectId: string; reason: string } }
  | { ok: false; fallbackReason: "parse_error" | "invalid_project_id" | "empty_reason" } => {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, fallbackReason: "parse_error" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return { ok: false, fallbackReason: "parse_error" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, fallbackReason: "parse_error" };
  }

  const projectId = (parsed as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    return { ok: false, fallbackReason: "parse_error" };
  }
  if (!candidateIds.includes(projectId)) {
    return { ok: false, fallbackReason: "invalid_project_id" };
  }

  const reasonRaw = (parsed as { reason?: unknown }).reason;
  const normalized = typeof reasonRaw === "string" ? reasonRaw.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return { ok: false, fallbackReason: "empty_reason" };
  const reason =
    normalized.length > MAX_SELECTION_REASON_LENGTH
      ? `${normalized.slice(0, MAX_SELECTION_REASON_LENGTH - 1)}…`
      : normalized;

  return { ok: true, choice: { projectId, reason } };
};

let cachedTemplate: string | null = null;

const loadSelectionPromptTemplate = async (): Promise<string> => {
  if (cachedTemplate !== null) return cachedTemplate;
  cachedTemplate = await readFile(
    path.join(process.cwd(), "scripts", "prompts", "agent-target-selection.md"),
    "utf8",
  );
  return cachedTemplate;
};

/**
 * ペルソナLLMに候補から1作品を理由付きで選ばせる。絶対に throw しない(冒頭のdocコメント参照)。
 * generateText 注入でテストを決定論化できる。既定は generateGeminiText
 * (operation="target-selection" でModelUsageLog上コメント生成と分離集計、timeoutMsでfetch中断)。
 */
export const chooseTargetProjectWithLlm = async (args: {
  profile: ReactionAgentProfile;
  candidates: LlmTargetCandidate[];
  unitPattern?: UnitPattern;
  timeoutMs?: number;
  now?: Date;
  template?: string;
  generateText?: (
    prompt: string,
    options: { temperature: number; timeoutMs: number; operation: string },
  ) => Promise<string>;
}): Promise<LlmTargetSelectionResult> => {
  try {
    if (args.candidates.length === 0) {
      return { ok: false, fallbackReason: "no_candidates" };
    }
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const timeoutMs = args.timeoutMs ?? llmSelectTimeoutMs();
    const projection =
      args.profile.reactionProjection ??
      buildReactionProjection(args.profile as unknown as AgentRegistryProfile);
    const template = args.template ?? (await loadSelectionPromptTemplate());
    const prompt = buildTargetSelectionPrompt(template, {
      projection,
      candidates: args.candidates,
      unitPattern: args.unitPattern,
      now: args.now,
    });
    const generateText =
      args.generateText ??
      ((text: string, options: { temperature: number; timeoutMs: number; operation: string }) =>
        generateGeminiText(text, options));
    const raw = await generateText(prompt, {
      temperature: 0.7,
      timeoutMs,
      operation: "target-selection",
    });
    const parsed = parseTargetSelectionResponse(
      raw,
      args.candidates.map((candidate) => candidate.projectId),
    );
    if (!parsed.ok) return { ok: false, fallbackReason: parsed.fallbackReason };
    return { ok: true, choice: parsed.choice, model };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (/cap reached/i.test(message)) {
      return { ok: false, fallbackReason: "budget_exhausted", detail: message.slice(0, 200) };
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, fallbackReason: "timeout" };
    }
    return { ok: false, fallbackReason: "generation_error", detail: message.slice(0, 200) };
  }
};

/**
 * planned行への注釈を作る。理由テキストは「LLMの選択と採用作品が一致した行」にだけ載せ、
 * plannerがフォールバックで別作品を採った行には llm_choice_not_adopted を記録する(誤伝播防止)。
 */
export const buildRowTargetSelection = (
  meta: TargetSelectionMeta,
  adoptedProjectId: string,
): RowTargetSelection => {
  if (meta.llmChoice && meta.llmChoice.projectId === adoptedProjectId) {
    return {
      mode: "llm-selected",
      candidateCount: meta.candidateCount,
      source: "llm",
      reason: meta.llmChoice.reason,
      model: meta.llmChoice.model,
    };
  }
  if (meta.llmChoice) {
    return {
      mode: "llm-selected",
      candidateCount: meta.candidateCount,
      source: "fallback",
      fallbackReason: "llm_choice_not_adopted",
      llmProjectId: meta.llmChoice.projectId,
    };
  }
  return {
    mode: "llm-selected",
    candidateCount: meta.candidateCount,
    source: "fallback",
    fallbackReason: meta.fallbackReason ?? "generation_error",
  };
};
