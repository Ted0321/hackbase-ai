import "./load-local-env";

import { createPrismaClient } from "./prisma-client";

/**
 * 運用クリーンアップ用: フィードバック digest（FeedbackGuidance）をリセットする。
 *
 * FeedbackGuidance は「直近の反応から抽出した学び」を次回生成に与えるキー付き
 * シングルトン。古い作品の学びを新規生成へ持ち込まないよう、掃除時に空にする。
 * DB 上の行を削除する（既定は "latest" キー、--all で全キー）。
 *
 * data/feedback/latest-guidance.json は本テーブルから生成される派生物なので、
 * 別途 guidance 再生成コマンドで作り直すか、空のまま次回生成で更新される。
 *
 * 既定はドライラン。実削除は --write --confirm が必須。
 *
 * 例:
 *   tsx scripts/reset-feedback-guidance.ts
 *   tsx scripts/reset-feedback-guidance.ts --write --confirm
 *   tsx scripts/reset-feedback-guidance.ts --all --write --confirm
 */

const prisma = createPrismaClient();

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--write") values.set("write", true);
    else if (item === "--confirm") values.set("confirm", true);
    else if (item === "--all") values.set("all", true);
    else if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(key, next);
        index += 1;
      } else {
        values.set(key, true);
      }
    }
  }
  const key = typeof values.get("key") === "string" ? (values.get("key") as string) : "latest";
  return {
    all: values.get("all") === true,
    key,
    write: values.get("write") === true,
    confirm: values.get("confirm") === true,
  };
};

async function main() {
  const args = parseArgs();
  if (args.write && !args.confirm) {
    throw new Error("--write requires --confirm.");
  }

  const where = args.all ? {} : { key: args.key };
  const targets = await prisma.feedbackGuidance.findMany({
    where,
    select: { key: true, version: true, generatedAt: true },
  });

  console.log("=== reset-feedback-guidance ===");
  console.log(`mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`filter: ${args.all ? "ALL" : `key=${args.key}`}`);
  console.log(`matched: ${targets.length}`);
  for (const row of targets) {
    console.log(`  DELETE key=${row.key} version=${row.version}`);
  }

  if (!args.write) {
    console.log("Dry run only. Re-run with --write --confirm to apply.");
    return;
  }

  if (targets.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const deleted = await prisma.feedbackGuidance.deleteMany({ where });
  console.log(`Deleted feedbackGuidance rows: ${deleted.count}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
