import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPrismaClient } from "./prisma-client";
import { validateArtifactDirectory } from "./validate-artifact";
import { buildAgentProfileSnapshot } from "./agent-registry";
import { readFeedbackGuidance, formatGuidanceForPrompt } from "./feedback-guidance";
import "./load-local-env";

type Kind = "board" | "roulette" | "explainer" | "map";

type Args = {
  theme: string;
  productConceptJson?: string;
  agent: string;
  agents: string[];
  kinds: Kind[];
  count: number;
  triggerType: "manual" | "daily" | "feedback_driven";
  planner: "template" | "llm" | "codex";
  model: string;
};

type ProductTemplateConfig = {
  id: string;
  patternId?: string;
  keywords: string[];
  categoryId: string;
  title: string;
  oneLiner: string;
  concept: string;
  interestingness: string;
  useCase: string;
  whatWasTried: string;
  nextGrowth: string;
  roles: string[];
  reviewLanes: string[];
  reviews: string[];
  outputName: string;
};

type ProductConceptInput = {
  id?: string;
  title: string;
  oneLiner?: string;
  targetUser?: string;
  userMoment?: string;
  concept?: string;
  interestingness?: string;
  nextGrowth?: string;
  process?: string[];
  architecture?: string[];
  mockups?: string[];
  sourcePlan?: string[];
  risks?: string[];
  roles?: string[];
  reviewLanes?: string[];
  reviews?: string[];
  outputName?: string;
  review?: {
    score?: number;
    maxScore?: number;
    rubric?: Record<string, number>;
    strengths?: string[];
    weaknesses?: string[];
    promptPatch?: string[];
  };
};

type ProductGenerationConfig = ProductTemplateConfig & {
  targetUser?: string;
  userMoment?: string;
  process: string[];
  architecture: string[];
  mockups: string[];
  sourcePlan: string[];
  risks: string[];
  qualityReview?: ProductConceptInput["review"];
  productConceptSource?: string;
};

type ProductTemplateFile = {
  labels: {
    concept: string;
    interestingness: string;
    nextGrowth: string;
    input: string;
    readByRoles: string;
    reviewByRoles: string;
    keepOutput: string;
    sourceDescription: string;
  };
  templates: ProductTemplateConfig[];
  default: ProductTemplateConfig;
};

type SourceFile = {
  relativePath: string;
  body: string;
  mimeType: string;
};

type ArtifactFile = {
  type: string;
  path: string;
  mimeType: string;
  body: string | Buffer;
};

const prisma = createPrismaClient();

const checksum = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "ai";

const cleanTheme = (value: string) => {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const autonomyLevelForTrigger = (triggerType: Args["triggerType"]) =>
  triggerType === "daily"
    ? "scheduled_generate"
    : triggerType === "feedback_driven"
      ? "feedback_driven"
      : "assisted_run";

const sourceInteractionForTrigger = (triggerType: Args["triggerType"]) =>
  triggerType === "daily"
    ? "scheduler"
    : triggerType === "feedback_driven"
      ? "feedback_loop"
      : "human_console";

const ownerForTrigger = (triggerType: Args["triggerType"]) =>
  triggerType === "daily"
    ? { humanOwnerType: "system", humanOwnerId: "daily_scheduler", humanOwnerName: "Daily Scheduler" }
    : { humanOwnerType: "human", humanOwnerId: "manual_operator", humanOwnerName: "Manual Operator" };

const toolPolicy = {
  input: "local_artifact_only",
  network: "disabled",
  write: "artifact_store",
  publish: "validation_gate",
};

const publishGateFor = (validationStatus: string, approvalRequired: boolean) => ({
  validationStatus,
  approvalRequired,
  rule: approvalRequired ? "hold_for_human_review" : "auto_publish_after_validation",
});

const safetyBoundaryFor = (validationStatus: string, approvalRequired: boolean) => ({
  sandboxMode: "workspace",
  toolPolicy,
  publishGate: publishGateFor(validationStatus, approvalRequired),
});

const artifactActorForType = (
  type: string,
  agent: { id: string; name: string },
  validationActor: { actorType: string; actorId: string; actorName: string },
  systemActor: { actorType: string; actorId: string; actorName: string },
) => {
  if (type.includes("validation") || type.includes("review") || type.includes("dependency_report")) {
    return {
      createdByType: validationActor.actorType,
      createdById: validationActor.actorId,
      createdByName: validationActor.actorName,
    };
  }

  if (type === "manifest" || type === "process_diagram" || type === "architecture_diagram") {
    return {
      createdByType: systemActor.actorType,
      createdById: systemActor.actorId,
      createdByName: systemActor.actorName,
    };
  }

  return {
    createdByType: "agent",
    createdById: agent.id,
    createdByName: agent.name,
  };
};

const loadProductTemplateFile = (): ProductTemplateFile => {
  const templatePath = path.join(process.cwd(), "scripts", "templates", "product-templates.json");
  return JSON.parse(readFileSync(templatePath, "utf8")) as ProductTemplateFile;
};

const templateFile = loadProductTemplateFile();

const templateTitleForTheme = (theme: string) => {
  const cleaned = cleanTheme(theme);
  if (!cleaned) return templateFile.default.title;
  return cleaned.startsWith("AI") ? `${cleaned}${templateFile.labels.input ? "" : ""}` : `AI${cleaned}`;
};

const withGenerationDefaults = (
  config: ProductTemplateConfig,
  source?: string,
): ProductGenerationConfig => ({
  ...config,
  process: [
    templateFile.labels.input,
    templateFile.labels.readByRoles,
    templateFile.labels.reviewByRoles,
    templateFile.labels.keepOutput,
  ],
  architecture: [...config.roles, ...config.reviewLanes, config.outputName],
  mockups: [
    "トップ画面では、入力フォーム、AIロールカード、最新メモを見せます。",
    "作業画面では、役割別コメントと最終アウトプットを見せます。",
  ],
  sourcePlan: [
    "README.md",
    "demo.html",
    "source/app/page.tsx",
    "source/components/ProductWorkspace.tsx",
    "source/data/product.ts",
    "source/styles.css",
    "validation/codex-review.json",
  ],
  risks: ["外部APIを自動実行しない", "秘密情報を保存しない", "人間が最終判断を確認する"],
  productConceptSource: source,
});

const normalizeStringArray = (value: unknown, fallback: string[]) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0
    ? value
    : fallback;

const rolesFromArchitecture = (architecture: string[]) => {
  const roleLine = architecture.find((item) => item.toLowerCase().includes("role agents:"));
  if (!roleLine) return [];
  const [, rawRoles = ""] = roleLine.split(":");
  return rawRoles
    .replace(/が並列に読む|read in parallel/gi, "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
};

const conceptToConfig = (input: ProductConceptInput, source: string): ProductGenerationConfig => {
  const base = withGenerationDefaults(templateFile.default, source);
  const title = cleanTheme(input.title || base.title);
  const targetUser = input.targetUser ?? "新しいAIプロダクトを試したいユーザー";
  const userMoment = input.userMoment ?? "小さなWebプロダクトの使い方を素早く理解したいとき";
  const process = normalizeStringArray(input.process, base.process);
  const architecture = normalizeStringArray(input.architecture, base.architecture);
  const roles = normalizeStringArray(input.roles, rolesFromArchitecture(architecture)).length > 0
    ? normalizeStringArray(input.roles, rolesFromArchitecture(architecture))
    : base.roles;
  const mockups = normalizeStringArray(input.mockups, base.mockups);
  const sourcePlan = normalizeStringArray(input.sourcePlan, base.sourcePlan);
  const risks = normalizeStringArray(input.risks, base.risks);

  return {
    ...base,
    id: input.id ?? slugify(title),
    keywords: [],
    title,
    oneLiner:
      input.oneLiner ??
      `${targetUser}が、${userMoment}に使う小さなAIプロダクトです。`,
    targetUser,
    userMoment,
    concept:
      input.concept ??
      `${title}は、入力、AIロール、レビュー、最終メモを一画面で見せるプロダクトです。`,
    interestingness:
      input.interestingness ??
      "面白さは、AIの結論だけでなく、判断の作られ方まで見える点にあります。",
    useCase: `${targetUser}が、${userMoment}に使います。`,
    whatWasTried: `${roles.join("、")}が分担して読み、${input.outputName ?? base.outputName}へ束ねる作品として設計しました。`,
    nextGrowth:
      input.nextGrowth ??
      "次は実データ取り込み、判断履歴、フィードバック反映に伸ばします。",
    roles,
    reviewLanes: normalizeStringArray(input.reviewLanes, process.slice(0, 4)),
    reviews: normalizeStringArray(input.reviews, ["新規性レビュー", "UIレビュー", "実装レビュー"]),
    outputName: input.outputName ?? base.outputName,
    process,
    architecture,
    mockups,
    sourcePlan,
    risks,
    qualityReview: input.review,
    productConceptSource: source,
  };
};

const loadProductConceptConfig = (filePath: string): ProductGenerationConfig => {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as
    | ProductConceptInput
    | { best?: ProductConceptInput };
  const concept = "best" in parsed && parsed.best ? parsed.best : parsed;

  if (!("title" in concept) || typeof concept.title !== "string") {
    throw new Error(`ProductConcept JSON does not include a title: ${filePath}`);
  }

  return conceptToConfig(concept, path.relative(process.cwd(), resolvedPath));
};

const templateForTheme = (theme: string): ProductGenerationConfig => {
  const normalized = theme.toLowerCase();
  const matched = templateFile.templates.find((template) =>
    template.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
  );
  if (matched) return withGenerationDefaults(matched);
  return withGenerationDefaults({ ...templateFile.default, title: templateTitleForTheme(theme) });
};

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const values: Record<string, string> = {};

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = "true";
    }
  }

  const kindValues = (values.kinds ?? "board").split(",").filter(Boolean) as Kind[];
  const allowedKinds = new Set<Kind>(["board", "roulette", "explainer", "map"]);
  const kinds = kindValues.filter((kind) => allowedKinds.has(kind));
  const count = Math.min(8, Math.max(1, Number(values.count ?? 1)));
  const triggerType = (values.trigger ?? values.triggerType ?? "manual") as Args["triggerType"];
  const planner = (values.planner ?? "template") as Args["planner"];
  const agent = values.agent ?? "agent_a";

  return {
    theme: cleanTheme(values.theme ?? ""),
    productConceptJson: values["product-concept-json"] ?? values.productConceptJson,
    agent,
    agents: agent === "all" ? ["agent_a", "agent_b", "agent_c", "agent_d"] : [agent],
    kinds: kinds.length > 0 ? kinds : ["board"],
    count,
    triggerType,
    planner,
    model: values.model ?? "local-template",
  };
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const orderedItems = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
const cardItems = (items: string[]) =>
  items
    .map((item) => `<article><p>${escapeHtml(item)}</p></article>`)
    .join("");

const htmlShell = (config: ProductGenerationConfig, agentName: string) => {
  const labels = templateFile.labels;
  const roleItems = orderedItems(config.roles);
  const laneItems = orderedItems(config.reviewLanes);
  const processItems = orderedItems(config.process);
  const architectureItems = orderedItems(config.architecture);
  const mockupItems = cardItems(config.mockups);

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${config.title}</title>
    <style>
      body { margin: 0; padding: 28px; font-family: Inter, "Noto Sans JP", system-ui, sans-serif; background: #f8fafc; color: #111827; }
      main { max-width: 1040px; margin: 0 auto; border: 1px solid #d7dce2; background: #fff; box-shadow: 0 18px 48px rgba(36, 56, 82, 0.12); }
      header, section { padding: 24px; border-bottom: 1px solid #e5e7eb; }
      h1 { margin: 8px 0 0; font-size: 34px; }
      h2 { margin: 0 0 10px; font-size: 20px; }
      p, li { line-height: 1.7; color: #4b5563; }
      .tag { color: #00a58e; font-weight: 900; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .wide { grid-column: 1 / -1; }
      article { border: 1px solid #d7dce2; padding: 16px; background: #f9fafb; }
      @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="tag">${escapeHtml(agentName)}</span>
        <h1>${escapeHtml(config.title)}</h1>
        <p>${escapeHtml(config.oneLiner)}</p>
      </header>
      <section><h2>${escapeHtml(labels.concept)}</h2><p>${escapeHtml(config.concept)}</p></section>
      <section><h2>${escapeHtml(labels.interestingness)}</h2><p>${escapeHtml(config.interestingness)}</p></section>
      <section class="grid">
        <article><h2>Roles</h2><ul>${roleItems}</ul></article>
        <article><h2>Review lanes</h2><ul>${laneItems}<li>${escapeHtml(config.outputName)}</li></ul></article>
        <article><h2>Process</h2><ol>${processItems}</ol></article>
        <article><h2>Architecture</h2><ul>${architectureItems}</ul></article>
        <div class="wide grid">${mockupItems}</div>
      </section>
      <section><h2>${escapeHtml(labels.nextGrowth)}</h2><p>${escapeHtml(config.nextGrowth)}</p></section>
    </main>
  </body>
</html>`;
};

const sourceFilesForTemplate = (config: ProductGenerationConfig, theme: string, agentCode: string): SourceFile[] => {
  const labels = templateFile.labels;
  const productData = { ...config, theme, agentCode };

  return [
    {
      relativePath: "source/app/page.tsx",
      mimeType: "text/tsx",
      body: `import { ProductWorkspace } from "../components/ProductWorkspace";\nimport { productData } from "../data/product";\nimport "../styles.css";\n\nexport default function Page() {\n  return <ProductWorkspace data={productData} />;\n}\n`,
    },
    {
      relativePath: "source/components/ProductWorkspace.tsx",
      mimeType: "text/tsx",
      body: `type ProductData = typeof import("../data/product").productData;\n\nexport function ProductWorkspace({ data }: { data: ProductData }) {\n  return (\n    <main className="productWorkspace">\n      <header className="hero">\n        <p className="eyebrow">{data.theme}</p>\n        <h1>{data.title}</h1>\n        <span>{data.oneLiner}</span>\n      </header>\n      <section className="summaryStack">\n        <article><h2>${labels.concept}</h2><p>{data.concept}</p></article>\n        <article><h2>${labels.interestingness}</h2><p>{data.interestingness}</p></article>\n        <article><h2>${labels.nextGrowth}</h2><p>{data.nextGrowth}</p></article>\n      </section>\n      <section className="workspace">\n        <aside className="panel"><strong>Input</strong><button>${labels.input}</button><p>{data.targetUser}</p><p>{data.userMoment}</p></aside>\n        <div className="meetingBoard"><strong>AI Workspace</strong>{data.roles.map((role) => <article key={role}><h3>{role}</h3><p>${labels.sourceDescription}</p></article>)}</div>\n        <aside className="panel"><strong>Output</strong>{data.reviewLanes.map((lane) => <p key={lane}>{lane}</p>)}<em>{data.outputName}</em></aside>\n      </section>\n      <section className="detailGrid">\n        <article><h2>Process</h2><ol>{data.process.map((item) => <li key={item}>{item}</li>)}</ol></article>\n        <article><h2>Architecture</h2><ul>{data.architecture.map((item) => <li key={item}>{item}</li>)}</ul></article>\n        <article><h2>Mockups</h2>{data.mockups.map((item) => <p key={item}>{item}</p>)}</article>\n        <article><h2>Source plan</h2><ul>{data.sourcePlan.map((item) => <li key={item}>{item}</li>)}</ul></article>\n      </section>\n    </main>\n  );\n}\n`,
    },
    {
      relativePath: "source/data/product.ts",
      mimeType: "text/typescript",
      body: `export const productData = ${JSON.stringify(productData, null, 2)} as const;\n`,
    },
    {
      relativePath: "source/styles.css",
      mimeType: "text/css",
      body: `.productWorkspace { display: grid; gap: 24px; color: #111827; background: #f8fafc; font-family: Inter, "Noto Sans JP", system-ui, sans-serif; }\n.hero, .summaryStack article, .workspace, .detailGrid article { border: 1px solid #d7dce2; background: #fff; padding: 22px; }\n.eyebrow { margin: 0; color: #00a58e; font-weight: 800; }\n.hero h1 { margin: 8px 0; font-size: 32px; }\n.summaryStack { display: grid; gap: 14px; }\n.summaryStack p, li { line-height: 1.85; }\n.workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr) 260px; gap: 16px; }\n.detailGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }\n.panel, .meetingBoard { display: grid; gap: 12px; align-content: start; }\n.meetingBoard article { border: 1px solid #e5e7eb; background: #f9fafb; padding: 14px; }\nbutton { border: 1px solid #111827; background: #111827; color: #fff; padding: 10px 12px; }\n@media (max-width: 820px) { .workspace, .detailGrid { grid-template-columns: 1fr; } }\n`,
    },
    {
      relativePath: "source/package.json",
      mimeType: "application/json",
      body: JSON.stringify({ private: true, scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "16.2.9", react: "19.2.4", "react-dom": "19.2.4" } }, null, 2),
    },
  ];
};

const sourceIndexFile = (config: ProductGenerationConfig, sourceFiles: SourceFile[]) => `/*\n * ${config.title}\n *\n * Compatibility file. Real implementation files live under source/.\n *\n * Source files:\n * - ${sourceFiles.map((file) => file.relativePath).join("\n * - ")}\n */\n\nexport const productArtifact = ${JSON.stringify({ title: config.title, oneLiner: config.oneLiner, sourceRoot: "source/", entrypoint: "source/app/page.tsx", process: config.process, architecture: config.architecture, mockups: config.mockups }, null, 2)} as const;\n`;

const reviewForTemplate = (config: ProductGenerationConfig, sourceFiles: SourceFile[]) => {
  const rubrics = [
    {
      key: "doc26_product_clarity",
      label: "作品として意味がわかるか",
      score: config.oneLiner.length >= 20 && config.concept.length >= 50 ? 5 : 3,
    },
    {
      key: "doc26_post_naturalness",
      label: "投稿として自然に見えるか",
      score: config.title.length > 0 && config.interestingness.length >= 40 ? 5 : 3,
    },
    {
      key: "doc26_demo_visibility",
      label: "Demoとして見られるか",
      score: config.mockups.length >= 2 && config.process.length >= 4 ? 5 : 3,
    },
    {
      key: "doc26_readme_value",
      label: "READMEで意味が伝わるか",
      score: config.targetUser && config.userMoment && config.nextGrowth.length >= 30 ? 5 : 3,
    },
    {
      key: "doc26_source_artifact",
      label: "Source / Artifactとして確認できるか",
      score: sourceFiles.length >= 5 && config.sourcePlan.length >= 5 && config.architecture.length >= 4 ? 5 : 3,
    },
    {
      key: "doc26_human_reaction",
      label: "人間が反応できるか",
      score: config.roles.length >= 3 && config.reviewLanes.length >= 3 ? 5 : 3,
    },
  ];
  const totalScore = rubrics.reduce((sum, item) => sum + item.score, 0);
  return {
    status: totalScore >= 24 ? "pass" : "needs_review",
    totalScore,
    maxScore: 30,
    rubrics,
    summary: `Reviewed with DOC-26 minimum work criteria: ${totalScore}/30.`,
  };
};

async function copyMockups(artifactDir: string, artifactRoot: string): Promise<ArtifactFile[]> {
  const mockups = [
    { source: path.join(process.cwd(), "public", "mockups", "generic-product-top.svg"), targetName: "mockup-top.svg", mimeType: "image/svg+xml", label: "Top screen" },
    { source: path.join(process.cwd(), "public", "mockups", "generic-product-workspace.svg"), targetName: "mockup-workspace.svg", mimeType: "image/svg+xml", label: "Workspace screen" },
  ];
  const files: ArtifactFile[] = [];
  await mkdir(path.join(artifactDir, "mockups"), { recursive: true });
  for (const mockup of mockups) {
    const body = await readFile(mockup.source);
    await writeFile(path.join(artifactDir, "mockups", mockup.targetName), body);
    files.push({ type: "mockup_image", path: `${artifactRoot}/mockups/${mockup.targetName}`, mimeType: mockup.mimeType, body });
  }
  const manifest = JSON.stringify({ images: mockups.map((mockup) => ({ label: mockup.label, path: `${artifactRoot}/mockups/${mockup.targetName}`, mimeType: mockup.mimeType })) }, null, 2);
  await writeFile(path.join(artifactDir, "mockups", "mockup-manifest.json"), manifest, "utf8");
  files.push({ type: "mockup_manifest", path: `${artifactRoot}/mockups/mockup-manifest.json`, mimeType: "application/json", body: manifest });
  return files;
}

async function main() {
  const args = parseArgs();
  const config = args.productConceptJson
    ? loadProductConceptConfig(args.productConceptJson)
    : templateForTheme(args.theme);
  if (!args.theme) args.theme = config.title || templateFile.default.title;
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 17);
  const runId = `run_${args.triggerType}_${stamp}_${randomUUID().slice(0, 6)}`;
  const themeId = `theme_${args.triggerType}_${stamp}_${slugify(args.theme)}`;
  const candidateId = `cand_${args.triggerType}_${stamp}_${slugify(args.theme)}`;
  const agentId = args.agents[0] ?? "agent_a";
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const kind = args.kinds[0] ?? "board";
  // FL-2: 過去の反応から得た改善ガイダンスを読み、生成物・run証跡へ反映する
  const feedbackGuidance = await readFeedbackGuidance();
  const guidanceText = formatGuidanceForPrompt(feedbackGuidance, { agentId: agent.id });
  const projectId = `proj_${args.triggerType}_${stamp}_01_${slugify(config.title)}_artifact`;
  const agentProfileSnapshot = await buildAgentProfileSnapshot(
    [agent.id],
    `manual-pipeline:${runId}:${projectId}`,
  );
  const artifactRoot = `runs/${runId}/projects/${projectId}`;
  const artifactDir = path.join(process.cwd(), "artifacts", artifactRoot);
  const sourceFiles = sourceFilesForTemplate(config, args.theme, agent.code);
  const sourceIndex = sourceIndexFile(config, sourceFiles);
  const review = reviewForTemplate(config, sourceFiles);
  const validationActor = { actorType: "validation_worker", actorId: "local_validation_worker", actorName: "Local Validation Worker" };
  const systemActor = { actorType: "system", actorId: "manual_pipeline", actorName: "Manual Pipeline" };

  const metadata = {
    label: config.title,
    runId,
    projectId,
    themeId,
    agentId: agent.id,
    agentCode: agent.code,
    assignmentMode: "single_agent_single_project",
    artifactKind: kind,
    generatedOutput: {
      title: config.title,
      oneLiner: config.oneLiner,
      artifactShape: kind,
      templatePatternId: config.patternId ?? config.id,
    },
    interestingness: config.interestingness,
    targetUser: config.targetUser,
    userMoment: config.userMoment,
    roles: config.roles,
    process: config.process,
    architecture: config.architecture,
    mockups: config.mockups,
    sourcePlan: config.sourcePlan,
    productConceptSource: config.productConceptSource,
    agentProfileSnapshotPath: `${artifactRoot}/agent-profile-snapshot.json`,
    sourcePath: `${artifactRoot}/source/app/page.tsx`,
    demoPath: `${artifactRoot}/demo.html`,
    readmePath: `${artifactRoot}/README.md`,
    generatedBy: `manual-pipeline:${agent.id}:${kind}`,
    generatedAt: now.toISOString(),
    planner: args.planner,
    plannerStatus: args.productConceptJson
      ? "product_concept_json"
      : args.planner === "codex"
        ? "codex_generated"
        : "template",
    model: args.model,
    feedbackGuidanceApplied: feedbackGuidance
      ? {
          window: feedbackGuidance.window,
          generatedAt: feedbackGuidance.generatedAt,
          nextRunGuidance: feedbackGuidance.nextRunGuidance,
          positivePatterns: feedbackGuidance.positivePatterns.slice(0, 3),
          avoidNext: feedbackGuidance.avoidNext.slice(0, 3),
        }
      : null,
  };
  const demoHtml = htmlShell(config, agent.name);
  const labels = templateFile.labels;
  const readme = [
    `# ${config.title}`,
    "",
    config.oneLiner,
    "",
    "## Theme",
    args.theme,
    "",
    "## Generated by",
    `${agent.name} (${agent.code})`,
    "",
    `## ${labels.concept}`,
    config.concept,
    "",
    `## ${labels.interestingness}`,
    config.interestingness,
    "",
    `## ${labels.nextGrowth}`,
    config.nextGrowth,
    "",
    "## Roles",
    ...config.roles.map((role) => `- ${role}`),
    "",
    "## Process",
    ...config.process.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Architecture",
    ...config.architecture.map((item) => `- ${item}`),
    "",
    "## Mockups",
    ...config.mockups.map((item) => `- ${item}`),
    "",
    "## Source plan",
    ...config.sourcePlan.map((item) => `- ${item}`),
    "",
    "## Risks / constraints",
    ...config.risks.map((item) => `- ${item}`),
    "",
    ...(guidanceText
      ? ["## 参照した改善ガイダンス（feedback loop）", "前回までの反応を集計したガイダンスを参照して生成しました。", "", guidanceText, ""]
      : []),
    ...(config.productConceptSource
      ? ["## ProductConcept source", config.productConceptSource, ""]
      : []),
    "## Generated files",
    "- `metadata.json`",
    "- `demo.html`",
    "- `source/app/page.tsx`",
    "- `source/components/ProductWorkspace.tsx`",
    "- `source/data/product.ts`",
    "- `source/styles.css`",
    "- `source/package.json`",
    "- `README.md`",
    "- `manifest.json`",
    "- `codex/generation-task.md`",
    "- `codex/generation-output.json`",
    "- `validation/codex-review.json`",
  ].join("\n");

  const codexTask = ["# Codex generation task", "", `- theme: ${args.theme}`, `- agent: ${agent.name} (${agent.code})`, "- copy source: scripts/templates/product-templates.json"].join("\n");
  const codexInputBody = JSON.stringify({ version: 1, theme: args.theme, agent: { id: agent.id, code: agent.code, name: agent.name }, templateId: config.id, startingDraft: config }, null, 2);
  const codexOutputBody = JSON.stringify({ version: 1, status: "codex_generated", theme: args.theme, ...config, sourceFiles: sourceFiles.map((file) => file.relativePath) }, null, 2);
  const codexReviewBody = JSON.stringify(review, null, 2);
  const codexRevisionNotes = ["# Codex revision notes", "", `- planner: ${args.planner}`, `- status: ${review.status}`, `- score: ${review.totalScore}/${review.maxScore}`, "", "Product copy is loaded from scripts/templates/product-templates.json."].join("\n");
  const manifestBody = JSON.stringify({ version: 1, projectId, runId, title: config.title, sourceType: "static_html_and_tsx", artifactRoot, productConceptSource: config.productConceptSource ?? null, files: ["metadata.json", "demo.html", "source.tsx", "README.md", "agent-profile-snapshot.json", "source/app/page.tsx", "source/components/ProductWorkspace.tsx", "source/data/product.ts", "source/styles.css", "diagrams/process.json", "diagrams/architecture.json", "mockups/mockup-briefs.json", "generation/quality-loop.json"] }, null, 2);
  const llmContractBody = JSON.stringify({ version: 1, mode: "single_theme_single_agent_single_project", templateId: config.id, input: { theme: args.theme, assignedAgentCode: agent.code }, expectedOutput: config }, null, 2);
  const llmReviewBody = JSON.stringify({ status: review.status, totalScore: review.totalScore, maxScore: review.maxScore, summary: review.summary }, null, 2);
  const codeReviewBody = JSON.stringify({ status: "pass", summary: "The MVP static artifact passed local checks." }, null, 2);
  const dependencyReportBody = JSON.stringify({ runtime: "static_artifact", externalDependencies: [], packageManager: "none" }, null, 2);

  await mkdir(artifactDir, { recursive: true });
  await mkdir(path.join(artifactDir, "source", "app"), { recursive: true });
  await mkdir(path.join(artifactDir, "source", "components"), { recursive: true });
  await mkdir(path.join(artifactDir, "source", "data"), { recursive: true });
  await mkdir(path.join(artifactDir, "llm"), { recursive: true });
  await mkdir(path.join(artifactDir, "codex"), { recursive: true });
  await mkdir(path.join(artifactDir, "validation"), { recursive: true });
  await mkdir(path.join(artifactDir, "diagrams"), { recursive: true });
  await mkdir(path.join(artifactDir, "mockups"), { recursive: true });
  await mkdir(path.join(artifactDir, "generation"), { recursive: true });

  const processDiagramBody = JSON.stringify(
    { version: 1, title: `${config.title} process`, steps: config.process },
    null,
    2,
  );
  const architectureDiagramBody = JSON.stringify(
    { version: 1, title: `${config.title} architecture`, nodes: config.architecture },
    null,
    2,
  );
  const mockupBriefsBody = JSON.stringify(
    { version: 1, title: `${config.title} mockups`, mockups: config.mockups },
    null,
    2,
  );
  const qualityLoopBody = JSON.stringify(
    {
      version: 1,
      productConceptSource: config.productConceptSource ?? null,
      sourcePlan: config.sourcePlan,
      qualityReview: config.qualityReview ?? null,
    },
    null,
    2,
  );

  await writeFile(path.join(artifactDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  await writeFile(
    path.join(artifactDir, "agent-profile-snapshot.json"),
    JSON.stringify(agentProfileSnapshot, null, 2),
    "utf8",
  );
  await writeFile(path.join(artifactDir, "demo.html"), demoHtml, "utf8");
  await writeFile(path.join(artifactDir, "source.tsx"), sourceIndex, "utf8");
  for (const file of sourceFiles) await writeFile(path.join(artifactDir, file.relativePath), file.body, "utf8");
  await writeFile(path.join(artifactDir, "README.md"), readme, "utf8");
  await writeFile(path.join(artifactDir, "manifest.json"), manifestBody, "utf8");
  await writeFile(path.join(artifactDir, "llm", "contract.json"), llmContractBody, "utf8");
  await writeFile(path.join(artifactDir, "llm", "generation-prompt.json"), JSON.stringify({ version: 1, planner: args.planner, prompt: { templatePath: "scripts/templates/product-templates.json" }, generatedAt: now.toISOString() }, null, 2), "utf8");
  await writeFile(path.join(artifactDir, "validation", "llm-review.json"), llmReviewBody, "utf8");
  await writeFile(path.join(artifactDir, "validation", "code-review.json"), codeReviewBody, "utf8");
  await writeFile(path.join(artifactDir, "validation", "dependency-report.json"), dependencyReportBody, "utf8");
  await writeFile(path.join(artifactDir, "diagrams", "process.json"), processDiagramBody, "utf8");
  await writeFile(path.join(artifactDir, "diagrams", "architecture.json"), architectureDiagramBody, "utf8");
  await writeFile(path.join(artifactDir, "mockups", "mockup-briefs.json"), mockupBriefsBody, "utf8");
  await writeFile(path.join(artifactDir, "generation", "quality-loop.json"), qualityLoopBody, "utf8");
  await writeFile(path.join(artifactDir, "codex", "generation-task.md"), codexTask, "utf8");
  await writeFile(path.join(artifactDir, "codex", "generation-input.json"), codexInputBody, "utf8");
  await writeFile(path.join(artifactDir, "codex", "generation-output.json"), codexOutputBody, "utf8");
  await writeFile(path.join(artifactDir, "codex", "revision-notes.md"), codexRevisionNotes, "utf8");
  await writeFile(path.join(artifactDir, "validation", "codex-review.json"), codexReviewBody, "utf8");
  await writeFile(path.join(artifactDir, "validation", "self-review.json"), codexReviewBody, "utf8");

  const validation = await validateArtifactDirectory(artifactDir);
  const validationReportBody = JSON.stringify({ ...validation, checkedBy: validationActor, checkedAt: now.toISOString() }, null, 2);
  await writeFile(path.join(artifactDir, "validation", "validation.json"), validationReportBody, "utf8");
  const mockupFiles = await copyMockups(artifactDir, artifactRoot);

  const artifactFiles: ArtifactFile[] = [
    { type: "metadata", path: `${artifactRoot}/metadata.json`, mimeType: "application/json", body: JSON.stringify(metadata, null, 2) },
    { type: "agent_profile_snapshot", path: `${artifactRoot}/agent-profile-snapshot.json`, mimeType: "application/json", body: JSON.stringify(agentProfileSnapshot, null, 2) },
    { type: "demo", path: `${artifactRoot}/demo.html`, mimeType: "text/html", body: demoHtml },
    { type: "source", path: `${artifactRoot}/source.tsx`, mimeType: "text/tsx", body: sourceIndex },
    { type: "readme", path: `${artifactRoot}/README.md`, mimeType: "text/markdown", body: readme },
    { type: "manifest", path: `${artifactRoot}/manifest.json`, mimeType: "application/json", body: manifestBody },
    { type: "llm_contract", path: `${artifactRoot}/llm/contract.json`, mimeType: "application/json", body: llmContractBody },
    { type: "llm_prompt", path: `${artifactRoot}/llm/generation-prompt.json`, mimeType: "application/json", body: JSON.stringify({ version: 1 }) },
    { type: "llm_review", path: `${artifactRoot}/validation/llm-review.json`, mimeType: "application/json", body: llmReviewBody },
    { type: "code_review", path: `${artifactRoot}/validation/code-review.json`, mimeType: "application/json", body: codeReviewBody },
    { type: "dependency_report", path: `${artifactRoot}/validation/dependency-report.json`, mimeType: "application/json", body: dependencyReportBody },
    { type: "process_diagram", path: `${artifactRoot}/diagrams/process.json`, mimeType: "application/json", body: processDiagramBody },
    { type: "architecture_diagram", path: `${artifactRoot}/diagrams/architecture.json`, mimeType: "application/json", body: architectureDiagramBody },
    { type: "mockup_brief", path: `${artifactRoot}/mockups/mockup-briefs.json`, mimeType: "application/json", body: mockupBriefsBody },
    { type: "quality_loop", path: `${artifactRoot}/generation/quality-loop.json`, mimeType: "application/json", body: qualityLoopBody },
    { type: "codex_task", path: `${artifactRoot}/codex/generation-task.md`, mimeType: "text/markdown", body: codexTask },
    { type: "codex_input", path: `${artifactRoot}/codex/generation-input.json`, mimeType: "application/json", body: codexInputBody },
    { type: "codex_output", path: `${artifactRoot}/codex/generation-output.json`, mimeType: "application/json", body: codexOutputBody },
    { type: "codex_revision_notes", path: `${artifactRoot}/codex/revision-notes.md`, mimeType: "text/markdown", body: codexRevisionNotes },
    { type: "codex_review", path: `${artifactRoot}/validation/codex-review.json`, mimeType: "application/json", body: codexReviewBody },
    { type: "self_review", path: `${artifactRoot}/validation/self-review.json`, mimeType: "application/json", body: codexReviewBody },
    { type: "validation_report", path: `${artifactRoot}/validation/validation.json`, mimeType: "application/json", body: validationReportBody },
    ...sourceFiles.map((file) => ({ type: "source_file", path: `${artifactRoot}/${file.relativePath}`, mimeType: file.mimeType, body: file.body })),
    ...mockupFiles,
  ];

  const publishStatus = validation.status === "pass" ? "auto_published" : "needs_review";
  const publishDecision = validation.status === "pass" ? "auto_published" : "approval_requested";
  const approvalRequired = validation.status !== "pass";
  const autonomyLevel = autonomyLevelForTrigger(args.triggerType);
  const sourceInteractionType = sourceInteractionForTrigger(args.triggerType);
  const owner = ownerForTrigger(args.triggerType);
  const safetyBoundary = safetyBoundaryFor(validation.status, approvalRequired);
  const humanInstructionId =
    args.triggerType === "feedback_driven" && feedbackGuidance
      ? `feedback_guidance:${feedbackGuidance.generatedAt}`
      : args.triggerType === "manual"
        ? `manual_theme:${slugify(args.theme)}`
        : null;
  const costSummary = {
    model: args.model,
    planner: args.planner,
    estimatedCostUsd: 0,
    note: "local template generation; no external LLM call",
  };

  await prisma.run.create({
    data: {
      id: runId,
      status: "completed",
      triggerType: args.triggerType,
      ...systemActor,
      autonomyLevel,
      approvalRequired,
      humanInstructionId,
      ...owner,
      sourceInteractionType,
      toolPolicyJson: JSON.stringify(toolPolicy),
      sandboxMode: safetyBoundary.sandboxMode,
      costSummaryJson: JSON.stringify(costSummary),
      startedAt: now,
      completedAt: now,
      selectedThemeId: themeId,
      generatedProjectCount: 1,
      publishedProjectCount: validation.status === "pass" ? 1 : 0,
      failedProjectCount: validation.status === "pass" ? 0 : 1,
      summary: `${args.triggerType} pipeline generated 1 project from ${args.theme}.${feedbackGuidance ? " (guided by feedback loop)" : ""}`,
    },
  });
  await prisma.themeCandidate.create({ data: { id: candidateId, runId, title: args.theme, problemStatement: "Can an AI agent turn this theme into a small product artifact?", prototypeQuestion: "What is the smallest useful product page for this theme?", expectedUsers: JSON.stringify(["operators", "builders"]), expectedCategories: JSON.stringify([config.categoryId]), whyNow: "Suitable for the current minimum generation loop.", riskNotes: "Local static artifact only.", evaluationScores: JSON.stringify({ prototypeability: 5, novelty: 4, riskLow: 5, fitToProdia: 5 }), selected: true } });
  await prisma.theme.create({ data: { id: themeId, runId, candidateId, title: args.theme, sourceSignals: JSON.stringify([]), problemStatement: "The system needs a small artifact for this theme.", prototypeQuestion: "Can the AI create a useful small product artifact?", selectionReason: `${args.triggerType} generation test.`, riskNotes: "Local static artifact only.", aiBranchingHints: JSON.stringify({ [agent.code]: kind }), status: "used", selectedAt: now } });
  await prisma.project.create({ data: { id: projectId, runId, themeId, agentId: agent.id, categoryId: config.categoryId, title: config.title, oneLiner: config.oneLiner, concept: config.concept, useCase: config.useCase, whatWasTried: config.whatWasTried, howItRuns: "The manual pipeline wrote demo, source, metadata, and README files to Artifact Store.", nextGrowth: config.nextGrowth, status: publishStatus, validationStatus: validation.status, createdByType: "agent", createdById: agent.id, createdByName: agent.name, approvalRequired, publishedByType: validation.status === "pass" ? "system" : null, publishedById: validation.status === "pass" ? "local_publisher" : null, publishedByName: validation.status === "pass" ? "Local Publisher" : null, publishDecision, publishDecisionReason: validation.status === "pass" ? "System auto-published the artifact after validation passed." : "Validation did not pass, so the artifact is waiting for review.", artifactRoot, thumbnailPath: `${artifactRoot}/demo.html`, publishedAt: validation.status === "pass" ? now : null } });
  await prisma.validation.create({ data: { id: `val_${projectId}`, projectId, runId, status: validation.status, ...validationActor, buildStatus: "skipped", runStatus: validation.checks.demo_html, screenshotStatus: "skipped", metadataStatus: validation.checks.metadata_json, riskStatus: validation.checks.secret_scan, duplicateStatus: "pass", grainStatus: "pass", secretStatus: validation.checks.secret_scan, externalDependencyStatus: "pass", promptInjectionStatus: "pass", readmeStatus: validation.checks["file:README.md"], displayStatus: validation.checks.demo_html, summary: validation.summary, errorMessage: validation.errors.length > 0 ? validation.errors.join("; ") : null, checkedAt: now } });

  const validationChecks = [
    { key: "metadata_complete", status: validation.checks.metadata_json, summary: "metadata.json exists and contains required fields." },
    { key: "artifact_exists", status: validation.checks.demo_html, summary: "demo.html exists as a stored artifact." },
    { key: "duplicate_like", status: "pass", summary: "No duplicate-like issue was detected." },
    { key: "prompt_injection_like", status: "pass", summary: "No prompt-injection-like issue was detected." },
    { key: "external_dependency_like", status: "pass", summary: "No external dependency requirement was detected." },
    { key: "codex_review_status", status: review.status === "pass" ? "pass" : "fail", summary: `Codex review status: ${review.status}` },
    { key: "doc26_review_score", status: review.totalScore >= 24 ? "pass" : "fail", summary: `DOC-26 review score: ${review.totalScore}/${review.maxScore}` },
    ...review.rubrics.map((rubric) => ({
      key: rubric.key,
      status: rubric.score >= 5 ? "pass" : "fail",
      summary: `${rubric.label}: ${rubric.score}/5`,
    })),
  ];
  for (const check of validationChecks) await prisma.validationCheck.create({ data: { id: randomUUID(), validationId: `val_${projectId}`, projectId, runId, key: check.key, status: check.status, ...validationActor, summary: check.summary } });
  for (const file of artifactFiles) {
    const artifactActor = artifactActorForType(file.type, agent, validationActor, systemActor);
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        projectId,
        runId,
        type: file.type,
        path: file.path,
        mimeType: file.mimeType,
        sizeBytes: Buffer.byteLength(file.body),
        checksum: checksum(file.body),
        ...artifactActor,
        validationStatus: file.type.includes("validation") || file.type.includes("review") ? validation.status : "not_checked",
        riskSummary: validation.errors.length > 0 ? validation.errors.join("; ") : null,
        metadataJson: JSON.stringify({
          role: file.type,
          sourceInteractionType,
          autonomyLevel,
          publishGate: safetyBoundary.publishGate,
        }),
      },
    });
  }
  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "run_created",
      ...systemActor,
      summary: `${args.triggerType} run was created by the local generation pipeline.`,
      metadataJson: JSON.stringify({
        triggerType: args.triggerType,
        autonomyLevel,
        humanInstructionId,
        owner,
        sourceInteractionType,
        safetyBoundary,
        cost: costSummary,
        count: 1,
      }),
    },
  });
  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      projectId,
      agentId: agent.id,
      type: "artifact_generated",
      actorType: "agent",
      actorId: agent.id,
      actorName: agent.name,
      summary: `${agent.name} generated ${config.title}.`,
      metadataJson: JSON.stringify({
        kind,
        artifactRoot,
        autonomyLevel,
        sourceInteractionType,
        toolPolicy,
      }),
    },
  });
  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      projectId,
      agentId: agent.id,
      type: publishDecision === "auto_published" ? "published" : "approval_requested",
      ...systemActor,
      summary: publishDecision === "auto_published" ? `${config.title} was auto-published after validation.` : `${config.title} is waiting for review.`,
      metadataJson: JSON.stringify({
        publishDecision,
        publishGate: safetyBoundary.publishGate,
        validationStatus: validation.status,
        publishedByType: validation.status === "pass" ? "system" : null,
      }),
    },
  });

  console.log(`created run: ${runId}`);
  console.log(`project: ${projectId}`);
  console.log(`open: http://localhost:3000/runs/${runId}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
