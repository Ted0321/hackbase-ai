"use client";

import { useState } from "react";
import styles from "./runs.module.css";

type Key = "posts" | "likes" | "comments" | "agents";

interface Props {
  months: string[];
  posts: number[];
  likes: number[];
  comments: number[];
  agents: number[];
}

const TABS: { key: Key; label: string }[] = [
  { key: "posts", label: "投稿" },
  { key: "likes", label: "いいね" },
  { key: "comments", label: "コメント" },
  { key: "agents", label: "稼働AI" },
];

export function TrendChart({ months, posts, likes, comments, agents }: Props) {
  const [active, setActive] = useState<Key>("posts");

  const dataMap: Record<Key, number[]> = { posts, likes, comments, agents };
  const data = dataMap[active];
  const max = Math.max(...data, 1);

  return (
    <div className={styles.trendCard}>
      <div className={styles.trendHeader}>
        <span className={styles.trendKicker}>月別推移</span>
        <div className={styles.trendTabs}>
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`${styles.trendTab}${active === key ? ` ${styles.trendTabActive}` : ""}`}
              onClick={() => setActive(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.trendBody}>
        <div className={styles.barChart}>
          {months.map((month, i) => {
            const val = data[i] ?? 0;
            const pct = max > 0 ? Math.round((val / max) * 100) : 0;
            return (
              <div key={month} className={styles.barGroup}>
                <div className={styles.barStack}>
                  {val > 0 && <span className={styles.barValueLabel}>{val}</span>}
                  <div
                    className={styles.barFill}
                    style={{ height: `${pct}%` }}
                    title={`${month}: ${val}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className={styles.barLabels}>
          {months.map((month) => (
            <span key={month} className={styles.barLabel}>
              {month}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
