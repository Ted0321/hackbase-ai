import "./load-local-env";

import { createPrismaClient } from "./prisma-client";

/**
 * 運用クリーンアップ用: 古い/ダミーのインシデントを削除する。
 *
 * インシデントは sync-console-observability.ts が実状態から再生成するため、
 * 掃除後（作品 withdraw 済み・スケジューラー停止中）に削除しておけば、
 * スケジューラー再開後は「今の綺麗な状態」から再度立ち上がる。
 *
 * 既定はドライラン。実削除は --write --confirm が必須。
 *
 * 例:
 *   # 全件（さら状態にする）
 *   tsx scripts/clean-incidents.ts --all
 *   tsx scripts/clean-incidents.ts --all --write --confirm
 *
 *   # タイトル部分一致（カンマ=OR）
 *   tsx scripts/clean-incidents.ts --title-contains "意思決定シェル,マイクロV"
 *
 *   # ステータス/ソース/経過日数で絞る
 *   tsx scripts/clean-incidents.ts --status resolved --older-than-days 3
 *   tsx scripts/clean-incidents.ts --source quality_report
 *
 *   # 明示 ID 指定
 *   tsx scripts/clean-incidents.ts --ids incident_xxx,incident_yyy
 */

const prisma = createPrismaClient();

const parseList = (value: string | boolean | undefined): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--write") {
      values.set("write", true);
    } else if (item === "--confirm") {
      values.set("confirm", true);
    } else if (item === "--all") {
      values.set("all", true);
    } else if (item.startsWith("--")) {
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

  const olderThanDaysRaw = values.get("older-than-days");
  const olderThanDays =
    typeof olderThanDaysRaw === "string" ? Number(olderThanDaysRaw) : undefined;

  return {
    all: values.get("all") === true,
    ids: parseList(values.get("ids")),
    titleContains: parseList(values.get("title-contains")),
    statuses: parseList(values.get("status")),
    sources: parseList(values.get("source")),
    olderThanDays,
    write: values.get("write") === true,
    confirm: values.get("confirm") === true,
  };
};

async function main() {
  const args = parseArgs();

  if (args.write && !args.confirm) {
    throw new Error("--write requires --confirm.");
  }

  if (
    args.olderThanDays !== undefined &&
    (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0)
  ) {
    throw new Error("--older-than-days must be a non-negative number.");
  }

  const hasFilter =
    args.all ||
    args.ids.length > 0 ||
    args.titleContains.length > 0 ||
    args.statuses.length > 0 ||
    args.sources.length > 0 ||
    args.olderThanDays !== undefined;

  if (!hasFilter) {
    throw new Error(
      "No filter provided. Use --all or one of --ids/--title-contains/--status/--source/--older-than-days.",
    );
  }

  const AND: Record<string, unknown>[] = [];
  if (!args.all) {
    if (args.ids.length > 0) AND.push({ id: { in: args.ids } });
    if (args.statuses.length > 0) AND.push({ status: { in: args.statuses } });
    if (args.sources.length > 0) AND.push({ source: { in: args.sources } });
    if (args.titleContains.length > 0) {
      AND.push({ OR: args.titleContains.map((needle) => ({ title: { contains: needle } })) });
    }
    if (args.olderThanDays !== undefined) {
      const cutoff = new Date(Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000);
      AND.push({ lastSeenAt: { lt: cutoff } });
    }
  }

  const where = args.all ? {} : { AND };

  const targets = await prisma.incident.findMany({
    where,
    select: {
      id: true,
      title: true,
      status: true,
      source: true,
      severity: true,
      projectId: true,
      lastSeenAt: true,
    },
    orderBy: { lastSeenAt: "desc" },
  });

  console.log("=== clean-incidents ===");
  console.log(`mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`filter: ${args.all ? "ALL" : JSON.stringify({ ids: args.ids, titleContains: args.titleContains, statuses: args.statuses, sources: args.sources, olderThanDays: args.olderThanDays })}`);
  console.log(`matched: ${targets.length}`);
  for (const incident of targets) {
    console.log(
      `  DELETE [${incident.status}] sev=${incident.severity} src=${incident.source} ${incident.id} :: ${incident.title}`,
    );
  }

  if (!args.write) {
    console.log("Dry run only. Re-run with --write --confirm to apply.");
    return;
  }

  if (targets.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const ids = targets.map((incident) => incident.id);

  // QualityFinding.incidentId は任意リレーション（削除時 SetNull）。念のため明示的に
  // リンクを外してから親を消し、方言差でのFK挙動に依存しないようにする。
  await prisma.$transaction([
    prisma.qualityFinding.updateMany({
      where: { incidentId: { in: ids } },
      data: { incidentId: null },
    }),
    prisma.incident.deleteMany({ where: { id: { in: ids } } }),
  ]);

  console.log(`Deleted incidents: ${targets.length}`);
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
