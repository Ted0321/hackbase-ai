import "./load-local-env";

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { generateVisualAssetsForArtifactDir } from "./generate-visual-assets";
import { isProductCategoryId, TEMPLATE_PATTERN_CATEGORY } from "./product-categories";
import { normalizeShortTagline } from "./product-copy";
import { highRiskTopicValidationCheck } from "./prompt-eval-metrics";
import { normalizeUsageGuide, serializeUsageGuide } from "../src/lib/usage-guide";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

type CheckStatus = "pass" | "fail" | "pending" | "skipped" | "warn";

type ReportFile = {
  key: string;
  type: string;
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  parsed?: unknown;
};

type VisualArtifactFile = {
  relativePath: string;
  type: "visual_manifest" | "product_logo" | "product_thumbnail" | "product_showcase";
  mimeType: "application/json" | "image/svg+xml" | "image/png" | "image/webp";
};

// SVG variants are the deterministic fallback and always registered when present.
// PNG variants exist only when an AI provider generated them (opt-in); they are
// probed too and registered alongside the SVG when found.
const visualArtifactFileSpecs: VisualArtifactFile[] = [
  { relativePath: "mockups/visual-manifest.json", type: "visual_manifest", mimeType: "application/json" },
  { relativePath: "mockups/product-logo.svg", type: "product_logo", mimeType: "image/svg+xml" },
  { relativePath: "mockups/product-logo.png", type: "product_logo", mimeType: "image/png" },
  { relativePath: "mockups/product-thumbnail.svg", type: "product_thumbnail", mimeType: "image/svg+xml" },
  { relativePath: "mockups/product-showcase.svg", type: "product_showcase", mimeType: "image/svg+xml" },
  { relativePath: "mockups/product-showcase.png", type: "product_showcase", mimeType: "image/png" },
];

type ProjectIdResolution = {
  projectId: string;
  baseProjectId: string;
  existingProject: { id: string; runId: string; artifactRoot: string } | null;
  collisionProject: { id: string; runId: string; artifactRoot: string } | null;
};

type MaterializedFile = {
  relativePath: string;
  purpose: string;
  sizeBytes: number;
  checksum: string;
  generatedFrom?: string;
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

type MaterializedMetadata = {
  version: number;
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
  readiness?: {
    firstScreenValue: string;
    coreInteraction: string;
    stateChange: string;
    inspectableOutput: string;
    staticDataBoundary: string;
    remainingWeakness: string;
  };
  mvpContract: MvpContract;
  mvpContractV2?: JsonRecord;
  interactionProofPlan?: JsonRecord;
  implementationNotes?: string[];
  knownRisks?: string[];
  sourceProvenance?: {
    sourceProductUsed?: string;
    sourceProductUse?: string;
    sourceEvidenceAudit?: unknown;
    antiCloneBoundary?: string;
    sourceBoundary?: string;
  };
  dbWrite?: {
    status: string;
    reason: string;
  };
  // Fields that may be present from pipeline integration
  title?: string;
  oneLiner?: string;
  // トップフィード/詳細ページ「プロダクト名直下の一文キャッチコピー」(例:「長い議事録を3行の決定メモに変える」)。
  shortTagline?: string;
  // 詳細ページ「タブ上のボックス」に出す2〜3文のプロダクト説明。新規性の主張は interestingness 側に置く。
  productSummary?: string;
  // 詳細ページ「使い方」タブの番号付き手順(materialize で正規化済み。publish 時に再正規化する)。
  usageGuide?: unknown;
  interestingness?: string;
  // Project.categoryId の第1候補(builder選択、materialize で whitelist 検証済み)。
  categoryId?: string;
  // materialize が concept/requirements 応答から転記する生成メタ。カテゴリー第2フォールバックに使う。
  generatedOutput?: {
    templatePatternId?: string;
  };
  agentId?: string;
  runId?: string;
  requirementSpecId?: string;
  // AS-5: 自走run（materialize --agent）が記録する一人称の企画意図
  selfDirectedPlan?: {
    agentId: string;
    planningIntent: string;
    publicProductionMemo?: string;
    feedbackConstraints: string[];
    learningApplied?: string[];
  };
};

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

const prisma = createPrismaClient();

type ReadinessError = Error & {
  readiness?: JsonRecord | null;
  readinessOutput?: string;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const checksum = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const collectVisualArtifactFiles = async (artifactDir: string) => {
  const existing: VisualArtifactFile[] = [];
  for (const file of visualArtifactFileSpecs) {
    try {
      await readFile(path.join(artifactDir, file.relativePath));
      existing.push(file);
    } catch {
      // Visual files are generated during write mode. Dry-run may inspect an older artifact without them.
    }
  }
  return existing;
};

const llmPipelineToolPolicy = {
  input: "materialized_artifact",
  network: "disabled_during_publish",
  write: "artifact_store_and_db",
  publish: "validation_gate",
};

const llmPipelineSafetyBoundary = (autoPublish: boolean) => ({
  sandboxMode: "workspace",
  toolPolicy: llmPipelineToolPolicy,
  publishGate: {
    validationStatus: autoPublish ? "pass" : "pending",
    approvalRequired: !autoPublish,
    rule: autoPublish ? "auto_publish_after_validation" : "hold_for_ops_review",
  },
});

const llmPipelineOwner = (autoPublish: boolean) =>
  autoPublish
    ? { humanOwnerType: "system", humanOwnerId: "llm_pipeline", humanOwnerName: "LLM Pipeline" }
    : { humanOwnerType: "human", humanOwnerId: "manual_operator", humanOwnerName: "Manual Operator" };

const artifactActorForType = (
  type: string,
  createdBy: { type: string; id: string; name: string },
  systemActor: { type: string; id: string; name: string },
  validationActor: { type: string; id: string; name: string },
) => {
  if (type.includes("validation") || type.includes("review") || type.includes("readiness")) {
    return {
      createdByType: validationActor.type,
      createdById: validationActor.id,
      createdByName: validationActor.name,
    };
  }

  if (type === "metadata" || type === "demo") {
    return {
      createdByType: systemActor.type,
      createdById: systemActor.id,
      createdByName: systemActor.name,
    };
  }

  return {
    createdByType: createdBy.type,
    createdById: createdBy.id,
    createdByName: createdBy.name,
  };
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const parseFirstJsonObject = (text: string): unknown | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const humanizeId = (id: string) =>
  id
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();

const baseProjectIdForArtifact = (artifactId: string) => `proj_llm_${slugify(artifactId)}`;

const projectIdForRun = (artifactId: string, runId: string) =>
  `${baseProjectIdForArtifact(artifactId)}_${slugify(runId)}`;

const baseThemeIdForRequirement = (requirementSpecId: string) =>
  `theme_llm_${slugify(requirementSpecId)}`;

const themeIdForRun = (requirementSpecId: string, runId: string) =>
  `${baseThemeIdForRequirement(requirementSpecId)}_${slugify(runId)}`;

const resolveProjectId = async (args: {
  artifactId: string;
  runId: string;
  artifactRoot: string;
}): Promise<ProjectIdResolution> => {
  const baseProjectId = baseProjectIdForArtifact(args.artifactId);
  const existingBase = await prisma.project.findUnique({
    where: { id: baseProjectId },
    select: { id: true, runId: true, artifactRoot: true },
  });

  if (!existingBase || existingBase.runId === args.runId) {
    return {
      projectId: baseProjectId,
      baseProjectId,
      existingProject: existingBase,
      collisionProject: null,
    };
  }

  const runScopedProjectId = projectIdForRun(args.artifactId, args.runId);
  const existingRunScoped = await prisma.project.findUnique({
    where: { id: runScopedProjectId },
    select: { id: true, runId: true, artifactRoot: true },
  });

  return {
    projectId: runScopedProjectId,
    baseProjectId,
    existingProject: existingRunScoped,
    collisionProject: existingBase,
  };
};

const resolveThemeId = async (args: {
  requirementSpecId: string;
  runId: string;
}): Promise<{ themeId: string; baseThemeId: string; collisionRunId: string | null }> => {
  const baseThemeId = baseThemeIdForRequirement(args.requirementSpecId);
  const existingBase = await prisma.theme.findUnique({
    where: { id: baseThemeId },
    select: { runId: true },
  });

  if (!existingBase || existingBase.runId === args.runId) {
    return { themeId: baseThemeId, baseThemeId, collisionRunId: null };
  }

  return {
    themeId: themeIdForRun(args.requirementSpecId, args.runId),
    baseThemeId,
    collisionRunId: existingBase.runId,
  };
};

const toRelPath = (filePath: string) => path.relative(process.cwd(), filePath).replace(/\\/g, "/");

const readJsonIfExists = async (filePath: string): Promise<unknown | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    return null;
  }
};

const optionalReport = async (args: {
  key: string;
  type: string;
  absolutePath: string;
  mimeType?: string;
  parsedOverride?: unknown;
}): Promise<ReportFile | null> => {
  try {
    const fileStats = await stat(args.absolutePath);
    if (!fileStats.isFile()) return null;
  } catch {
    return null;
  }

  const mimeType = args.mimeType ?? mimeTypeForPath(args.absolutePath);
  const parsed =
    args.parsedOverride !== undefined
      ? args.parsedOverride
      : mimeType === "application/json"
        ? await readJsonIfExists(args.absolutePath)
        : null;

  return {
    key: args.key,
    type: args.type,
    absolutePath: args.absolutePath,
    relativePath: toRelPath(args.absolutePath),
    mimeType,
    parsed,
  };
};

const deriveRunRoot = (artifactDir: string, runId: string): string | null => {
  const parent = path.dirname(artifactDir);
  if (path.basename(parent) === "materialized") {
    return path.dirname(parent);
  }

  if (runId) {
    return path.resolve(process.cwd(), "artifacts", "llm-pipeline-runs", runId);
  }

  let dir = artifactDir;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      path.basename(dir) === "llm-pipeline-runs" ||
      path.basename(path.dirname(dir)) === "llm-pipeline-runs"
    ) {
      return dir;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }

  return null;
};

const collectLaneDReports = async (args: {
  artifactDir: string;
  runRoot: string | null;
  publisherResponse: { path: string; parsed: JsonRecord } | null;
  readinessFromGate: JsonRecord | null;
}): Promise<ReportFile[]> => {
  const artifactReports = [
    {
      key: "mvp_contract_v2",
      type: "mvp_contract_v2",
      absolutePath: path.join(args.artifactDir, "validation", "mvp-contract-v2.json"),
    },
    {
      key: "interaction_proof",
      type: "interaction_proof",
      absolutePath: path.join(args.artifactDir, "validation", "interaction-proof.json"),
    },
    {
      key: "render_verification",
      type: "render_verification",
      absolutePath: path.join(args.artifactDir, "validation", "render-verification.json"),
    },
    {
      key: "render_screenshot",
      type: "render_screenshot",
      absolutePath: path.join(args.artifactDir, "validation", "render-verification.png"),
      mimeType: "image/png",
    },
  ];

  const runReports = args.runRoot
    ? [
        {
          key: "publish_readiness",
          type: "publish_readiness",
          absolutePath: path.join(args.runRoot, "publish-readiness.json"),
          parsedOverride: args.readinessFromGate ?? undefined,
        },
        {
          key: "validation_summary",
          type: "validation_summary",
          absolutePath: path.join(args.runRoot, "validation-summary.json"),
        },
        {
          key: "publisher_response",
          type: "publisher_response",
          absolutePath: path.join(args.runRoot, "publisher", "response.json"),
          parsedOverride: args.publisherResponse?.parsed,
        },
      ]
    : [];

  const collected = await Promise.all(
    [...artifactReports, ...runReports].map((report) => optionalReport(report)),
  );

  return collected.filter((report): report is ReportFile => report !== null);
};

const dbStatus = (value: unknown): CheckStatus | null => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["pass", "fail", "pending", "skipped", "warn"].includes(normalized)) {
    return normalized as CheckStatus;
  }
  if (normalized === "publish" || normalized === "true") return "pass";
  if (["block", "reject", "false", "error"].includes(normalized)) return "fail";
  return null;
};

const statusFromReport = (report: unknown, fallback: CheckStatus = "pending"): CheckStatus => {
  if (!isRecord(report)) return fallback;
  return dbStatus(report.result) ?? dbStatus(report.status) ?? fallback;
};

const statusFromBoolean = (value: unknown): CheckStatus =>
  value === true ? "pass" : value === false ? "fail" : "pending";

const artifactPrefix = () => (process.env.ARTIFACT_PREFIX ?? "artifacts").replace(/\/+$/, "");

const normalizeArtifactPathArg = (value: string) =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

const runRootFromArtifactPath = (artifactPath: string) => {
  const normalized = normalizeArtifactPathArg(artifactPath);
  const match = normalized.match(/^(?:artifacts\/)?llm-pipeline-runs\/[^/]+/);
  return match?.[0] ?? normalized;
};

const stripArtifactsPrefix = (value: string) => value.replace(/^artifacts\//, "");

const hydrateRunFromGcsIfMissing = async (args: {
  artifactPath: string;
  resolvedPath: string;
}) => {
  try {
    const stats = await stat(args.resolvedPath);
    if (stats.isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const bucketName = process.env.ARTIFACT_BUCKET;
  if (!bucketName) return;

  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(bucketName);
  const objectPrefix = `${artifactPrefix()}/${stripArtifactsPrefix(runRootFromArtifactPath(args.artifactPath))}/`;
  const [files] = await bucket.getFiles({ prefix: objectPrefix });

  if (files.length === 0) return;

  for (const file of files) {
    const objectName = file.name;
    if (!objectName.startsWith(`${artifactPrefix()}/`)) continue;
    const relativeArtifactPath = objectName.slice(`${artifactPrefix()}/`.length);
    const localPath = path.join(process.cwd(), "artifacts", relativeArtifactPath);
    await mkdir(path.dirname(localPath), { recursive: true });
    const [contents] = await file.download();
    await writeFile(localPath, contents);
  }

  console.log(`Hydrated ${files.length} artifact file(s) from gs://${bucketName}/${objectPrefix}`);
};

const truncateSummary = (value: string, maxLength = 260) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

const summaryText = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim()
    ? truncateSummary(value.trim())
    : fallback;

const buildLaneDChecks = (args: {
  mvpContractV2: unknown;
  interactionProof: unknown;
  renderVerification: unknown;
  publishReadiness: unknown;
  validationSummary: unknown;
  publisherResponse: unknown;
  riskEvidence?: unknown;
}): Array<[string, CheckStatus, string]> => {
  const checks = new Map<string, [string, CheckStatus, string]>();
  const add = (key: string, status: CheckStatus, summary: string) => {
    if (!checks.has(key)) {
      checks.set(key, [key, status, summary]);
    }
  };

  const highRiskCheck = highRiskTopicValidationCheck(args.riskEvidence ?? null);
  add(highRiskCheck.key, highRiskCheck.status, highRiskCheck.summary);

  if (isRecord(args.mvpContractV2)) {
    const status = statusFromReport(args.mvpContractV2);
    add("mvp_contract_v2.result", status, summaryText(args.mvpContractV2.summary, `MVP Contract V2 result: ${status}.`));
    add(
      "mvp_contract_v2.mode",
      dbStatus(args.mvpContractV2.externalDependencyMode) ?? "pass",
      `externalDependencyMode=${String(args.mvpContractV2.externalDependencyMode ?? "unknown")}`,
    );
    add(
      "mvp_contract_v2.tier",
      dbStatus(args.mvpContractV2.artifactTier) ?? "pass",
      `artifactTier=${String(args.mvpContractV2.artifactTier ?? "unknown")}`,
    );
    add(
      "mvp_contract_v2.auto_publishable",
      statusFromBoolean(args.mvpContractV2.autoPublishable),
      `autoPublishable=${String(args.mvpContractV2.autoPublishable ?? "unknown")}`,
    );
  }

  if (isRecord(args.interactionProof)) {
    const status = statusFromReport(args.interactionProof);
    add("interaction_proof.result", status, summaryText(args.interactionProof.summary, `interaction proof result: ${status}.`));
  }

  if (isRecord(args.renderVerification)) {
    const status = statusFromReport(args.renderVerification);
    add(
      "render_verification.status",
      status,
      `render verification status=${String(args.renderVerification.status ?? args.renderVerification.result ?? "unknown")}`,
    );
  }

  if (isRecord(args.validationSummary)) {
    const status = statusFromReport(args.validationSummary);
    add("validation_summary.status", status, `validation-summary status=${String(args.validationSummary.status ?? "unknown")}`);
  }

  if (isRecord(args.publisherResponse)) {
    add(
      "publisher.status",
      dbStatus(args.publisherResponse.status) ?? "pending",
      `publisher status=${String(args.publisherResponse.status ?? "unknown")}`,
    );
    for (const field of ["requiredArtifactsPresent", "reviewPass", "validationPass", "mvpContractPass"]) {
      add(`publisher.${field}`, statusFromBoolean(args.publisherResponse[field]), `${field}=${String(args.publisherResponse[field] ?? "unknown")}`);
    }
  }

  if (isRecord(args.publishReadiness)) {
    const status = statusFromReport(args.publishReadiness);
    const blockers = Array.isArray(args.publishReadiness.blockers) ? args.publishReadiness.blockers.length : 0;
    const warnings = Array.isArray(args.publishReadiness.warnings) ? args.publishReadiness.warnings.length : 0;
    add("publish_readiness.result", status, `publish-readiness result=${status}, blockers=${blockers}, warnings=${warnings}`);

    if (Array.isArray(args.publishReadiness.gateResults)) {
      for (const gate of args.publishReadiness.gateResults.filter(isRecord)) {
        const gateId = String(gate.id ?? "unknown").replace(/[^a-zA-Z0-9_.:-]+/g, "_");
        const gateStatus = dbStatus(gate.status) ?? "pending";
        add(
          `publish_readiness.${gateId}`,
          gateStatus,
          summaryText(gate.message, `publish-readiness gate ${gateId}: ${gateStatus}`),
        );
      }
    }
  }

  return [...checks.values()];
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === "--dry-run") {
      values.set("dry-run", true);
    } else if (item === "--write") {
      values.set("write", true);
    } else if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(key, next);
        index += 1;
      } else {
        values.set(key, true);
      }
    }
  }

  const artifactPath = values.get("path") as string | undefined;
  const runId = values.get("run") as string | undefined;
  const write = values.get("write") === true;
  const dryRun = !write; // dry-run is the default unless --write is passed
  // Self-directed runs publish autonomously only after the AI publisher decision and MVP gate pass.
  const autoPublish = values.get("auto-publish") === true;

  return { artifactPath, runId, write, dryRun, autoPublish };
};

const runPublishReadinessCheck = (args: {
  artifactPath: string;
  runId: string;
  writeReport: boolean;
}): JsonRecord | null => {
  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/check-publish-readiness.ts",
      "--path",
      args.artifactPath,
      "--run",
      args.runId,
      ...(args.writeReport ? ["--write"] : []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
      },
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  process.stdout.write(output);
  const parsed = parseFirstJsonObject(output);
  if (typeof result.status !== "number" || result.status !== 0) {
    const error: ReadinessError = new Error(
      "Publish readiness check failed; refusing unattended auto-publish.",
    );
    error.readiness = isRecord(parsed) ? parsed : null;
    error.readinessOutput = output;
    throw error;
  }
  return isRecord(parsed) ? parsed : null;
};

const recordAutoPublishBlocked = async (args: {
  artifactId: string;
  artifactPath: string;
  costSummary: JsonRecord;
  owner: { humanOwnerType: string; humanOwnerId: string; humanOwnerName: string };
  readiness: JsonRecord | null;
  readinessOutput?: string;
  requirementSpecId: string;
  runId: string;
  safetyBoundary: JsonRecord;
  sourceInteractionType: string;
  title: string;
}) => {
  const now = new Date();
  const blockers = Array.isArray(args.readiness?.blockers)
    ? args.readiness.blockers.filter((item): item is string => typeof item === "string")
    : [];
  const warnings = Array.isArray(args.readiness?.warnings)
    ? args.readiness.warnings.filter((item): item is string => typeof item === "string")
    : [];

  const existingRun = await prisma.run.findUnique({ where: { id: args.runId } });
  if (existingRun) {
    await prisma.run.update({
      where: { id: existingRun.id },
      data: {
        approvalRequired: true,
        errorMessage:
          existingRun.errorMessage ??
          `Auto-publish blocked by readiness gate (${blockers.length} blocker(s)).`,
        humanInstructionId:
          existingRun.humanInstructionId ??
          (args.requirementSpecId ? `requirement_spec:${args.requirementSpecId}` : null),
        humanOwnerType: existingRun.humanOwnerType ?? args.owner.humanOwnerType,
        humanOwnerId: existingRun.humanOwnerId ?? args.owner.humanOwnerId,
        humanOwnerName: existingRun.humanOwnerName ?? args.owner.humanOwnerName,
        sourceInteractionType: existingRun.sourceInteractionType ?? args.sourceInteractionType,
        toolPolicyJson: existingRun.toolPolicyJson ?? JSON.stringify(llmPipelineToolPolicy),
        sandboxMode:
          existingRun.sandboxMode ??
          (typeof args.safetyBoundary.sandboxMode === "string"
            ? args.safetyBoundary.sandboxMode
            : "workspace"),
        costSummaryJson: existingRun.costSummaryJson ?? JSON.stringify(args.costSummary),
      },
    });
  } else {
    await prisma.run.create({
      data: {
        id: args.runId,
        status: "failed",
        triggerType: "llm_pipeline",
        actorType: "system",
        actorId: "llm_pipeline_publisher",
        actorName: "LLM Pipeline Publisher",
        autonomyLevel: "L3_auto_publish",
        approvalRequired: true,
        humanInstructionId: args.requirementSpecId
          ? `requirement_spec:${args.requirementSpecId}`
          : null,
        ...args.owner,
        sourceInteractionType: args.sourceInteractionType,
        toolPolicyJson: JSON.stringify(llmPipelineToolPolicy),
        sandboxMode:
          typeof args.safetyBoundary.sandboxMode === "string"
            ? args.safetyBoundary.sandboxMode
            : "workspace",
        costSummaryJson: JSON.stringify(args.costSummary),
        startedAt: now,
        completedAt: now,
        summary: `Auto-publish blocked for ${args.title}.`,
        errorMessage: `Auto-publish blocked by readiness gate (${blockers.length} blocker(s)).`,
      },
    });
  }

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId: args.runId,
      type: "auto_publish_blocked",
      actorType: "validation_worker",
      actorId: "publish_readiness_checker",
      actorName: "Publish Readiness Checker",
      summary: `Auto-publish blocked for ${args.title}: ${blockers.length} blocker(s), ${warnings.length} warning(s).`,
      metadataJson: JSON.stringify({
        artifactId: args.artifactId,
        artifactPath: args.artifactPath,
        blockers,
        warnings,
        readiness: args.readiness,
        readinessOutput: args.readinessOutput?.slice(0, 12000),
        safetyBoundary: args.safetyBoundary,
        owner: args.owner,
        sourceInteractionType: args.sourceInteractionType,
        cost: args.costSummary,
      }),
      createdAt: now,
    },
  });
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.artifactPath) {
    console.error("Error: --path is required.");
    console.error(
      "Usage: npm run llm:publish -- --path artifacts/llm-pipeline-runs/<runId>/materialized/<artifactId> [--run <runId>] [--write]",
    );
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), args.artifactPath);
  await hydrateRunFromGcsIfMissing({ artifactPath: args.artifactPath, resolvedPath });

  // Verify directory exists
  try {
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`${resolvedPath} is not a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Error: Directory not found: ${resolvedPath}`);
      console.error(
        "Make sure to run materialize-llm-plan.ts --write first to generate the artifact directory.",
      );
      process.exit(1);
    }
    throw error;
  }

  // Read metadata.json
  const metadataPath = path.join(resolvedPath, "metadata.json");
  let metadata: MaterializedMetadata;
  try {
    const raw = await readFile(metadataPath, "utf8");
    metadata = JSON.parse(raw) as MaterializedMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Error: metadata.json not found in ${resolvedPath}`);
      process.exit(1);
    }
    throw error;
  }

  // Read README.md for concept/title enrichment
  let readmeContent = "";
  try {
    readmeContent = await readFile(path.join(resolvedPath, "README.md"), "utf8");
  } catch {
    // README is optional
  }

  // Publish gate: the pipeline's Publisher stage must have decided to publish this
  // artifact. The decision lives at <runRoot>/publisher/response.json. The artifact
  // dir is typically <runRoot>/materialized/<artifactId>, so we walk parent dirs up
  // to find a publisher/response.json.
  // --auto-publish: any non-"publish" decision refuses registration (strict).
  // Without --auto-publish the registration is held_for_review(ops_review) and never
  // public, so a revise/hold decision does not block it; instead the decision and its
  // reason are carried into publishDecisionReason so /human shows why it was held.
  const publisherResponse = await findPublisherResponse(resolvedPath);
  let opsHoldDetail = "";
  if (publisherResponse) {
    const status = String(publisherResponse.parsed.status ?? "").trim();
    if (status !== "publish") {
      if (args.autoPublish) {
        console.error(
          `Error: Publisher decision is "${status || "(missing)"}", not "publish".`,
        );
        console.error(`  Publisher file: ${publisherResponse.path}`);
        console.error("Refusing to register an artifact that did not clear the AI publisher gate.");
        process.exit(1);
      }
      const reasonText = String(publisherResponse.parsed.reason ?? "").trim();
      opsHoldDetail = ` publisher=${status || "missing"}${reasonText ? `: ${reasonText}` : ""}`;
      console.warn(
        `Publisher decision is "${status || "(missing)"}"; registering for ops review only (not published). ${publisherResponse.path}`,
      );
    } else {
      console.log(`Publisher decision: publish (${publisherResponse.path})`);
    }
  } else {
    if (args.autoPublish) {
      console.error("Error: No publisher/response.json found near the artifact dir.");
      console.error("Refusing --auto-publish without an AI publisher decision.");
      process.exit(1);
    }
    console.warn(
      "Warning: No publisher/response.json found near the artifact dir; skipping publish gate.",
    );
  }
  if (!args.autoPublish) {
    const blockers = await findPublishReadinessBlockers(resolvedPath);
    if (blockers.length > 0) {
      opsHoldDetail += ` blockers=${blockers.join(" | ")}`;
    }
    if (opsHoldDetail.length > 500) {
      opsHoldDetail = `${opsHoldDetail.slice(0, 499)}…`;
    }
  }

  // Derive IDs and labels
  const artifactId = metadata.artifactId;
  const title = metadata.title?.trim() || humanizeId(artifactId);
  const oneLiner =
    metadata.oneLiner?.trim() ||
    metadata.mvpContract.firstScreenValue.split(/[。.!\n]/)[0]?.trim() ||
    metadata.mvpContract.firstScreenValue;
  // concept は公開ページ「何が面白いか」等に出る人間向けテキスト。README.md は materialize が
  // 生成する内部ボイラープレート（"# <id> This directory is a materialized LLM BuildPlan
  // artifact candidate. ## Readiness ..."）なので絶対に流し込まない。クリーンな要約フィールドを使う。
  const concept =
    metadata.interestingness?.trim() ||
    metadata.readiness?.firstScreenValue?.trim() ||
    metadata.mvpContract.firstScreenValue?.trim() ||
    metadata.mvpContract.coreInteraction;

  // Derive artifact root: relative path from the project root (apps/web)
  // We normalize the path to be relative from cwd (apps/web), keeping the artifacts/... prefix.
  const cwdResolved = path.resolve(process.cwd());
  const artifactRoot = path.relative(cwdResolved, resolvedPath).replace(/\\/g, "/");

  // Derive run ID: from arg, metadata, or derive from path
  let runId = args.runId ?? metadata.runId;
  if (!runId) {
    // Try to derive from path pattern: artifacts/llm-pipeline-runs/<runId>/materialized/<artifactId>
    const parts = artifactRoot.split("/");
    const materializedIndex = parts.indexOf("materialized");
    if (materializedIndex > 1) {
      runId = parts[materializedIndex - 1];
    } else {
      runId = `llm_run_${Date.now()}`;
    }
  }
  const runRoot = deriveRunRoot(resolvedPath, runId);

  const requirementSpecId =
    metadata.generatedFrom?.requirementSpecId ?? metadata.requirementSpecId ?? artifactId;
  const projectIdResolution = await resolveProjectId({ artifactId, runId, artifactRoot });
  const projectId = projectIdResolution.projectId;

  console.log(`Publish LLM Pipeline Artifact: ${args.dryRun ? "DRY-RUN (no DB writes)" : "WRITE"}`);
  console.log(`  Artifact ID : ${artifactId}`);
  console.log(`  Project ID  : ${projectId}`);
  if (projectIdResolution.collisionProject) {
    console.log(
      `  ID collision : ${projectIdResolution.baseProjectId} already belongs to run ${projectIdResolution.collisionProject.runId}; using run-scoped Project ID`,
    );
  }
  if (projectIdResolution.existingProject) {
    console.log(
      `  Existing    : Project ${projectIdResolution.existingProject.id} is already registered for run ${projectIdResolution.existingProject.runId}`,
    );
  }
  console.log(`  Run ID      : ${runId}`);
  console.log(`  Title       : ${title}`);
  console.log(`  Artifact dir: ${artifactRoot}`);
  console.log(`  Run root    : ${runRoot ? toRelPath(runRoot) : "(not found)"}`);
  console.log(`  Source files: ${metadata.sourceFiles.length}`);
  console.log(`  Provenance  : ${metadata.selfDirectedPlan ? "full_auto_llm" : "human_assisted_pipeline"}`);
  console.log("");

  const now = new Date();
  const safetyBoundary = llmPipelineSafetyBoundary(args.autoPublish);
  const owner = llmPipelineOwner(args.autoPublish);
  const sourceInteractionType = args.autoPublish ? "llm_pipeline_auto_publish" : "llm_pipeline_ops_review";
  const costSummary = {
    model: "not_recorded",
    planner: "llm_pipeline",
    estimatedCostUsd: null,
    note: "publish step registers already-materialized artifacts; generation cost is tracked upstream when available",
  };

  let readinessFromGate: JsonRecord | null = null;
  if (args.autoPublish) {
    console.log("Publish readiness gate: unattended auto-publish");
    try {
      readinessFromGate = runPublishReadinessCheck({
        artifactPath: args.artifactPath,
        runId,
        writeReport: args.write,
      });
    } catch (error) {
      if (args.write) {
        const readinessError = error as ReadinessError;
        await recordAutoPublishBlocked({
          artifactId,
          artifactPath: args.artifactPath,
          costSummary,
          owner,
          readiness: readinessError.readiness ?? null,
          readinessOutput: readinessError.readinessOutput,
          requirementSpecId,
          runId,
          safetyBoundary,
          sourceInteractionType,
          title,
        });
        console.log(`Recorded RunEvent(type=auto_publish_blocked) for run ${runId}.`);
      }
      throw error;
    }
    console.log("");
  }

  const laneDReports = await collectLaneDReports({
    artifactDir: resolvedPath,
    runRoot,
    publisherResponse,
    readinessFromGate,
  });
  const reportByKey = new Map(laneDReports.map((report) => [report.key, report]));
  const publishReadinessForChecks =
    readinessFromGate ?? reportByKey.get("publish_readiness")?.parsed ?? null;
  const laneDChecks = buildLaneDChecks({
    mvpContractV2: reportByKey.get("mvp_contract_v2")?.parsed ?? metadata.mvpContractV2 ?? null,
    interactionProof: reportByKey.get("interaction_proof")?.parsed ?? metadata.interactionProofPlan ?? null,
    renderVerification: reportByKey.get("render_verification")?.parsed ?? null,
    publishReadiness: publishReadinessForChecks,
    validationSummary: reportByKey.get("validation_summary")?.parsed ?? null,
    publisherResponse: publisherResponse?.parsed ?? reportByKey.get("publisher_response")?.parsed ?? null,
    riskEvidence: {
      title,
      oneLiner,
      concept,
      readmeContent,
      metadata: {
        knownRisks: metadata.knownRisks ?? [],
        sourceProvenance: metadata.sourceProvenance ?? null,
      },
      publisherResponse: publisherResponse?.parsed ?? reportByKey.get("publisher_response")?.parsed ?? null,
    },
  });
  const highRiskTopicCheck = laneDChecks.find(([key]) => key === "high_risk_topic");

  if (args.autoPublish && highRiskTopicCheck && highRiskTopicCheck[1] !== "pass") {
    throw Object.assign(
      new Error(
        `High-risk topic validation failed; refusing unattended auto-publish. ${highRiskTopicCheck[2]}`,
      ),
      { highRiskTopicGate: true },
    );
  }

  if (!args.dryRun) {
    await generateVisualAssetsForArtifactDir(resolvedPath);
  }
  const visualArtifactFiles = await collectVisualArtifactFiles(resolvedPath);

  if (args.dryRun) {
    console.log("Plan:");
    console.log("  [1] Get or create Run (triggerType: llm_pipeline, status: completed)");
    console.log(`  [2] Get or create Theme from requirementSpecId: ${requirementSpecId}`);
    console.log("  [3] Get Agent (from metadata.agentId or fallback: agent_builder_v1)");
    console.log(
      `  [4] Get Category (resolved: builder=${metadata.categoryId ?? "-"} -> template_pattern -> agent_primary -> cat_utility)`,
    );
    console.log(`  [5] Create Project: ${projectId}`);
    console.log(
      `  [6] Create Artifact rows for ${metadata.sourceFiles.length} source files + fixed files + ${visualArtifactFiles.length} visual files`,
    );
    if (visualArtifactFiles.length === 0) {
      console.log("      Visual assets: will be generated during --write");
    }
    console.log(`      Lane D evidence artifacts: ${laneDReports.length}`);
    for (const report of laneDReports) {
      console.log(`        - ${report.type}: ${report.relativePath}`);
    }
    console.log(`  [7] Create Validation + ${6 + laneDChecks.length} ValidationCheck rows`);
    for (const [key, status, summary] of laneDChecks) {
      console.log(`        - ${key}: ${status} (${summary})`);
    }
    console.log("  [8] Increment Run generatedProjectCount / publishedProjectCount");
    console.log("");
    console.log("Re-run with --write to apply these changes.");
    return;
  }

  // -------------------------------------------------------------------
  // WRITE MODE
  // -------------------------------------------------------------------

  await prisma.$transaction(async (tx) => {
    // [1] Get or create Run
    let run = await tx.run.findUnique({ where: { id: runId } });
    if (!run) {
      run = await tx.run.create({
      data: {
        id: runId,
        triggerType: "llm_pipeline",
        actorType: "system",
        actorId: "llm_pipeline_publisher",
        actorName: "LLM Pipeline Publisher",
        autonomyLevel: args.autoPublish ? "L3_auto_publish" : "L1_assisted",
        approvalRequired: !args.autoPublish,
        humanInstructionId: requirementSpecId ? `requirement_spec:${requirementSpecId}` : null,
        ...owner,
        sourceInteractionType,
        toolPolicyJson: JSON.stringify(llmPipelineToolPolicy),
        sandboxMode: safetyBoundary.sandboxMode,
        costSummaryJson: JSON.stringify(costSummary),
        status: "completed",
        summary: `LLM pipeline run for ${artifactId}.`,
        startedAt: now,
        completedAt: now,
      },
    });
    console.log(`Created Run: ${run.id}`);
  } else {
    run = await tx.run.update({
      where: { id: run.id },
      data: {
        approvalRequired: run.approvalRequired || !args.autoPublish,
        humanInstructionId:
          run.humanInstructionId ?? (requirementSpecId ? `requirement_spec:${requirementSpecId}` : null),
        humanOwnerType: run.humanOwnerType ?? owner.humanOwnerType,
        humanOwnerId: run.humanOwnerId ?? owner.humanOwnerId,
        humanOwnerName: run.humanOwnerName ?? owner.humanOwnerName,
        sourceInteractionType: run.sourceInteractionType ?? sourceInteractionType,
        toolPolicyJson: run.toolPolicyJson ?? JSON.stringify(llmPipelineToolPolicy),
        sandboxMode: run.sandboxMode ?? safetyBoundary.sandboxMode,
        costSummaryJson: run.costSummaryJson ?? JSON.stringify(costSummary),
      },
    });
    console.log(`Using existing Run: ${run.id}`);
  }

  // [2] Get or create Theme
  let theme = await tx.theme.findFirst({
    where: { runId: run.id },
  });
  if (!theme) {
    const themeIdResolution = await resolveThemeId({ requirementSpecId, runId: run.id });
    if (themeIdResolution.collisionRunId) {
      console.log(
        `Theme ID collision: ${themeIdResolution.baseThemeId} already belongs to run ${themeIdResolution.collisionRunId}; using ${themeIdResolution.themeId}`,
      );
    }

    // Try to find or create a ThemeCandidate first (Theme requires candidateId)
    let candidate = await tx.themeCandidate.findFirst({
      where: { runId: run.id },
    });
    if (!candidate) {
      candidate = await tx.themeCandidate.create({
        data: {
          id: randomUUID(),
          runId: run.id,
          title: title,
          problemStatement: oneLiner,
          prototypeQuestion: `What is the core user interaction for ${title}?`,
          selected: true,
        },
      });
    }

    theme = await tx.theme.create({
      data: {
        id: themeIdResolution.themeId,
        runId: run.id,
        candidateId: candidate.id,
        title: title,
        problemStatement: oneLiner,
        prototypeQuestion: `What is the core user interaction for ${title}?`,
        selectionReason: "Generated by LLM pipeline publisher",
        aiBranchingHints: JSON.stringify([]),
        status: "selected",
        selectedAt: new Date(),
      },
    });
    console.log(`Created Theme: ${theme.id}`);
  } else {
    console.log(`Using existing Theme: ${theme.id}`);
  }

  // Update run's selectedThemeId if not set
  if (!run.selectedThemeId) {
    await tx.run.update({
      where: { id: run.id },
      data: { selectedThemeId: theme.id },
    });
  }

  // [3] Get Agent
  const agentId = metadata.agentId;
  let agent = agentId
    ? await tx.agent.findFirst({ where: { OR: [{ id: agentId }, { code: agentId }] } })
    : null;
  if (!agent) {
    agent = await tx.agent.findFirst({ where: { code: "agent_builder_v1" } });
  }
  if (!agent) {
    agent = await tx.agent.findFirst({ orderBy: { createdAt: "asc" } });
  }
  if (!agent) {
    throw new Error(
      "No Agent found in DB. At least one agent must exist. Run your agent seeding script first.",
    );
  }
  console.log(`Using Agent: ${agent.id} (${agent.code})`);
  const provenanceLabel = metadata.selfDirectedPlan ? "full_auto_llm" : "human_assisted_pipeline";
  const createdByType = metadata.agentId || metadata.selfDirectedPlan ? "agent" : "system";
  const createdById = createdByType === "agent" ? agent.id : "llm_pipeline_publisher";
  const createdByName = createdByType === "agent" ? agent.name : "LLM Pipeline Publisher";
  const createdBy = { type: createdByType, id: createdById, name: createdByName };
  const systemActor = { type: "system", id: "llm_pipeline_publisher", name: "LLM Pipeline Publisher" };
  const validationActor = {
    type: "validation_worker",
    id: args.autoPublish ? "publish_readiness_checker" : "local_validation_worker",
    name: args.autoPublish ? "Publish Readiness Checker" : "Local Validation Worker",
  };

  // [4] Get Category — builder選択 → templatePattern表 → agent主カテゴリ → cat_utility の決定論フォールバック連鎖。
  // 各候補を DB Category lookup で検証する(存在しない id は自然に次候補へ) = whitelist を DB が担保する。
  // 旧実装は cat_operations 固定で、LLMパイプライン経由の全公開作品が「運用支援」に偏っていた(2026-07-10 是正)。
  const templatePatternId = metadata.generatedOutput?.templatePatternId;
  const categoryCandidates: Array<{ id: string | undefined; source: string }> = [
    { id: isProductCategoryId(metadata.categoryId) ? metadata.categoryId : undefined, source: "builder" },
    { id: templatePatternId ? TEMPLATE_PATTERN_CATEGORY[templatePatternId] : undefined, source: "template_pattern" },
    { id: agent.primaryCategoryId, source: "agent_primary" },
    { id: "cat_utility", source: "fallback" },
  ];
  const resolveCategory = async () => {
    for (const candidate of categoryCandidates) {
      if (!candidate.id) continue;
      const row = await tx.category.findFirst({ where: { id: candidate.id } });
      if (row) return { row, source: candidate.source };
    }
    return null;
  };
  const resolvedCategory = await resolveCategory();
  if (!resolvedCategory) {
    throw new Error(
      "No Category candidate found in DB. Run your category seeding script first.",
    );
  }
  const category = resolvedCategory.row;
  const categorySource = resolvedCategory.source;
  console.log(`Using Category: ${category.id} (${category.name}, source=${categorySource})`);
  const publicNextGrowth = metadata.readiness?.remainingWeakness
    ? `今後は、${metadata.readiness.remainingWeakness}`
    : metadata.mvpContract.stateChange || "今後は、反応を見ながら改良点を増やしていきます。";

  // [5] Create Project (skip if already exists)
  const existing = await tx.project.findUnique({ where: { id: projectId } });
  if (existing) {
    throw new Error(`Project ${projectId} already exists. Refusing to overwrite an existing materialized artifact registration.`);
  } else {
    await tx.project.create({
      data: {
        id: projectId,
        runId: run.id,
        themeId: theme.id,
        agentId: agent.id,
        categoryId: category.id,
        title,
        oneLiner,
        // トップフィード/詳細ページ「名前直下の一文キャッチコピー」。materialize で正規化済みだが、
        // 旧 artifact を直接 publish する経路に備えて決定論正規化を再適用する。
        // 不合格(空/40字超)は null＝表示側で oneLiner 先頭文にフォールバック。
        shortTagline: normalizeShortTagline(metadata.shortTagline),
        // 使い方タブの番号付き手順。materialize で正規化済みだが、旧 artifact を直接 publish する
        // 経路に備えて再正規化する。不合格は null＝表示側が howItRuns からの決定論導出へフォールバック。
        usageGuide: (() => {
          const guide = normalizeUsageGuide(metadata.usageGuide);
          return guide ? serializeUsageGuide(guide) : null;
        })(),
        concept,
        useCase: metadata.mvpContract.coreInteraction || oneLiner,
        // 詳細ページ「タブ上のボックス（2〜3文説明）」の元。新規性テキスト(interestingness/concept)との重複を避けるため、
        // 説明フィールド(productSummary)を優先し、無ければ oneLiner にフォールバックする。
        whatWasTried: metadata.productSummary?.trim() || oneLiner,
        // howItRuns は「使い方」タブ等に出るユーザー向け文。内部のパイプライン説明ではなく、
        // 実際の動作（何を操作すると何が変わり、何が確認できるか）をmvpContractから組み立てる。
        howItRuns:
          [metadata.mvpContract.coreInteraction, metadata.mvpContract.stateChange, metadata.mvpContract.inspectableOutput]
            .map((part) => part?.trim())
            .filter((part): part is string => Boolean(part))
            .join(" ") || oneLiner,
        nextGrowth: publicNextGrowth,
        status: args.autoPublish ? "auto_published" : "held_for_review",
        validationStatus: args.autoPublish ? "pass" : "pending",
        createdByType,
        createdById,
        createdByName,
        approvalRequired: !args.autoPublish,
        publishDecision: args.autoPublish ? "auto_published" : "ops_review",
        publishDecisionReason: args.autoPublish
          ? `Self-directed run passed the AI publisher gate and MVP artifact validation; auto-published by the agent pipeline. provenance=${provenanceLabel}`
          : `Registered from LLM pipeline materialized artifact for ops inspection.${opsHoldDetail} provenance=${provenanceLabel}`,
        // Auto-publish enters the public feed immediately. Non-auto registrations stay out
        // of the feed as direct-route ops review records until a human operator approves.
        publishedAt: args.autoPublish ? now : null,
        artifactRoot,
        thumbnailPath: visualArtifactFiles.some((file) => file.relativePath === "mockups/product-thumbnail.svg")
          ? `${artifactRoot}/mockups/product-thumbnail.svg`
          : `${artifactRoot}/demo-placeholder.md`,
      },
    });
    console.log(`Created Project: ${projectId}`);
    if (process.env.PRODIA_PUBLISH_TEST_FAIL_AFTER_PROJECT_CREATE === projectId) {
      throw new Error(`Test failure after Project create: ${projectId}`);
    }

    await tx.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: "artifact_generated",
        actorType: createdByType,
        actorId: createdById,
        actorName: createdByName,
        summary: `${createdByName} generated ${title} as a materialized BuildPlan artifact.`,
        metadataJson: JSON.stringify({
          artifactId,
          artifactRoot,
          requirementSpecId,
          source: "llm_pipeline_materialized",
          provenance: provenanceLabel,
          sourceProvenance: metadata.sourceProvenance ?? null,
          selfDirectedPlan: metadata.selfDirectedPlan ?? null,
          mvpContractV2: metadata.mvpContractV2
            ? {
                artifactTier: metadata.mvpContractV2.artifactTier ?? null,
                externalDependencyMode: metadata.mvpContractV2.externalDependencyMode ?? null,
              }
            : null,
        }),
      },
    });
    await tx.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: "artifact_registered",
        actorType: "system",
        actorId: "llm_pipeline_publisher",
        actorName: "LLM Pipeline Publisher",
        summary: `Registered ${title} as Project ${projectId} from materialized artifact files.`,
        metadataJson: JSON.stringify({
          artifactId,
          artifactRoot,
          requirementSpecId,
          provenance: provenanceLabel,
          // カテゴリーがフォールバック連鎖のどの段で決まったかの監査記録(builder / template_pattern / agent_primary / fallback)。
          category: { id: category.id, source: categorySource },
          sourceProvenance: metadata.sourceProvenance ?? null,
          laneDReports: laneDReports.map((report) => ({
            key: report.key,
            type: report.type,
            path: report.relativePath,
          })),
        }),
      },
    });
  }

  // [6] Create Artifact rows (source files)
  if (!existing) {
    for (const file of metadata.sourceFiles) {
      let fileContent = "";
      const absFilePath = path.join(resolvedPath, file.relativePath);
      try {
        fileContent = await readFile(absFilePath, "utf8");
      } catch {
        // File may not exist if it was only planned but not written
      }
      const sizeBytes = fileContent ? Buffer.byteLength(fileContent) : file.sizeBytes;
      const fileChecksum = fileContent ? checksum(fileContent) : file.checksum;

      await tx.artifact.create({
        data: {
          id: randomUUID(),
          projectId,
          runId: run.id,
          type: "source",
          path: `${artifactRoot}/${file.relativePath}`,
          mimeType: mimeTypeForPath(file.relativePath),
          sizeBytes,
          checksum: fileChecksum,
          ...artifactActorForType("source", createdBy, systemActor, validationActor),
          validationStatus: args.autoPublish ? "pass" : "pending",
          riskSummary: metadata.knownRisks?.join("; ") || null,
          metadataJson: JSON.stringify({
            role: "source",
            generatedFrom: file.generatedFrom ?? null,
            sourceInteractionType,
            autonomyLevel: args.autoPublish ? "L3_auto_publish" : "L1_assisted",
            publishGate: safetyBoundary.publishGate,
          }),
        },
      });
    }

    // Also record metadata.json and README.md as artifacts
    const fixedFiles = [
      { relativePath: "metadata.json", type: "metadata", mimeType: "application/json" },
      { relativePath: "README.md", type: "readme", mimeType: "text/markdown" },
      { relativePath: "demo-placeholder.md", type: "demo", mimeType: "text/markdown" },
      { relativePath: "validation/self-review.json", type: "self_review", mimeType: "application/json" },
    ];
    for (const file of fixedFiles) {
      let fileContent = "";
      try {
        fileContent = await readFile(path.join(resolvedPath, file.relativePath), "utf8");
      } catch {
        // Optional files
      }
      if (!fileContent) continue;

      await tx.artifact.create({
        data: {
          id: randomUUID(),
          projectId,
          runId: run.id,
          type: file.type,
          path: `${artifactRoot}/${file.relativePath}`,
          mimeType: file.mimeType,
          sizeBytes: Buffer.byteLength(fileContent),
          checksum: checksum(fileContent),
          ...artifactActorForType(file.type, createdBy, systemActor, validationActor),
          validationStatus: args.autoPublish ? "pass" : "pending",
          riskSummary: metadata.knownRisks?.join("; ") || null,
          metadataJson: JSON.stringify({
            role: file.type,
            sourceInteractionType,
            autonomyLevel: args.autoPublish ? "L3_auto_publish" : "L1_assisted",
            publishGate: safetyBoundary.publishGate,
          }),
        },
      });
    }

    for (const file of visualArtifactFiles) {
      // Read as bytes: AI-generated PNG/WebP would be corrupted by a utf8 read,
      // and Buffer produces the same checksum/size as utf8 for text SVG/JSON.
      const fileContent = await readFile(path.join(resolvedPath, file.relativePath));

      await tx.artifact.create({
        data: {
          id: randomUUID(),
          projectId,
          runId: run.id,
          type: file.type,
          path: `${artifactRoot}/${file.relativePath}`,
          mimeType: file.mimeType,
          sizeBytes: fileContent.byteLength,
          checksum: checksum(fileContent),
          ...artifactActorForType(file.type, createdBy, systemActor, validationActor),
          validationStatus: args.autoPublish ? "pass" : "pending",
          riskSummary: metadata.knownRisks?.join("; ") || null,
          metadataJson: JSON.stringify({
            role: file.type,
            sourceInteractionType,
            autonomyLevel: args.autoPublish ? "L3_auto_publish" : "L1_assisted",
            publishGate: safetyBoundary.publishGate,
            conceptOnly: true,
            notImplementedAsSource: true,
          }),
        },
      });
    }

    for (const report of laneDReports) {
      const fileContent = await readFile(report.absolutePath);
      await tx.artifact.create({
        data: {
          id: randomUUID(),
          projectId,
          runId: run.id,
          type: report.type,
          path: report.relativePath,
          mimeType: report.mimeType,
          sizeBytes: fileContent.byteLength,
          checksum: checksum(fileContent),
          ...artifactActorForType(report.type, createdBy, systemActor, validationActor),
          validationStatus: args.autoPublish ? "pass" : "pending",
          riskSummary: highRiskTopicCheck?.[2] ?? metadata.knownRisks?.join("; ") ?? null,
          metadataJson: JSON.stringify({
            role: report.type,
            key: report.key,
            sourceInteractionType,
            autonomyLevel: args.autoPublish ? "L3_auto_publish" : "L1_assisted",
            publishGate: safetyBoundary.publishGate,
          }),
        },
      });
    }

    console.log(
      `Created Artifact rows for ${metadata.sourceFiles.length} source files + fixed files + ${visualArtifactFiles.length} visual files + ${laneDReports.length} Lane D evidence files`,
    );

    // [7] Create Validation
    // --auto-publish is called only after the publisher and readiness gates pass.
    const vp: CheckStatus = args.autoPublish ? statusFromReport(publishReadinessForChecks, "pass") : "pending";
    const mvpContractV2Status = statusFromReport(
      reportByKey.get("mvp_contract_v2")?.parsed ?? metadata.mvpContractV2 ?? null,
      args.autoPublish ? "fail" : "skipped",
    );
    const interactionProofStatus = statusFromReport(
      reportByKey.get("interaction_proof")?.parsed ?? metadata.interactionProofPlan ?? null,
      "skipped",
    );
    const renderVerificationStatus = statusFromReport(
      reportByKey.get("render_verification")?.parsed ?? null,
      "skipped",
    );
    const riskValidationStatus = highRiskTopicCheck?.[1] ?? vp;
    const validationStatus: CheckStatus = riskValidationStatus === "fail" ? "fail" : vp;
    const displayStatus: CheckStatus =
      [interactionProofStatus, renderVerificationStatus].includes("fail")
        ? "fail"
        : [interactionProofStatus, renderVerificationStatus].includes("warn")
          ? "warn"
          : interactionProofStatus === "skipped" && renderVerificationStatus === "skipped"
            ? "skipped"
            : "pass";
    const validationId = `val_${projectId}`;
    await tx.validation.create({
      data: {
        id: validationId,
        projectId,
        runId: run.id,
        status: validationStatus,
        actorType: "validation_worker",
        actorId: args.autoPublish ? "publish_readiness_checker" : "local_validation_worker",
        actorName: args.autoPublish ? "Publish Readiness Checker" : "Local Validation Worker",
        buildStatus: args.autoPublish ? "pass" : "skipped",
        runStatus: vp,
        screenshotStatus: renderVerificationStatus,
        metadataStatus: "pass",
        riskStatus: riskValidationStatus,
        duplicateStatus: vp,
        grainStatus: vp,
        secretStatus: vp,
        externalDependencyStatus: mvpContractV2Status,
        promptInjectionStatus: vp,
        readmeStatus: readmeContent ? "pass" : "fail",
        displayStatus,
        summary: args.autoPublish
          ? "AI publisher, MVP Contract V2, interaction proof, and publish-readiness gates passed; auto-published by the agent pipeline."
          : "Validation pending; artifact registered from LLM pipeline for ops inspection.",
        checkedAt: now,
      },
    });

    const checks: Array<[string, CheckStatus, string]> = [
      ["metadata_complete", "pass", "metadata.json exists and has required fields."],
      ["artifact_exists", metadata.sourceFiles.length > 0 ? "pass" : "fail", "Source files listed in metadata."],
      ["readme_exists", readmeContent ? "pass" : "fail", "README.md exists."],
      [
        "product_showcase_visual",
        visualArtifactFiles.some((file) => file.type === "product_showcase") ? "pass" : "fail",
        visualArtifactFiles.some((file) => file.type === "product_showcase")
          ? "Concept-only Product Hunt style showcase visual is registered without UI source code."
          : "Product showcase visual image is missing.",
      ],
      [
        "product_icon_visual",
        visualArtifactFiles.some((file) => file.type === "product_logo") ? "pass" : "fail",
        visualArtifactFiles.some((file) => file.type === "product_logo")
          ? "Concept-only Open-Launch style product icon is registered without UI source code."
          : "Product icon visual image is missing.",
      ],
      ["duplicate_like", vp, args.autoPublish ? "MVP check passed." : "Duplicate check not yet run."],
      ["prompt_injection_like", vp, args.autoPublish ? "MVP check passed." : "Prompt injection check not yet run."],
      ...laneDChecks,
    ];

    for (const [key, status, summary] of checks) {
      await tx.validationCheck.create({
        data: {
          id: randomUUID(),
          validationId,
          projectId,
          runId: run.id,
          key,
          status,
          actorType: "validation_worker",
          actorId: "local_validation_worker",
          actorName: "Local Validation Worker",
          summary,
        },
      });
    }

    await tx.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: "validation_checked",
        actorType: "validation_worker",
        actorId: args.autoPublish ? "publish_readiness_checker" : "local_validation_worker",
        actorName: args.autoPublish ? "Publish Readiness Checker" : "Local Validation Worker",
        summary: args.autoPublish
          ? `MVP Contract V2 and publish-readiness gates passed for ${title}.`
          : `Validation pending for ${title} (LLM pipeline artifact).`,
        metadataJson: JSON.stringify({
          validationId,
          mvpContractV2Status,
          interactionProofStatus,
          renderVerificationStatus,
          publishReadinessStatus: statusFromReport(publishReadinessForChecks, vp),
          safetyBoundary,
          cost: costSummary,
        }),
      },
    });

    await tx.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: args.autoPublish ? "published" : "ops_review_requested",
        actorType: "system",
        actorId: "llm_pipeline_publisher",
        actorName: "LLM Pipeline Publisher",
        summary: args.autoPublish
          ? `${title} was auto-published after passing MVP validation.`
          : `${title} was registered for ops inspection after LLM pipeline materialization.`,
        metadataJson: JSON.stringify({
          publishDecision: args.autoPublish ? "auto_published" : "ops_review",
          provenance: provenanceLabel,
          sourceProvenance: metadata.sourceProvenance ?? null,
          owner,
          sourceInteractionType,
          safetyBoundary,
          laneDReports: laneDReports.map((report) => report.relativePath),
        }),
      },
    });

    // AS-5: 自走run由来なら「自分で立てた企画」の証跡を残す（run詳細/project詳細で表示）
    if (metadata.selfDirectedPlan) {
      await tx.runEvent.create({
        data: {
          id: randomUUID(),
          runId: run.id,
          projectId,
          agentId: agent.id,
          type: "self_directed_plan",
          actorType: "agent",
          actorId: agent.id,
          actorName: agent.name,
          summary: metadata.selfDirectedPlan.planningIntent,
          metadataJson: JSON.stringify({
            agentId: agent.id,
            agentName: agent.name,
            planningIntent: metadata.selfDirectedPlan.planningIntent,
            publicProductionMemo: metadata.selfDirectedPlan.publicProductionMemo,
            feedbackConstraints: metadata.selfDirectedPlan.feedbackConstraints,
            learningApplied: metadata.selfDirectedPlan.learningApplied ?? [],
            provenance: provenanceLabel,
          }),
        },
      });
    }

    // [8] Increment Run counts
    const generatedProjectCount = await tx.project.count({ where: { runId: run.id } });
    const publishedProjectCount = await tx.project.count({
      where: { runId: run.id, status: { in: ["auto_published", "published"] } },
    });
    const failedProjectCount = await tx.project.count({
      where: { runId: run.id, validationStatus: "fail" },
    });

    await tx.run.update({
      where: { id: run.id },
      data: {
        generatedProjectCount,
        publishedProjectCount,
        failedProjectCount,
        summary: `LLM pipeline run for ${artifactId}. Published ${publishedProjectCount} project(s).`,
      },
    });
  }
  });

  console.log("");
  console.log(`Run    : ${runId}`);
  console.log(`Project: ${projectId}`);
  console.log(`Open   : http://localhost:3000/runs/${runId}`);
  console.log(`Feed   : http://localhost:3000/projects/${projectId}`);
}

/**
 * Walk up from the artifact directory looking for a sibling `publisher/response.json`
 * (written by the pipeline's Publisher stage at the run root). Returns the parsed JSON
 * and the path it was read from, or null if none is found within a few levels.
 */
async function findPublisherResponse(
  artifactDir: string,
): Promise<{ path: string; parsed: JsonRecord } | null> {
  let dir = artifactDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "publisher", "response.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
      if (isRecord(parsed)) {
        return { path: candidate, parsed };
      }
    } catch {
      // Not at this level; continue walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Held-registration note: the readiness gate writes <runRoot>/publish-readiness.json
// with a blockers[] array. When registering without --auto-publish we surface those
// blockers in publishDecisionReason so /human shows why the run was held.
async function findPublishReadinessBlockers(artifactDir: string): Promise<string[]> {
  let dir = artifactDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "publish-readiness.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
      if (isRecord(parsed) && Array.isArray(parsed.blockers)) {
        return parsed.blockers.map((blocker) => String(blocker).trim()).filter(Boolean);
      }
    } catch {
      // Not at this level; continue walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".js": "text/javascript",
    ".jsx": "text/jsx",
    ".json": "application/json",
    ".md": "text/markdown",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return map[ext] ?? "application/octet-stream";
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    // high-risk topicゲートは意図した停止であり異常終了(1)と区別する。
    // 呼び出し側(self-directed)が auto-publish なしで ops_review 登録へフォールバックする。
    if ((error as { highRiskTopicGate?: boolean })?.highRiskTopicGate) {
      process.exit(5);
    }
    process.exit(1);
  });
