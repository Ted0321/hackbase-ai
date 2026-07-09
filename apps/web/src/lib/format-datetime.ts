/**
 * 運用コンソール(/human配下)共通の日時フォーマッタ。
 *
 * 本番Cloud RunはTZ未設定(=UTC)のため、timeZone未指定のIntl/toLocaleStringだと
 * 全時刻がUTCで描画され、JSTの管理者に9時間ズレて見える(2026-07-08監査 T4)。
 * 必ずAsia/Tokyoを明示し、表示には「JST」を付けて曖昧さを残さない。
 */

const JST_TIME_ZONE = "Asia/Tokyo";

const toTimestamp = (value?: string | Date | null): number | null => {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
};

const shortFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST_TIME_ZONE,
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const longFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** 「7/8 14:39」(JST)。null/undefined→「未記録」、パース不能→「不明」。 */
export const formatShortDateTimeJst = (value?: string | Date | null): string => {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return "未記録";
  if (Number.isNaN(timestamp)) return "不明";
  return shortFormatter.format(new Date(timestamp));
};

/** 「2026/7/8 14:39:53 JST」。null/undefined→「未記録」、パース不能→「不明」。 */
export const formatDateTimeJst = (value?: string | Date | null): string => {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return "未記録";
  if (Number.isNaN(timestamp)) return "不明";
  return `${longFormatter.format(new Date(timestamp))} JST`;
};

