/**
 * 運用コンソール（/human）の「デモ基準時刻」。
 *
 * この時刻より前の運用ログ（Run / Artifact / RunEvent / 利用量 / Runtime /
 * SchedulerRun / QualityReport / Incident 等の時系列レコード）は、コンソールUIに
 * 一切表示しない。DB 上のデータは削除せず保持する（非破壊。AgentSkill や監査履歴も無傷）。
 *
 * `PRODIA_CONSOLE_EPOCH` に ISO8601（例: "2026-07-06T02:20:00Z"）を設定すると有効化。
 * 未設定・不正値なら null を返し、従来どおり全期間を表示する（既存挙動・テストに無影響）。
 */
export const getConsoleLogEpoch = (): Date | null => {
  const raw = process.env.PRODIA_CONSOLE_EPOCH?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * base（todayStart や sevenDaysAgo 等）と epoch の「遅い方」を下限として返す。
 * 既に createdAt >= base を持つ利用量クエリ等で使う。
 */
export const gteWithEpoch = (base: Date): Date => {
  const epoch = getConsoleLogEpoch();
  return epoch && epoch.getTime() > base.getTime() ? epoch : base;
};

/**
 * scheduler の単発 state を、最終完了時刻が epoch より前なら隠す（null 化）。
 * HEALTHY EVIDENCE の「最終成功Scheduler」等に使う。
 */
export const hideStaleSchedulerState = <T extends { lastCompletedAt?: string } | null | undefined>(
  state: T,
): T | null => {
  const epoch = getConsoleLogEpoch();
  if (!epoch || !state) return state ?? null;
  const last = state.lastCompletedAt ? new Date(state.lastCompletedAt) : null;
  if (last && !Number.isNaN(last.getTime()) && last.getTime() < epoch.getTime()) {
    return null;
  }
  return state;
};
