import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type SourceType =
  | "github_trending"
  | "hacker_news"
  | "product_hunt"
  | "official_ai_release"
  | "human_feedback";

type SignalCard = {
  id: string;
  sourceType: SourceType;
  title: string;
  url: string;
  freshness: number;
  momentum: number;
  technicalNovelty: number;
  productizability: number;
  reproducibility: number;
  visualPotential: number;
  risk: number;
  summary: string;
  whyItMatters: string;
  transferAngles: string[];
};

type ProductConcept = {
  id: string;
  title: string;
  oneLiner: string;
  targetUser: string;
  userMoment: string;
  roles: string[];
  outputName: string;
  concept: string;
  interestingness: string;
  nextGrowth: string;
  process: string[];
  architecture: string[];
  mockups: string[];
  sourcePlan: string[];
  risks: string[];
};

type Review = {
  score: number;
  maxScore: number;
  rubric: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  promptPatch: string[];
};

type IterationResult = {
  iteration: number;
  selectedSignals: SignalCard[];
  concepts: Array<ProductConcept & { review: Review }>;
  best: ProductConcept & { review: Review };
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (item.startsWith("--")) {
    args.set(item.slice(2), process.argv[index + 1] ?? "");
    index += 1;
  }
}

const iterationsArg = Number.parseInt(args.get("iterations") ?? "4", 10);
const iterations = Number.isFinite(iterationsArg) ? Math.max(1, Math.min(iterationsArg, 8)) : 4;
const passScore = Number.parseInt(args.get("pass-score") ?? "36", 10);

const signals: SignalCard[] = [
  {
    id: "github_trading_agents",
    sourceType: "github_trending",
    title: "TradingAgents",
    url: "https://github.com/TauricResearch/TradingAgents",
    freshness: 4,
    momentum: 5,
    technicalNovelty: 5,
    productizability: 5,
    reproducibility: 4,
    visualPotential: 5,
    risk: 2,
    summary: "複数AIエージェントを投資判断組織のように分担させるフレームワーク。",
    whyItMatters: "AIの回答ではなく、役割分担、議論、レビュー、最終判断の流れ自体をプロダクト化できる。",
    transferAngles: ["投資以外の意思決定", "専門家チーム風UI", "レビュー会議の可視化"],
  },
  {
    id: "hn_agentic_coding",
    sourceType: "hacker_news",
    title: "Agentic coding workflows",
    url: "https://news.ycombinator.com/",
    freshness: 5,
    momentum: 4,
    technicalNovelty: 4,
    productizability: 4,
    reproducibility: 3,
    visualPotential: 4,
    risk: 2,
    summary: "AIコーディングエージェントが、開発タスクを長い単位で引き受け始めている。",
    whyItMatters: "人間が指示するだけでなく、AIの作業計画、差分、検証を観測するUIが必要になる。",
    transferAngles: ["作業履歴の観測", "レビュー待ちキュー", "AI担当者の進捗ボード"],
  },
  {
    id: "official_ai_long_horizon",
    sourceType: "official_ai_release",
    title: "Long-horizon AI agent capability",
    url: "https://openai.com/",
    freshness: 4,
    momentum: 4,
    technicalNovelty: 5,
    productizability: 4,
    reproducibility: 3,
    visualPotential: 3,
    risk: 3,
    summary: "AIが単発回答から、長めの委任タスクや複数ステップの実行へ広がっている。",
    whyItMatters: "ユーザーは結果だけでなく、途中で何を根拠に判断したかを見たい。",
    transferAngles: ["長時間タスクのダッシュボード", "根拠ログ", "自動実行の安全確認"],
  },
  {
    id: "human_feedback_readability",
    sourceType: "human_feedback",
    title: "作品ページはユーザー向けに短く、でも構造は深く",
    url: "local://DOC-26",
    freshness: 5,
    momentum: 5,
    technicalNovelty: 3,
    productizability: 5,
    reproducibility: 5,
    visualPotential: 5,
    risk: 1,
    summary: "概要、面白さ、新規性、図解、モックアップ、コード導線をユーザー目線に整理する。",
    whyItMatters: "AI生成物の説明が制作者向けになると、見た人に価値が伝わらない。",
    transferAngles: ["README風作品ページ", "プロセス図とアーキテクチャ図の分離", "コードを見る導線"],
  },
];

const domainFrames = [
  {
    id: "security_review_room",
    title: "AIセキュリティレビュー会議ダッシュボード",
    targetUser: "小さな開発チームのPM、エンジニア、セキュリティ担当",
    userMoment: "リリース前に、脆弱性、依存関係、権限、ログ出力の論点を短時間で確認したいとき",
    roles: ["脆弱性アナリスト", "依存関係レビューAI", "権限設計AI", "リリース判定AI"],
    output: "リリース前リスク判定メモ",
  },
  {
    id: "customer_research_room",
    title: "AI顧客インサイト会議ボード",
    targetUser: "新機能を検討しているPdM、UXリサーチャー、創業者",
    userMoment: "問い合わせ、レビュー、商談メモから、次に作るべき機能の仮説を整理したいとき",
    roles: ["課題抽出AI", "反対意見AI", "価値仮説AI", "優先度判定AI"],
    output: "顧客インサイト優先度メモ",
  },
  {
    id: "research_to_product_room",
    title: "AI研究プロダクト化会議ボード",
    targetUser: "論文や新技術をプロダクト案に変えたい開発者、事業開発、個人開発者",
    userMoment: "新しい論文やOSSを見つけたが、何を作れば面白いか決めたいとき",
    roles: ["手法解説AI", "用途探索AI", "実装難度AI", "デモ企画AI"],
    output: "プロダクト化仮説メモ",
  },
];

const promptPatchesByIteration = [
  "良いOSSを紹介するだけでなく、別領域へ転用したときの非自明さを書く。",
  "ユーザーの利用場面を先に固定し、画面の主要ボタンまで言語化する。",
  "プロセス図は実行順、アーキテクチャ図は構成要素と責務として分ける。",
  "source tree、validation、リスク制約を作品ページのコード導線につなげる。",
];

function signalScore(signal: SignalCard) {
  return (
    signal.freshness +
    signal.momentum +
    signal.technicalNovelty +
    signal.productizability +
    signal.reproducibility +
    signal.visualPotential -
    signal.risk
  );
}

function selectSignals(iteration: number) {
  const sorted = [...signals].sort((a, b) => signalScore(b) - signalScore(a));
  return iteration < 3 ? sorted.slice(0, 2) : sorted.slice(0, 3);
}

function buildConcept(frame: (typeof domainFrames)[number], selectedSignals: SignalCard[], iteration: number): ProductConcept {
  const signalTitles = selectedSignals.map((signal) => signal.title).join(" / ");
  const transfer = selectedSignals.flatMap((signal) => signal.transferAngles).slice(0, 4).join("、");
  const detailLevel = iteration >= 3 ? "high" : iteration >= 2 ? "medium" : "low";

  return {
    id: frame.id,
    title: frame.title,
    oneLiner: `${frame.targetUser}が、${frame.userMoment}に使うAI会議型の小さなWebツール。`,
    targetUser: frame.targetUser,
    userMoment: frame.userMoment,
    roles: frame.roles,
    outputName: frame.output,
    concept: `${signalTitles}から得た「複数AIが役割を持って判断過程を見せる」という型を、${frame.userMoment}のために転用する。単一のAI回答ではなく、専門役の見解、反対意見、レビュー、最終メモを分けて見せることで、人間が判断の根拠を追えるようにする。`,
    interestingness:
      detailLevel === "low"
        ? `面白さは、AIを1つの回答機ではなく、${frame.roles.join("、")}という小さな組織として見せる点にある。`
        : `面白さは、${transfer}という流れを、${frame.title}として具体化する点にある。単一のAI回答ではなく、複数の役割が同じ材料を別々の角度で読み、最後に${frame.output}へ束ねる。そのため、ユーザーは「なぜその判断になったか」を画面上で追える。`,
    nextGrowth:
      detailLevel === "high"
        ? "次は、実データ取り込み、過去判断との差分、AIごとの得意不得意、フィードバック反映履歴を追加し、毎回の会議が学習していく形に伸ばす。"
        : "次は、実データ取り込みと、判断履歴の比較に伸ばす。",
    process:
      detailLevel === "low"
        ? ["入力を集める", "AIが役割別に読む", "最終メモを作る"]
        : [
            "ユーザーが対象データと判断したい問いを入力する",
            `${frame.roles[0]}と${frame.roles[1]}が、根拠と懸念を分けて抽出する`,
            `${frame.roles[2]}が、抜け漏れや反対意見を整理する`,
            `${frame.roles[3]}が、採用、保留、却下の判定案を作る`,
            "人間が最終メモを確認し、コメントを残す",
          ],
    architecture:
      detailLevel === "high"
        ? [
            "Input Store: URL、メモ、CSV、READMEなどを保存する",
            "Orchestrator: 入力を役割ごとのタスクに分解する",
            `Role Agents: ${frame.roles.join(" / ")}が並列に読む`,
            "Review Layer: 重複、根拠不足、外部依存、危険な提案を確認する",
            `Output Store: ${frame.output}、根拠ログ、コメントを保存する`,
          ]
        : [
            "Input Store: ユーザー入力を保存する",
            `Role Agents: ${frame.roles.join(" / ")}が読む`,
            `Output: ${frame.output}を作る`,
          ],
    mockups:
      detailLevel === "high"
        ? [
            "トップ画面: 左に入力フォーム、中央にAIロールの状態カード、右に最新の判定メモ。主要ボタンは「材料を追加」「会議を開始」「コードを見る」。",
            "作業画面: 上部に進捗ステップ、中央に役割別コメント、下部に最終メモと人間コメント欄。保留理由と次アクションを強調する。",
          ]
        : [
            "トップ画面: 入力フォームとAIロールカードを並べる。",
            "作業画面: 役割別コメントと最終メモを表示する。",
          ],
    sourcePlan:
      detailLevel === "high"
        ? [
            "README.md: コンセプト、面白さ、操作手順、制約",
            "source/app/page.tsx: 静的な会議ボードUI",
            "source/app/styles.module.css: モックアップ相当の見た目",
            "diagrams/process.json: 実行順",
            "diagrams/architecture.json: 構成要素",
            "validation/self-review.json: rubric結果",
          ]
        : ["README.md", "source/app/page.tsx", "metadata.json"],
    risks: ["外部APIの自動実行はしない", "秘密情報を保存しない", "最終判断は人間が確認する"],
  };
}

function scoreConcept(concept: ProductConcept, iteration: number): Review {
  const rubric = {
    interestingness: concept.interestingness.includes("なぜ") || concept.interestingness.includes("面白さ") ? 5 : 3,
    novelty: concept.concept.includes("転用") && concept.interestingness.includes("単一のAI回答ではなく") ? 5 : 3,
    userClarity: concept.targetUser.length > 20 && concept.userMoment.length > 20 ? 5 : 3,
    processClarity: concept.process.length >= 5 ? 5 : 3,
    architectureClarity: concept.architecture.length >= 5 ? 5 : 3,
    mockupClarity: concept.mockups.join("\n").includes("主要ボタン") ? 5 : 3,
    codeFeasibility: concept.sourcePlan.some((item) => item.includes("source/app/page.tsx")) && concept.sourcePlan.length >= 5 ? 5 : 3,
    riskControl: concept.risks.length >= 3 ? 5 : 4,
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
    maxScore: 40,
    rubric,
    strengths,
    weaknesses,
    promptPatch:
      weaknesses.length === 0
        ? ["次は実Signal Cardを接続し、同じ評価で品質が落ちないか確認する。"]
        : [promptPatchesByIteration[Math.min(iteration - 1, promptPatchesByIteration.length - 1)], ...weaknesses.map((key) => `${key}を次回生成プロンプトで明示する。`)],
  };
}

function reportMarkdown(result: IterationResult) {
  const rows = result.concepts
    .map((concept) => `| ${concept.title} | ${concept.review.score}/40 | ${concept.review.strengths.join(", ")} | ${concept.review.weaknesses.join(", ") || "-"} |`)
    .join("\n");

  return `# IPO Quality Loop Iteration ${result.iteration}

## Selected Signals

${result.selectedSignals
  .map(
    (signal) =>
      `- ${signal.title} (${signal.sourceType}): ${signal.whyItMatters} / score ${signalScore(signal)}`,
  )
  .join("\n")}

## Candidate Scores

| Candidate | Score | Strengths | Weaknesses |
|---|---:|---|---|
${rows}

## Best Candidate

### ${result.best.title}

${result.best.oneLiner}

### コンセプト

${result.best.concept}

### 面白さ・新規性

${result.best.interestingness}

### 次に伸ばすなら

${result.best.nextGrowth}

### プロセス

${result.best.process.map((item, index) => `${index + 1}. ${item}`).join("\n")}

### アーキテクチャ

${result.best.architecture.map((item) => `- ${item}`).join("\n")}

### モックアップ

${result.best.mockups.map((item) => `- ${item}`).join("\n")}

### コード保管方針

${result.best.sourcePlan.map((item) => `- ${item}`).join("\n")}

### Prompt Patch

${result.best.review.promptPatch.map((item) => `- ${item}`).join("\n")}
`;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const root = path.join(process.cwd(), "artifacts", "ipo-quality-loops", stamp);
  await mkdir(root, { recursive: true });

  const results: IterationResult[] = [];
  let reachedPass = false;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const selectedSignals = selectSignals(iteration);
    const concepts = domainFrames.map((frame) => {
      const concept = buildConcept(frame, selectedSignals, iteration);
      return { ...concept, review: scoreConcept(concept, iteration) };
    });
    const best = [...concepts].sort((a, b) => b.review.score - a.review.score)[0];
    const result = { iteration, selectedSignals, concepts, best };
    results.push(result);

    const iterationDir = path.join(root, `iteration-${iteration}`);
    await mkdir(iterationDir, { recursive: true });
    await writeFile(path.join(iterationDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
    await writeFile(path.join(iterationDir, "report.md"), reportMarkdown(result), "utf8");

    if (best.review.score >= passScore) {
      reachedPass = true;
      break;
    }
  }

  const finalBest = results[results.length - 1].best;
  const summary = {
    version: 1,
    createdAt: new Date().toISOString(),
    passScore,
    reachedPass,
    finalScore: finalBest.review.score,
    finalTitle: finalBest.title,
    finalThemeForCoreDemo: finalBest.title,
    outputRoot: path.relative(process.cwd(), root),
    checksum: createHash("sha256").update(JSON.stringify(results)).digest("hex"),
    iterations: results.map((result) => ({
      iteration: result.iteration,
      bestTitle: result.best.title,
      score: result.best.review.score,
      weaknesses: result.best.review.weaknesses,
    })),
  };

  await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(
    path.join(root, "next-core-demo-theme.txt"),
    `${finalBest.title}\n${finalBest.oneLiner}\n`,
    "utf8",
  );

  console.log(`IPO quality loop: ${summary.outputRoot}`);
  console.log(`Best: ${summary.finalTitle} (${summary.finalScore}/40)`);
  console.log(`Reached pass: ${summary.reachedPass ? "yes" : "no"}`);
  console.log(`Next core:demo theme: ${summary.finalThemeForCoreDemo}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
