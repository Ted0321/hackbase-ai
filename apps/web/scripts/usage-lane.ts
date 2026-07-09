/**
 * Gemini使用量の「予算レーン」解決。
 *
 * ModelUsageLog.lane に記録され、rate-guard の日次集計プールを分ける識別子。
 * 2026-07-08 の本番障害（scheduler:all が "389/120" で即死）の原因は、
 * rate-guard の母数が UTC 日次の全行共有プールで、手動生成スキル（$50/2000req）と
 * 本番 Cloud Run Job（$3/120req）が同じ枠を食い合っていたこと。レーンを分けることで
 * 「各レーンの上限は各レーンの使用量にだけ効く」ようにする。
 *
 * レーンは env PRODIA_USAGE_LANE で指定する（書き込み logModelUsage と
 * 読み取り enforceGeminiBudget の両方が同じ解決を使う）:
 *   - 未設定 → "scheduler"（本番 Cloud Run Job / Service。旧イメージからの INSERT も
 *     DB 既定値でここに落ちるため、本番の保守的な上限が緩む方向には壊れない）
 *   - 手動スキルは buildProdEnv（.claude/skills/hackbase-manual-generate/scripts/lib/
 *     prod-db-url.js）が "manual" を注入する
 *   - 値は自由文字列（将来 "eval" 等の追加レーンを想定）。trim + 小文字化のみ行う。
 */

export const DEFAULT_USAGE_LANE = "scheduler";

/** 生の env 値をレーン名に正規化する。空/未設定は既定レーン。 */
export const resolveUsageLane = (raw: string | null | undefined): string => {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "" ? DEFAULT_USAGE_LANE : value;
};

/** このプロセスの予算レーン（env PRODIA_USAGE_LANE から解決）。 */
export const currentUsageLane = (): string => resolveUsageLane(process.env.PRODIA_USAGE_LANE);
