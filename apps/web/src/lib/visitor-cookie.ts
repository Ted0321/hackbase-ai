import { cookies } from "next/headers";
import {
  VISITOR_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_NAME,
  isValidVisitorId,
  mintVisitorId,
} from "./visitor-id";

/**
 * Server Component から訪問者IDを読む。Cookie未発行なら null。
 * （Server Componentのレンダリング中はCookieを発行できないため、発行は
 * いいね時の Server Action = ensureVisitorId に任せる。）
 */
export async function readVisitorId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(VISITOR_COOKIE_NAME)?.value;
  return isValidVisitorId(value) ? value : null;
}

/** Server Action 内で訪問者IDを読み取り、無ければ発行してCookieに保存する。 */
export async function ensureVisitorId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(VISITOR_COOKIE_NAME)?.value;
  if (isValidVisitorId(existing)) {
    return existing;
  }
  const visitorId = mintVisitorId(crypto.randomUUID());
  store.set(VISITOR_COOKIE_NAME, visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
  return visitorId;
}
