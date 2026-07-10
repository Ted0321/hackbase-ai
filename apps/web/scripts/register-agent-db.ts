/**
 * ROSTER（agent-roster.ts）の1体をDBのAgent行として登録/更新する（非破壊upsert）。
 *
 *   tsx scripts/register-agent-db.ts --agent agent_u [--dry-run]
 *
 * エージェント増員手順（DOC-113）の一部。publish-llm-pipeline-artifact.ts はAgent行が
 * 見つからないと黙って別エージェント(agent_builder_v1等)へフォールバックするため、
 * 新エージェントの初回生成前にこのスクリプトで必ずAgent行を作る。
 * ローカルsqlite・本番（cloud-sql-proxy + DATABASE_URL）のどちらに対しても同じように動く。
 */
import { createPrismaClient } from "./prisma-client";
import { ROSTER, toDbAgent } from "./agent-roster";
import "./load-local-env";

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const prisma = createPrismaClient();

async function main() {
  const agentId = arg("--agent");
  const dryRun = process.argv.includes("--dry-run");
  if (!agentId) {
    throw new Error("usage: tsx scripts/register-agent-db.ts --agent <agentId> [--dry-run]");
  }

  const spec = ROSTER.find((item) => item.id === agentId);
  if (!spec) {
    throw new Error(
      `${agentId} is not in ROSTER (scripts/agent-roster.ts). Add the roster entry first — the roster is the single source of truth.`,
    );
  }

  const data = toDbAgent(spec);

  for (const categoryId of [data.primaryCategoryId, data.secondaryCategoryId]) {
    if (!categoryId) continue;
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new Error(
        `Category ${categoryId} does not exist in this DB. Seed categories first (prisma/seed.ts locally; production already has them).`,
      );
    }
  }

  const existing = await prisma.agent.findUnique({ where: { id: spec.id } });
  if (dryRun) {
    console.log(`[register-agent-db] DRY ${existing ? "update" : "create"} ${spec.id}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const row = await prisma.agent.upsert({
    where: { id: spec.id },
    update: { ...data, active: true },
    create: { ...data, active: true },
  });
  console.log(
    `[register-agent-db] ${existing ? "updated" : "created"} Agent row: ${row.id} | ${row.code} | ${row.name} | ${row.primaryCategoryId}/${row.secondaryCategoryId ?? "-"}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
