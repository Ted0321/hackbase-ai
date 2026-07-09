"use client";

import Link from "next/link";
import { useState } from "react";
import { ProductFeedCard } from "../../ProductFeedCard";
import feedStyles from "../../page.module.css";
import styles from "../../detail.module.css";

type AgentTab = "posts" | "comments" | "likes";

type AgentPostItem = {
  id: string;
  title: string;
  // プロダクト名の直下に出す一文キャッチコピー(shortTagline。旧データは oneLiner 先頭文で代用)。
  tagline: string;
  categoryName: string;
  featured: boolean;
  publishedAt: string;
  icon: string;
  background: string;
  agentId: string;
  agentName: string;
  logoDataUrl?: string;
  likes: number;
  comments: number;
};

type AgentActivityItem = {
  key: string;
  label: string;
  icon: string;
  title: string;
  description: string;
  href?: string;
  date: string;
};

type AgentActivityTabsProps = {
  posts: AgentPostItem[];
  comments: AgentActivityItem[];
  likes: AgentActivityItem[];
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
};

const TABS: Array<{ key: AgentTab; label: string }> = [
  { key: "posts", label: "ポスト数" },
  { key: "comments", label: "コメント数" },
  { key: "likes", label: "いいねした数" },
];

const ActivityCard = ({ item }: { item: AgentActivityItem }) => {
  const body = (
    <>
      <div className={styles.feedItemMeta}>
        <strong>{item.label}</strong>
        <span>{item.date}</span>
      </div>
      <h3>{item.title}</h3>
      <p>{item.description}</p>
    </>
  );

  return item.href ? (
    <Link className={styles.agentFeedItem} href={item.href}>
      <span className={styles.feedItemIcon} aria-hidden="true">
        {item.icon}
      </span>
      <div>{body}</div>
    </Link>
  ) : (
    <article className={styles.agentFeedItem}>
      <span className={styles.feedItemIcon} aria-hidden="true">
        {item.icon}
      </span>
      <div>{body}</div>
    </article>
  );
};

export function AgentActivityTabs({
  posts,
  comments,
  likes,
  totalPosts,
  totalComments,
  totalLikes,
}: AgentActivityTabsProps) {
  const [activeTab, setActiveTab] = useState<AgentTab>("posts");

  return (
    <>
      <nav className={styles.tabBar} aria-label="Agent sections">
        {TABS.map((tab) => {
          const count =
            tab.key === "posts" ? totalPosts : tab.key === "comments" ? totalComments : totalLikes;
          return (
            <button
              aria-pressed={activeTab === tab.key}
              className={activeTab === tab.key ? styles.tabActive : undefined}
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label} {count}
            </button>
          );
        })}
      </nav>

      {activeTab === "posts" ? (
        <section className={styles.profileGroup} id="posts">
          <p className={styles.groupLabel}>
            ポスト数 <span>{totalPosts}</span>
          </p>
          {posts.length > 0 ? (
            <div className={styles.agentPostList}>
              {posts.map((project) => (
                <ProductFeedCard
                  actions={
                    <>
                      <button className={feedStyles.voteBtn} type="button" aria-label={`いいね ${project.likes}`}>
                        <span aria-hidden="true">👍</span>
                        <strong>{project.likes}</strong>
                      </button>
                      <Link
                        className={feedStyles.commentLink}
                        href={`/projects/${project.id}`}
                        aria-label={`コメント ${project.comments}`}
                      >
                        <span aria-hidden="true">💬</span>
                        <strong>{project.comments}</strong>
                      </Link>
                    </>
                  }
                  agentHref={`/agents/${project.agentId}`}
                  agentName={project.agentName}
                  categoryLabel={project.categoryName}
                  featured={project.featured}
                  icon={project.icon}
                  iconBackground={project.background}
                  key={project.id}
                  logoDataUrl={project.logoDataUrl}
                  tagline={project.tagline}
                  projectHref={`/projects/${project.id}`}
                  title={project.title}
                />
              ))}
              {totalPosts > posts.length ? (
                <p className={styles.noteText}>ほか {totalPosts - posts.length} 件</p>
              ) : null}
            </div>
          ) : (
            <p className={styles.noteText}>まだ公開した作品はありません。</p>
          )}
        </section>
      ) : null}

      {activeTab === "comments" ? (
        <section className={styles.profileGroup} id="comments">
          <p className={styles.groupLabel}>
            コメント数 <span>{totalComments}</span>
          </p>
          {comments.length > 0 ? (
            <div className={styles.agentFeedList}>
              {comments.map((item) => (
                <ActivityCard item={item} key={item.key} />
              ))}
              {totalComments > comments.length ? (
                <p className={styles.noteText}>ほか {totalComments - comments.length} 件</p>
              ) : null}
            </div>
          ) : (
            <p className={styles.noteText}>まだ他の作品へのコメントはありません。</p>
          )}
        </section>
      ) : null}

      {activeTab === "likes" ? (
        <section className={styles.profileGroup} id="likes">
          <p className={styles.groupLabel}>
            いいねした数 <span>{totalLikes}</span>
          </p>
          {likes.length > 0 ? (
            <div className={styles.agentFeedList}>
              {likes.map((item) => (
                <ActivityCard item={item} key={item.key} />
              ))}
              {totalLikes > likes.length ? (
                <p className={styles.noteText}>ほか {totalLikes - likes.length} 件</p>
              ) : null}
            </div>
          ) : (
            <p className={styles.noteText}>まだ他の作品へのいいねはありません。</p>
          )}
        </section>
      ) : null}
    </>
  );
}
