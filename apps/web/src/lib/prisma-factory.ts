import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * 共有Prismaクライアント生成。
 *
 * `DATABASE_URL` のスキームで driver adapter を切替える:
 *   - `postgres://` / `postgresql://` → @prisma/adapter-pg（本番 Cloud SQL）
 *   - `file:` ほか                    → @prisma/adapter-better-sqlite3（ローカル開発）
 *
 * datasource の provider（SQL方言）は schema.prisma 側で固定されるため、生成された
 * クライアントの方言と adapter のドライバが一致している必要がある。本番イメージは
 * ビルド時に provider=postgresql で生成（scripts/set-prisma-provider.ts）し postgres を、
 * ローカルは provider=sqlite のまま sqlite を使う。
 */

const DEFAULT_SQLITE_URL = "file:./prisma/dev.db";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_SQLITE_URL;
}

export function isPostgresUrl(url: string = databaseUrl()): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export function createPrismaClient(): PrismaClient {
  const url = databaseUrl();

  if (isPostgresUrl(url)) {
    const adapter = new PrismaPg({ connectionString: url });
    return new PrismaClient({ adapter });
  }

  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}
