import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readFeedbackGuidanceRecord } from "./feedback-store";

/**
 * FL-2: Feedback Digest（裏方artifact）の共有reader。
 *
 * `data/feedback/latest-guidance.json`（build-feedback-digest.ts の出力）を読み、
 * 次の生成（theme選定・concept prompt）へ差し込む短い guidance テキストに整形する。
 *
 * 改善ループの「反応 → 次生成への反映」の注入点。生コメントは直接入れず、
 * 構造化された guidance（positive/weak/nextRunGuidance/avoidNext）だけを渡す。
 */

export type FeedbackGuidance = {
  version: number;
  generatedAt: string;
  window: string;
  focusProjectId: string | null;
  totals: {
    feedback: number;
    like: number;
    want_to_grow: number;
    comment: number;
    report: number;
    agentReactions: number;
  };
  positivePatterns: string[];
  weakPatterns: string[];
  agentLessons: Array<{ agentId: string; lesson: string }>;
  sourceLessons: string[];
  nextRunGuidance: string[];
  avoidNext: string[];
  topProjects: Array<{
    id: string;
    title: string;
    category: string;
    agentId: string;
    agentName: string;
    likeCount: number;
    commentCount: number;
    agentReactionCount: number;
    reportCount: number;
    score: number;
  }>;
  recentComments: string[];
};

export const feedbackGuidancePath = () =>
  path.join(process.cwd(), "data", "feedback", "latest-guidance.json");

export const readFeedbackGuidance = async (): Promise<FeedbackGuidance | null> => {
  // ① DB（正本）。Cloud Run の FS 揮発でも「反応から得た改善」が消えないよう DB を優先する（B-3）。
  const prisma = createPrismaClient();
  try {
    const fromDb = await readFeedbackGuidanceRecord(prisma);
    if (fromDb) return fromDb;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  // ② FS フォールバック（ローカル / DB未初期化 / 同一Job内の直近書き込み）。
  try {
    return JSON.parse(await readFile(feedbackGuidancePath(), "utf8")) as FeedbackGuidance;
  } catch {
    return null;
  }
};

/**
 * guidance を、生成 prompt に挿入できる短いテキストブロックへ整形する。
 * agentId を渡すと、そのagent向けの lesson を優先的に含める。
 */
export const formatGuidanceForPrompt = (
  guidance: FeedbackGuidance | null,
  options?: { agentId?: string; maxLines?: number },
): string => {
  if (!guidance) return "";
  const maxLines = options?.maxLines ?? 6;
  const lines: string[] = [];

  for (const item of guidance.nextRunGuidance) {
    lines.push(`- ${item}`);
  }
  for (const item of guidance.positivePatterns.slice(0, 2)) {
    lines.push(`- 好評: ${item}`);
  }
  for (const item of guidance.avoidNext.slice(0, 2)) {
    lines.push(`- 回避: ${item}`);
  }
  if (options?.agentId) {
    const lesson = guidance.agentLessons.find((entry) => entry.agentId === options.agentId);
    if (lesson) lines.push(`- このAIへの示唆: ${lesson.lesson}`);
  }

  if (lines.length === 0) return "";
  const trimmed = lines.slice(0, maxLines);
  return [
    "## 過去の反応から得た改善ガイダンス（feedback loop）",
    `（集計期間: ${guidance.window} / 反応 ${guidance.totals.feedback}件）`,
    ...trimmed,
  ].join("\n");
};
