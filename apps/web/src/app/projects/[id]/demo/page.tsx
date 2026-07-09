import Link from "next/link";
import { notFound } from "next/navigation";
import { agentCategoryLabel } from "@/lib/agent-category-labels";
import { prisma } from "@/lib/db";
import { readStoredArtifactFile, readStoredArtifactMetadata } from "@/lib/artifact-store";
import { isPublicProject, publicProjectWhere } from "@/lib/project-visibility";
import { ProjectDemoById } from "@/project-artifacts/catalog";
import { projectArtifactMeta } from "@/project-artifacts/metadata";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import styles from "../../../detail.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

const isTradingAgentsProject = (title: string, themeTitle?: string) => {
  const text = `${title} ${themeTitle ?? ""}`.toLowerCase();
  return text.includes("tradingagents") || text.includes("投資") || text.includes("trading");
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });

function TradingArchitecture() {
  return (
    <div className={styles.tradingArchitecture} aria-label="TradingAgents風のアーキテクチャ図">
      <div className={styles.archInputs}>
        <h3>入力ソース</h3>
        <span>市場データ</span>
        <span>SNS / Reddit</span>
        <span>ニュース</span>
        <span>企業情報</span>
      </div>
      <div className={styles.archResearch}>
        <h3>Researcher Team</h3>
        <div className={styles.bullishBox}>Bullish</div>
        <div className={styles.archDiscussion}>Discussion</div>
        <div className={styles.bearishBox}>Bearish</div>
      </div>
      <div className={styles.archTrader}>
        <h3>Trader</h3>
        <p>強気材料と弱気材料を受け取り、売買ではなく判断メモとして組み立てます。</p>
      </div>
      <div className={styles.archRisk}>
        <h3>Risk Management Team</h3>
        <span>Aggressive</span>
        <span>Neutral</span>
        <span>Conservative</span>
      </div>
      <div className={styles.archManager}>
        <h3>Manager</h3>
        <p>リスク評価を踏まえて、最終判断と次に見る指標をまとめます。</p>
      </div>
      <div className={styles.archExecution}>Execution / Report</div>
    </div>
  );
}

export default async function ProjectDemo({ params }: PageProps) {
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: {
      ...publicProjectWhere,
      id,
    },
    include: {
      agent: true,
      category: true,
      theme: true,
    },
  });

  if (!project || !isPublicProject(project)) {
    notFound();
  }

  const artifact = projectArtifactMeta[project.id];
  const storedArtifact = artifact ? null : await readStoredArtifactMetadata(project.artifactRoot);
  const storedDemo = storedArtifact
    ? await readStoredArtifactFile(project.artifactRoot, "demo.html")
    : null;
  const showTradingArchitecture = isTradingAgentsProject(project.title, project.theme.title);
  const categoryLabel = agentCategoryLabel(project.category.name);
  const demoPoints = [
    {
      label: "入力",
      body: `作品ページの説明、保存された制作証跡、カテゴリ「${categoryLabel}」を起点に確認します。`,
    },
    {
      label: "AIの進め方",
      body: `${project.agent.name}が、材料をどのように画面と操作へ落としたかを作品単位で見ます。`,
    },
    {
      label: "検証",
      body: "ライブAPIやsecretに依存せず、提出動画で再現できる静的な作品として確認できます。",
    },
    {
      label: "出力",
      body: `「${project.title}」の価値、使いどころ、次に伸ばす余地を短時間で把握できます。`,
    },
  ];
  const fallbackDemoHtml = `
    <main style="font-family: system-ui, sans-serif; padding: 24px; color: #0e1a27; line-height: 1.7;">
      <h1 style="margin: 0 0 12px; font-size: 24px;">${escapeHtml(project.title)}</h1>
      <p>${escapeHtml(project.oneLiner)}</p>
      <p>この作品の専用デモファイルはまだ保存されていません。作品ページとコード画面で、生成物の概要と制作証跡を確認できます。</p>
    </main>
  `;

  if (!artifact && !storedArtifact) {
    notFound();
  }

  return (
    <main className={styles.readmePage}>
      <AppHeader />

      <Link className={styles.back} href={`/projects/${project.id}`}>
        ← {project.title}
      </Link>
      <header className={styles.readmeHero}>
        <p className={styles.kicker}>デモ</p>
        <h1>{project.title}</h1>
        <p className={styles.lead}>{project.oneLiner}</p>
        <div className={styles.actionRow}>
          <Link href={`/projects/${project.id}/source`}>
            <span className={styles.buttonIcon} aria-hidden="true">&lt;/&gt;</span>
            コードを見る
          </Link>
        </div>
      </header>
      <section className={styles.readmeSummary} aria-label="デモの要点">
        {demoPoints.map((point) => (
          <div key={point.label}>
            <span>{point.label}</span>
            <p>{point.body}</p>
          </div>
        ))}
      </section>
      {showTradingArchitecture ? (
        <section className={styles.readmeSection}>
          <h2>アーキテクチャ</h2>
          <TradingArchitecture />
        </section>
      ) : null}
      <section className={styles.readmeSection}>
        <h2>デモ画面</h2>
        {artifact ? (
          <ProjectDemoById projectId={project.id} />
        ) : (
          <iframe
            className={styles.demoFrame}
            sandbox="allow-scripts"
            srcDoc={storedDemo ?? fallbackDemoHtml}
            title={`${project.title} デモ`}
          />
        )}
      </section>
      <AppFooter codeHref={`/projects/${project.id}/source`} />
    </main>
  );
}
