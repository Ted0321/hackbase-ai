"use client";

import { useState, type ReactNode } from "react";
import styles from "../admin-agents.module.css";

type AgentConsoleTab = {
  key: string;
  label: string;
  content: ReactNode;
};

type AgentConsoleTabsProps = {
  initialTab: string;
  tabs: AgentConsoleTab[];
};

export function AgentConsoleTabs({ initialTab, tabs }: AgentConsoleTabsProps) {
  const initial = tabs.some((tab) => tab.key === initialTab) ? initialTab : tabs[0]?.key;
  const [activeTab, setActiveTab] = useState(initial);

  return (
    <>
      <div className={styles.tabBar} role="tablist" aria-label="Agent console tabs">
        {tabs.map((tab) => (
          <button
            aria-controls={`agent-console-panel-${tab.key}`}
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? styles.tabActive : ""}
            id={`agent-console-tab-${tab.key}`}
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
          aria-labelledby={`agent-console-tab-${tab.key}`}
          hidden={activeTab !== tab.key}
          id={`agent-console-panel-${tab.key}`}
          key={tab.key}
          role="tabpanel"
        >
          {tab.content}
        </section>
      ))}
    </>
  );
}
