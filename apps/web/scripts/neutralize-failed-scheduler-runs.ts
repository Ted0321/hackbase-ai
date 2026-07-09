import "./load-local-env";

import { createPrismaClient } from "./prisma-client";

/**
 * 運用対応用: 一過性の失敗 SchedulerRun 行を「解決済みマーカー」へ更新し、そこから派生した
 * scheduler インシデントを解消する。
 *
 * 背景: sync-console-observability.ts は SchedulerRun.status="failed" を DERIVED_INCIDENT_LOOKBACK_DAYS
 * (=7日) 窓で拾い、毎同期で派生インシデントを再オープンする。根本原因を修正しても、失敗行が窓内に
 * 残る限り P0 が消えない。そこで対象の失敗行の status を failed → <status-to>(既定 failed_resolved) へ
 * 更新し、failedSchedulers クエリ(status="failed")に引っかからないようにする。errorMessage 等は保持
 * するので監査情報は残る。あわせて `scheduler:<id>` フィンガープリントの派生インシデントを resolved 化する
 * (トリガーが無効化されるため再オープンしない)。
 *
 * 既定はドライラン。実更新は --write --confirm が必須。
 *
 * 例:
 *   # 当日の agent-creation-daily の失敗行を確認(ドライラン)
 *   tsx scripts/neutralize-failed-scheduler-runs.ts --schedule-name agent-creation-daily --since-days 1
 *   # 実行
 *   tsx scripts/neutralize-failed-scheduler-runs.ts --schedule-name agent-creation-daily --since-days 1 --write --confirm
 *   # 明示 ID 指定
 *   tsx scripts/neutralize-failed-scheduler-runs.ts --ids sched_xxx,sched_yyy --write --confirm
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

  const sinceDaysRaw = values.get("since-days");
  const sinceDays = typeof sinceDaysRaw === "string" ? Number(sinceDaysRaw) : undefined;
  const statusToRaw = values.get("status-to");

  return {
    ids: parseList(values.get("ids")),
    scheduleName: typeof values.get("schedule-name") === "string" ? (values.get("schedule-name") as string) : undefined,
    sinceDays,
    statusTo: typeof statusToRaw === "string" ? statusToRaw : "failed_resolved",
    write: values.get("write") === true,
    confirm: values.get("confirm") === true,
  };
};

async function main() {
  const args = parseArgs();

  if (args.write && !args.confirm) {
    throw new Error("--write requires --confirm.");
  }
  if (args.sinceDays !== undefined && (!Number.isFinite(args.sinceDays) || args.sinceDays < 0)) {
    throw new Error("--since-days must be a non-negative number.");
  }
  if (!args.statusTo || args.statusTo === "failed") {
    throw new Error("--status-to must be a non-'failed' marker (default failed_resolved).");
  }

  const hasFilter = args.ids.length > 0 || args.scheduleName !== undefined || args.sinceDays !== undefined;
  if (!hasFilter) {
    throw new Error("No filter provided. Use --ids and/or --schedule-name and/or --since-days.");
  }

  const AND: Record<string, unknown>[] = [{ status: "failed" }];
  if (args.ids.length > 0) AND.push({ id: { in: args.ids } });
  if (args.scheduleName !== undefined) AND.push({ scheduleName: args.scheduleName });
  if (args.sinceDays !== undefined) {
    const cutoff = new Date(Date.now() - args.sinceDays * 24 * 60 * 60 * 1000);
    AND.push({ startedAt: { gte: cutoff } });
  }

  const targets = await prisma.schedulerRun.findMany({
    where: { AND },
    select: {
      id: true,
      scheduleName: true,
      status: true,
      runId: true,
      startedAt: true,
      errorMessage: true,
    },
    orderBy: { startedAt: "desc" },
  });

  console.log("=== neutralize-failed-scheduler-runs ===");
  console.log(`mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(
    `filter: ${JSON.stringify({ ids: args.ids, scheduleName: args.scheduleName, sinceDays: args.sinceDays, statusTo: args.statusTo })}`,
  );
  console.log(`matched SchedulerRun(status=failed): ${targets.length}`);
  for (const run of targets) {
    const err = (run.errorMessage ?? "").split("\n")[0].slice(0, 80);
    console.log(
      `  NEUTRALIZE ${run.id} [${run.scheduleName}] run=${run.runId ?? "-"} at ${run.startedAt.toISOString()} :: ${err}`,
    );
  }

  // 派生インシデントの fingerprint は sync-console-observability.ts で `scheduler:<SchedulerRun.id>`。
  const fingerprints = targets.map((run) => `scheduler:${run.id}`);
  const derivedIncidents =
    fingerprints.length > 0
      ? await prisma.incident.findMany({
          where: { fingerprint: { in: fingerprints }, status: { notIn: ["resolved", "ignored"] } },
          select: { id: true, fingerprint: true, status: true, priority: true, title: true },
        })
      : [];
  console.log(`derived scheduler incident(s) to resolve: ${derivedIncidents.length}`);
  for (const incident of derivedIncidents) {
    console.log(`  RESOLVE [${incident.status}] ${incident.priority} ${incident.fingerprint} :: ${incident.title}`);
  }

  if (!args.write) {
    console.log("Dry run only. Re-run with --write --confirm to apply.");
    return;
  }
  if (targets.length === 0) {
    console.log("Nothing to neutralize.");
    return;
  }

  const ids = targets.map((run) => run.id);
  const [runUpdate, incidentUpdate] = await prisma.$transaction([
    prisma.schedulerRun.updateMany({
      where: { id: { in: ids } },
      data: { status: args.statusTo },
    }),
    prisma.incident.updateMany({
      where: { fingerprint: { in: fingerprints }, status: { notIn: ["resolved", "ignored"] } },
      data: { status: "resolved", resolvedAt: new Date() },
    }),
  ]);

  console.log(`Neutralized SchedulerRun rows: ${runUpdate.count} (status -> ${args.statusTo})`);
  console.log(`Resolved derived incidents: ${incidentUpdate.count}`);
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
