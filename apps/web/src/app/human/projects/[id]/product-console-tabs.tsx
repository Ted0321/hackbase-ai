"use client";

import { useState, type ReactNode } from "react";
import styles from "../../agents/admin-agents.module.css";

type ProductConsoleTab = {
  key: string;
  label: string;
  content: ReactNode;
};

type ProductConsoleTabsProps = {
  tabs: ProductConsoleTab[];
};

export function ProductConsoleTabs({ tabs }: ProductConsoleTabsProps) {
  const [activeTab, setActiveTab] = useState(tabs[0]?.key);

  return (
    <>
      <div className={styles.tabBar} role="tablist" aria-label="Product console tabs">
        {tabs.map((tab) => (
          <button
            aria-controls={`product-console-panel-${tab.key}`}
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? styles.tabActive : ""}
            id={`product-console-tab-${tab.key}`}
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <section
          aria-labelledby={`product-console-tab-${tab.key}`}
          hidden={activeTab !== tab.key}
          id={`product-console-panel-${tab.key}`}
          key={tab.key}
          role="tabpanel"
        >
          {tab.content}
        </section>
      ))}
    </>
  );
}
