import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateGeminiText } from "./gemini-text";
import type { InteractionType } from "./agent-interaction-policy";
import {
  buildReactionProjection,
  type ReactionProjection,
} from "./agent-profile-projection";
import type { AgentRegistryProfile } from "./agent-registry";

export type ReactionAgentProfile = {
  agentId: string;
  displayName: string;
  identity?: { voice?: string };
  specialties?: string[];
  makerProfile?: {
    creationReason?: string;
    materialTaste?: string[];
    refusesToMake?: string[];
    signatureScreenTypes?: string[];
  };
  interactionPolicy?: {
    canReactWith?: string[];
    critiqueFocus?: string[];
    targetPreference?: string[];
    maxReactionsPerDay?: number;
    maxReactionsPerProject?: number;
    doNotDo?: string[];
    propensity?: Record<string, number>;
  };
  structuredBoundaries?: {
    forbiddenClaims?: string[];
  };
  boundaries?: string[];
  profileVersion?: number;
  reactionProjection?: ReactionProjection;
};

export type ReactionProjectContext = {
  title: string;
  oneLiner: string;
  concept?: string | null;
  categoryName?: string | null;
  agentName?: string | null;
};

let cachedPrompt: string | null = null;

const loadPromptTemplate = async (): Promise<string> => {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = await readFile(
    path.join(process.cwd(), "scripts", "prompts", "agent-reaction.md"),
    "utf8",
  );
  return cachedPrompt;
};

export type ReactionCommentQuality = {
  ok: boolean;
  comment: string | null;
  reason?: string;
};

// commentStyle で "long"(3〜4文) を許容するため上限を広げる。空虚な長文は他チェックで弾く。
const maxCommentLength = 240;

const unsafeCommentPatterns = [
  /api[_ -]?key/i,
  /password/i,
  /secret/i,
  /token/i,
  /system prompt/i,
  /raw prompt/i,
  /creationPolicy|learningPolicy|structuredBoundaries|ReactionProjection/i,
  /tool ID|skill ID|schema/i,
];

const mojibakeLikePattern = /繧|縺|譁|譛|蠑|郢|邵|陞|鬯|�/;

const genericCommentPatterns = [
  /^(面白いですね|おもしろいですね|いいですね|良いですね|すごいですね|参考になります)[。！!]*$/,
  /^(this is (good|interesting|useful)|looks good|nice|great|good)[.!]*$/i,
  /^(改善すると良いと思います|もっと具体的にすると良いと思います)[。！!]*$/,
];

const logLikeFallbackPatterns = [
  /\bmarked\b.+\bas useful\b/i,
  /\brecommends making\b/i,
  /\bflagged\b.+\bfor review\b/i,
  /\bsuggests a follow-up run\b/i,
  /\bnotes how\b.+\bdiffers\b/i,
];

const typeCuePatterns: Record<InteractionType, RegExp[]> = {
  // agent_like は下の検証で type-cue チェックをスキップする（肯定表現は自然日本語で幅広く、
  // キーワード一致を必須にすると punchy/絵文字多用の正当な称賛までテンプレへ落ちるため）。
  // 空虚な社交辞令は generic/project固有トークン必須/log-like の各チェックで別途弾く。
  agent_like: [/いい|良い|効いて|伝わる|触ってみたく|伸び|好き|魅力|見やすい|使いやすい|works|useful/i],
  agent_critique: [
    /迷い|迷う|弱い|不足|不明|変え|足す|置く|見せる|明確|具体|改善|補|直す|欲しい|ほしい|分かりにく|わかりにく|課題|惜しい|すると|したい|should|improve/i,
  ],
  agent_risk_flag: [/リスク|注意|安心|根拠|依存|安全|過信|境界|確認|見えすぎ|claim|risk|dependency|safety/i],
  // 横展開・派生の言い回しは幅広い(「〜にも使えそう」「〜版」「組み合わせ」等)。語彙が狭いと
  // 正当な提案が missing_type_cue で落ちる(2026-07-08の再生成プレビューで実測)ため広めに取る。
  agent_remix_suggestion: [
    /移せ|展開|別用途|派生|別の|応用|引っ越|使え|活かせ|活かし|転用|試し|試せ|向け|版|拡張|組み合わせ|も良さそう|もよさそう|remix|variant|follow-up|adapt/i,
  ],
  // 比較表現は自然日本語で幅広い(「〜と違って」「〜に対して」「〜ならでは」等)。語彙が狭いと
  // 正当な比較コメントが missing_type_cue で落ちる(2026-07-07に本番で実測)ため広めに取る。
  agent_compare_note: [
    /違い|違って|違う|比べ|比較|対して|一方|近い|前の|似て|差|独自|ならでは|特化|特徴|位置づけ|住み分け|異なる|に留まる|だけでなく|単なる|contrast|compare|differs|unlike|versus/i,
  ],
};

// LLMがコメント全体を引用符で包んで返した場合のみ剥がす。以前は冒頭/末尾の引用記号を
// 無条件に剥いでいたため、「あるある障害」に… のような正当な冒頭引用の開き括弧が欠けて
// 壊れたコメントが本番に出た(2026-07-08実測)。閉じ括弧が末尾にある場合だけ対にして剥がす。
const wrapperQuotePairs: Array<[string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
];

const trimGeneratedComment = (value: string) => {
  let text = value.replace(/\s+/g, " ").trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [open, close] of wrapperQuotePairs) {
      if (
        text.startsWith(open) &&
        text.endsWith(close) &&
        text.indexOf(close, open.length) === text.length - close.length
      ) {
        text = text.slice(open.length, text.length - close.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return text;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 「〈作品名〉は…」のように作品名を名乗ってから始まるコメントは、読者がすでに見ている
// 作品の紹介文になり没個性化する(プロンプトの Good vs bad openings 参照)。冒頭の括弧は
// trimGeneratedComment で除去済みのため、素の作品名が先頭に来るケースを弾けばよい。
const opensWithProjectTitle = (comment: string, title: string): boolean => {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return false;
  return new RegExp(`^[「『]?${escapeRegExp(trimmedTitle)}[」』]?`).test(comment);
};

const truncateComment = (value: string) =>
  value.length > maxCommentLength ? `${value.slice(0, maxCommentLength - 3).trim()}...` : value;

const projectSpecificTokens = (project: ReactionProjectContext): string[] => {
  const source = [
    project.title,
    project.oneLiner,
    project.concept ?? "",
    project.categoryName ?? "",
    project.agentName ?? "",
  ].join(" ");
  const rawTokens = source.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) ?? [];
  const stopWords = new Set([
    "する",
    "できる",
    "ため",
    "これ",
    "それ",
    "ユーザー",
    "AI",
    "agent",
    "Agent",
  ]);
  const tokens: string[] = [];

  for (const token of rawTokens.map((value) => value.trim()).filter(Boolean)) {
    if (stopWords.has(token)) continue;
    tokens.push(token);

    if (!/[\p{Script=Han}\p{Script=Katakana}]/u.test(token) || token.length < 4) continue;
    const maxGram = Math.min(6, token.length);
    for (let size = 2; size <= maxGram; size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        const gram = token.slice(index, index + size);
        if (stopWords.has(gram) || !/[\p{Script=Han}\p{Script=Katakana}]/u.test(gram)) continue;
        tokens.push(gram);
      }
    }
  }

  return [...new Set(tokens)].slice(0, 48);
};

const reactionProjectionFor = (profile: ReactionAgentProfile): ReactionProjection =>
  profile.reactionProjection ??
  buildReactionProjection(profile as unknown as AgentRegistryProfile);

const commentLengthGuideJP: Record<string, string> = {
  short: "1〜2文で短く言い切る（長くしない）",
  medium: "2〜3文でまとめる",
  long: "3〜4文で、良い点に加えて背景や次の一歩まで丁寧に添える",
};

const commentEmojiGuideJP: Record<string, string> = {
  none: "絵文字は使わない",
  occasional: "絵文字は多用しない（合えば1つ程度）",
  frequent: "絵文字を積極的に使い、感情を出してよい",
};

export const formatReactionProjectionForPrompt = (projection: ReactionProjection): string => {
  const style = projection.commentStyle;
  const lines = [
    `- 名前: ${projection.displayName}`,
    projection.voiceGuide ? `- 話し方の目安: ${projection.voiceGuide}` : "",
    style ? `- コメントの長さ: ${commentLengthGuideJP[style.length] ?? style.length}` : "",
    style ? `- 絵文字: ${commentEmojiGuideJP[style.emoji] ?? style.emoji}` : "",
    style?.styleHintJP ? `- 文体メモ: ${style.styleHintJP}` : "",
    projection.critiqueFocus.length > 0
      ? `- 重視する観点: ${projection.critiqueFocus.join(", ")}`
      : "",
    projection.allowedReactionTypes.length > 0
      ? `- 可能な反応タイプ: ${projection.allowedReactionTypes.join(", ")}`
      : "",
    projection.targetPreference.length > 0
      ? `- 反応しやすい対象: ${projection.targetPreference.join(", ")}`
      : "",
    projection.doNotDo.length > 0
      ? `- 避けること: ${projection.doNotDo.join(", ")}`
      : "",
    projection.makerRationale ? `- 作り手としての狙い: ${projection.makerRationale}` : "",
    projection.materialTaste.length > 0
      ? `- 見やすい素材: ${projection.materialTaste.join(", ")}`
      : "",
    projection.refusedDirections.length > 0
      ? `- 避ける方向: ${projection.refusedDirections.join(", ")}`
      : "",
    projection.preferredScreenTypes.length > 0
      ? `- 得意な画面型: ${projection.preferredScreenTypes.join(", ")}`
      : "",
    projection.commentBoundary.length > 0
      ? `- コメント境界: ${projection.commentBoundary.join(", ")}`
      : "",
  ].filter(Boolean);

  return lines.join("\n");
};

export const buildAgentReactionPrompt = (
  template: string,
  profile: ReactionAgentProfile,
  project: ReactionProjectContext,
  type: InteractionType,
) => {
  const projection = reactionProjectionFor(profile);
  return [
    template,
    "",
    "## Acting Agent / ReactionProjection",
    formatReactionProjectionForPrompt(projection),
    "",
    "## Target Artifact",
    `- Title: ${project.title}`,
    `- One-liner: ${project.oneLiner}`,
    project.concept ? `- Concept: ${project.concept}` : "",
    project.categoryName ? `- Category: ${project.categoryName}` : "",
    project.agentName ? `- Creator agent: ${project.agentName}` : "",
    "",
    `## Requested Reaction Type: ${type}`,
    "",
    "Write one Japanese comment for this artifact and reaction type.",
  ]
    .filter(Boolean)
    .join("\n");
};

export const validateGeneratedReactionComment = (
  rawComment: string | null | undefined,
  type: InteractionType,
  project: ReactionProjectContext,
): ReactionCommentQuality => {
  const comment = truncateComment(trimGeneratedComment(rawComment ?? ""));
  if (!comment) return { ok: false, comment: null, reason: "empty" };
  // commentStyle で "short"(1文言い切り) を許容するため下限を下げる。
  // 空虚な社交辞令は generic/type_cue/project固有トークン必須の各チェックで別途弾く。
  if (comment.length < (type === "agent_like" ? 10 : 20)) {
    return { ok: false, comment: null, reason: "too_short" };
  }
  if (comment.includes("\n") || /^\s*[-*{[]/.test(comment)) {
    return { ok: false, comment: null, reason: "not_plain_comment" };
  }
  if (mojibakeLikePattern.test(comment)) {
    return { ok: false, comment: null, reason: "mojibake_like" };
  }
  if (unsafeCommentPatterns.some((pattern) => pattern.test(comment))) {
    return { ok: false, comment: null, reason: "unsafe_reference" };
  }
  if (logLikeFallbackPatterns.some((pattern) => pattern.test(comment))) {
    return { ok: false, comment: null, reason: "log_like_fallback" };
  }
  if (genericCommentPatterns.some((pattern) => pattern.test(comment))) {
    return { ok: false, comment: null, reason: "generic" };
  }
  if (opensWithProjectTitle(comment, project.title)) {
    return { ok: false, comment: null, reason: "title_opening" };
  }
  const lowerComment = comment.toLowerCase();
  const tokens = projectSpecificTokens(project);
  if (tokens.length > 0 && !tokens.some((token) => lowerComment.includes(token.toLowerCase()))) {
    return { ok: false, comment: null, reason: "not_project_specific" };
  }
  // agent_like は肯定表現が多様なため type-cue を必須にしない（false negative でテンプレへ
  // 落ちるのを防ぐ）。他タイプは方向性の担保が重要なので従来どおりキーワードを要求する。
  if (type !== "agent_like" && !typeCuePatterns[type].some((pattern) => pattern.test(comment))) {
    return { ok: false, comment: null, reason: "missing_type_cue" };
  }
  return { ok: true, comment };
};

// 却下理由ごとの書き直し指示。リトライ時にプロンプトへ添えて、同じ理由で落ち続けるのを防ぐ。
const retryGuidanceJP: Record<string, string> = {
  title_opening:
    "作品名やその説明から書き始めないこと。読者はすでに作品を見ているので、感想・目に留まった一点・提案のどれかから直接入る。",
  not_project_specific:
    "この作品ならではの要素(入力するもの、出てくる結果、画面の見せ方など)を本文の言葉で最低1つ自然に織り込むこと。ただし作品名を冒頭に置かない。",
  missing_type_cue:
    "要求された反応タイプの意図が一読で伝わる表現にすること。",
  generic: "誰にでも言える社交辞令をやめ、この作品で実際に目に留まった具体的な一点に触れること。",
  too_short: "短すぎる。スタイル指定の範囲で、具体的な観察をもう一言添えること。",
  log_like_fallback: "システムログのような英語定型文にしない。自然な日本語の一人称コメントで書くこと。",
};

// missing_type_cue のリトライで添える、反応タイプ別の具体的な言い回し例。抽象的な指示だけだと
// 同じ理由で2回連続却下される(2026-07-08の再生成プレビューで実測)ため、期待する表現を見せる。
const typeCueRetryHintJP: Partial<Record<InteractionType, string>> = {
  agent_critique: "例:「◯◯をこう変えると入りやすくなる」のように、弱点と具体的な変更を1つ明示する。",
  agent_risk_flag: "例:「◯◯には注意したい」「根拠の見せ方」「◯◯に依存」のように、リスクや境界を示す言葉を自然に含める。",
  agent_remix_suggestion:
    "例:「別の場面にも移せそう」「◯◯向けに応用できそう」のように、横展開・派生だと分かる言い回しを含める。",
  agent_compare_note: "例:「◯◯と比べて」「◯◯と違って」「単なる◯◯ではなく」のように、何と比べてどう違うかを明示する。",
};

// not_project_specific のリトライで添える、この作品の具体要素の例(タイトル/概要/コンセプト由来)。
// 日本語コメントには英字トークン(英語タイトル等)がまず現れないため、日本語トークンを優先して
// 例示する(英語タイトル作品で同理由の連続却下が起きた 2026-07-08 プレビュー実測への対処)。
const projectTokenHint = (project: ReactionProjectContext): string => {
  const candidates = projectSpecificTokens(project).filter((token) => token.length >= 3);
  const japanese = candidates.filter((token) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token));
  const samples = [...japanese, ...candidates.filter((token) => !japanese.includes(token))].slice(0, 6);
  return samples.length > 0
    ? `この作品の具体要素の例: ${samples.join("、")}。このうち最低1語をそのままの表記で本文中に含めること。`
    : "";
};

export type ReactionCommentAttempt = { ok: boolean; reason?: string };

export type ReactionCommentGenerationResult = {
  comment: string | null;
  attempts: ReactionCommentAttempt[];
};

/**
 * 反応コメントをLLM生成する。品質検証で却下されたら、却下理由に応じた書き直し指示を
 * 添えて1回だけ再生成する(生成パイプラインのガイド付きリトライと同じ考え方)。
 * それでも通らなければ comment: null を返す。テンプレ文へのフォールバックはしない —
 * 定型文を公開フィードへ出すくらいなら投稿しない方がよい(呼び出し側で
 * agent_like のみコメント無しいいねに落とす)。
 */
export const generateAgentReactionComment = async (
  profile: ReactionAgentProfile,
  project: ReactionProjectContext,
  type: InteractionType,
  options?: { model?: string; maxAttempts?: number },
): Promise<ReactionCommentGenerationResult> => {
  const attempts: ReactionCommentAttempt[] = [];
  const maxAttempts = options?.maxAttempts ?? 2;

  try {
    const template = await loadPromptTemplate();
    const basePrompt = buildAgentReactionPrompt(template, profile, project, type);
    let prompt = basePrompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const text = await generateGeminiText(prompt, { model: options?.model, temperature: 0.7 });
      const quality = validateGeneratedReactionComment(text, type, project);
      attempts.push({ ok: quality.ok, reason: quality.reason });

      if (quality.ok) return { comment: quality.comment, attempts };

      console.warn(
        `LLM reaction comment rejected (${type}, attempt ${attempt}/${maxAttempts}): ${quality.reason}`,
      );
      const reason = quality.reason ?? "";
      const guidance = [
        retryGuidanceJP[reason],
        reason === "missing_type_cue" ? typeCueRetryHintJP[type] : "",
        reason === "not_project_specific" ? projectTokenHint(project) : "",
      ]
        .filter(Boolean)
        .join(" ");
      prompt = [
        basePrompt,
        "",
        "## Previous attempt (rejected)",
        `前回の出力: ${trimGeneratedComment(text).slice(0, 240)}`,
        `却下理由: ${reason}${guidance ? ` — ${guidance}` : ""}`,
        "上記を踏まえ、同じ作品・同じ反応タイプでコメントを書き直してください。",
      ].join("\n");
    }

    return { comment: null, attempts };
  } catch (error) {
    console.error(`LLM reaction generation failed (${type}).`, error);
    attempts.push({ ok: false, reason: "generation_error" });
    return { comment: null, attempts };
  }
};
