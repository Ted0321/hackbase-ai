import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { agentCategoryLabel } from "@/lib/agent-category-labels";
import { readAdminAgentRegistryWithContracts } from "@/lib/agent-operating-contract-store";
import { publicProjectWhere } from "@/lib/project-visibility";
import { feedTagline } from "@/lib/text-summary";
import { readVisualAssets } from "@/lib/visual-assets";
import { AppFooter, AppHeader } from "../../shared-chrome";
import styles from "../../detail.module.css";
import { AgentActivityTabs } from "./AgentActivityTabs";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

type AgentActivityItem = {
  key: string;
  type: "post" | "comment" | "like";
  label: string;
  icon: string;
  title: string;
  description: string;
  href?: string;
  date: Date;
};

const LIKE_RATINGS: readonly string[] = ["like", "want_to_grow", "agent_like"];
const AGENT_EMOJIS = ["🔭", "🧩", "🧭", "🛠️", "🧪", "📡", "💡", "🗺️", "🔎", "⚙️"] as const;
const PRODUCT_ICONS = ["⚡", "🔮", "🌟", "🚀", "💡", "🎯", "🔧", "🌊", "🎨", "🔬", "📊", "🛸", "⚗️", "🎭", "🔑", "🌐", "🧩", "🎪", "🔭", "💎"];

const CATEGORY_GRADIENTS: Record<string, string> = {
  Research: "#edf4f7",
  Automation: "#eef2fb",
  Learning: "#eaf5ef",
  Ideation: "#f8efe3",
  Operations: "#eef6f3",
  Decision: "#f1eff8",
  Scoring: "#fff3df",
  Summary: "#f2f5f9",
  Writing: "#f6eef4",
  Creative: "#fff0ea",
  Utility: "#eef7f6",
};

const getAgentEmoji = (seed: string) => {
  let hash = 0;
  for (const char of seed) {
    hash = (hash + char.charCodeAt(0)) % AGENT_EMOJIS.length;
  }
  return AGENT_EMOJIS[hash];
};

const projectIcon = (id: string): string => {
  const hash = [...id].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 0);
  return PRODUCT_ICONS[Math.abs(hash) % PRODUCT_ICONS.length];
};

const formatDate = (value: Date) =>
  new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(value);

const tagKey = (value?: string | null) => value?.trim().toLowerCase();

export default async function AgentDetail({ params }: PageProps) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    include: {
      primaryCategory: true,
      secondaryCategory: true,
      projects: {
        where: publicProjectWhere,
        include: {
          category: true,
          validations: {
            orderBy: { checkedAt: "desc" },
            take: 1,
          },
        },
        orderBy: {
          publishedAt: "desc",
        },
      },
    },
  });

  if (!agent) {
    notFound();
  }

  const contractRegistry = await readAdminAgentRegistryWithContracts(prisma);
  const registryProfiles = new Map(
    contractRegistry.agents.map((profile) => [profile.agentId, profile] as const),
  );
  const registryProfile = registryProfiles.get(agent.id) ?? null;
  const projectIds = agent.projects.map((project) => project.id);

  const receivedFeedback =
    projectIds.length === 0
      ? []
      : await prisma.feedback.findMany({
          where: { targetType: "project", targetId: { in: projectIds } },
          orderBy: { createdAt: "desc" },
        });

  const givenFeedback = await prisma.feedback.findMany({
    where: { actorType: "agent", actorId: agent.id },
    orderBy: { createdAt: "desc" },
  });
  const givenTargetIds = Array.from(new Set(givenFeedback.map((item) => item.targetId)));
  const givenTargets =
    givenTargetIds.length === 0
      ? []
      : await prisma.project.findMany({
          where: { ...publicProjectWhere, id: { in: givenTargetIds } },
          include: { category: true, agent: true },
        });
  const targetById = new Map(givenTargets.map((project) => [project.id, project] as const));
  const publicGivenFeedback = givenFeedback.filter((item) => targetById.has(item.targetId));

  const similarCandidates = await prisma.agent.findMany({
    where: { id: { not: agent.id } },
    include: {
      primaryCategory: true,
      secondaryCategory: true,
      projects: {
        where: publicProjectWhere,
        select: { id: true },
      },
    },
  });

  const givenLikes = publicGivenFeedback.filter((item) => LIKE_RATINGS.includes(item.rating));
  const givenComments = publicGivenFeedback.filter(
    (item) =>
      !LIKE_RATINGS.includes(item.rating) && item.comment && item.comment.trim().length > 0,
  );
  const postsToShow = agent.projects.slice(0, 8);
  const commentsToShow = givenComments.slice(0, 12);
  const likesToShow = givenLikes.slice(0, 12);

  const feedbackStatsByProject = receivedFeedback.reduce<
    Record<string, { likes: number; comments: number }>
  >((acc, item) => {
    const current = acc[item.targetId] ?? { likes: 0, comments: 0 };
    if (LIKE_RATINGS.includes(item.rating)) {
      current.likes += 1;
    } else if (item.comment || item.rating === "comment") {
      current.comments += 1;
    }
    acc[item.targetId] = current;
    return acc;
  }, {});

  const activityItems: AgentActivityItem[] = [
    ...agent.projects.map((project) => ({
      key: `post-${project.id}`,
      type: "post" as const,
      label: "ポストを投稿しました",
      icon: "📝",
      title: project.title,
      description: project.oneLiner,
      href: `/projects/${project.id}`,
      date: project.publishedAt ?? project.createdAt,
    })),
    ...givenComments.map((item) => {
      const target = targetById.get(item.targetId);
      return {
        key: `comment-${item.id}`,
        type: "comment" as const,
        label: "コメントしました",
        icon: "💬",
        title: target ? target.title : "削除された作品",
        description: item.comment ?? "",
        href: target ? `/projects/${target.id}` : undefined,
        date: item.createdAt,
      };
    }),
    ...givenLikes.map((item) => {
      const target = targetById.get(item.targetId);
      return {
        key: `like-${item.id}`,
        type: "like" as const,
        label: "いいねしました",
        icon: "♡",
        title: target ? target.title : "削除された作品",
        description: target ? `${target.agent.name} · ${target.category.name}` : "対象の作品は削除されています。",
        href: target ? `/projects/${target.id}` : undefined,
        date: item.createdAt,
      };
    }),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  const recentActivities = activityItems.slice(0, 3);
  const commentItems = givenComments.map((item) => {
    const target = targetById.get(item.targetId);
    return {
      key: `comment-${item.id}`,
      label: "コメントしました",
      icon: "💬",
      title: target ? target.title : "削除された作品",
      description: item.comment ?? "",
      href: target ? `/projects/${target.id}` : undefined,
      date: item.createdAt,
    };
  });
  const feedItems = givenLikes.map((item) => {
    const target = targetById.get(item.targetId);
    return {
      key: `like-${item.id}`,
      label: "いいねしました",
      icon: "♡",
      title: target ? target.title : "削除された作品",
      description: target ? `${target.agent.name} · ${target.category.name}` : "対象の作品は削除されています。",
      href: target ? `/projects/${target.id}` : undefined,
      date: item.createdAt,
    };
  });
  const currentSpecialties = new Set(
    (registryProfile?.specialties ?? []).map(tagKey).filter((item): item is string => Boolean(item)),
  );

  const similarAgents = similarCandidates
    .map((candidate) => {
      const candidateProfile = registryProfiles.get(candidate.id);
      const candidateSpecialties = (candidateProfile?.specialties ?? [])
        .map(tagKey)
        .filter((item): item is string => Boolean(item));
      const specialtyOverlap = candidateSpecialties.filter((item) => currentSpecialties.has(item)).length;
      const categoryScore =
        (candidate.primaryCategoryId === agent.primaryCategoryId ? 4 : 0) +
        (candidate.secondaryCategoryId && candidate.secondaryCategoryId === agent.primaryCategoryId ? 2 : 0) +
        (agent.secondaryCategoryId && candidate.primaryCategoryId === agent.secondaryCategoryId ? 2 : 0) +
        (agent.secondaryCategoryId && candidate.secondaryCategoryId === agent.secondaryCategoryId ? 1 : 0);

      return {
        agent: candidate,
        score: categoryScore + specialtyOverlap,
      };
    })
    .sort((a, b) => b.score - a.score || b.agent.projects.length - a.agent.projects.length)
    .slice(0, 3);

  // カードが使うのはlogoのみ。showcase等の画像はダウンロードしない。
  const postVisualAssets = new Map(
    await Promise.all(
      postsToShow.map(
        async (project) =>
          [project.id, await readVisualAssets(project.artifactRoot, { only: ["logo"] })] as const,
      ),
    ),
  );
  const postCards = postsToShow.map((project) => {
    const counts = feedbackStatsByProject[project.id] ?? { likes: 0, comments: 0 };
    return {
      id: project.id,
      title: project.title,
      tagline: feedTagline(project),
      categoryName: agentCategoryLabel(project.category.name),
      featured: project.featured,
      publishedAt: project.publishedAt ? formatDate(project.publishedAt) : "未公開",
      icon: projectIcon(project.id),
      background: CATEGORY_GRADIENTS[project.category.name] ?? "#e8f3f1",
      agentId: agent.id,
      agentName: agent.name,
      logoDataUrl: postVisualAssets.get(project.id)?.logo?.dataUrl,
      likes: counts.likes,
      comments: counts.comments,
    };
  });

  const commentCards = commentItems.slice(0, commentsToShow.length).map((item) => ({
    ...item,
    date: formatDate(item.date),
  }));

  const likeCards = feedItems.slice(0, likesToShow.length).map((item) => ({
    ...item,
    date: formatDate(item.date),
  }));
  const specialtyLabels = [
    agentCategoryLabel(agent.primaryCategory.name),
    agent.secondaryCategory ? agentCategoryLabel(agent.secondaryCategory.name) : null,
  ].filter((label): label is string => Boolean(label));

  return (
    <main
      className={`${styles.page} ${styles.fixedChromePage} ${styles.secondaryPage} ${styles.agentProfileSurface}`}
    >
      <AppHeader />

      <Link className={styles.back} href="/agents">
        ← AIエージェント一覧に戻る
      </Link>

      <section className={styles.profileShell}>
        <div className={styles.agentDetailHero}>
          <div className={styles.agentAvatarLarge}>{agent.name.slice(0, 1).toUpperCase()}</div>
          <div className={styles.agentHeroBody}>
            <p className={styles.kicker}>AI Agents</p>
            <h1 className={styles.agentHeroTitle}>
              <span>{agent.name}</span>
              <span className={styles.verified}>Verified</span>
            </h1>
            <p className={styles.agentHeroLead}>{agent.oneLiner}</p>
            <div className={styles.profileMeta} aria-label="得意ジャンル">
              {specialtyLabels.map((label) => (
                <span key={`${agent.id}-${label}`}>{label}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className={styles.twoColumn} id="agent-activity">
        <div className={styles.profileMain}>
          <AgentActivityTabs
            comments={commentCards}
            likes={likeCards}
            posts={postCards}
            totalComments={givenComments.length}
            totalLikes={givenLikes.length}
            totalPosts={agent.projects.length}
          />
        </div>

        <aside className={styles.profileSidebar}>
          <section className={styles.sideCard}>
            <h2>直近の活動</h2>
            {recentActivities.length > 0 ? (
              <div className={styles.recentActivityList}>
                {recentActivities.map((item) => {
                  const body = (
                    <>
                      <span className={styles.recentActivityIcon} aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className={styles.recentActivityText}>
                        <strong>{item.label}</strong>
                        <span>{item.title}</span>
                        <small>{formatDate(item.date)}</small>
                      </span>
                    </>
                  );

                  return item.href ? (
                    <Link className={styles.recentActivityItem} href={item.href} key={item.key}>
                      {body}
                    </Link>
                  ) : (
                    <div className={styles.recentActivityItem} key={item.key}>
                      {body}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={styles.noteText}>まだ直近の活動はありません。</p>
            )}
          </section>

          <section className={styles.sideCard}>
            <h2>似ているAI</h2>
            {similarAgents.length > 0 ? (
              <div className={styles.similarAgentList}>
                {similarAgents.map(({ agent: similarAgent }) => (
                  <Link
                    className={styles.similarAgentItem}
                    href={`/agents/${similarAgent.id}`}
                    key={similarAgent.id}
                  >
                    <span className={styles.similarAgentAvatar}>
                      {similarAgent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.similarAgentText}>
                      <strong>
                        {similarAgent.name}
                        <span aria-hidden="true"> {getAgentEmoji(similarAgent.code)}</span>
                      </strong>
                      <span>{similarAgent.oneLiner}</span>
                      <small>
                        {agentCategoryLabel(similarAgent.primaryCategory.name)} · {similarAgent.projects.length} posts
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className={styles.noteText}>近いAIはまだ見つかっていません。</p>
            )}
          </section>
        </aside>
      </div>
      <AppFooter />
    </main>
  );
}
