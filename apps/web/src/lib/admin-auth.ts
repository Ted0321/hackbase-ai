export type AdminActor = {
  actorType: "human";
  actorId: string;
  actorName: string;
  mode: "key" | "local_dev";
};

const valueOf = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

export function adminWriteKeyConfigured() {
  return Boolean(process.env.PRODIA_ADMIN_WRITE_KEY);
}

/**
 * 審査(デモ)用の読み取り専用モード。PRODIA_CONSOLE_READONLY=1 のとき、
 * 運用コンソールからの一切の書き込み操作(mutation)を無効化する。
 * 審査員が自由に触れる環境で、誤操作による副作用を防ぐための多層防御。
 */
export function consoleReadOnly() {
  return process.env.PRODIA_CONSOLE_READONLY === "1";
}

export const CONSOLE_READONLY_NOTICE =
  "審査用環境のため、この操作は無効化されています（閲覧のみ可能）。";

/**
 * mutation系のserver action冒頭で呼ぶ。読み取り専用モードなら例外を投げて弾く。
 * UI側のガードをすり抜けた直POSTに対しても効く最後の砦。
 */
export function assertConsoleWriteAllowed() {
  if (consoleReadOnly()) {
    throw new Error(CONSOLE_READONLY_NOTICE);
  }
}

export function adminWriteRequiresKey() {
  return process.env.NODE_ENV === "production" || process.env.PRODIA_REQUIRE_ADMIN_KEY === "1";
}

export function assertAdminWriteAllowed(formData: FormData): AdminActor {
  const configuredKey = process.env.PRODIA_ADMIN_WRITE_KEY;
  const submittedKey = valueOf(formData, "adminWriteKey");
  const adminName = valueOf(formData, "adminName") || "Local Admin";
  const adminActorId = valueOf(formData, "adminActorId") || "local_admin";

  if (configuredKey) {
    if (submittedKey !== configuredKey) {
      throw new Error("Admin write key is invalid.");
    }
    return { actorType: "human", actorId: adminActorId, actorName: adminName, mode: "key" };
  }

  if (adminWriteRequiresKey()) {
    throw new Error("PRODIA_ADMIN_WRITE_KEY is required for admin writes in this environment.");
  }

  return { actorType: "human", actorId: adminActorId, actorName: adminName, mode: "local_dev" };
}
