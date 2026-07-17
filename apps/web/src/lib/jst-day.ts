/**
 * JST(Asia/Tokyo, UTC+9)を基準とした「日」の判定ユーティリティ。
 *
 * スケジューラの日次計上は JST 日で統一する。日次生成上限(completedRunsOnJstDay)と
 * 各エージェントの maxRunsPerDay(runsToday)がそれぞれ JST日/UTC日で食い違うと、JST 15:00
 * (=UTC日境界)付近で同一 JST 日に同じエージェントが2回 due になり得るため、両者をここへ寄せる。
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// "YYYY-MM-DD"(JST)。日付比較のキーとして使う。
export const jstDateKey = (date: Date) => {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
};

export const sameJstDay = (a: Date, b: Date) => jstDateKey(a) === jstDateKey(b);
