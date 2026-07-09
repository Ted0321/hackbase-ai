import path from "node:path";
import { spawn } from "node:child_process";
import { createPrismaClient } from "./prisma-client";
import { readAgentRegistry, type AgentRegistryProfile } from "./agent-registry";
import { isInteractionType, type InteractionType } from "./agent-interaction-policy";
import "./load-local-env";

/**
 * 手動レーン: AI同士のいいね/コメントを、日次スケジューラ(Lane3)と独立に手動実行する。
 *
 * - SchedulerState(agent-interactions-daily)を一切読み書きしない = 定期実行のdue-gateに影響なし。
 * - 既定で --force を実体(run-agent-interactions.ts)に渡し、日次/週次/作品上限をバイパスする
 *   (手動=上限なし)。--respect-limits で通常上限に戻せる。
 * - force でも残るハードルール: 同一agent×同一作品は「いいね1回＋コメント系1回」まで(排他グループ別)。
 *   → like残枠 = そのagentがまだいいねしていない公開作品数(status で確認できる)。
 * - run/balance は「1件ずつ全員に配ってから2周目」のラウンドロビンで実行するため、枠が
 *   足りない状況でも早い者勝ちで偏らない(希少な枠を公平に分配する)。
 * - pool は誰が引くかを各エージェントのpropensity(性格の重み)で毎回抽選する。本番スケジューラの
 *   重み付き抽選と同じ考え方を手動側でも使い、"いいねを多発する/滅多にしない"という個性を
 *   反応の頻度そのものに反映する。
 *
 * Usage:
 *   tsx scripts/run-agent-interactions-manual.ts status
 *   tsx scripts/run-agent-interactions-manual.ts run [--agent a | --agents a,b] [--count N]
 *        [--type like|critique|remix|risk|compare] [--project under-interacted|latest|featured|<id>]
 *        [--no-llm] [--dry-run] [--respect-limits]
 *   tsx scripts/run-agent-interactions-manual.ts balance [--target N] [--type like] [--agents a,b]
 *        [--no-llm] [--dry-run] [--respect-limits]
 *   tsx scripts/run-agent-interactions-manual.ts pool --count N [--type like] [--agents a,b]
 *        [--project under-interacted|latest|featured|<id>] [--no-llm] [--dry-run] [--respect-limits]
 *
 * コメントは既定でLLM(Gemini・人格反映)生成。以前は --llm 明示が必要で、渡し忘れると
 * 全件テンプレ定型文になる事故が起きた(2026-07-08、公開フィードに「作品名+定型文」が
 * 露出)。テンプレ生成に戻したい場合のみ --no-llm を渡す(Gemini非課金・動作確認用)。
 */

const prisma = createPrismaClient();

// run-agent-interactions.ts の publicInteractionTargetWhere と同一(非export のため複製)
const publicInteractionTargetWhere = {
  status: { in: ["auto_published", "published"] },
  NOT: { publishDecision: "withdrawn" },
};

const TYPE_ALIASES: Record<string, InteractionType> = {
  like: "agent_like",
  critique: "agent_critique",
  remix: "agent_remix_suggestion",
  risk: "agent_risk_flag",
  compare: "agent_compare_note",
};

const DAY_MS = 24 * 60 * 60 * 1000;

type CliArgs = {
  command: "status" | "run" | "balance" | "pool";
  agentIds?: string[];
  count: number;
  target?: number;
  type?: InteractionType;
  project: string;
  llm: boolean;
  dryRun: boolean;
  respectLimits: boolean;
};

function parseCliArgs(): CliArgs {
  const raw = process.argv.slice(2);
  const command = raw[0] && !raw[0].startsWith("--") ? raw[0] : "status";
  if (command !== "status" && command !== "run" && command !== "balance" && command !== "pool") {
    throw new Error(`unknown command "${command}" (expected: status | run | balance | pool)`);
  }

  const values = new Map<string, string | boolean>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const agentsRaw = values.get("agents") ?? values.get("agent");
  const agentIds =
    typeof agentsRaw === "string"
      ? agentsRaw.split(",").map((id) => id.trim()).filter(Boolean)
      : undefined;

  let type: InteractionType | undefined;
  const rawType = values.get("type");
  if (typeof rawType === "string") {
    const resolved = TYPE_ALIASES[rawType] ?? rawType;
    if (!isInteractionType(resolved)) {
      throw new Error(
        `--type must be one of: ${Object.keys(TYPE_ALIASES).join(", ")} (or full names like agent_like)`,
      );
    }
    type = resolved;
  }

  const parsePositive = (key: string, fallback?: number) => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${key} must be a positive integer`);
    return parsed;
  };

  return {
    command,
    agentIds,
    count: parsePositive("count", 1) ?? 1,
    target: parsePositive("target"),
    type,
    project: typeof values.get("project") === "string" ? String(values.get("project")) : "under-interacted",
    // 既定LLM生成。--no-llm 明示時のみテンプレへ(渡し忘れによるテンプレ定型文の本番露出を防ぐ)。
    llm: !values.has("no-llm"),
    dryRun: values.has("dry-run") || values.has("dryRun"),
    respectLimits: values.has("respect-limits"),
  };
}

function resolveAgents(registryAgents: AgentRegistryProfile[], requestedIds?: string[]) {
  const eligible = registryAgents.filter(
    (agent) => (agent.status ?? "active") === "active" && (agent.interactionPolicy?.canReactWith.length ?? 0) > 0,
  );
  if (!requestedIds) {
    return eligible.filter((agent) => (agent.role ?? "creator") === "creator");
  }
  const byId = new Map(eligible.map((agent) => [agent.agentId, agent]));
  return requestedIds.map((id) => {
    const agent = byId.get(id);
    if (!agent) {
      throw new Error(
        `Unknown or inactive agent: ${id} (available: ${eligible.map((a) => a.agentId).join(", ")})`,
      );
    }
    return agent;
  });
}

type AgentStats = {
  total: number;
  byType: Map<string, number>;
  last24h: number;
  last7d: number;
  reactableProjects: number;
  likeableProjects: number;
};

async function collectStats(agents: AgentRegistryProfile[]) {
  const published = await prisma.project.findMany({
    where: publicInteractionTargetWhere,
    select: { id: true, title: true, agentId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const feedbackRows = await prisma.feedback.findMany({
    where: { actorType: "agent", targetType: "project" },
    select: { actorId: true, targetId: true, rating: true, createdAt: true },
  });
  const interactions = feedbackRows.filter((row) => isInteractionType(row.rating));

  const now = Date.now();
  const publishedIds = new Set(published.map((project) => project.id));
  const projectCounts = new Map<
    string,
    { total: number; likes: number; likeActorIds: Set<string>; commentActorIds: Set<string> }
  >();
  for (const row of interactions) {
    if (!publishedIds.has(row.targetId)) continue;
    const entry =
      projectCounts.get(row.targetId) ??
      { total: 0, likes: 0, likeActorIds: new Set<string>(), commentActorIds: new Set<string>() };
    entry.total += 1;
    if (row.rating === "agent_like") entry.likes += 1;
    if (row.actorId) {
      (row.rating === "agent_like" ? entry.likeActorIds : entry.commentActorIds).add(row.actorId);
    }
    projectCounts.set(row.targetId, entry);
  }

  const perAgent = new Map<string, AgentStats>();
  for (const agent of agents) {
    const stats: AgentStats = {
      total: 0,
      byType: new Map(),
      last24h: 0,
      last7d: 0,
      reactableProjects: 0,
      likeableProjects: 0,
    };
    for (const project of published) {
      if (project.agentId === agent.agentId) continue;
      const counts = projectCounts.get(project.id);
      // 新ルール(いいねper-agent化): 残枠はエージェント個人のスロット単位で数える。
      const likeOpen = !counts?.likeActorIds.has(agent.agentId);
      const commentOpen = !counts?.commentActorIds.has(agent.agentId);
      if (likeOpen || commentOpen) stats.reactableProjects += 1;
      if (likeOpen) stats.likeableProjects += 1;
    }
    perAgent.set(agent.agentId, stats);
  }
  for (const row of interactions) {
    if (!row.actorId) continue;
    const stats = perAgent.get(row.actorId);
    if (!stats) continue;
    stats.total += 1;
    stats.byType.set(row.rating, (stats.byType.get(row.rating) ?? 0) + 1);
    const age = now - row.createdAt.getTime();
    if (age <= DAY_MS) stats.last24h += 1;
    if (age <= 7 * DAY_MS) stats.last7d += 1;
  }

  return { published, projectCounts, perAgent };
}

type Stats = Awaited<ReturnType<typeof collectStats>>;

function printAgentTable(agents: AgentRegistryProfile[], stats: Stats) {
  console.log("\n== エージェント別 反応実績(与えた側) ==");
  console.log("  agent            like    fb  total   24h    7d  like残枠  反応残枠  name");
  const sorted = [...agents].sort((left, right) => {
    const l = stats.perAgent.get(left.agentId);
    const r = stats.perAgent.get(right.agentId);
    return (l?.byType.get("agent_like") ?? 0) - (r?.byType.get("agent_like") ?? 0);
  });
  for (const agent of sorted) {
    const s = stats.perAgent.get(agent.agentId);
    if (!s) continue;
    const likes = s.byType.get("agent_like") ?? 0;
    const fb = s.total - likes;
    const pad = (value: number, width: number) => String(value).padStart(width);
    console.log(
      `  ${agent.agentId.padEnd(16)}${pad(likes, 5)}${pad(fb, 6)}${pad(s.total, 7)}${pad(s.last24h, 6)}${pad(s.last7d, 6)}${pad(s.likeableProjects, 9)}${pad(s.reactableProjects, 9)}  ${agent.displayName}`,
    );
  }
}

function printProjectTable(stats: Stats) {
  const rows = [...stats.published]
    .map((project) => ({
      project,
      counts:
        stats.projectCounts.get(project.id) ??
        { total: 0, likes: 0, likeActorIds: new Set<string>(), commentActorIds: new Set<string>() },
    }))
    .sort(
      (left, right) =>
        left.counts.total - right.counts.total ||
        right.project.createdAt.getTime() - left.project.createdAt.getTime(),
    );
  const unliked = rows.filter((row) => row.counts.likes === 0).length;
  console.log(
    `\n== 作品側の状況 == 公開作品 ${stats.published.length} 件 / 未いいね ${unliked} 件(=like追加可能枠)`,
  );
  console.log("  反応が少ない順(上位15件):  総反応  like  projectId  title");
  for (const { project, counts } of rows.slice(0, 15)) {
    const title = project.title.length > 36 ? `${project.title.slice(0, 36)}…` : project.title;
    console.log(
      `  ${String(counts.total).padStart(8)}${String(counts.likes).padStart(6)}  ${project.id.padEnd(50)}  ${title}`,
    );
  }
}

const runInteractionsChild = (childArgs: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/run-agent-interactions.ts", ...childArgs],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buf += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      buf += String(chunk);
    });
    child.on("exit", (code) =>
      code === 0 ? resolve(buf) : reject(new Error(`run-agent-interactions exited ${code}`)),
    );
  });

function baseChildArgs(agentId: string, args: CliArgs, limit: number, typeOverride?: InteractionType) {
  const childArgs = ["--agent", agentId, "--project", args.project, "--limit", String(limit)];
  const type = typeOverride ?? args.type;
  if (type) childArgs.push("--type", type);
  if (!args.respectLimits) childArgs.push("--force");
  if (args.llm) childArgs.push("--llm");
  if (args.dryRun) childArgs.push("--dry-run");
  return childArgs;
}

function parseOutcome(output: string) {
  const planned = (output.match(/"feedbackId":/g) ?? []).length;
  const createdMatch = output.match(/"created":\s*(\d+)/);
  const created = createdMatch ? Number.parseInt(createdMatch[1], 10) : 0;
  const typeMatch = output.match(/"type":\s*"(agent_\w+)"/);
  return { planned, created, type: typeMatch ? (typeMatch[1] as InteractionType) : undefined };
}

// 1件だけ実行する(ラウンドロビン/抽選ループの最小単位)。dry-runでは created は常に0なので
// 呼び出し側は planned>0 を「成功」の代わりに見る。
async function runOnce(agentId: string, args: CliArgs, typeOverride?: InteractionType) {
  const output = await runInteractionsChild(baseChildArgs(agentId, args, 1, typeOverride));
  return { agentId, ...parseOutcome(output) };
}

// dry-run時のプレビュー用: --limit count 相当を1回で問い合わせる(10超は分割)。実行しないため
// ラウンドロビンの公平性は関係なく、単に「今この件数を要求したら何件計画されるか」を見せる。
async function previewForAgent(agentId: string, count: number, args: CliArgs) {
  let remaining = count;
  let planned = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 10);
    remaining -= chunk;
    const output = await runInteractionsChild(baseChildArgs(agentId, args, chunk));
    planned += parseOutcome(output).planned;
  }
  return { agentId, requested: count, planned, created: 0 };
}

type RoundResult = { agentId: string; requested: number; planned: number; created: number };

// 「1件ずつ全員に配ってから2周目」のラウンドロビン。ある agent がその周で0件しか取れなければ
// (=候補作品が尽きた)以降はスキップし、他の agent には引き続き機会を与える。全員が0件だった
// 周が来たら(=全体の枠が尽きた)打ち切る。
async function runRoundRobin(order: AgentRegistryProfile[], initialCounts: Map<string, number>, args: CliArgs) {
  const remaining = new Map(initialCounts);
  const totals = new Map<string, RoundResult>(
    order.map((agent) => [agent.agentId, { agentId: agent.agentId, requested: initialCounts.get(agent.agentId) ?? 0, planned: 0, created: 0 }]),
  );
  const exhausted = new Set<string>();
  let round = 0;

  while (order.some((agent) => (remaining.get(agent.agentId) ?? 0) > 0 && !exhausted.has(agent.agentId))) {
    round += 1;
    let anySuccess = false;
    for (const agent of order) {
      const left = remaining.get(agent.agentId) ?? 0;
      if (left <= 0 || exhausted.has(agent.agentId)) continue;
      const result = await runOnce(agent.agentId, args);
      const total = totals.get(agent.agentId)!;
      total.planned += result.planned;
      total.created += result.created;
      const succeeded = args.dryRun ? result.planned > 0 : result.created > 0;
      if (succeeded) {
        anySuccess = true;
        remaining.set(agent.agentId, left - 1);
      } else {
        exhausted.add(agent.agentId);
        console.log(`  [周${round}] ${agent.agentId}: 候補なし(枠切れ/反応済み) → 以降スキップ`);
      }
    }
    if (!anySuccess) break;
    if (args.dryRun) break; // dry-runは状態を書き換えないため2周目以降は同じ結果の繰り返しになる
  }
  return [...totals.values()];
}

function weightedPick<T>(items: T[], weightOf: (item: T) => number, random: () => number = Math.random): T {
  let best: T | undefined;
  let bestKey = -Infinity;
  for (const item of items) {
    const weight = Math.max(0.0001, weightOf(item));
    const key = Math.pow(random(), 1 / weight);
    if (key > bestKey) {
      bestKey = key;
      best = item;
    }
  }
  return best as T;
}

// 各エージェントの propensity(性格の重み)で「誰が引くか」を毎回抽選する。同じ重み設計が
// 本番スケジューラの反応タイプ選択(agent-interaction-policy.ts の orderTypesByPropensity)で
// 既に使われている: agent_like の重みが高いエージェントほど頻繁に選ばれる = "いいねを多発する
// /滅多にしない"という個性が反応の頻度そのものに出る。
async function runPool(agents: AgentRegistryProfile[], args: CliArgs) {
  const effectiveType: InteractionType = args.type ?? "agent_like";
  const weightOf = (agent: AgentRegistryProfile) => agent.interactionPolicy?.propensity?.[effectiveType] ?? 1;

  console.log(`\n== pool 抽選ウェイト(基準タイプ: ${effectiveType}) ==`);
  const totalWeight = agents.reduce((sum, agent) => sum + Math.max(0.0001, weightOf(agent)), 0);
  for (const agent of [...agents].sort((a, b) => weightOf(b) - weightOf(a))) {
    const pct = ((Math.max(0.0001, weightOf(agent)) / totalWeight) * 100).toFixed(1);
    console.log(`  ${agent.agentId.padEnd(16)} weight=${weightOf(agent).toFixed(2)}  期待割合≈${pct}%  ${agent.displayName}`);
  }

  if (args.dryRun) {
    console.log(
      `\n[pool] dry-run: 上記の重みで ${args.count} 回抽選します(状態を書き換えないため実際の抽選列は省略)。`,
    );
    return [] as RoundResult[];
  }

  const totals = new Map<string, RoundResult>(
    agents.map((agent) => [agent.agentId, { agentId: agent.agentId, requested: 0, planned: 0, created: 0 }]),
  );
  let pool = [...agents];
  let drawsLeft = args.count;
  let draw = 0;

  while (drawsLeft > 0 && pool.length > 0) {
    draw += 1;
    const chosen = weightedPick(pool, weightOf);
    const total = totals.get(chosen.agentId)!;
    total.requested += 1;
    const result = await runOnce(chosen.agentId, args, args.type);
    total.planned += result.planned;
    total.created += result.created;
    if (result.created > 0) {
      drawsLeft -= 1;
      console.log(`  [抽選${draw}] ${chosen.agentId} → ${result.type ?? effectiveType} 成立(残り${drawsLeft}件)`);
    } else {
      pool = pool.filter((agent) => agent.agentId !== chosen.agentId);
      console.log(`  [抽選${draw}] ${chosen.agentId} → 候補なし、プールから除外(残りプール${pool.length}体)`);
    }
  }
  if (drawsLeft > 0) {
    console.log(`\n注: 全エージェントの候補が尽きたため ${drawsLeft} 件は未達成のまま終了しました。`);
  }
  return [...totals.values()];
}

function printSummary(results: RoundResult[], dryRun: boolean) {
  console.log("\n== 実行サマリ ==");
  console.log("  agent            要求  計画  作成");
  for (const result of results) {
    console.log(
      `  ${result.agentId.padEnd(16)}${String(result.requested).padStart(4)}${String(result.planned).padStart(6)}${String(
        dryRun ? "-" : result.created,
      ).padStart(6)}`,
    );
  }
  const shortfall = results.filter((result) => !dryRun && result.created < result.requested);
  if (shortfall.length > 0) {
    console.log(
      "\n注: 要求より作成が少ないのは、候補作品が尽きたケース(既に全候補へ反応済み / like枠なし)。" +
        "status で残枠を確認するか、--project で対象を指定してください。",
    );
  }
}

async function main() {
  const args = parseCliArgs();
  const registry = await readAgentRegistry();
  const agents = resolveAgents(registry.agents, args.agentIds);
  if (agents.length === 0) throw new Error("no eligible agents found");

  if (args.command === "status") {
    const stats = await collectStats(agents);
    printAgentTable(agents, stats);
    printProjectTable(stats);
    return;
  }

  if (args.command === "pool") {
    console.log(
      `[manual-interactions] mode=pool agents=${agents.length} count=${args.count} project=${args.project}` +
        ` type=${args.type ?? "agent_like(重み基準)"} llm=${args.llm} dryRun=${args.dryRun}` +
        ` limits=${args.respectLimits ? "通常上限を尊重" : "バイパス(--force)"}`,
    );
    const results = await runPool(agents, args);
    if (results.length > 0) {
      printSummary(results, args.dryRun);
      const stats = await collectStats(agents);
      printAgentTable(agents, stats);
    }
    return;
  }

  // run / balance: エージェントごとの目標件数を決める
  let allocation: Array<{ agent: AgentRegistryProfile; count: number }>;
  if (args.command === "run") {
    allocation = agents.map((agent) => ({ agent, count: args.count }));
  } else {
    const stats = await collectStats(agents);
    const metric = (agentId: string) => {
      const s = stats.perAgent.get(agentId);
      if (!s) return 0;
      return args.type ? (s.byType.get(args.type) ?? 0) : s.total;
    };
    const currentMax = Math.max(...agents.map((agent) => metric(agent.agentId)));
    const target = args.target ?? currentMax;
    allocation = agents
      .map((agent) => ({ agent, count: Math.max(0, target - metric(agent.agentId)) }))
      .filter((entry) => entry.count > 0);
    const metricLabel = args.type ?? "total";
    console.log(`[manual-interactions] balance: metric=${metricLabel} target=${target}`);
    if (allocation.length === 0) {
      console.log("既に均等です(全員がtarget到達済み)。--target N で底上げできます。");
      return;
    }
  }

  console.log(
    `[manual-interactions] mode=${args.command} agents=${allocation.length} project=${args.project}` +
      ` type=${args.type ?? "(propensity抽選)"} llm=${args.llm} dryRun=${args.dryRun}` +
      ` limits=${args.respectLimits ? "通常上限を尊重" : "バイパス(--force)"}` +
      ` 割当=ラウンドロビン(1件ずつ周回)`,
  );
  for (const entry of allocation) {
    console.log(`  - ${entry.agent.agentId}: ${entry.count} 件`);
  }

  let results: RoundResult[];
  if (args.dryRun) {
    results = await Promise.all(
      allocation.map((entry) => previewForAgent(entry.agent.agentId, entry.count, args)),
    );
  } else {
    const order = allocation.map((entry) => entry.agent);
    const initialCounts = new Map(allocation.map((entry) => [entry.agent.agentId, entry.count]));
    results = await runRoundRobin(order, initialCounts, args);
  }

  printSummary(results, args.dryRun);

  if (!args.dryRun) {
    const stats = await collectStats(agents);
    printAgentTable(agents, stats);
  }
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
