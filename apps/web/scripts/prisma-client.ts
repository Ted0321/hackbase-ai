import type { PrismaClient } from "@prisma/client";
import { createPrismaClient, databaseUrl, isPostgresUrl } from "../src/lib/prisma-factory";

/**
 * scripts 共通の Prisma クライアント入口。各 script の
 * `new PrismaBetterSqlite3(...) + new PrismaClient({adapter})` インライン初期化を
 * これに集約し、sqlite/postgres を DATABASE_URL のスキームで自動切替する。
 */

export { createPrismaClient, databaseUrl, isPostgresUrl };

/**
 * 初期化済みテーブル名の集合を方言非依存で返す。postgres は information_schema、
 * sqlite は sqlite_master を参照する（旧 `SELECT name FROM sqlite_master` の置換）。
 */
export async function listExistingTables(prisma: PrismaClient): Promise<Set<string>> {
  if (isPostgresUrl()) {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    return new Set(rows.map((row) => row.name));
  }

  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
}

/**
 * 必須テーブルのうち未作成のものを返す。DB 未初期化時のガードに使う。
 */
export async function missingTables(
  prisma: PrismaClient,
  requiredTables: string[],
): Promise<string[]> {
  const existing = await listExistingTables(prisma);
  return requiredTables.filter((table) => !existing.has(table));
}
