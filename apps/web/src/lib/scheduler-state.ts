import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Scheduler state persistence helper (prisma注入式).
 *
 * Cloud Run JobのローカルFSは揮発するため、scheduler state（per-agent due state等）を
 * DBの `SchedulerState` テーブルへ移す。web は `@/lib/db` の singleton、scripts は各自の
 * `createPrismaClient()` を引数で渡す。
 *
 * key      = 既存FSファイルの basename（例: "agent-creation-daily"）
 * scope    = "pipeline" | "agent-due" | "interactions" など分類ラベル
 * stateJson = JSON.stringify(state) 全体。SQLite/Postgres共通のTEXT列。
 */

/** Prisma client が `schedulerState` delegate を持つことだけを要求する最小型。 */
type SchedulerStatePrisma = {
  schedulerState: {
    findUnique: (args: {
      where: { key: string };
    }) => Promise<{ stateJson: string } | null>;
    upsert: (args: {
      where: { key: string };
      create: { key: string; scope: string; version: string | null; stateJson: string };
      update: { scope: string; version: string | null; stateJson: string };
    }) => Promise<unknown>;
  };
};

type AnyPrisma = PrismaClient | SchedulerStatePrisma;

const schedulerStateFilePath = (key: string) =>
  path.join(process.cwd(), "data", "scheduler", `${key}.json`);

const extractVersion = (state: unknown): string | null => {
  if (state && typeof state === "object" && "version" in state) {
    const version = (state as { version?: unknown }).version;
    if (typeof version === "string") {
      return version;
    }
  }
  return null;
};

/**
 * scheduler state を読む（3段フォールバック）。
 *   ① DB (`findUnique` → `JSON.parse(stateJson)`)
 *   ② 既存FSファイル `data/scheduler/<key>.json`（初回Job実行時のDB自動シード源）
 *   ③ null（呼び出し側の default 温存）
 *
 * DBから読んだ生JSONはそのまま呼び出し側へ渡す（normalize/legacy吸収は呼び出し側で実施）。
 */
export async function readSchedulerStateRecord<T>(
  prisma: AnyPrisma,
  key: string,
): Promise<T | null> {
  // ① DB
  try {
    const row = await (prisma as SchedulerStatePrisma).schedulerState.findUnique({
      where: { key },
    });
    if (row) {
      return JSON.parse(row.stateJson) as T;
    }
  } catch {
    // DB未初期化（テーブル無し）等はFSフォールバックへ。
  }

  // ② 既存FSファイル
  try {
    const raw = await readFile(schedulerStateFilePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    // ENOENT 等は ③ へ。
  }

  // ③ null
  return null;
}

/**
 * scheduler state を書く。`upsert`（原子的・last-write-wins）。
 * **DBのみに書く**（揮発FSへの二重書きはしない）。
 */
export async function writeSchedulerStateRecord<T>(
  prisma: AnyPrisma,
  key: string,
  scope: string,
  state: T,
): Promise<void> {
  const stateJson = JSON.stringify(state);
  const version = extractVersion(state);

  await (prisma as SchedulerStatePrisma).schedulerState.upsert({
    where: { key },
    create: { key, scope, version, stateJson },
    update: { scope, version, stateJson },
  });
}

/**
 * `--state <path>` CLI引数の互換シム。
 * パス（"data/scheduler/foo.json" 等）が来たら basename から ".json" を除いた key を返す。
 * 既にkey（拡張子なし・パス区切りなし）であればそのまま返す。
 */
export function schedulerStateKeyFromArg(value: string): string {
  const base = path.basename(value);
  return base.endsWith(".json") ? base.slice(0, -".json".length) : base;
}
