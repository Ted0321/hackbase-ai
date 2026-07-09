import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { createPrismaClient } from "./prisma-client";
import "./load-local-env";

const execFileAsync = promisify(execFile);
const prisma = createPrismaClient();

type Kind = "board" | "roulette" | "explainer" | "map";

type Assignment = {
  agentId: string;
  agentName: string;
  kind: Kind;
  reason: string;
};

const cleanTheme = (value: string) => value.trim().replace(/^["']|["']$/g, "");

const readThemeFromResultJson = (filePath: string) => {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    title?: string;
    best?: { title?: string };
  };
  const title = parsed.best?.title ?? parsed.title;
  return title ? cleanTheme(title) : "";
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const next = raw[index + 1];

    if (!item.startsWith("--") || !next || next.startsWith("--")) {
      continue;
    }

    values.set(item.slice(2), next);
    index += 1;
  }

  const resultJson = values.get("result-json") ?? values.get("product-concept-json") ?? "";
  const themeFromResult = resultJson ? readThemeFromResultJson(resultJson) : "";

  return {
    theme: cleanTheme(
      values.get("theme") ||
        themeFromResult ||
        "AI agents make small tools for understanding today's developer signals",
    ),
    resultJson,
    agent: values.get("agent") ?? "",
    baseUrl: values.get("base-url") ?? "http://127.0.0.1:3001",
  };
};

const assignmentRules: Array<{
  agentId: string;
  agentName: string;
  kind: Kind;
  keywords: string[];
  reason: string;
}> = [
  {
    agentId: "agent_d",
    agentName: "Cartographer",
    kind: "map",
    keywords: [
      "map",
      "matrix",
      "visual",
      "dashboard",
      "relation",
      "network",
      "trend",
      "compare",
      "可視化",
      "地図",
      "構造",
      "関係",
      "比較",
      "俯瞰",
      "トレンド",
    ],
    reason: "テーマが構造、関係、比較、俯瞰表示を求めているため。",
  },
  {
    agentId: "agent_c",
    agentName: "Explainer",
    kind: "explainer",
    keywords: [
      "explain",
      "learn",
      "guide",
      "brief",
      "education",
      "why",
      "理解",
      "学習",
      "説明",
      "解説",
      "ガイド",
      "入門",
      "なぜ",
    ],
    reason: "テーマに説明、導入、読みやすいガイドが必要なため。",
  },
  {
    agentId: "agent_b",
    agentName: "Shuffle",
    kind: "roulette",
    keywords: [
      "play",
      "random",
      "discover",
      "idea",
      "fun",
      "card",
      "roulette",
      "遊び",
      "偶然",
      "発見",
      "アイデア",
      "カード",
      "ルーレット",
      "探索",
    ],
    reason: "テーマが遊び心のある発見や軽い探索体験と相性がよいため。",
  },
  {
    agentId: "agent_a",
    agentName: "Triage",
    kind: "board",
    keywords: [
      "task",
      "tool",
      "workflow",
      "priority",
      "triage",
      "decision",
      "checklist",
      "work",
      "tradingagents",
      "trading",
      "finance",
      "stock",
      "market",
      "整理",
      "判断",
      "優先",
      "業務",
      "作業",
      "道具",
      "支える",
      "チェック",
      "投資",
      "金融",
      "株",
      "市場",
      "銘柄",
      "トレード",
    ],
    reason: "テーマが実用寄りで、小さな判断・作業支援ツールと相性がよいため。",
  },
];

const assignAgent = (theme: string, overrideAgentId?: string): Assignment => {
  if (overrideAgentId) {
    const matched = assignmentRules.find((rule) => rule.agentId === overrideAgentId);

    if (matched) {
      return {
        agentId: matched.agentId,
        agentName: matched.agentName,
        kind: matched.kind,
        reason: `AI指定があったため、その指定を優先しました。${matched.reason}`,
      };
    }
  }

  const normalizedTheme = theme.toLowerCase();
  const scored = assignmentRules
    .map((rule) => ({
      ...rule,
      score: rule.keywords.filter((keyword) => normalizedTheme.includes(keyword.toLowerCase()))
        .length,
    }))
    .sort((a, b) => b.score - a.score);
  const selected =
    scored[0]?.score > 0
      ? scored[0]
      : {
          ...assignmentRules[3],
          score: 0,
        };

  return {
    agentId: selected.agentId,
    agentName: selected.agentName,
    kind: selected.kind,
    reason:
      selected.score > 0
        ? selected.reason
        : "強いキーワード一致がなかったため、MVPの既定値として実用寄りのTriageを使いました。",
  };
};

const runPipeline = async (theme: string, assignment: Assignment, resultJson?: string) => {
  const productConceptArgs = resultJson ? ["--product-concept-json", resultJson] : [];
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "scripts/generate-manual-post.ts",
      "--theme",
      theme,
      "--agent",
      assignment.agentId,
      "--count",
      "1",
      "--kinds",
      assignment.kind,
      ...productConceptArgs,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  const runId =
    stdout.match(/Created run (run_[^\s]+)/)?.[1] ??
    stdout.match(/created run: (run_[^\s]+)/i)?.[1] ??
    stdout.match(/作成したrun: (run_[^\s]+)/)?.[1];

  if (!runId) {
    throw new Error(`パイプライン出力からrun idを読み取れませんでした:\n${stdout}`);
  }

  return runId;
};

async function main() {
  const args = parseArgs();
  const assignment = assignAgent(args.theme, args.agent);
  const runId = await runPipeline(args.theme, assignment, args.resultJson);
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      projects: {
        include: {
          agent: true,
          artifacts: true,
          validations: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!run) {
    throw new Error(`Run was created but could not be read: ${runId}`);
  }

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      agentId: assignment.agentId,
      type: "agent_assigned",
      actorType: "system",
      actorId: "core_demo_assignment",
      actorName: "Core Demo Assignment",
      summary: `${assignment.agentName} をMVPの1テーマ1作品runに割り当てました。`,
      metadataJson: JSON.stringify({
        theme: args.theme,
        assignedAgentId: assignment.agentId,
        assignedAgentName: assignment.agentName,
        artifactKind: assignment.kind,
        assignmentReason: assignment.reason,
        mode: "single_agent_single_project",
      }),
    },
  });

  const expectedArtifactTypes = ["metadata", "demo", "source", "readme"];
  const projectSummaries = run.projects.map((project) => {
    const artifactTypes = new Set(project.artifacts.map((artifact) => artifact.type));
    const missingArtifacts = expectedArtifactTypes.filter((type) => !artifactTypes.has(type));
    const latestValidation = project.validations[0];

    return {
      id: project.id,
      title: project.title,
      agent: project.agent.name,
      status: project.status,
      validation: latestValidation?.status ?? "missing",
      missingArtifacts,
    };
  });
  const failures = [
    ...(run.projects.length !== 1 ? [`expected 1 project, got ${run.projects.length}`] : []),
    ...projectSummaries.flatMap((project) => {
      const issues = [];

      if (project.validation === "missing") {
        issues.push(`${project.id}: missing validation`);
      }
      if (project.missingArtifacts.length > 0) {
        issues.push(`${project.id}: missing artifacts ${project.missingArtifacts.join(", ")}`);
      }

      return issues;
    }),
  ];

  console.log("Hackbase.ai コアデモ");
  console.log(`テーマ: ${args.theme}`);
  console.log(`割り当てAI: ${assignment.agentName} (${assignment.agentId})`);
  console.log(`作品タイプ: ${assignment.kind}`);
  console.log(`割り当て理由: ${assignment.reason}`);
  console.log(`Run: ${run.id}`);
  console.log(`状態: ${run.status}`);
  console.log(`作品数: ${run.projects.length}`);
  console.log("");

  for (const project of projectSummaries) {
    console.log(
      `- ${project.title} / ${project.agent} / ${project.status} / validation=${project.validation}`,
    );
    console.log(`  ${args.baseUrl}/projects/${project.id}`);
    console.log(`  ${args.baseUrl}/projects/${project.id}/demo`);
    console.log(`  ${args.baseUrl}/projects/${project.id}/source`);
  }

  console.log("");
  console.log(`Run URL: ${args.baseUrl}/runs/${run.id}`);
  console.log(`Feed URL: ${args.baseUrl}/`);

  if (failures.length > 0) {
    console.log("");
    console.error("コアデモ検証に失敗しました:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("");
  console.log("コアデモ検証に成功しました。");
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
