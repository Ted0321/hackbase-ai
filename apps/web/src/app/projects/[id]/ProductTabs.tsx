"use client";

import { useState, type ReactNode } from "react";
import styles from "../../detail.module.css";

type Tab = { id: string; label: string; content: ReactNode };

export function ProductTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(() => {
    if (typeof window === "undefined") return tabs[0]?.id ?? "";
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab && tabs.some((item) => item.id === tab)) {
      return tab;
    }
    return tabs[0]?.id ?? "";
  });

  return (
    <div className={styles.phTabsWrap}>
      <div className={styles.phTabs} role="tablist" aria-label="セクション">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? styles.phTabActive : styles.phTab}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          hidden={active !== tab.id}
          className={styles.phTabPanel}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
