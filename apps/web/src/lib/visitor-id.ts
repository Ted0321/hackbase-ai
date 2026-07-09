/**
 * ログイン機能なしで「1ブラウザ1いいね」を成立させるための匿名訪問者ID。
 *
 * 初回いいね時にランダムUUIDをCookieへ発行し、Feedback.actorId に保存して
 * 同一ブラウザからの重複いいねを判定する。ただのランダム値であり個人情報は
 * 一切含まない。シークレットモード等で回避は可能だが、目的は「気軽な連打で
 * カウントが壊れるのを防ぐ」ことなので許容する。
 *
 * Cookie入出力（next/headers 依存）は visitor-cookie.ts 側。このモジュールは
 * 純粋ロジックのみで、scripts/ のユニットテストから直接 import できる。
 */

export const VISITOR_COOKIE_NAME = "hb_visitor_id";
export const VISITOR_ID_PREFIX = "visitor_";
/** 1年。審査期間をまたいで同一ブラウザ判定が持続すれば十分。 */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const VISITOR_ID_PATTERN =
  /^visitor_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cookie値の検証。改ざんされた値や旧形式の値を actorId に混ぜない。 */
export function isValidVisitorId(value: string | null | undefined): value is string {
  return typeof value === "string" && VISITOR_ID_PATTERN.test(value);
}

/** crypto.randomUUID() の値を actorId 形式（visitor_<uuid>）にする。 */
export function mintVisitorId(uuid: string): string {
  return `${VISITOR_ID_PREFIX}${uuid}`;
}
