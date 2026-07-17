/**
 * agent-due-scheduler の SchedulerState.history の刈り込みロジック。
 *
 * 毎時実行はエージェント全員分のskipエントリ(~20件/回)をhistoryへ積むため、単純な
 * 先頭50件切り捨てだと completed エントリが約2.5時間で枠外へ押し出され、
 * completedRunsOnJstDay の日次カウントが過小になる(2026-07-10 に completedToday=1、
 * 実完了2 として顕在化。日次生成上限が実質バインドしない)。
 * 当日JSTの completed は50件枠の外でも保持する。
 */

import { jstDateKey } from "../src/lib/jst-day";

export type SchedulerHistoryItem = {
  at: string;
  agentId: string;
  decision: "due" | "skipped" | "failed" | "completed";
  reason: string;
  runId?: string;
};

// JST 日の判定は src/lib/jst-day.ts を単一の正とする(agent-due-decision.ts と共用)。
// 既存 importer(run-agent-daily-scheduler.ts 等)の互換のためここで再エクスポートする。
export { jstDateKey };

export const HISTORY_LIMIT = 50;

export const pruneHistory = (
  history: SchedulerHistoryItem[],
  now: Date,
): SchedulerHistoryItem[] => {
  const todayKey = jstDateKey(now);
  return history.filter((item, index) => {
    if (index < HISTORY_LIMIT) return true;
    if (item.decision !== "completed") return false;
    const at = new Date(item.at);
    return !Number.isNaN(at.getTime()) && jstDateKey(at) === todayKey;
  });
};
