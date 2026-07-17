import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeStoredArtifactFile } from "../src/lib/artifact-store";
import { generateVisualAssetFiles } from "./generate-visual-assets";
import {
  coerceParseableJsonContent,
  isReservedPipelineMetadataFile,
  repairJsonFileContent,
} from "./llm-pipeline/json-file-repair";
import { isProductCategoryId } from "./product-categories";
import { normalizeShortTagline } from "./product-copy";
import { normalizeUsageGuide, type UsageGuide } from "../src/lib/usage-guide";

type BuildPlan = {
  requirementSpecId: string;
  framework: string;
  interestingness?: string;
  // トップフィード/詳細ページ「プロダクト名直下の一文キャッチコピー」(例:「長い議事録を3行の決定メモに変える」)。
  shortTagline?: string;
  // 詳細ページ「タブ上のボックス」に出す2〜3文のプロダクト説明。
  productSummary?: string;
  // 公開時 Project.categoryId の第1候補(builder選択)。PRODUCT_CATEGORIES 内の id のみ metadata へ伝搬する。
  categoryId?: string;
  categoryReason?: string;
  // 詳細ページ「使い方」タブの番号付き手順(builder生成の生値)。正規化は metadata 構築時に行う。
  usageGuide?: Record<string, unknown>;
  files: Array<{
    path: string;
    purpose: string;
    content?: string;
  }>;
  implementationNotes: string[];
  knownRisks: string[];
  submissionReadiness: {
    firstScreenValue: string;
    coreInteraction: string;
    stateChange?: string;
    inspectableOutput: string;
    staticDataBoundary: string;
    remainingWeakness: string;
  };
  mvpContract?: Partial<MvpContract>;
  mvpContractV2?: Partial<MvpContractV2>;
  interactionProofPlan?: Partial<InteractionProofPlan>;
  sourceTrace?: Partial<SourceTrace>;
};

type SourceTrace = {
  sourceProductUsed?: string;
  sourceProductUse?: string;
  sourceEvidenceAudit?: unknown;
  antiCloneBoundary?: string;
  sourceBoundary?: string;
  missingSourceEvidence?: string[];
};

type InteractionProofPlan = {
  primaryAction: string;
  initialState: string;
  expectedState: string;
  visibleEvidence: string[];
  proofSelectors?: string[];
  requiredSourceFiles: string[];
  manualFallbackReason?: string;
};

type MvpContract = {
  firstScreenValue: string;
  coreInteraction: string;
  stateChange: string;
  inspectableOutput: string;
  staticDataBoundary: string;
  requiredFiles: string[];
  nonGoals: string[];
  forbiddenDependencies: string[];
};

type ArtifactTier =
  | "static_mvp"
  | "proposed_integration"
  | "mocked_integration_mvp"
  | "live_integration_candidate";

type ExternalDependencyMode = "none" | "proposed" | "mocked_adapter" | "live_required";

type ExternalIntegrationContract = {
  service: string;
  intendedUse: string;
  dataFlow: string;
  authRequirement: "none" | "api_key" | "oauth" | "unknown";
  currentImplementation: "not_connected" | "mock_data" | "mock_adapter" | "live_call";
  adapterPath?: string;
  sampleDataPath?: string;
  riskNotes: string[];
};

type RuntimeBoundary = {
  networkCalls: "none" | "live_required";
  secrets: "none" | "required";
  externalWrites: "none" | "proposed" | "live_required";
};

type MvpComplexityBudget = {
  maxScreens: 1 | 2;
  maxPrimaryActions: 1;
  maxSourceFiles: number;
  maxNewDependencies: 0;
  allowDatabase: false;
};

type IntegrationAssumption = {
  service: string;
  officialDocsVerifiedAt?: string;
  verificationStatus: "unverified" | "official_docs_checked" | "not_applicable";
  unavailableOrUnknown: string[];
  rateLimitRisk: "low" | "medium" | "high" | "unknown";
  costRisk: "low" | "medium" | "high" | "unknown";
  termsRisk: "low" | "medium" | "high" | "unknown";
};

type MockFidelity = {
  samplePayloadPath?: string;
  simulatedBehaviors: string[];
  omittedBehaviors: string[];
  failureCasesIncluded: string[];
};

type ClaimBoundary = {
  publicCopyMustSay: string[];
  publicCopyMustNotSay: string[];
};

type RenderVerification = {
  required: true;
  checks: Array<"render" | "click" | "state_change" | "screenshot">;
  screenshotPath?: string;
};

type MvpContractV2 = MvpContract & {
  contractVersion: "mvp-contract-v2";
  artifactTier: ArtifactTier;
  externalDependencyMode: ExternalDependencyMode;
  externalIntegrations: ExternalIntegrationContract[];
  runtimeBoundary: RuntimeBoundary;
  mvpComplexityBudget: MvpComplexityBudget;
  integrationAssumptions: IntegrationAssumption[];
  mockFidelity?: MockFidelity;
  claimBoundary: ClaimBoundary;
  renderVerification: RenderVerification;
  humanReviewTriggers: string[];
};

type CliArgs = {
  input: string;
  output?: string;
  run?: string;
  artifact?: string;
  agentId?: string;
  dryRun: boolean;
};

const fallbackSubmissionReadiness: BuildPlan["submissionReadiness"] = {
  firstScreenValue: "Not provided by builder response. Inspect README.md and source placeholders.",
  coreInteraction: "Not provided by builder response. Inspect BuildPlan.files[] purposes.",
  stateChange: "Not provided by builder response. Inspect the interactive source file before publishing.",
  inspectableOutput: "README.md, metadata.json, demo-placeholder.md, and source/ files.",
  staticDataBoundary: "Not provided by builder response. Treat this as artifact-only until reviewed.",
  remainingWeakness: "Builder response did not include submissionReadiness.",
};

const defaultForbiddenDependencies = [
  "external API",
  "secret",
  "login-only flow",
  "paid API",
  "external publishing",
];

type MaterializedFile = {
  relativePath: string;
  purpose: string;
  sizeBytes: number;
  checksum: string;
  generatedFrom: string;
};

type MaterializedMetadata = {
  version: 1;
  artifactId: string;
  generatedAt: string;
  generatedFrom: {
    input: string;
    requirementSpecId: string;
    framework: string;
  };
  sourceFiles: MaterializedFile[];
  demo: {
    path: string;
    purpose: string;
  };
  readiness: BuildPlan["submissionReadiness"];
  interestingness?: string;
  shortTagline?: string;
  productSummary?: string;
  // 公開時 Project.categoryId の第1候補(builder選択、whitelist検証済みのみ)。
  categoryId?: string;
  // 詳細ページ「使い方」タブの番号付き手順(normalizeUsageGuide 済み)。
  usageGuide?: UsageGuide;
  mvpContract: MvpContract;
  mvpContractV2: MvpContractV2;
  interactionProofPlan?: InteractionProofPlan;
  generatedOutput?: {
    title?: string;
    oneLiner?: string;
    artifactShape?: string;
    templatePatternId?: string;
    surfacePattern?: string;
    aiMechanismPattern?: string;
  };
  // R1: review/rewrite ループで rewriter が差し替え/追加したソースを記録（publish 監査用）。
  rewriteApplied?: {
    changedFilePaths: string[];
    appendedFilePaths: string[];
  };
  implementationNotes: string[];
  knownRisks: string[];
  sourceProvenance?: SourceTrace;
  // AS-5: 自走run（--agent）のとき、誰が作ったか＋一人称の企画意図＋人間可読タイトルを記録し、publishがそれを使う。
  title?: string;
  oneLiner?: string;
  agentId?: string;
  selfDirectedPlan?: {
    agentId: string;
    planningIntent: string;
    publicProductionMemo?: string;
    feedbackConstraints: string[];
    learningApplied?: string[];
  };
  dbWrite: {
    status: "skipped";
    reason: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const parseArgs = (): CliArgs => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return {
    input: String(values.get("input") ?? "artifacts/llm-pipeline-runs/findy_gemini_evidence/builder/response.json"),
    output: typeof values.get("output") === "string" ? String(values.get("output")) : undefined,
    run: typeof values.get("run") === "string" ? String(values.get("run")) : undefined,
    artifact: typeof values.get("artifact") === "string" ? String(values.get("artifact")) : undefined,
    agentId: typeof values.get("agent") === "string" ? String(values.get("agent")) : undefined,
    dryRun: values.get("dry-run") === true || values.get("write") !== true,
  };
};

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const looksLikeCode = (value: string) =>
  /\b(import|export|const|let|function|type|interface|class|return)\b/.test(value) ||
  value.includes("<") ||
  value.includes("{");

const isSourceLike = (filePath: string) => /\.(tsx?|jsx?|css|json|md|html|svg)$/i.test(filePath);

const slashPath = (value: string) => value.replace(/\\/g, "/");

const relativeToWeb = (filePath: string) => slashPath(path.relative(process.cwd(), filePath));

const materializedSourcePath = (filePath: string) => {
  const normalized = slashPath(filePath).replace(/^\/+/, "");
  return normalized.startsWith("source/") ? normalized : `source/${normalized}`;
};

const resolveMaterializedPath = (filePath: string, sourceFiles: MaterializedFile[]) => {
  const normalized = slashPath(filePath).replace(/^\/+/, "");
  const prefixed = materializedSourcePath(normalized);
  const sourceMatch = sourceFiles.find(
    (file) =>
      file.relativePath === normalized ||
      file.relativePath === prefixed ||
      file.generatedFrom === normalized ||
      materializedSourcePath(file.generatedFrom) === prefixed,
  );
  return sourceMatch?.relativePath ?? normalized;
};

const deriveRunId = (input: string, explicitRun?: string) => {
  if (explicitRun) return explicitRun;

  const parts = slashPath(input).split("/");
  const markerIndex = parts.indexOf("llm-pipeline-runs");
  if (markerIndex >= 0 && parts[markerIndex + 1]) return parts[markerIndex + 1];

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `manual_materialize_${stamp}`;
};

const safePlanFilePath = (filePath: string) => {
  const normalized = slashPath(filePath).replace(/^\/+/, "");
  if (
    normalized.includes("..") ||
    path.isAbsolute(normalized) ||
    normalized.length === 0 ||
    !isSourceLike(normalized)
  ) {
    throw new Error(`Unsafe or unsupported BuildPlan file path: ${filePath}`);
  }
  return normalized;
};

const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

const firstNonEmpty = (...values: Array<unknown>) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
};

const assertBuildPlan = (value: unknown): BuildPlan => {
  const plan = value as Partial<BuildPlan>;
  if (!plan || typeof plan !== "object") {
    throw new Error("Input JSON must be a BuildPlan object.");
  }
  if (typeof plan.requirementSpecId !== "string" || !plan.requirementSpecId) {
    throw new Error("BuildPlan.requirementSpecId is required.");
  }
  if (typeof plan.framework !== "string" || !plan.framework) {
    throw new Error("BuildPlan.framework is required.");
  }
  if (!Array.isArray(plan.files) || plan.files.length === 0) {
    throw new Error("BuildPlan.files[] must contain at least one file.");
  }
  return {
    requirementSpecId: plan.requirementSpecId,
    framework: plan.framework,
    files: plan.files.map((file, index) => {
      if (!file || typeof file.path !== "string" || typeof file.purpose !== "string") {
        throw new Error(`BuildPlan.files[${index}] must include path and purpose.`);
      }
      return {
        path: safePlanFilePath(file.path),
        purpose: file.purpose,
        content: typeof file.content === "string" ? file.content : undefined,
      };
    }),
    implementationNotes: Array.isArray(plan.implementationNotes)
      ? plan.implementationNotes.filter((item): item is string => typeof item === "string")
      : [],
    knownRisks: Array.isArray(plan.knownRisks)
      ? plan.knownRisks.filter((item): item is string => typeof item === "string")
      : [],
    submissionReadiness:
      plan.submissionReadiness && typeof plan.submissionReadiness === "object"
        ? {
            ...fallbackSubmissionReadiness,
            ...(plan.submissionReadiness as Partial<BuildPlan["submissionReadiness"]>),
          }
        : fallbackSubmissionReadiness,
    mvpContract: plan.mvpContract && typeof plan.mvpContract === "object" ? plan.mvpContract : undefined,
    mvpContractV2:
      plan.mvpContractV2 && typeof plan.mvpContractV2 === "object"
        ? plan.mvpContractV2
        : undefined,
    interactionProofPlan:
      plan.interactionProofPlan && typeof plan.interactionProofPlan === "object"
        ? plan.interactionProofPlan
        : undefined,
    sourceTrace:
      plan.sourceTrace && typeof plan.sourceTrace === "object"
        ? plan.sourceTrace
        : undefined,
    // 公開ページ「何が面白いか」の元。builder が top-level に必須で出す（builder.md）
    // リッチな新規性コピー。ここで拾わないと metadata.json へ伝搬されず、公開ページが
    // 薄い concept にフォールバックしてしまう（過去はこの再構築で取りこぼしていた）。
    interestingness:
      typeof plan.interestingness === "string" && plan.interestingness.trim()
        ? plan.interestingness
        : undefined,
    // 公開コピー/分類の残り3フィールドも同様にここで拾う。この再構築に列挙しないフィールドは
    // 型に定義があっても暗黙に破棄される(shortTagline/productSummary は PR#94 でこの取りこぼしに
    // 該当しており、パイプライン経由では metadata へ一度も伝搬されていなかった。2026-07-10 修正)。
    shortTagline:
      typeof plan.shortTagline === "string" && plan.shortTagline.trim()
        ? plan.shortTagline
        : undefined,
    productSummary:
      typeof plan.productSummary === "string" && plan.productSummary.trim()
        ? plan.productSummary
        : undefined,
    categoryId:
      typeof plan.categoryId === "string" && plan.categoryId.trim() ? plan.categoryId : undefined,
    categoryReason:
      typeof plan.categoryReason === "string" && plan.categoryReason.trim()
        ? plan.categoryReason
        : undefined,
    // 使い方タブの番号付き手順。ここに列挙しないと暗黙破棄される(上記コメント参照)。
    // 構造検証は metadata 構築時の normalizeUsageGuide が担うため、ここでは形だけ通す。
    usageGuide:
      plan.usageGuide && typeof plan.usageGuide === "object" && !Array.isArray(plan.usageGuide)
        ? (plan.usageGuide as Record<string, unknown>)
        : undefined,
  };
};

// R1: rewriter の changedFiles を builder の plan.files にマージする。
// content を持つ変更のみ path 一致で差替/append（builder の response.json 原本は不変）。
// content 無しは builder 本文を維持。不正/非ソース path は throw でなく skip して run を落とさない。
// 禁止依存の再混入は後段 check-mvp-artifact --strict-auto-publish が検出するため、ここでは実体化のみ。
const mergeRewriterChangedFiles = (
  plan: BuildPlan,
  rewriter: Record<string, unknown> | null,
): { applied: string[]; appended: string[] } => {
  const applied: string[] = [];
  const appended: string[] = [];
  if (!rewriter || !Array.isArray(rewriter.changedFiles)) return { applied, appended };
  const byPath = new Map(plan.files.map((file) => [file.path, file]));
  for (const raw of rewriter.changedFiles) {
    if (!isRecord(raw)) continue;
    const rawPath = typeof raw.path === "string" ? raw.path : "";
    let content = typeof raw.content === "string" ? raw.content : "";
    if (!rawPath || !content) continue; // content 無し = 差替対象外（builder 本文を維持）
    let normalized: string;
    try {
      normalized = safePlanFilePath(rawPath);
    } catch {
      continue; // 不正/非ソース path は skip
    }
    // buildPlan.json は成果物ファイルではなくパイプラインメタデータ。rewriter が入力の
    // buildPlan キーからファイル名を捏造して全文再掲→途中切断JSONを混入させる既知事故が
    // あるため、名前で除外する(builder はこの名前を出力しない)。
    if (isReservedPipelineMetadataFile(normalized)) {
      console.warn(
        `[materialize] rewriter change skipped: ${normalized} is pipeline metadata, not an artifact file`,
      );
      continue;
    }
    // .json の差替/追加は書き込み前に parse 検証する。LLM は outer JSON を正しく閉じたまま
    // 内側のファイル内容文字列だけを途中で切ることがあり(11-12KB付近で頻発)、そのまま採用
    // すると strict MVP の generated_source_syntax ゲートで確実に held 落ちする。修復不能なら
    // 変更を捨てて builder 原本を維持(新規追加なら追加しない)する方が、run全体を無駄にしない。
    if (normalized.endsWith(".json")) {
      const coerced = coerceParseableJsonContent(content);
      if (coerced === null) {
        console.warn(
          `[materialize] rewriter change skipped: ${normalized} content is not parseable JSON (likely truncated); keeping builder version`,
        );
        continue;
      }
      content = coerced;
    }
    const existing = byPath.get(normalized);
    if (existing) {
      existing.content = content;
      applied.push(normalized);
    } else {
      const purpose =
        typeof raw.changeSummary === "string" && raw.changeSummary.trim().length > 0
          ? raw.changeSummary
          : "Added by rewriter to resolve a reviewer issue.";
      const file = { path: normalized, purpose, content };
      plan.files.push(file);
      byPath.set(normalized, file);
      appended.push(normalized);
    }
  }
  return { applied, appended };
};

const chooseEntrypoint = (files: MaterializedFile[]) => {
  const exact =
    files.find((file) => file.relativePath === "source/app/page.tsx") ??
    files.find((file) => file.relativePath === "source/source/app/page.tsx");
  if (exact) return exact.relativePath;

  const appPage = files.find((file) => /(^|\/)app\/page\.tsx$/.test(file.generatedFrom));
  if (appPage) return appPage.relativePath;

  const demoLike = files.find((file) => /\.(tsx|jsx)$/.test(file.relativePath) && /demo|workspace|page|catalog/i.test(file.relativePath));
  if (demoLike) return demoLike.relativePath;

  return files.find((file) => /\.(tsx|jsx|ts|js)$/.test(file.relativePath))?.relativePath ?? files[0]?.relativePath ?? "";
};

const buildMvpContract = (plan: BuildPlan, sourceFiles: MaterializedFile[], demoPath: string): MvpContract => {
  const fallbackRequiredFiles = [
    "README.md",
    "metadata.json",
    "manifest.json",
    demoPath,
    "validation/self-review.json",
    ...sourceFiles.map((file) => file.relativePath),
  ];
  const contract = plan.mvpContract ?? {};
  const requiredFilesFromBuilder = asStringArray(contract.requiredFiles).map((requiredPath) => {
    return resolveMaterializedPath(requiredPath, sourceFiles);
  });

  return {
    firstScreenValue: firstNonEmpty(
      contract.firstScreenValue,
      plan.submissionReadiness.firstScreenValue,
      "First screen must show product value, input/control area, and concrete output.",
    ),
    coreInteraction: firstNonEmpty(
      contract.coreInteraction,
      plan.submissionReadiness.coreInteraction,
      "A user-controlled select, filter, score, compare, simulate, route, reveal, or move interaction is required.",
    ),
    stateChange: firstNonEmpty(
      contract.stateChange,
      plan.submissionReadiness.stateChange,
      "The declared interaction must visibly change the displayed output.",
    ),
    inspectableOutput: firstNonEmpty(
      contract.inspectableOutput,
      plan.submissionReadiness.inspectableOutput,
      "README.md, metadata.json, manifest.json, validation/self-review.json, demo placeholder, and source files are inspectable.",
    ),
    staticDataBoundary: firstNonEmpty(
      contract.staticDataBoundary,
      plan.submissionReadiness.staticDataBoundary,
      "Runs entirely on static sample data; no external network, credentials, paid APIs, login, or publishing are required.",
    ),
    requiredFiles:
      requiredFilesFromBuilder.length > 0 ? Array.from(new Set(requiredFilesFromBuilder)) : fallbackRequiredFiles,
    nonGoals:
      asStringArray(contract.nonGoals).length > 0
        ? asStringArray(contract.nonGoals)
        : ["No live external API integration", "No account login", "No paid service dependency", "No external publishing"],
    forbiddenDependencies:
      asStringArray(contract.forbiddenDependencies).length > 0
        ? asStringArray(contract.forbiddenDependencies)
        : defaultForbiddenDependencies,
  };
};

const artifactTiers = [
  "static_mvp",
  "proposed_integration",
  "mocked_integration_mvp",
  "live_integration_candidate",
] as const;

const externalDependencyModes = ["none", "proposed", "mocked_adapter", "live_required"] as const;
const authRequirements = ["none", "api_key", "oauth", "unknown"] as const;
const currentImplementations = ["not_connected", "mock_data", "mock_adapter", "live_call"] as const;
const riskLevels = ["low", "medium", "high", "unknown"] as const;
const verificationStatuses = ["unverified", "official_docs_checked", "not_applicable"] as const;
const renderChecks = ["render", "click", "state_change", "screenshot"] as const;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const defaultModeForTier = (tier: ArtifactTier): ExternalDependencyMode => {
  if (tier === "proposed_integration") return "proposed";
  if (tier === "mocked_integration_mvp") return "mocked_adapter";
  if (tier === "live_integration_candidate") return "live_required";
  return "none";
};

const normalizeV2Path = (value: unknown): string | undefined => {
  const text = firstNonEmpty(value);
  return text ? slashPath(text).replace(/^\/+/, "") : undefined;
};

const normalizeMaterializedV2Path = (value: unknown, sourceFiles: MaterializedFile[]): string | undefined => {
  const normalized = normalizeV2Path(value);
  return normalized ? resolveMaterializedPath(normalized, sourceFiles) : undefined;
};

const normalizeRuntimeBoundary = (
  value: unknown,
  mode: ExternalDependencyMode,
): RuntimeBoundary => {
  const record = isRecord(value) ? value : {};
  return {
    networkCalls: oneOf(
      record.networkCalls,
      ["none", "live_required"] as const,
      mode === "live_required" ? "live_required" : "none",
    ),
    secrets: oneOf(
      record.secrets,
      ["none", "required"] as const,
      mode === "live_required" ? "required" : "none",
    ),
    externalWrites: oneOf(
      record.externalWrites,
      ["none", "proposed", "live_required"] as const,
      mode === "live_required" ? "live_required" : "none",
    ),
  };
};

const normalizeComplexityBudget = (value: unknown): MvpComplexityBudget => {
  const record = isRecord(value) ? value : {};
  const maxSourceFiles = typeof record.maxSourceFiles === "number" && Number.isFinite(record.maxSourceFiles)
    ? Math.max(1, Math.floor(record.maxSourceFiles))
    : 12;
  return {
    maxScreens: record.maxScreens === 2 ? 2 : 1,
    maxPrimaryActions: 1,
    maxSourceFiles,
    maxNewDependencies: 0,
    allowDatabase: false,
  };
};

const normalizeExternalIntegrations = (
  value: unknown,
  sourceFiles: MaterializedFile[],
): ExternalIntegrationContract[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    service: firstNonEmpty(item.service, "Unspecified external API"),
    intendedUse: firstNonEmpty(item.intendedUse, "Describe how this service would support the product after MVP validation."),
    dataFlow: firstNonEmpty(item.dataFlow, "external service -> adapter -> static sample data -> UI"),
    authRequirement: oneOf(item.authRequirement, authRequirements, "unknown"),
    currentImplementation: oneOf(item.currentImplementation, currentImplementations, "not_connected"),
    ...(normalizeMaterializedV2Path(item.adapterPath, sourceFiles)
      ? { adapterPath: normalizeMaterializedV2Path(item.adapterPath, sourceFiles) }
      : {}),
    ...(normalizeMaterializedV2Path(item.sampleDataPath, sourceFiles)
      ? { sampleDataPath: normalizeMaterializedV2Path(item.sampleDataPath, sourceFiles) }
      : {}),
    riskNotes: asStringArray(item.riskNotes),
  }));
};

const normalizeIntegrationAssumptions = (
  value: unknown,
  integrations: ExternalIntegrationContract[],
): IntegrationAssumption[] => {
  if (Array.isArray(value)) {
    const normalized = value.filter(isRecord).map((item) => ({
      service: firstNonEmpty(item.service, "Unspecified external API"),
      ...(firstNonEmpty(item.officialDocsVerifiedAt) ? { officialDocsVerifiedAt: firstNonEmpty(item.officialDocsVerifiedAt) } : {}),
      verificationStatus: oneOf(item.verificationStatus, verificationStatuses, "unverified"),
      unavailableOrUnknown: asStringArray(item.unavailableOrUnknown),
      rateLimitRisk: oneOf(item.rateLimitRisk, riskLevels, "unknown"),
      costRisk: oneOf(item.costRisk, riskLevels, "unknown"),
      termsRisk: oneOf(item.termsRisk, riskLevels, "unknown"),
    }));
    if (normalized.length > 0) return normalized;
  }

  return integrations.map((integration) => ({
    service: integration.service,
    verificationStatus: "unverified",
    unavailableOrUnknown: ["Official API behavior has not been verified during MVP materialization."],
    rateLimitRisk: "unknown",
    costRisk: "unknown",
    termsRisk: "unknown",
  }));
};

const normalizeMockFidelity = (
  value: unknown,
  mode: ExternalDependencyMode,
  sourceFiles: MaterializedFile[],
): MockFidelity | undefined => {
  const record = isRecord(value) ? value : null;
  if (!record && mode !== "mocked_adapter") return undefined;
  return {
    ...(normalizeMaterializedV2Path(record?.samplePayloadPath, sourceFiles)
      ? { samplePayloadPath: normalizeMaterializedV2Path(record?.samplePayloadPath, sourceFiles) }
      : {}),
    simulatedBehaviors:
      asStringArray(record?.simulatedBehaviors).length > 0
        ? asStringArray(record?.simulatedBehaviors)
        : ["Static sample response for the proposed external service."],
    omittedBehaviors:
      asStringArray(record?.omittedBehaviors).length > 0
        ? asStringArray(record?.omittedBehaviors)
        : ["Authentication", "rate limits", "live network calls", "external writes"],
    failureCasesIncluded:
      asStringArray(record?.failureCasesIncluded).length > 0
        ? asStringArray(record?.failureCasesIncluded)
        : ["empty result"],
  };
};

const normalizeClaimBoundary = (value: unknown, mode: ExternalDependencyMode): ClaimBoundary => {
  const record = isRecord(value) ? value : {};
  const defaultMustSay =
    mode === "none"
      ? ["This MVP runs on static sample data."]
      : ["This MVP does not connect to the external service at runtime.", "External integration is a proposal or mock boundary."];
  return {
    publicCopyMustSay:
      asStringArray(record.publicCopyMustSay).length > 0
        ? asStringArray(record.publicCopyMustSay)
        : defaultMustSay,
    publicCopyMustNotSay:
      asStringArray(record.publicCopyMustNotSay).length > 0
        ? asStringArray(record.publicCopyMustNotSay)
        : [
            "real-time external API",
            "automatic external publishing",
            "live external data is guaranteed",
            "production-ready integration",
          ],
  };
};

const normalizeRenderVerification = (value: unknown): RenderVerification => {
  const record = isRecord(value) ? value : {};
  const checks = asStringArray(record.checks).filter((check): check is RenderVerification["checks"][number] =>
    (renderChecks as readonly string[]).includes(check),
  );
  return {
    required: true,
    checks: checks.length > 0 ? checks : ["render", "click", "state_change", "screenshot"],
    ...(normalizeV2Path(record.screenshotPath) ? { screenshotPath: normalizeV2Path(record.screenshotPath) } : {}),
  };
};

const buildMvpContractV2 = (
  plan: BuildPlan,
  mvpContract: MvpContract,
  sourceFiles: MaterializedFile[],
): MvpContractV2 => {
  const raw = isRecord(plan.mvpContractV2) ? plan.mvpContractV2 : {};
  const artifactTier = oneOf(raw.artifactTier, artifactTiers, "static_mvp");
  const externalDependencyMode = oneOf(
    raw.externalDependencyMode,
    externalDependencyModes,
    defaultModeForTier(artifactTier),
  );
  const externalIntegrations = normalizeExternalIntegrations(raw.externalIntegrations, sourceFiles);
  const integrationAssumptions = normalizeIntegrationAssumptions(raw.integrationAssumptions, externalIntegrations);
  const mockFidelity = normalizeMockFidelity(raw.mockFidelity, externalDependencyMode, sourceFiles);
  const requiredFiles = asStringArray(raw.requiredFiles).map((requiredPath) =>
    resolveMaterializedPath(requiredPath, sourceFiles),
  );
  const computedReviewTriggers = [
    ...(externalDependencyMode === "live_required" ? ["externalDependencyMode is live_required"] : []),
    ...(artifactTier === "live_integration_candidate" ? ["artifactTier is live_integration_candidate"] : []),
  ];

  return {
    ...mvpContract,
    contractVersion: "mvp-contract-v2",
    firstScreenValue: firstNonEmpty(raw.firstScreenValue, mvpContract.firstScreenValue),
    coreInteraction: firstNonEmpty(raw.coreInteraction, mvpContract.coreInteraction),
    stateChange: firstNonEmpty(raw.stateChange, mvpContract.stateChange),
    inspectableOutput: firstNonEmpty(raw.inspectableOutput, mvpContract.inspectableOutput),
    staticDataBoundary: firstNonEmpty(raw.staticDataBoundary, mvpContract.staticDataBoundary),
    requiredFiles: requiredFiles.length > 0 ? Array.from(new Set(requiredFiles)) : mvpContract.requiredFiles,
    nonGoals: asStringArray(raw.nonGoals).length > 0 ? asStringArray(raw.nonGoals) : mvpContract.nonGoals,
    forbiddenDependencies:
      asStringArray(raw.forbiddenDependencies).length > 0
        ? asStringArray(raw.forbiddenDependencies)
        : mvpContract.forbiddenDependencies,
    artifactTier,
    externalDependencyMode,
    externalIntegrations,
    runtimeBoundary: normalizeRuntimeBoundary(raw.runtimeBoundary, externalDependencyMode),
    mvpComplexityBudget: normalizeComplexityBudget(raw.mvpComplexityBudget),
    integrationAssumptions,
    ...(mockFidelity ? { mockFidelity } : {}),
    claimBoundary: normalizeClaimBoundary(raw.claimBoundary, externalDependencyMode),
    renderVerification: normalizeRenderVerification(raw.renderVerification),
    humanReviewTriggers: Array.from(new Set([...asStringArray(raw.humanReviewTriggers), ...computedReviewTriggers])),
  };
};

const normalizeInteractionProofPlan = (
  value: unknown,
  sourceFiles: MaterializedFile[],
): InteractionProofPlan | undefined => {
  if (!isRecord(value)) return undefined;
  const requiredSourceFiles = asStringArray(value.requiredSourceFiles).map((requiredPath) => {
    return resolveMaterializedPath(requiredPath, sourceFiles);
  });
  return {
    primaryAction: firstNonEmpty(value.primaryAction),
    initialState: firstNonEmpty(value.initialState),
    expectedState: firstNonEmpty(value.expectedState),
    visibleEvidence: asStringArray(value.visibleEvidence),
    proofSelectors: asStringArray(value.proofSelectors),
    requiredSourceFiles,
    manualFallbackReason: firstNonEmpty(value.manualFallbackReason),
  };
};

const firstLiteralButtonText = (source: string): string | undefined => {
  const matches = source.matchAll(/<button\b[\s\S]*?>\s*([^<{]+?)\s*<\/button>/g);
  for (const match of matches) {
    const label = firstNonEmpty(match[1]);
    if (label) return label;
  }
  return undefined;
};

const firstDataProofSelector = (source: string): string | undefined => {
  const match = source.match(/data-proof=["']([^"']+)["']/);
  return match?.[1] ? `[data-proof="${match[1]}"]` : undefined;
};

const fallbackVisibleEvidence = (source: string, readiness: BuildPlan["submissionReadiness"]): string[] => {
  const candidates = [
    firstNonEmpty(readiness?.stateChange),
    ...Array.from(source.matchAll(/<h[1-3]\b[\s\S]*?>\s*([^<{]+?)\s*<\/h[1-3]>/g)).map((match) =>
      firstNonEmpty(match[1]),
    ),
    ...Array.from(source.matchAll(/<strong>\s*([^<{]+?)\s*<\/strong>/g)).map((match) => firstNonEmpty(match[1])),
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates)).slice(0, 3);
};

const buildFallbackInteractionProofPlan = (
  plan: BuildPlan,
  sourceFiles: Array<{ content: string; materialized: MaterializedFile }>,
): InteractionProofPlan | undefined => {
  const entry = sourceFiles.find((file) => file.materialized.relativePath.endsWith("app/page.tsx")) ?? sourceFiles[0];
  if (!entry) return undefined;
  const primaryAction = firstLiteralButtonText(entry.content);
  const requiredSourceFiles = [entry.materialized.relativePath];
  const proofSelector = firstDataProofSelector(entry.content);
  const visibleEvidence = fallbackVisibleEvidence(entry.content, plan.submissionReadiness);
  if (!primaryAction || visibleEvidence.length === 0) return undefined;
  return {
    primaryAction,
    initialState: firstNonEmpty(plan.submissionReadiness?.firstScreenValue) ?? "Initial artifact screen is rendered.",
    expectedState: firstNonEmpty(plan.submissionReadiness?.stateChange) ?? "Primary interaction changes visible state.",
    visibleEvidence,
    proofSelectors: proofSelector ? [proofSelector] : [],
    requiredSourceFiles,
    manualFallbackReason:
      "Generated fallback proof plan from materialized source because upstream requirements/build output did not provide one.",
  };
};

const manifestContent = (metadata: MaterializedMetadata, entrypoint: string) =>
  `${JSON.stringify(
    {
      version: 1,
      artifactId: metadata.artifactId,
      entrypoint,
      files: [
        "README.md",
        "metadata.json",
        "manifest.json",
        metadata.demo.path,
        "validation/self-review.json",
        "validation/mvp-contract-v2.json",
        ...metadata.sourceFiles.map((file) => file.relativePath),
      ],
      mvpContract: metadata.mvpContract,
      mvpContractV2: metadata.mvpContractV2,
      ...(metadata.interactionProofPlan ? { interactionProofPlan: metadata.interactionProofPlan } : {}),
    },
    null,
    2,
  )}\n`;

const selfReviewContent = (metadata: MaterializedMetadata, entrypoint: string) =>
  `${JSON.stringify(
    {
      version: 1,
      artifactId: metadata.artifactId,
      status: "needs_review",
      entrypoint,
      checks: {
        firstScreenValue: "declared",
        userControlledInteraction: "declared",
        stateChange: "declared",
        interactionProofPlan: metadata.interactionProofPlan ? "declared" : "missing",
        mvpContractV2: "declared",
        externalDependencyMode: metadata.mvpContractV2.externalDependencyMode,
        artifactTier: metadata.mvpContractV2.artifactTier,
        renderVerification: metadata.mvpContractV2.renderVerification.required ? "required" : "not_required",
        inspectableOutput: "declared",
        staticDataBoundary: "declared",
        forbiddenDependencies: "declared_absent",
      },
      interactionProofPlan: metadata.interactionProofPlan ?? null,
      mvpContractV2: {
        artifactTier: metadata.mvpContractV2.artifactTier,
        externalDependencyMode: metadata.mvpContractV2.externalDependencyMode,
        runtimeBoundary: metadata.mvpContractV2.runtimeBoundary,
        claimBoundary: metadata.mvpContractV2.claimBoundary,
        renderVerification: metadata.mvpContractV2.renderVerification,
      },
      notes: [
        "Generated by materialize-llm-plan fallback. Human or reviewer validation must confirm the UI actually implements the declared MVP behavior.",
      ],
    },
    null,
    2,
  )}\n`;

const mvpContractV2Content = (metadata: MaterializedMetadata) =>
  `${JSON.stringify(
    {
      version: 1,
      generatedAt: metadata.generatedAt,
      status: "needs_validation",
      contract: metadata.mvpContractV2,
      summary: {
        artifactTier: metadata.mvpContractV2.artifactTier,
        externalDependencyMode: metadata.mvpContractV2.externalDependencyMode,
        runtimeBoundary: metadata.mvpContractV2.runtimeBoundary,
        renderVerification: metadata.mvpContractV2.renderVerification,
        humanReviewTriggers: metadata.mvpContractV2.humanReviewTriggers,
      },
    },
    null,
    2,
  )}\n`;

const sourceFileContent = (file: BuildPlan["files"][number]) => {
  if (file.content && looksLikeCode(file.content)) return file.content;

  const ext = path.extname(file.path).toLowerCase();
  const note = file.content ?? "No concrete file body was returned by the builder.";

  if (ext === ".json") {
    return JSON.stringify({ purpose: file.purpose, builderInstruction: note }, null, 2);
  }

  if (ext === ".css") {
    return [
      "/*",
      `Purpose: ${file.purpose}`,
      "",
      "Builder instruction:",
      note,
      "*/",
      "",
    ].join("\n");
  }

  if (ext === ".md") {
    return [`# ${path.basename(file.path)}`, "", file.purpose, "", "## Builder instruction", "", note, ""].join("\n");
  }

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    return [
      `// Materialized placeholder for ${file.path}`,
      `// Purpose: ${file.purpose}`,
      `// Builder instruction: ${note.replace(/\n/g, " ")}`,
      "",
      "export const materializedPlanFile = {",
      `  path: ${JSON.stringify(file.path)},`,
      `  purpose: ${JSON.stringify(file.purpose)},`,
      `  builderInstruction: ${JSON.stringify(note)},`,
      "} as const;",
      "",
    ].join("\n");
  }

  return note;
};

const cssImportPattern = /import\s+["'](\.\/[^"']+\.css|\.\.\/[^"']+\.css)["'];?/g;

const compatCssWrites = (
  sourceFiles: Array<{ content: string; materialized: MaterializedFile }>,
): Array<{ relativePath: string; content: string }> => {
  const cssFiles = sourceFiles.filter((file) => file.materialized.relativePath.endsWith(".css"));
  if (cssFiles.length === 0) return [];

  const cssByBasename = new Map(cssFiles.map((file) => [path.basename(file.materialized.relativePath), file.content]));
  const fallbackCss = cssFiles[0].content;
  const existingPaths = new Set(sourceFiles.map((file) => file.materialized.relativePath));
  const writes = new Map<string, string>();

  for (const file of sourceFiles) {
    if (!/\.(tsx|ts|jsx|js)$/.test(file.materialized.relativePath)) continue;
    const sourceDir = path.posix.dirname(file.materialized.relativePath.replace(/\\/g, "/"));
    for (const match of file.content.matchAll(cssImportPattern)) {
      const importPath = match[1];
      const resolvedPath = path.posix.normalize(path.posix.join(sourceDir, importPath));
      if (existingPaths.has(resolvedPath) || writes.has(resolvedPath)) continue;
      writes.set(resolvedPath, cssByBasename.get(path.basename(importPath)) ?? fallbackCss);
    }
  }

  return [...writes.entries()].map(([relativePath, content]) => ({ relativePath, content }));
};

const readmeContent = (plan: BuildPlan, metadata: MaterializedMetadata) =>
  [
    `# ${metadata.artifactId}`,
    "",
    "This directory is a materialized LLM BuildPlan artifact candidate.",
    "",
    "## Readiness",
    "",
    `- First screen value: ${plan.submissionReadiness.firstScreenValue}`,
    `- Core interaction: ${plan.submissionReadiness.coreInteraction}`,
    `- State change: ${metadata.mvpContract.stateChange}`,
    `- Inspectable output: ${plan.submissionReadiness.inspectableOutput}`,
    `- Static data boundary: ${plan.submissionReadiness.staticDataBoundary}`,
    `- Remaining weakness: ${plan.submissionReadiness.remainingWeakness}`,
    "",
    "## Interaction Proof Plan",
    "",
    metadata.interactionProofPlan
      ? `- Primary action: ${metadata.interactionProofPlan.primaryAction}`
      : "- Primary action: not declared",
    metadata.interactionProofPlan
      ? `- Initial state: ${metadata.interactionProofPlan.initialState}`
      : "- Initial state: not declared",
    metadata.interactionProofPlan
      ? `- Expected state: ${metadata.interactionProofPlan.expectedState}`
      : "- Expected state: not declared",
    metadata.interactionProofPlan
      ? `- Visible evidence: ${metadata.interactionProofPlan.visibleEvidence.join("; ")}`
      : "- Visible evidence: not declared",
    "",
    "## MVP Contract",
    "",
    `- Required files: ${metadata.mvpContract.requiredFiles.map((file) => `\`${file}\``).join(", ")}`,
    `- Non-goals: ${metadata.mvpContract.nonGoals.join("; ")}`,
    `- Forbidden dependencies: ${metadata.mvpContract.forbiddenDependencies.join("; ")}`,
    "",
    "## MVP Contract V2",
    "",
    `- Artifact tier: ${metadata.mvpContractV2.artifactTier}`,
    `- External dependency mode: ${metadata.mvpContractV2.externalDependencyMode}`,
    `- Runtime boundary: network=${metadata.mvpContractV2.runtimeBoundary.networkCalls}, secrets=${metadata.mvpContractV2.runtimeBoundary.secrets}, externalWrites=${metadata.mvpContractV2.runtimeBoundary.externalWrites}`,
    `- Render verification: ${metadata.mvpContractV2.renderVerification.required ? "required" : "not required"} (${metadata.mvpContractV2.renderVerification.checks.join(", ")})`,
    `- Public copy boundary: ${metadata.mvpContractV2.claimBoundary.publicCopyMustSay.join("; ")}`,
    metadata.mvpContractV2.externalIntegrations.length > 0
      ? `- External integrations: ${metadata.mvpContractV2.externalIntegrations.map((integration) => `${integration.service}=${integration.currentImplementation}`).join(", ")}`
      : "- External integrations: none",
    metadata.mvpContractV2.mockFidelity
      ? `- Mock fidelity: ${metadata.mvpContractV2.mockFidelity.simulatedBehaviors.join("; ")}`
      : "- Mock fidelity: not applicable",
    "",
    "## Files",
    "",
    ...metadata.sourceFiles.map((file) => `- \`${file.relativePath}\`: ${file.purpose}`),
    "",
    "## Demo Placeholder",
    "",
    `- \`${metadata.demo.path}\`: ${metadata.demo.purpose}`,
    "",
    "## DB Write",
    "",
    `${metadata.dbWrite.status}: ${metadata.dbWrite.reason}`,
    "",
  ].join("\n");

const demoPlaceholderContent = (plan: BuildPlan, artifactId: string) =>
  [
    `# Demo Placeholder: ${artifactId}`,
    "",
    "This placeholder makes the materialized artifact inspectable before UI integration.",
    "",
    "## First Screen",
    "",
    plan.submissionReadiness.firstScreenValue,
    "",
    "## Core Interaction",
    "",
    plan.submissionReadiness.coreInteraction,
    "",
    "## State Change",
    "",
    plan.submissionReadiness.stateChange,
    "",
    "## Inspectable Output",
    "",
    plan.submissionReadiness.inspectableOutput,
    "",
    "## Static Boundary",
    "",
    plan.submissionReadiness.staticDataBoundary,
    "",
  ].join("\n");

async function main() {
  const args = parseArgs();
  const inputPath = path.resolve(process.cwd(), args.input);
  const input = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const plan = assertBuildPlan(input);
  const runId = deriveRunId(args.input, args.run);
  const artifactId = args.artifact ?? slugify(plan.requirementSpecId);
  const runDir = path.dirname(path.dirname(inputPath));
  const readSibling = async (step: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await readFile(path.join(runDir, step, "response.json"), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };
  const conceptResponse = await readSibling("concept");
  const requirementsResponse = await readSibling("requirements");
  // R1: review/rewrite ループの rewrite を実体化に反映（rewriter が無い run では no-op）。
  const rewriteApplied = mergeRewriterChangedFiles(plan, await readSibling("rewriter"));
  if (rewriteApplied.applied.length > 0 || rewriteApplied.appended.length > 0) {
    console.log(
      `Rewriter merge: ${rewriteApplied.applied.length} replaced, ${rewriteApplied.appended.length} appended`,
    );
  }
  const selectedConcept =
    conceptResponse && isRecord(conceptResponse.selectedConcept)
      ? conceptResponse.selectedConcept
      : null;
  const conceptCandidates = Array.isArray(conceptResponse?.candidates)
    ? (conceptResponse?.candidates as Record<string, unknown>[])
    : [];
  const fullConcept =
    conceptCandidates.find((candidate) => candidate.id === selectedConcept?.id) ?? selectedConcept;
  const fallbackSourceProvenance =
    fullConcept || requirementsResponse
      ? {
          sourceProductUsed: nonEmptyString(fullConcept?.sourceProductUsed),
          sourceProductUse: nonEmptyString(fullConcept?.sourceProductUse),
          sourceEvidenceAudit: fullConcept?.sourceEvidenceAudit,
          antiCloneBoundary: nonEmptyString(fullConcept?.antiCloneBoundary ?? requirementsResponse?.antiCloneBoundary),
          sourceBoundary: nonEmptyString(
            requirementsResponse?.sourceBoundary ??
              requirementsResponse?.sourceUseBoundary ??
              fullConcept?.sourceBoundary,
          ),
        }
      : undefined;
  const planSourceTrace = plan.sourceTrace;
  const missingSourceEvidence = asStringArray(planSourceTrace?.missingSourceEvidence);
  const sourceProvenance =
    planSourceTrace || fallbackSourceProvenance
      ? {
          sourceProductUsed:
            nonEmptyString(planSourceTrace?.sourceProductUsed) ?? fallbackSourceProvenance?.sourceProductUsed,
          sourceProductUse:
            nonEmptyString(planSourceTrace?.sourceProductUse) ?? fallbackSourceProvenance?.sourceProductUse,
          sourceEvidenceAudit: planSourceTrace?.sourceEvidenceAudit ?? fallbackSourceProvenance?.sourceEvidenceAudit,
          antiCloneBoundary:
            nonEmptyString(planSourceTrace?.antiCloneBoundary) ?? fallbackSourceProvenance?.antiCloneBoundary,
          sourceBoundary:
            nonEmptyString(planSourceTrace?.sourceBoundary) ?? fallbackSourceProvenance?.sourceBoundary,
          ...(missingSourceEvidence.length > 0 ? { missingSourceEvidence } : {}),
        }
      : {
          sourceProductUsed: plan.requirementSpecId ?? artifactId,
          sourceProductUse: "direct",
          sourceEvidenceAudit: {
            evidenceLevel: "generated_artifact_metadata",
            observedFields: ["generatedFrom", "requirementSpecId", "sourceFiles", "mvpContract"],
            inferredFields: ["sourceProductUse"],
            missingFields: ["upstream sourceEvidenceAudit"],
            usePolicy: "Use as a local provenance fallback; require human review before unattended publish.",
          },
          antiCloneBoundary:
            "Fallback provenance records the generation chain only; it must not be presented as external product-source evidence.",
          sourceBoundary:
            "Materialized from the local LLM pipeline build plan and requirement metadata; no live external source was fetched during materialization.",
        };

  // AS-5: 自走run（--agent）なら、兄弟の concept/requirements 応答から一人称の企画意図と
  // 要件制約を取り出し、metadata に記録する（publishがself_directed_planイベントへ転記）。
  let selfDirectedPlan: MaterializedMetadata["selfDirectedPlan"];
  const conceptTitle =
    fullConcept && typeof fullConcept.title === "string" ? fullConcept.title : undefined;
  const conceptOneLiner =
    fullConcept && typeof fullConcept.oneLiner === "string" ? fullConcept.oneLiner : undefined;
  const generatedOutput: MaterializedMetadata["generatedOutput"] = {
    ...(conceptTitle ? { title: conceptTitle } : {}),
    ...(conceptOneLiner ? { oneLiner: conceptOneLiner } : {}),
    ...(nonEmptyString(fullConcept?.artifactShape) ? { artifactShape: nonEmptyString(fullConcept?.artifactShape) } : {}),
    ...(nonEmptyString(fullConcept?.templatePatternId ?? requirementsResponse?.templatePatternId)
      ? { templatePatternId: nonEmptyString(fullConcept?.templatePatternId ?? requirementsResponse?.templatePatternId) }
      : {}),
    ...(nonEmptyString(fullConcept?.surfacePattern ?? requirementsResponse?.surfacePattern)
      ? { surfacePattern: nonEmptyString(fullConcept?.surfacePattern ?? requirementsResponse?.surfacePattern) }
      : {}),
    ...(nonEmptyString(fullConcept?.aiMechanismPattern ?? requirementsResponse?.aiMechanismPattern)
      ? { aiMechanismPattern: nonEmptyString(fullConcept?.aiMechanismPattern ?? requirementsResponse?.aiMechanismPattern) }
      : {}),
  };
  const publicProductionMemo = nonEmptyString(requirementsResponse?.publicProductionMemo);
  const materializedAgentId = args.agentId ?? nonEmptyString(requirementsResponse?.ownerAgentId);
  if (materializedAgentId || publicProductionMemo) {
    const planningIntent =
      (selectedConcept && typeof selectedConcept.selectionReason === "string"
        ? selectedConcept.selectionReason
        : null) ?? `${args.agentId} が今日のsignalと自分の学びから一人称で企画した作品。`;
    const feedbackConstraints = Array.isArray(requirementsResponse?.feedbackConstraints)
      ? (requirementsResponse?.feedbackConstraints as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    // 2.7: 自走runが立てた self-directed-plan.json の learningApplied（適用した学び）を
    // metadata へ転記し、publish が RunEvent へ残す＝学びの往復を追跡可能にする。
    let learningApplied: string[] = [];
    try {
      const planRaw = JSON.parse(
        await readFile(path.join(runDir, "self-directed-plan.json"), "utf8"),
      ) as Record<string, unknown>;
      if (Array.isArray(planRaw.learningApplied)) {
        learningApplied = (planRaw.learningApplied as unknown[]).filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      // self-directed-plan.json が無い run は学び転記をスキップ（任意）。
    }
    selfDirectedPlan = {
      agentId: materializedAgentId ?? "llm_pipeline",
      planningIntent,
      ...(publicProductionMemo ? { publicProductionMemo } : {}),
      feedbackConstraints,
      learningApplied,
    };
  }

  const outputDir =
    args.output !== undefined
      ? path.resolve(process.cwd(), args.output)
      : path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId, "materialized", artifactId);

  const sourceFiles = plan.files.map((file) => {
    const content = sourceFileContent(file);
    return {
      file,
      content,
      materialized: {
        relativePath: materializedSourcePath(file.path),
        purpose: file.purpose,
        sizeBytes: Buffer.byteLength(content),
        checksum: checksum(content),
        generatedFrom: file.path,
      } satisfies MaterializedFile,
    };
  });
  const demoPath = "demo-placeholder.md";
  const demoContent = demoPlaceholderContent(plan, artifactId);
  const mvpContract = buildMvpContract(plan, sourceFiles.map((file) => file.materialized), demoPath);
  const mvpContractV2 = buildMvpContractV2(plan, mvpContract, sourceFiles.map((file) => file.materialized));
  const interactionProofPlan =
    normalizeInteractionProofPlan(
      plan.interactionProofPlan ?? requirementsResponse?.interactionProofPlan,
      sourceFiles.map((file) => file.materialized),
    ) ?? buildFallbackInteractionProofPlan(plan, sourceFiles);
  // トップフィード/詳細ページ「名前直下の一文キャッチコピー」。決定論正規化(囲み記号除去/第1文抽出/
  // 末尾句点除去/40字超は棄却)を通し、不合格なら metadata から落として表示側の oneLiner フォールバックに委ねる。
  const normalizedShortTagline = normalizeShortTagline(plan.shortTagline);
  const normalizedUsageGuide = normalizeUsageGuide(plan.usageGuide);
  const metadata: MaterializedMetadata = {
    version: 1,
    artifactId,
    generatedAt: new Date().toISOString(),
    generatedFrom: {
      input: relativeToWeb(inputPath),
      requirementSpecId: plan.requirementSpecId,
      framework: plan.framework,
    },
    sourceFiles: sourceFiles.map((file) => file.materialized),
    demo: {
      path: demoPath,
      purpose: "Inspectable placeholder for submission/demo review before UI wiring.",
    },
    readiness: plan.submissionReadiness,
    // 公開ページ「何が面白いか」の元。builder の top-level interestingness を metadata へ伝搬する。
    ...(plan.interestingness && plan.interestingness.trim()
      ? { interestingness: plan.interestingness.trim() }
      : {}),
    // トップフィード/詳細ページ「名前直下の一文キャッチコピー」の元。正規化済み shortTagline を metadata へ伝搬する。
    ...(normalizedShortTagline ? { shortTagline: normalizedShortTagline } : {}),
    // 詳細ページ「タブ上のボックス（2〜3文説明）」の元。builder の top-level productSummary を metadata へ伝搬する。
    ...(plan.productSummary && plan.productSummary.trim()
      ? { productSummary: plan.productSummary.trim() }
      : {}),
    // 公開時 Project.categoryId の第1候補。builder 選択値をカタログ whitelist で検証して伝搬し、
    // 不正な id はここで棄却して publish 側の決定論フォールバック(テンプレ表→agent主カテゴリ)に委ねる。
    ...(isProductCategoryId(plan.categoryId) ? { categoryId: plan.categoryId } : {}),
    // 詳細ページ「使い方」タブの番号付き手順。決定論正規化(重複文除去/2〜4件/文長上限)を通し、
    // 不合格なら metadata から落として表示側の howItRuns 決定論導出にフォールバックさせる。
    ...(normalizedUsageGuide ? { usageGuide: normalizedUsageGuide } : {}),
    mvpContract,
    mvpContractV2,
    ...(interactionProofPlan ? { interactionProofPlan } : {}),
    ...(Object.keys(generatedOutput).length > 0 ? { generatedOutput } : {}),
    ...(rewriteApplied.applied.length || rewriteApplied.appended.length
      ? {
          rewriteApplied: {
            changedFilePaths: rewriteApplied.applied,
            appendedFilePaths: rewriteApplied.appended,
          },
        }
      : {}),
    implementationNotes: plan.implementationNotes,
    knownRisks: plan.knownRisks,
    ...(conceptTitle ? { title: conceptTitle } : {}),
    ...(conceptOneLiner ? { oneLiner: conceptOneLiner } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(selfDirectedPlan ? { selfDirectedPlan } : {}),
    ...(sourceProvenance ? { sourceProvenance } : {}),
    dbWrite: {
      status: "skipped",
      reason:
        "BuildPlan materialization is artifact-only for this session. Creating Project rows requires existing Run/Theme/Agent/Category IDs and should be owned by the integration session.",
    },
  };
  const metadataContent = `${JSON.stringify(metadata, null, 2)}\n`;
  const readme = readmeContent(plan, metadata);
  const entrypoint = chooseEntrypoint(metadata.sourceFiles);
  const visualAssetFiles = generateVisualAssetFiles(metadata).files;

  const plannedWrites = [
    { relativePath: "README.md", content: readme },
    { relativePath: "metadata.json", content: metadataContent },
    { relativePath: "manifest.json", content: manifestContent(metadata, entrypoint) },
    { relativePath: demoPath, content: demoContent },
    { relativePath: "validation/self-review.json", content: selfReviewContent(metadata, entrypoint) },
    { relativePath: "validation/mvp-contract-v2.json", content: mvpContractV2Content(metadata) },
    ...visualAssetFiles.map((file) => ({ relativePath: file.relativePath, content: file.content })),
    ...sourceFiles.map((file) => ({ relativePath: file.materialized.relativePath, content: file.content })),
    ...compatCssWrites(sourceFiles),
  ];

  console.log(`Materialize LLM BuildPlan: ${args.dryRun ? "dry-run" : "write"}`);
  console.log(`Input: ${relativeToWeb(inputPath)}`);
  console.log(`Output: ${relativeToWeb(outputDir)}`);
  console.log(`Files: ${plannedWrites.length}`);
  for (const planned of plannedWrites) {
    console.log(`- ${planned.relativePath} (${Buffer.byteLength(planned.content)} bytes)`);
  }

  if (args.dryRun) {
    console.log("No files were written. Pass --write to materialize the artifact.");
    return;
  }

  for (const planned of plannedWrites) {
    const target = path.join(outputDir, planned.relativePath);
    let content = planned.content.endsWith("\n") ? planned.content : `${planned.content}\n`;
    if (planned.relativePath.endsWith(".json")) {
      content = repairJsonFileContent(planned.relativePath, content);
    }
    const relFromCwd = path.relative(process.cwd(), target).replaceAll("\\", "/");

    if (relFromCwd.startsWith("artifacts/")) {
      // artifacts/ 配下はFS＋（ARTIFACT_BUCKET設定時は）GCSへ永続化。本番では別インスタンスの
      // webがGCSフォールバックで読めるようになる。
      await writeStoredArtifactFile(relFromCwd, content);
    } else {
      // --output で artifacts 外を明示した場合は従来通りFSのみ。
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }

  console.log(`Materialized artifact: ${relativeToWeb(outputDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
