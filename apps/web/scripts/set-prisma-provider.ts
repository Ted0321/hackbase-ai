import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * datasource db の provider を切替える（generate/ビルド時専用）。
 *
 * Prisma 7 では provider は固定リテラルで実行時に切替えられないため、本番イメージは
 * ビルド時に `--provider postgresql` で生成し、ローカルは schema.prisma の正本（sqlite）を
 * そのまま使う。generator 側の `provider = "prisma-client-js"` は変更しない。
 *
 * Usage: tsx scripts/set-prisma-provider.ts --provider postgresql|sqlite
 *        （--provider 省略時は DATABASE_URL のスキームから推定）
 */

function resolveProvider(): "sqlite" | "postgresql" {
  const idx = process.argv.indexOf("--provider");
  if (idx >= 0 && process.argv[idx + 1]) {
    const value = process.argv[idx + 1];
    if (value === "sqlite" || value === "postgresql") return value;
    console.error(`Unsupported --provider: ${value} (expected sqlite|postgresql)`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://")
    ? "postgresql"
    : "sqlite";
}

const provider = resolveProvider();
const schemaPath = path.resolve(process.cwd(), "prisma", "schema.prisma");
const original = readFileSync(schemaPath, "utf8");

// datasource db { ... } ブロック内の provider 行だけを置換（generator は対象外）。
const updated = original.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"(?:sqlite|postgresql|postgres|mysql|sqlserver|cockroachdb|mongodb)"/,
  `$1"${provider}"`,
);

if (updated === original) {
  console.log(`schema.prisma datasource provider already "${provider}" (no change).`);
} else {
  writeFileSync(schemaPath, updated, "utf8");
  console.log(`schema.prisma datasource provider set to "${provider}".`);
}
