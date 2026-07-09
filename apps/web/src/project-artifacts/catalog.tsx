"use client";

import styles from "./artifacts.module.css";
import type { ReactNode } from "react";
import { useState } from "react";
import { GitHubMissionDemo } from "./github-mission-demo";
import { GitHubMissionPreview } from "./github-mission-preview";
import { projectArtifactMeta } from "./metadata";

type ArtifactEntry = {
  Preview: () => ReactNode;
  Demo: () => ReactNode;
};

const PreviewFrame = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className={styles.preview}>
    <div className={styles.previewHeader}>
      <span>{label}</span>
      <div className={styles.windowDots} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
    {children}
  </div>
);

const TrendPreview = () => (
  <PreviewFrame label="triage board">
    <div className={`${styles.board} ${styles.triageBoard}`}>
      <div className={styles.column}>
        <strong>Try today</strong>
        <span>Local agent runner</span>
        <span>Prompt eval kit</span>
      </div>
      <div className={styles.column}>
        <strong>Maybe</strong>
        <span>UI generation helper</span>
        <span>Vector note app</span>
      </div>
      <div className={styles.column}>
        <strong>Skip</strong>
        <span>Heavy enterprise suite</span>
      </div>
    </div>
  </PreviewFrame>
);

const RoulettePreview = () => (
  <PreviewFrame label="discovery roulette">
    <div className={`${styles.roulette} ${styles.roulettePreview}`}>
      <div className={styles.dial}>42</div>
      <div className={styles.card}>
        <strong>Drawn tool</strong>
        <span>Good for quick prototype research.</span>
        <span>Try when you have 15 minutes.</span>
      </div>
    </div>
  </PreviewFrame>
);

const ExplainerPreview = () => (
  <PreviewFrame label="quick explainer">
    <div className={`${styles.guide} ${styles.explainerPreview}`}>
      <div className={styles.card}>
        <strong>What it replaces</strong>
        <span>Manual comparison between similar AI tools.</span>
      </div>
      <div className={styles.card}>
        <strong>Who should care</strong>
        <span>Builders deciding what to try next.</span>
      </div>
    </div>
  </PreviewFrame>
);

const MapPreview = () => (
  <PreviewFrame label="trend map">
    <div className={`${styles.map} ${styles.mapPreview}`}>
      <div className={styles.mapCell}>
        <strong>Generate</strong>
        <span>crowded</span>
      </div>
      <div className={styles.mapCell}>
        <strong>Search</strong>
        <span>rising</span>
      </div>
      <div className={styles.mapCell}>
        <strong>Agents</strong>
        <span>early</span>
      </div>
      <div className={styles.mapCell}>
        <strong>Ops</strong>
        <span>useful</span>
      </div>
    </div>
  </PreviewFrame>
);

const triageSeed = {
  "Try today": ["Local agent runner", "Prompt eval kit", "Browser task recorder"],
  "Maybe later": ["Vector note app", "UI generation helper"],
  Skip: ["Heavy enterprise suite", "Unclear workflow bot"],
};

const TrendDemo = () => {
  const [columns, setColumns] = useState(triageSeed);

  const moveCard = (from: keyof typeof triageSeed, item: string) => {
    const order = Object.keys(triageSeed) as Array<keyof typeof triageSeed>;
    const to = order[(order.indexOf(from) + 1) % order.length];

    setColumns((current) => ({
      ...current,
      [from]: current[from].filter((value) => value !== item),
      [to]: [...current[to], item],
    }));
  };

  return (
    <div className={`${styles.demo} ${styles.triageDemo}`}>
      <div className={styles.demoShell}>
        <div className={styles.demoHero}>
          <div>
            <span className={styles.demoTag}>Decision</span>
            <h2>Trend Triage Board</h2>
            <p>
              Click a card to move it through try, maybe, and skip. The point is
              not to track everything. The point is to decide what gets attention
              today.
            </p>
          </div>
          <span className={styles.demoTag}>
            {Object.values(columns).flat().length} candidates
          </span>
        </div>
        <div className={`${styles.demoGrid} ${styles.triageGrid}`}>
          {(Object.entries(columns) as Array<[keyof typeof triageSeed, string[]]>).map(
            ([column, items]) => (
              <div className={styles.demoPanel} key={column}>
                <strong>{column}</strong>
                <div className={styles.cardStack}>
                  {items.map((item) => (
                    <button
                      className={styles.toolCard}
                      key={item}
                      type="button"
                      onClick={() => moveCard(column, item)}
                    >
                      {item}
                      <span>Move next</span>
                    </button>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
};

const rouletteCards = [
  {
    number: 42,
    title: "Browser task recorder",
    summary: "Best when you need to turn repeated browser work into a script.",
    bullets: ["15 minute trial", "Useful for ops-heavy teams", "Skip if your flow is mostly API-based"],
  },
  {
    number: 17,
    title: "Prompt eval kit",
    summary: "Good when a workflow depends on prompt quality and you need a baseline.",
    bullets: ["Compare 3 prompts", "Save the winning run", "Useful before model changes"],
  },
  {
    number: 8,
    title: "Local agent runner",
    summary: "A small way to test agent loops without wiring up a full platform.",
    bullets: ["Start with one tool", "Watch file output", "Keep secrets out"],
  },
];

const RouletteDemo = () => {
  const [index, setIndex] = useState(0);
  const card = rouletteCards[index];

  return (
    <div className={`${styles.demo} ${styles.rouletteDemo}`}>
      <div className={styles.demoShell}>
        <div className={styles.demoHero}>
          <div>
            <span className={styles.demoTag}>Ideation</span>
            <h2>Discovery Roulette</h2>
            <p>
              Draw a card, read a tiny reason to care, then decide whether to
              keep exploring.
            </p>
          </div>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => setIndex((value) => (value + 1) % rouletteCards.length)}
          >
            Draw next
          </button>
        </div>
        <div className={`${styles.roulette} ${styles.rouletteStage}`}>
          <div className={styles.dial}>{card.number}</div>
          <div className={styles.demoPanel}>
            <strong>{card.title}</strong>
            <span>{card.summary}</span>
            <ul>
              {card.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

const explainerTabs = [
  {
    label: "What it replaces",
    body: "Reading scattered launch posts and guessing whether a tool matters.",
    bullets: ["Unclear positioning", "Too many feature lists", "No first task"],
  },
  {
    label: "Who should care",
    body: "People deciding whether a new AI tool deserves a real trial.",
    bullets: ["PMs evaluating workflow tools", "Builders choosing a stack", "Solo makers saving time"],
  },
  {
    label: "First thing to try",
    body: "Run one real task, compare the output, and decide whether to keep it.",
    bullets: ["Pick a concrete task", "Measure friction", "Write one next action"],
  },
];

const ExplainerDemo = () => {
  const [activeTab, setActiveTab] = useState(0);
  const tab = explainerTabs[activeTab];

  return (
    <div className={`${styles.demo} ${styles.explainerDemo}`}>
      <div className={styles.demoShell}>
        <div className={styles.demoHero}>
          <div>
            <span className={styles.demoTag}>Learning</span>
            <h2>Why This Tool Matters?</h2>
            <p>
              Switch between short explanations that turn a noisy tool
              announcement into plain language.
            </p>
          </div>
          <span className={styles.demoTag}>5 min read</span>
        </div>
        <div className={styles.tabs}>
          {explainerTabs.map((item, tabIndex) => (
            <button
              className={tabIndex === activeTab ? styles.activeTab : undefined}
              key={item.label}
              type="button"
              onClick={() => setActiveTab(tabIndex)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className={styles.demoPanel}>
          <strong>{tab.label}</strong>
          <span>{tab.body}</span>
          <ul>
            {tab.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

const mapZones = [
  {
    label: "Generate",
    status: "Crowded",
    detail: "Fast-moving and noisy. Useful, but hard to differentiate.",
  },
  {
    label: "Search",
    status: "Rising",
    detail: "Research, memory, and retrieval workflows are getting more practical.",
  },
  {
    label: "Agents",
    status: "Early",
    detail: "Still weird, but full of prototypes that hint at new habits.",
  },
  {
    label: "Ops",
    status: "Useful",
    detail: "Less flashy than generation, but often easier to connect to real work.",
  },
];

const MapDemo = () => {
  const [selected, setSelected] = useState(0);
  const zone = mapZones[selected];

  return (
    <div className={`${styles.demo} ${styles.mapDemo}`}>
      <div className={styles.demoShell}>
        <div className={styles.demoHero}>
          <div>
            <span className={styles.demoTag}>Research</span>
            <h2>AI Tool Trend Map</h2>
            <p>
              Click a zone to inspect why it matters and what kind of tools live
              there.
            </p>
          </div>
          <span className={styles.demoTag}>{zone.label}</span>
        </div>
        <div className={styles.mapLayout}>
          <div className={styles.map}>
            {mapZones.map((item, zoneIndex) => (
              <button
                className={zoneIndex === selected ? styles.activeMapCell : styles.mapButton}
                key={item.label}
                type="button"
                onClick={() => setSelected(zoneIndex)}
              >
                <strong>{item.label}</strong>
                <span>{item.status}</span>
              </button>
            ))}
          </div>
          <div className={styles.demoPanel}>
            <strong>{zone.label}</strong>
            <span>{zone.detail}</span>
            <ul>
              <li>Status: {zone.status}</li>
              <li>Use this zone to decide what to inspect next.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export const projectArtifacts: Record<string, ArtifactEntry> = {
  proj_a_trend_triage: {
    Preview: TrendPreview,
    Demo: TrendDemo,
  },
  proj_b_discovery_roulette: {
    Preview: RoulettePreview,
    Demo: RouletteDemo,
  },
  proj_c_why_tool_matters: {
    Preview: ExplainerPreview,
    Demo: ExplainerDemo,
  },
  proj_d_oss_trend_map: {
    Preview: MapPreview,
    Demo: MapDemo,
  },
  proj_g_github_mission_maker: {
    Preview: GitHubMissionPreview,
    Demo: GitHubMissionDemo,
  },
};

type ProjectPreviewProps = {
  agentName?: string;
  featured?: boolean;
  projectId: string;
  summary?: string;
  title?: string;
};

const HomeVisualPreview = ({
  agentName,
  featured,
  summary,
  title,
}: Omit<ProjectPreviewProps, "projectId">) => (
  <div className={styles.homePreview} aria-label="プロダクトプレビュー">
    <div className={featured ? styles.filledVisual : styles.emptyVisual}>
      {featured ? (
        <>
          <div className={styles.thumbTop}>
            <span>制作レビュー</span>
            <strong>相談</strong>
          </div>
          <div className={styles.thumbBody}>
            <strong>{title ?? "レビュー会議ダッシュボード"}</strong>
            <span>{summary ?? "会議の論点と次アクションを見える化するダッシュボード"}</span>
          </div>
          <div className={styles.thumbBars} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </>
      ) : (
        <span>作品サムネイル</span>
      )}
    </div>
    <div className={featured ? styles.filledVisual : styles.emptyVisual}>
      {featured ? (
        <div className={styles.dashboardMock}>
          <div className={styles.dashboardHeader}>
            <span>{agentName ?? "制作AI"}</span>
            <strong>公開中</strong>
          </div>
          <div className={styles.dashboardGrid}>
            <section>
              <b>論点</b>
              <em>12</em>
            </section>
            <section>
              <b>判断</b>
              <em>7</em>
            </section>
            <section>
              <b>次の一手</b>
              <em>18</em>
            </section>
          </div>
          <div className={styles.dashboardRows} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : (
        <span>画面プレビュー</span>
      )}
    </div>
  </div>
);

export function ProjectPreview({ agentName, featured, projectId, summary, title }: ProjectPreviewProps) {
  const artifact = projectArtifacts[projectId];

  if (!artifact) {
    return <HomeVisualPreview agentName={agentName} featured={featured} summary={summary} title={title} />;
  }

  return featured ? (
    <HomeVisualPreview agentName={agentName} featured={featured} summary={summary} title={title} />
  ) : (
    <artifact.Preview />
  );
}

export function ProjectDemoById({ projectId }: { projectId: string }) {
  const artifact = projectArtifacts[projectId];
  const meta = projectArtifactMeta[projectId];

  if (!artifact) {
    return (
      <div className={styles.demo}>
        <div className={styles.demoShell}>
          <div className={styles.demoHero}>
            <div>
              <span className={styles.demoTag}>デモ</span>
              <h2>表示できるデモはまだありません</h2>
              <p>この作品には、まだ表示可能なデモが保存されていません。</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {meta ? <span className={styles.srOnly}>{meta.label}</span> : null}
      <artifact.Demo />
    </div>
  );
}
