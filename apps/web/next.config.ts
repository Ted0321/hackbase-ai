import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Prisma driver adapters と native/動的requireを持つドライバは bundle せず、
  // 実行時に node_modules から解決させる（standalone の nft トレースで同梱される）。
  // @prisma/client と better-sqlite3 は Next の既定 external だが、pg 経路を確実に
  // 同梱するため明示する。
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "@prisma/adapter-better-sqlite3",
    "pg",
    "better-sqlite3",
    "@google-cloud/storage",
  ],
};

export default nextConfig;
