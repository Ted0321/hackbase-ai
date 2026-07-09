import type { PrismaClient } from "@prisma/client";
import type { FeedbackGuidance } from "./feedback-guidance";

/**
 * B-3: feedback guidance（改善ループの「反応 → 次生成」注入データ）の DB 永続化ヘルパー。
 *
 * Cloud Run JobのローカルFSは揮発するため、`data/feedback/latest-guidance.json` を DB の
 * `FeedbackGuidance` テーブルへ正本化する。SchedulerState 同様の keyed singleton（"latest" を
 * upsert）。scheduler-state.ts の prisma 注入パターンに合わせ、単体テスト可能な純IOヘルパにする。
 */

const FEEDBACK_GUIDANCE_KEY = "latest";

/** Prisma client が `feedbackGuidance` delegate を持つことだけを要求する最小型。 */
type FeedbackGuidancePrisma = {
  feedbackGuidance: {
    findUnique: (args: {
      where: { key: string };
    }) => Promise<{ guidanceJson: string } | null>;
    upsert: (args: {
      where: { key: string };
      create: {
        key: string;
        version: number;
        generatedAt: Date;
        window: string;
        guidanceJson: string;
      };
      update: { version: number; generatedAt: Date; window: string; guidanceJson: string };
    }) => Promise<unknown>;
  };
};

type AnyPrisma = PrismaClient | FeedbackGuidancePrisma;

/**
 * feedback guidance を DB から読む。テーブル未作成/未保存時は null（呼び出し側でFSフォールバック）。
 */
export async function readFeedbackGuidanceRecord(
  prisma: AnyPrisma,
): Promise<FeedbackGuidance | null> {
  try {
    const row = await (prisma as FeedbackGuidancePrisma).feedbackGuidance.findUnique({
      where: { key: FEEDBACK_GUIDANCE_KEY },
    });
    if (row) {
      return JSON.parse(row.guidanceJson) as FeedbackGuidance;
    }
  } catch {
    // DB未初期化（テーブル無し）等は呼び出し側のFSフォールバックへ。
  }
  return null;
}

/**
 * feedback guidance を DB へ書く（upsert・last-write-wins の単一スロット）。
 */
export async function writeFeedbackGuidanceRecord(
  prisma: AnyPrisma,
  guidance: FeedbackGuidance,
): Promise<void> {
  const parsedAt = new Date(guidance.generatedAt);
  const data = {
    version: guidance.version,
    generatedAt: Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt,
    window: guidance.window,
    guidanceJson: JSON.stringify(guidance),
  };
  await (prisma as FeedbackGuidancePrisma).feedbackGuidance.upsert({
    where: { key: FEEDBACK_GUIDANCE_KEY },
    create: { key: FEEDBACK_GUIDANCE_KEY, ...data },
    update: data,
  });
}
