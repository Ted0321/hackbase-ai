import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type CandidateTheme = {
  id: string;
  theme: string;
  sourceInspiration: string;
  targetUser: string;
  userMoment: string;
  domain: string;
};

type GeneratedBrief = {
  theme: string;
  title: string;
  oneLiner: string;
  concept: string;
  interestingness: string;
  targetUser: string;
  userMoment: string;
  processSteps: Array<{ label: string; title: string; body: string }>;
  architecture: {
    dataSources: string[];
    orchestrator: string;
    aiRoles: string[];
    reviewRoles: string[];
    manager: string;
    output: string;
  };
  mockups: {
    topScreen: string;
    workspaceScreen: string;
  };
  codePlan: {
    sourceType: "static_html" | "next_app";
    files: string[];
    primaryComponent: string;
    validationHints: string[];
  };
  review: {
    score: number;
    rubric: Record<string, number>;
    strengths: string[];
    weaknesses: string[];
    improvement: string;
  };
};

const args = new Map<string, string>();
for (let index = 0; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (item.startsWith("--")) {
    args.set(item.slice(2), process.argv[index + 1] ?? "");
    index += 1;
  }
}

const iterations = Number.parseInt(args.get("iterations") ?? "3", 10);
const safeIterations = Number.isFinite(iterations) ? Math.max(1, Math.min(iterations, 8)) : 3;

const candidates: CandidateTheme[] = [
  {
    id: "hiring_panel",
    theme: "AI採用面接パネル",
    sourceInspiration:
      "複数の面接官が候補者を別々の観点で見て、最後に採用判断メモへまとめる。",
    targetUser: "採用担当者、面接官、スタートアップの創業者",
    userMoment: "面接後に評価が散らばり、誰が何を懸念しているのか見えにくいとき",
    domain: "people_ops",
  },
  {
    id: "incident_room",
    theme: "AIインシデント対応司令室",
    sourceInspiration:
      "SRE、サポート、広報、プロダクト担当のAIが障害対応を分担し、次アクションを整理する。",
    targetUser: "小規模プロダクトチーム、SRE、CS担当",
    userMoment: "障害発生直後に、原因調査、ユーザー影響、告知、復旧判断を同時に見る必要があるとき",
    domain: "ops",
  },
  {
    id: "paper_reading_room",
    theme: "AI論文読書会ワークベンチ",
    sourceInspiration:
      "複数AIが論文を手法、実験、限界、実装可能性に分けて読み、読書会メモへまとめる。",
    targetUser: "AIエンジニア、研究開発チーム、技術調査担当",
    userMoment: "新しい論文をチームで読む前に、どこを議論すべきかを整理したいとき",
    domain: "research",
  },
  {
    id: "requirements_review",
    theme: "AIプロダクト要件レビュー会議",
    sourceInspiration:
      "PM、デザイナー、エンジニア、QA、リスク担当AIが要件を読み、抜け漏れをレビューする。",
    targetUser: "PM、PdM、開発リード",
    userMoment: "仕様書を実装前にレビューし、曖昧さやリスクを潰したいとき",
    domain: "product",
  },
];

const roleSets: Record<string, { aiRoles: string[]; reviewRoles: string[]; output: string }> = {
  people_ops: {
    aiRoles: ["Skill Interviewer", "Culture Interviewer", "Hiring Manager", "Reference Checker"],
    reviewRoles: ["Bias Review", "Risk Review", "Level Calibration"],
    output: "Hiring decision memo",
  },
  ops: {
    aiRoles: ["SRE Analyst", "Customer Impact Analyst", "Comms Lead", "Product Owner"],
    reviewRoles: ["Severity Review", "Rollback Review", "Customer Trust Review"],
    output: "Incident action memo",
  },
  research: {
    aiRoles: ["Method Reader", "Experiment Reader", "Limitations Reader", "Implementation Reader"],
    reviewRoles: ["Novelty Review", "Reproducibility Review", "Adoption Risk Review"],
    output: "Reading group memo",
  },
  product: {
    aiRoles: ["PM Reviewer", "Design Reviewer", "Engineering Reviewer", "QA Reviewer"],
    reviewRoles: ["Scope Review", "Risk Review", "Launch Readiness Review"],
    output: "Requirements review memo",
  },
};

const promptPrinciples = [
  "AIをチャット相手ではなく、役割を持つ小さなチームとして見せる。",
  "便利さではなく、何が面白いか・どこが新しいかを先に書く。",
  "Processは順番、Architectureは部品接続として必ず分ける。",
  "外部API、秘密情報、課金API、ログイン必須をMVPに入れない。",
  "コードはArtifact Storeに残る小さなWeb作品として考える。",
];

function buildBrief(candidate: CandidateTheme, iteration: number, previousImprovement?: string): GeneratedBrief {
  const roles = roleSets[candidate.domain] ?? roleSets.product;
  const maturity = iteration >= 3 ? "code_ready" : iteration >= 2 ? "page_ready" : "rough";
  const focus = maturity === "rough" ? "role clarity" : maturity === "page_ready" ? "mockup clarity" : "code feasibility";
  const title = candidate.theme.replace(/^AI/, "AI");

  const processSteps = [
    {
      label: "01",
      title: "対象を入力",
      body: `${candidate.userMoment}に、対象情報と制約を入力する。`,
    },
    {
      label: "02",
      title: "材料を集める",
      body: "手元のメモ、ログ、評価観点、参考情報をローカル素材として整理する。",
    },
    {
      label: "03",
      title: "AIが分担して読む",
      body: `${roles.aiRoles.slice(0, 4).join(" / ")} が別々の観点で解釈する。`,
    },
    ...(maturity === "rough"
      ? [
          {
            label: "04",
            title: "判断メモを出す",
            body: `${roles.output} として、人間が次に確認する論点を残す。`,
          },
        ]
      : [
          {
            label: "04",
            title: "レビューでぶつける",
            body: `${roles.reviewRoles.join(" / ")} を通して偏りや抜け漏れを確認する。`,
          },
          {
            label: "05",
            title: "判断メモを出す",
            body: `${roles.output} として、人間が次に確認すべき論点を残す。`,
          },
        ]),
  ];

  const concept = `${title}は、${candidate.sourceInspiration} ための小さなWebワークスペースです。AIを単独の回答者ではなく、役割を持つチームとして配置し、人間が判断する前に論点の偏りを見えるようにします。`;
  const interestingness =
    maturity === "rough"
      ? `${candidate.theme}の面白さは、複数のAIが別々の観点で読む点です。`
      : `${candidate.theme}の面白さは、AIの答えを1つにまとめるのではなく、複数の役割が別々に読んで、最後にレビューでぶつける構造を画面に出す点です。${roles.aiRoles[0]} と ${roles.reviewRoles[0]} が同じ対象を違う角度から見るため、人間は結論だけでなく判断の作られ方を確認できます。`;

  const brief: GeneratedBrief = {
    theme: candidate.theme,
    title,
    oneLiner: `${candidate.targetUser}が、${candidate.userMoment}に使うAIチーム型レビュー画面。`,
    concept,
    interestingness,
    targetUser: candidate.targetUser,
    userMoment: candidate.userMoment,
    processSteps,
    architecture: {
      dataSources: ["User notes", "Local documents", "Past decisions", "Review checklist"],
      orchestrator: "入力素材を各AIロールへ配り、比較しやすい形で集約する。",
      aiRoles: roles.aiRoles,
      reviewRoles: maturity === "rough" ? roles.reviewRoles.slice(0, 1) : roles.reviewRoles,
      manager: "複数ロールの見解を統合し、人間向けの判断メモへ編集する。",
      output: roles.output,
    },
    mockups: {
      topScreen:
        maturity === "rough"
          ? `トップ画面では、対象入力と開始ボタンを見せる。${focus}を特に強調する。`
          : `トップ画面では、対象入力、制約、レビュー観点、開始ボタン、最近の判断メモを見せる。${focus}を特に強調する。`,
      workspaceScreen:
        maturity === "rough"
          ? "作業画面では、AIロール別カードと判断メモを配置する。"
          : "作業画面では、左に入力素材、中央にAIロール別カード、右にレビュー観点、下に判断メモを配置する。",
    },
    codePlan: {
      sourceType: "static_html",
      files:
        maturity === "code_ready"
          ? ["README.md", "source.tsx", "metadata.json", "mockups/mockup-manifest.json", "validation/code-review.json"]
          : maturity === "page_ready"
            ? ["README.md", "source.tsx", "metadata.json", "mockups/mockup-manifest.json"]
            : ["README.md", "source.tsx", "metadata.json"],
      primaryComponent: `${candidate.id.replace(/(^|_)([a-z])/g, (_, __, char: string) => char.toUpperCase())}Workspace`,
      validationHints:
        maturity === "code_ready"
          ? ["metadata_complete", "artifact_exists", "prompt_injection_like", "external_dependency_like", "secret_like"]
          : ["metadata_complete", "artifact_exists"],
    },
    review: {
      score: 0,
      rubric: {},
      strengths: [],
      weaknesses: [],
      improvement: previousImprovement ?? "初回生成のため、教師サンプル原則をそのまま適用する。",
    },
  };

  brief.review = reviewBrief(brief);
  return brief;
}

function scoreText(value: string, patterns: RegExp[]) {
  return patterns.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
}

function reviewBrief(brief: Omit<GeneratedBrief, "review"> & { review?: GeneratedBrief["review"] }): GeneratedBrief["review"] {
  const combined = `${brief.concept}\n${brief.interestingness}\n${brief.mockups.topScreen}\n${brief.mockups.workspaceScreen}`;
  const rubric = {
    interestingness: Math.min(5, 1 + scoreText(brief.interestingness, [/面白さ/, /役割/, /判断/, /構造/, /作られ方/])),
    roleClarity: Math.min(5, 1 + brief.architecture.aiRoles.length),
    processClarity: brief.processSteps.length === 5 && brief.processSteps.some((step) => step.title.includes("レビュー")) ? 5 : 3,
    architectureClarity:
      brief.architecture.dataSources.length > 0 &&
      brief.architecture.aiRoles.length > 0 &&
      brief.architecture.reviewRoles.length > 0
        ? 5
        : 3,
    mockupClarity: Math.min(5, 1 + scoreText(combined, [/トップ画面/, /作業画面/, /カード/, /レビュー観点/, /判断メモ/])),
    codeFeasibility:
      brief.codePlan.sourceType === "static_html" &&
      brief.codePlan.files.includes("source.tsx") &&
      brief.codePlan.files.includes("mockups/mockup-manifest.json") &&
      brief.codePlan.files.includes("validation/code-review.json") &&
      brief.codePlan.validationHints.length >= 5
        ? 5
        : brief.codePlan.files.includes("mockups/mockup-manifest.json")
          ? 4
          : 3,
    riskLow: scoreText(combined, [/外部API|課金|秘密|ログイン/]) > 0 ? 3 : 5,
  };

  const score = Object.values(rubric).reduce((sum, value) => sum + value, 0);
  const weaknesses = Object.entries(rubric)
    .filter(([, value]) => value < 5)
    .map(([key]) => key);
  const strengths = Object.entries(rubric)
    .filter(([, value]) => value >= 5)
    .map(([key]) => key);

  return {
    score,
    rubric,
    strengths,
    weaknesses,
    improvement:
      weaknesses.length === 0
        ? "次は実際のUIモックとsource/ディレクトリ保存へ進める。"
        : `次ループでは ${weaknesses.join(", ")} を強める。特に画面上にAIロールとレビュー観点を明示する。`,
  };
}

function markdownReport(iteration: number, briefs: GeneratedBrief[]) {
  const best = [...briefs].sort((a, b) => b.review.score - a.review.score)[0];
  const rows = briefs
    .map(
      (brief) =>
        `| ${brief.theme} | ${brief.review.score}/35 | ${brief.review.strengths.join(", ")} | ${brief.review.weaknesses.join(", ") || "-"} |`,
    )
    .join("\n");

  return `# Modelcase Loop ${iteration}

## Teacher Sample Principles

${promptPrinciples.map((item) => `- ${item}`).join("\n")}

## Scores

| Theme | Score | Strengths | Weaknesses |
|---|---:|---|---|
${rows}

## Best Candidate

${best.title} (${best.review.score}/35)

### Concept

${best.concept}

### Interestingness

${best.interestingness}

### Process

${best.processSteps.map((step) => `- ${step.label} ${step.title}: ${step.body}`).join("\n")}

### Architecture

- Data Sources: ${best.architecture.dataSources.join(", ")}
- Orchestrator: ${best.architecture.orchestrator}
- AI Roles: ${best.architecture.aiRoles.join(", ")}
- Review Roles: ${best.architecture.reviewRoles.join(", ")}
- Manager: ${best.architecture.manager}
- Output: ${best.architecture.output}

### Mockups

- Top: ${best.mockups.topScreen}
- Workspace: ${best.mockups.workspaceScreen}

### Code Plan

- sourceType: ${best.codePlan.sourceType}
- files: ${best.codePlan.files.join(", ")}
- primaryComponent: ${best.codePlan.primaryComponent}

### Improvement

${best.review.improvement}
`;
}

async function main() {
  const runStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const root = path.join(process.cwd(), "artifacts", "modelcase-experiments", runStamp);
  await mkdir(root, { recursive: true });

  let previousImprovement: string | undefined;
  const summary: Array<{ iteration: number; bestTheme: string; score: number; path: string }> = [];

  for (let iteration = 1; iteration <= safeIterations; iteration += 1) {
    const briefs = candidates.map((candidate) => buildBrief(candidate, iteration, previousImprovement));
    const best = [...briefs].sort((a, b) => b.review.score - a.review.score)[0];
    const iterationDir = path.join(root, `iteration-${iteration}`);
    await mkdir(iterationDir, { recursive: true });
    await writeFile(path.join(iterationDir, "briefs.json"), JSON.stringify({ iteration, briefs }, null, 2));
    await writeFile(path.join(iterationDir, "report.md"), markdownReport(iteration, briefs));
    previousImprovement = best.review.improvement;
    summary.push({
      iteration,
      bestTheme: best.theme,
      score: best.review.score,
      path: path.join("artifacts", "modelcase-experiments", runStamp, `iteration-${iteration}`, "report.md"),
    });
  }

  const summaryBody = JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      teacherSample: "AI投資会議ダッシュボード",
      promptPrinciples,
      iterations: summary,
      checksum: createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
    },
    null,
    2,
  );
  await writeFile(path.join(root, "summary.json"), summaryBody);

  console.log(`Modelcase experiment: artifacts/modelcase-experiments/${runStamp}`);
  for (const item of summary) {
    console.log(`- iteration ${item.iteration}: ${item.bestTheme} ${item.score}/35`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
