export type StaticArtifactMetadata = {
  architecture: string[];
  aiMechanismPattern?: string;
  artifactShape?: string;
  interestingness: string;
  label: string;
  mockups: string[];
  process: string[];
  productConceptSource: string;
  roles: string[];
  sourcePlan: string[];
  surfacePattern?: string;
  targetUser: string;
  templatePatternId?: string;
  userMoment: string;
  visualIdentity?: {
    logoPrompt?: string;
    logoDescription?: string;
    thumbnailPrompt?: string;
    thumbnailDescription?: string;
    screenshotDescription?: string;
    visualReadiness?: "ready" | "placeholder" | "missing";
    assetNotes?: string[];
  };
};

export type StaticArtifactSourceFile = {
  body: string;
  label: string;
  language: string;
  path: string;
};

const staticArtifacts: Record<
  string,
  {
    metadata: StaticArtifactMetadata;
    readme: string;
    sourceExcerpt: string;
    validationSummary: string;
  }
> = {
  proj_a_trend_triage: {
    metadata: {
      architecture: [
        "Static candidate data: AI tool candidates are grouped into attention columns.",
        "Client state: cards move between Try today, Maybe later, and Skip.",
        "Publish surface: the artifact is rendered by a bundled React demo component.",
      ],
      interestingness:
        "AI tool discovery usually becomes a long list. This artifact turns discovery into an attention budget: what deserves today's trial, what can wait, and what should be ignored.",
      label: "Trend Triage Board",
      mockups: [
        "Three-column triage board: candidate cards move across attention states.",
        "Decision header: total candidates and current action state stay visible.",
      ],
      process: [
        "Read the theme about AI tool overload.",
        "Convert the theme into decision columns.",
        "Generate candidate cards with short use reasons.",
        "Validate that the artifact needs no external service.",
      ],
      productConceptSource: "seed_static_artifact",
      roles: ["Triage", "Local Validation Worker", "Seed Publisher"],
      sourcePlan: ["source/app/page.tsx", "source/components/ProductWorkspace.tsx", "source/data/product.ts"],
      targetUser: "PM, solo builder, or AI-curious operator choosing what to try this week.",
      userMoment: "A weekly planning moment when too many AI tools are competing for attention.",
    },
    readme: `# Trend Triage Board

Trend Triage Board is a small decision board for AI tool overload.

The user clicks candidate cards to move them through Try today, Maybe later, and Skip. The value is not tracking every tool. The value is making the next trial explicit.

## Artifact

- One-screen triage board
- Static sample data
- No external API calls
- Source and validation are inspectable inside Prodia
`,
    sourceExcerpt: `const triageSeed = {
  "Try today": ["Local agent runner", "Prompt eval kit", "Browser task recorder"],
  "Maybe later": ["Vector note app", "UI generation helper"],
  Skip: ["Heavy enterprise suite", "Unclear workflow bot"],
};

function TrendDemo() {
  const [columns, setColumns] = useState(triageSeed);
  const moveCard = (from, item) => {
    const order = Object.keys(triageSeed);
    const to = order[(order.indexOf(from) + 1) % order.length];
    setColumns((current) => ({
      ...current,
      [from]: current[from].filter((value) => value !== item),
      [to]: [...current[to], item],
    }));
  };
}`,
    validationSummary:
      "Pass. The artifact has a visible interaction, static sample data, no secrets, no network dependency, and a clear one-screen purpose.",
  },
  proj_b_discovery_roulette: {
    metadata: {
      architecture: [
        "Static card deck: each card contains a candidate, summary, and trial advice.",
        "Client state: Draw next advances through the deck.",
        "Publish surface: the artifact is rendered by a bundled React demo component.",
      ],
      interestingness:
        "Instead of making AI tool research feel like homework, the artifact uses controlled randomness to create a low-friction discovery moment.",
      label: "Discovery Roulette",
      mockups: [
        "Roulette stage: a drawn number and candidate card anchor the screen.",
        "Action button: Draw next creates a lightweight exploration loop.",
      ],
      process: [
        "Start from the same AI tool overload theme.",
        "Shift the surface pattern from decision board to playful discovery.",
        "Create a small card deck and draw interaction.",
        "Validate that every card has a practical trial reason.",
      ],
      productConceptSource: "seed_static_artifact",
      roles: ["Shuffle", "Local Validation Worker", "Seed Publisher"],
      sourcePlan: ["source/app/page.tsx", "source/components/ProductWorkspace.tsx", "source/data/product.ts"],
      targetUser: "AI-curious user who wants a quick next thing to inspect.",
      userMoment: "A short break or exploration session where the user does not want a full research workflow.",
    },
    readme: `# Discovery Roulette

Discovery Roulette makes AI tool exploration feel lighter.

The user draws a card and gets one candidate, one reason to care, and one small next action.

## Artifact

- One button interaction
- Static card deck
- Designed for a five-minute discovery moment
- No live service dependency
`,
    sourceExcerpt: `const rouletteCards = [
  {
    number: 42,
    title: "Browser task recorder",
    summary: "Best when you need to turn repeated browser work into a script.",
    bullets: ["15 minute trial", "Useful for ops-heavy teams", "Skip if your flow is mostly API-based"],
  },
];

function RouletteDemo() {
  const [index, setIndex] = useState(0);
  const card = rouletteCards[index];
  return <button onClick={() => setIndex((value) => (value + 1) % rouletteCards.length)}>Draw next</button>;
}`,
    validationSummary:
      "Pass. The artifact is self-contained, clearly interactive, and avoids pretending to use live recommendation data.",
  },
  proj_c_why_tool_matters: {
    metadata: {
      architecture: [
        "Static explanation tabs: each tab answers a different adoption question.",
        "Client state: active tab changes the explanation path.",
        "Publish surface: the artifact is rendered by a bundled React demo component.",
      ],
      interestingness:
        "The artifact treats explanation as a navigable product surface, not a long article. It helps the user decide whether a tool matters before reading launch copy.",
      label: "Why This Tool Matters?",
      mockups: [
        "Tabbed explainer: What it replaces, Who should care, First thing to try.",
        "Short bullet panel: each tab ends with concrete evaluation points.",
      ],
      process: [
        "Identify that launch copy often hides the actual replacement behavior.",
        "Break the explanation into adoption questions.",
        "Render those questions as tabs instead of an article.",
        "Validate that the artifact is understandable without external data.",
      ],
      productConceptSource: "seed_static_artifact",
      roles: ["Explainer", "Local Validation Worker", "Seed Publisher"],
      sourcePlan: ["source/app/page.tsx", "source/components/ProductWorkspace.tsx", "source/data/product.ts"],
      targetUser: "Non-specialist or AI beginner trying to understand whether a new tool matters.",
      userMoment: "Before trying a new tool, when the user needs a plain-language framing.",
    },
    readme: `# Why This Tool Matters?

Why This Tool Matters? is a short interactive explainer for noisy AI tool announcements.

The user switches between adoption questions: what the tool replaces, who should care, and what to try first.

## Artifact

- Tabbed explanation
- Static sample copy
- Built to be understandable without reading a long README
`,
    sourceExcerpt: `const explainerTabs = [
  {
    label: "What it replaces",
    body: "Reading scattered launch posts and guessing whether a tool matters.",
    bullets: ["Unclear positioning", "Too many feature lists", "No first task"],
  },
];

function ExplainerDemo() {
  const [activeTab, setActiveTab] = useState(0);
  const tab = explainerTabs[activeTab];
  return <button onClick={() => setActiveTab(0)}>{tab.label}</button>;
}`,
    validationSummary:
      "Pass. The artifact has a visible adaptive explanation path and does not depend on live product claims.",
  },
  proj_d_oss_trend_map: {
    metadata: {
      architecture: [
        "Static trend zones: categories summarize where AI tools cluster.",
        "Client state: selecting a zone reveals its meaning and next use.",
        "Publish surface: the artifact is rendered by a bundled React demo component.",
      ],
      interestingness:
        "The map makes a noisy tool landscape inspectable by area. It is useful because the user can decide where to look next, not because it claims a definitive market map.",
      label: "AI Tool Trend Map",
      mockups: [
        "Four-zone map: Generate, Search, Agents, Ops.",
        "Detail panel: selected zone explains status and exploration use.",
      ],
      process: [
        "Translate individual AI tool candidates into trend zones.",
        "Choose a map surface so the user sees structure before details.",
        "Add zone selection as the core interaction.",
        "Validate that labels are sample-oriented and non-authoritative.",
      ],
      productConceptSource: "seed_static_artifact",
      roles: ["Cartographer", "Local Validation Worker", "Seed Publisher"],
      sourcePlan: ["source/app/page.tsx", "source/components/ProductWorkspace.tsx", "source/data/product.ts"],
      targetUser: "Builder or product strategist choosing which AI tool category to inspect next.",
      userMoment: "Early research, before committing to one product category.",
    },
    readme: `# AI Tool Trend Map

AI Tool Trend Map turns scattered AI tool categories into a small inspectable map.

The user selects a zone and reads why that area is crowded, rising, early, or useful.

## Artifact

- Clickable map zones
- Static trend interpretation
- No claim of exhaustive market coverage
`,
    sourceExcerpt: `const mapZones = [
  { label: "Generate", status: "Crowded", detail: "Fast-moving and noisy." },
  { label: "Search", status: "Rising", detail: "Research and retrieval workflows are getting practical." },
];

function MapDemo() {
  const [selected, setSelected] = useState(0);
  const zone = mapZones[selected];
  return <button onClick={() => setSelected(1)}>{zone.label}</button>;
}`,
    validationSummary:
      "Pass. The artifact presents sample structure, includes a clear interaction, and avoids unsupported live market claims.",
  },
  proj_g_github_mission_maker: {
    metadata: {
      architecture: [
        "Static repo material: sample repositories include files, roles, and learning missions.",
        "Client state: repo and mode selections change the mission route.",
        "Publish surface: the artifact is rendered by a bundled React demo component.",
      ],
      aiMechanismPattern: "workflow_generation",
      artifactShape: "workspace",
      interestingness:
        "The artifact turns a GitHub repository from a passive code pile into a 30-minute modification mission. It shows Prodia's strongest direction: AI can transform source material into an actionable mini-product.",
      label: "GitHub攻略ミッションメーカー",
      mockups: [
        "Repo picker: choose a sample codebase.",
        "Mission route: inspect beginner, builder, or deep-dive paths.",
        "Selected step: see task, completion clue, stumbling point, and recovery hint.",
      ],
      process: [
        "Read repo-like structured material.",
        "Extract entry files, components, tests, and docs.",
        "Generate a time-boxed mission route for the selected skill level.",
        "Validate that the sample uses no live GitHub API or secrets.",
      ],
      productConceptSource: "bundled_static_mvp_artifact",
      roles: ["Cartographer", "Explainer", "Local Validation Worker", "Seed Publisher"],
      sourcePlan: [
        "source/app/page.tsx",
        "source/components/GitHubMissionDemo.tsx",
        "source/data/repoMaterials.ts",
      ],
      surfacePattern: "learning_explainer",
      targetUser: "Beginner builder, indie hacker, or AI coding learner opening an unfamiliar repository.",
      templatePatternId: "source_to_mission",
      userMoment: "The first 30 minutes after finding a repo that looks useful but hard to enter.",
    },
    readme: `# GitHub攻略ミッションメーカー

GitHub攻略ミッションメーカー converts repo material into a concrete learning and modification route.

The user chooses a sample repository and a mission mode. The artifact then shows which files to inspect, what to do, when the step is done, where the user may stumble, and how to recover.

## Why it matters

Most repository discovery stops at stars, README claims, or a vague "try it later" note. This artifact turns a repo into an executable 30-minute mission.

## Artifact

- Repo selector
- Mission mode tabs
- File map
- Step-by-step mission route
- Static sample repo data
- No live GitHub API access
`,
    sourceExcerpt: `export function GitHubMissionDemo() {
  const [repoId, setRepoId] = useState(repoMaterials[0]?.id ?? "");
  const [mode, setMode] = useState("builder");
  const selectedRepo = repoMaterials.find((repo) => repo.id === repoId) ?? repoMaterials[0];
  const plan = selectedRepo.plans[mode];
  const [selectedStepId, setSelectedStepId] = useState(plan.steps[0]?.id ?? "");

  // The UI turns repo structure into a route: repo -> mode -> file map -> selected mission step.
}`,
    validationSummary:
      "Pass. The artifact is static, source-inspectable, has multiple visible interactions, and clearly avoids live GitHub access.",
  },
};

const jsonFile = (label: string, path: string, value: unknown): StaticArtifactSourceFile => ({
  body: JSON.stringify(value, null, 2),
  label,
  language: "json",
  path,
});

export const getStaticArtifactMetadata = (projectId: string) =>
  staticArtifacts[projectId]?.metadata ?? null;

export const getStaticArtifactSourceFiles = (projectId: string): StaticArtifactSourceFile[] => {
  const artifact = staticArtifacts[projectId];
  if (!artifact) return [];

  return [
    {
      body: artifact.readme,
      label: "README.md",
      language: "markdown",
      path: `static-artifacts/${projectId}/README.md`,
    },
    jsonFile("metadata.json", `static-artifacts/${projectId}/metadata.json`, artifact.metadata),
    jsonFile("manifest.json", `static-artifacts/${projectId}/manifest.json`, {
      projectId,
      sourceType: "bundled_static_react_artifact",
      requiredFiles: [
        "README.md",
        "metadata.json",
        "source.tsx",
        "validation/validation.json",
        "validation/self-review.json",
      ],
      publicDemo: `/projects/${projectId}/demo`,
      sourceInspectable: true,
    }),
    {
      body: artifact.sourceExcerpt,
      label: "source.tsx",
      language: "tsx",
      path: `static-artifacts/${projectId}/source.tsx`,
    },
    jsonFile("validation/validation.json", `static-artifacts/${projectId}/validation/validation.json`, {
      status: "pass",
      summary: artifact.validationSummary,
      checks: {
        core_interaction_visible: "pass",
        external_dependency: "pass",
        secret_scan: "pass",
        source_inspectable: "pass",
        metadata_complete: "pass",
      },
    }),
    jsonFile("validation/self-review.json", `static-artifacts/${projectId}/validation/self-review.json`, {
      status: "pass",
      totalScore: 30,
      maxScore: 30,
      summary: artifact.validationSummary,
      checks: {
        firstScreenValue: "pass",
        userControlledInteraction: "pass",
        stateChange: "pass",
        inspectableOutput: "pass",
      },
    }),
  ];
};
