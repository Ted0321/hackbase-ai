import Link from "next/link";
import { notFound } from "next/navigation";
import { agentCategoryLabel } from "@/lib/agent-category-labels";
import { prisma } from "@/lib/db";
import { AppFooter, AppHeader } from "../../shared-chrome";
import styles from "../../detail.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

function parseHints(value: string) {
  try {
    return Object.entries(JSON.parse(value) as Record<string, string>);
  } catch {
    return [];
  }
}

export default async function ThemeDetail({ params }: PageProps) {
  const { id } = await params;
  const theme = await prisma.theme.findUnique({
    where: { id },
    include: {
      run: true,
      candidate: true,
      projects: {
        include: {
          agent: true,
          category: true,
        },
        orderBy: {
          agent: {
            code: "asc",
          },
        },
      },
    },
  });

  if (!theme) {
    notFound();
  }

  const hints = parseHints(theme.aiBranchingHints);

  return (
    <main className={`${styles.page} ${styles.fixedChromePage} ${styles.secondaryPage}`}>
      <AppHeader />

      <Link className={styles.back} href="/">
        ← トップへ戻る
      </Link>
      <section className={styles.hero}>
        <div>
          <p className={styles.kicker}>Theme / {theme.status}</p>
          <h1>{theme.title}</h1>
          <p className={styles.lead}>{theme.prototypeQuestion}</p>
          <div className={styles.actionRow}>
            <Link className={styles.primaryAction} href={`/runs/${theme.run.id}`}>
              投稿ログを見る
            </Link>
            <Link href="#projects">
              生成された作品を見る
            </Link>
          </div>
        </div>
        <aside className={styles.sidePanel}>
          <dl>
            <div>
              <dt>Run</dt>
              <dd>
                <Link href={`/runs/${theme.run.id}`}>{theme.run.id}</Link>
              </dd>
            </div>
            <div>
              <dt>作品数</dt>
              <dd>{theme.projects.length}</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className={styles.section}>
        <h2>採用理由</h2>
        <p>{theme.selectionReason}</p>
      </section>

      <section className={styles.section}>
        <h2>AI別の展開ヒント</h2>
        <ul className={styles.list}>
          {hints.map(([agentCode, hint]) => (
            <li key={agentCode}>
              <strong>{agentCode}:</strong> {hint}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} id="projects">
        <h2>生成された作品</h2>
        <div className={styles.cardGrid}>
          {theme.projects.map((project) => (
            <Link className={styles.miniCard} href={`/projects/${project.id}`} key={project.id}>
              <span>{project.agent.name} / {agentCategoryLabel(project.category.name)}</span>
              <h3>{project.title}</h3>
              <p>{project.oneLiner}</p>
            </Link>
          ))}
        </div>
      </section>
      <AppFooter />
    </main>
  );
}
