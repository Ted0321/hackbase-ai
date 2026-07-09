import path from "node:path";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
  evidencePath?: string;
};

type JsonRecord = Record<string, unknown>;

type RuntimeBoundary = {
  networkCalls: "none" | "live_required";
  secrets: "none" | "required";
  externalWrites: "none" | "proposed" | "live_required";
};

type MvpContractV2 = {
  contractVersion: "mvp-contract-v2";
  artifactTier: "static_mvp" | "proposed_integration" | "mocked_integration_mvp" | "live_integration_candidate";
  firstScreenValue: string;
  coreInteraction: string;
  stateChange: string;
  inspectableOutput: string;
  staticDataBoundary: string;
  requiredFiles: string[];
  nonGoals: string[];
  forbiddenDependencies: string[];
  externalDependencyMode: "none" | "proposed" | "mocked_adapter" | "live_required";
  externalIntegrations: Array<{
    service: string;
    intendedUse: string;
    dataFlow: string;
    authRequirement: "none" | "api_key" | "oauth" | "unknown";
    currentImplementation: "not_connected" | "mock_data" | "mock_adapter" | "live_call";
    adapterPath?: string;
    sampleDataPath?: string;
    riskNotes: string[];
  }>;
  runtimeBoundary: RuntimeBoundary;
  mvpComplexityBudget: {
    maxScreens: 1 | 2;
    maxPrimaryActions: 1;
    maxSourceFiles: number;
    maxNewDependencies: 0;
    allowDatabase: false;
  };
  integrationAssumptions: Array<{
    service: string;
    officialDocsVerifiedAt?: string;
    verificationStatus: "unverified" | "official_docs_checked" | "not_applicable";
    unavailableOrUnknown: string[];
    rateLimitRisk: "low" | "medium" | "high" | "unknown";
    costRisk: "low" | "medium" | "high" | "unknown";
    termsRisk: "low" | "medium" | "high" | "unknown";
  }>;
  mockFidelity?: {
    samplePayloadPath?: string;
    simulatedBehaviors: string[];
    omittedBehaviors: string[];
    failureCasesIncluded: string[];
  };
  claimBoundary: {
    publicCopyMustSay: string[];
    publicCopyMustNotSay: string[];
  };
  renderVerification: {
    required: true;
    checks: Array<"render" | "click" | "state_change" | "screenshot">;
    screenshotPath?: string;
  };
  humanReviewTriggers: string[];
};

type CheckResult = {
  version: 1;
  generatedAt: string;
  checkKey: "mvp_contract_v2";
  path: string;
  result: "pass" | "fail" | "warn";
  status: "pass" | "fail" | "warn";
  source: "mvpContractV2" | "validation_report" | "v1_fallback" | "missing";
  artifactTier: string | null;
  externalDependencyMode: string | null;
  autoPublishable: boolean;
  checks: Check[];
  findings: string[];
  contract: MvpContractV2 | null;
};

const artifactTiers = [
  "static_mvp",
  "proposed_integration",
  "mocked_integration_mvp",
  "live_integration_candidate",
] as const;
const externalDependencyModes = ["none", "proposed", "mocked_adapter", "live_required"] as const;
const currentImplementations = ["not_connected", "mock_data", "mock_adapter", "live_call"] as const;
const renderChecks = ["render", "click", "state_change", "screenshot"] as const;

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const artifactPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  if (!artifactPath) {
    console.error(
      "Usage: tsx scripts/check-mvp-contract-v2.ts --path <artifact-dir> [--write] [--output <json>] [--json-only]",
    );
    process.exit(1);
  }

  return {
    artifactPath,
    write: values.get("write") === true,
    output: typeof values.get("output") === "string" ? String(values.get("output")) : "",
    jsonOnly: values.get("json-only") === true,
  };
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isNonEmptyString(item)) : [];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const toRel = (filePath: string) => path.relative(process.cwd(), filePath).replace(/\\/g, "/");

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
};

const collectFiles = async (dir: string): Promise<string[]> => {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await collectFiles(fullPath)));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch {
    // Missing source directory is handled by a check.
  }
  return results;
};

const readTextIfExists = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const toPortableRel = (root: string, filePath: string) => path.relative(root, filePath).replace(/\\/g, "/");

const isInternalArtifactSourceFile = (root: string, filePath: string) => {
  const rel = toPortableRel(root, filePath);
  return (
    rel === "source/metadata.json" ||
    rel === "source/manifest.json" ||
    rel.startsWith("source/validation/")
  );
};

const isImplementationSourceFile = (root: string, filePath: string) =>
  !isInternalArtifactSourceFile(root, filePath) && /\.(tsx?|jsx?|css)$/.test(filePath);

const isPublicTextSourceFile = (root: string, filePath: string) =>
  !isInternalArtifactSourceFile(root, filePath) && /\.(tsx?|jsx?|css|md)$/.test(filePath);

const addCheck = (
  checks: Check[],
  id: string,
  status: CheckStatus,
  message: string,
  evidencePath?: string,
) => {
  checks.push({
    id,
    status,
    message,
    ...(evidencePath ? { evidencePath: toRel(evidencePath) } : {}),
  });
};

const getContractCandidate = (
  metadata: JsonRecord | null,
  validationReport: JsonRecord | null,
): { contract: JsonRecord | null; source: CheckResult["source"] } => {
  if (isRecord(validationReport?.contract)) {
    return { contract: validationReport.contract, source: "validation_report" };
  }
  if (validationReport?.contractVersion === "mvp-contract-v2") {
    return { contract: validationReport, source: "validation_report" };
  }
  if (isRecord(metadata?.mvpContractV2)) {
    return { contract: metadata.mvpContractV2, source: "mvpContractV2" };
  }
  if (isRecord(metadata?.mvpContract)) {
    const v1 = metadata.mvpContract;
    return {
      source: "v1_fallback",
      contract: {
        contractVersion: "mvp-contract-v2",
        artifactTier: "static_mvp",
        firstScreenValue: String(v1.firstScreenValue ?? ""),
        coreInteraction: String(v1.coreInteraction ?? ""),
        stateChange: String(v1.stateChange ?? ""),
        inspectableOutput: String(v1.inspectableOutput ?? ""),
        staticDataBoundary: String(v1.staticDataBoundary ?? "Static sample data only."),
        requiredFiles: asStringArray(v1.requiredFiles),
        nonGoals: asStringArray(v1.nonGoals),
        forbiddenDependencies: asStringArray(v1.forbiddenDependencies),
        externalDependencyMode: "none",
        externalIntegrations: [],
        runtimeBoundary: {
          networkCalls: "none",
          secrets: "none",
          externalWrites: "none",
        },
        mvpComplexityBudget: {
          maxScreens: 1,
          maxPrimaryActions: 1,
          maxSourceFiles: 12,
          maxNewDependencies: 0,
          allowDatabase: false,
        },
        integrationAssumptions: [],
        claimBoundary: {
          publicCopyMustSay: ["This MVP runs on static sample data."],
          publicCopyMustNotSay: [
            "real-time external API",
            "automatic external publishing",
            "live external data is guaranteed",
            "production-ready integration",
          ],
        },
        renderVerification: {
          required: true,
          checks: ["render", "click", "state_change", "screenshot"],
        },
        humanReviewTriggers: [],
      },
    };
  }
  return { contract: null, source: "missing" };
};

const normalizeContract = (value: JsonRecord): MvpContractV2 => {
  const runtime = isRecord(value.runtimeBoundary) ? value.runtimeBoundary : {};
  const budget = isRecord(value.mvpComplexityBudget) ? value.mvpComplexityBudget : {};
  const claimBoundary = isRecord(value.claimBoundary) ? value.claimBoundary : {};
  const renderVerification = isRecord(value.renderVerification) ? value.renderVerification : {};
  const integrations = Array.isArray(value.externalIntegrations)
    ? value.externalIntegrations.filter(isRecord).map((item) => ({
        service: String(item.service ?? ""),
        intendedUse: String(item.intendedUse ?? ""),
        dataFlow: String(item.dataFlow ?? ""),
        authRequirement: oneOf(item.authRequirement, ["none", "api_key", "oauth", "unknown"] as const, "unknown"),
        currentImplementation: oneOf(item.currentImplementation, currentImplementations, "not_connected"),
        ...(isNonEmptyString(item.adapterPath) ? { adapterPath: item.adapterPath.replace(/\\/g, "/") } : {}),
        ...(isNonEmptyString(item.sampleDataPath) ? { sampleDataPath: item.sampleDataPath.replace(/\\/g, "/") } : {}),
        riskNotes: asStringArray(item.riskNotes),
      }))
    : [];
  const checks = asStringArray(renderVerification.checks).filter((check): check is MvpContractV2["renderVerification"]["checks"][number] =>
    (renderChecks as readonly string[]).includes(check),
  );

  return {
    contractVersion: "mvp-contract-v2",
    artifactTier: oneOf(value.artifactTier, artifactTiers, "static_mvp"),
    firstScreenValue: String(value.firstScreenValue ?? ""),
    coreInteraction: String(value.coreInteraction ?? ""),
    stateChange: String(value.stateChange ?? ""),
    inspectableOutput: String(value.inspectableOutput ?? ""),
    staticDataBoundary: String(value.staticDataBoundary ?? ""),
    requiredFiles: asStringArray(value.requiredFiles),
    nonGoals: asStringArray(value.nonGoals),
    forbiddenDependencies: asStringArray(value.forbiddenDependencies),
    externalDependencyMode: oneOf(value.externalDependencyMode, externalDependencyModes, "none"),
    externalIntegrations: integrations,
    runtimeBoundary: {
      networkCalls: oneOf(runtime.networkCalls, ["none", "live_required"] as const, "none"),
      secrets: oneOf(runtime.secrets, ["none", "required"] as const, "none"),
      externalWrites: oneOf(runtime.externalWrites, ["none", "proposed", "live_required"] as const, "none"),
    },
    mvpComplexityBudget: {
      maxScreens: budget.maxScreens === 2 ? 2 : 1,
      maxPrimaryActions: 1,
      maxSourceFiles: typeof budget.maxSourceFiles === "number" ? Math.max(1, Math.floor(budget.maxSourceFiles)) : 12,
      maxNewDependencies: 0,
      allowDatabase: false,
    },
    integrationAssumptions: Array.isArray(value.integrationAssumptions)
      ? value.integrationAssumptions.filter(isRecord).map((item) => ({
          service: String(item.service ?? ""),
          ...(isNonEmptyString(item.officialDocsVerifiedAt) ? { officialDocsVerifiedAt: item.officialDocsVerifiedAt } : {}),
          verificationStatus: oneOf(
            item.verificationStatus,
            ["unverified", "official_docs_checked", "not_applicable"] as const,
            "unverified",
          ),
          unavailableOrUnknown: asStringArray(item.unavailableOrUnknown),
          rateLimitRisk: oneOf(item.rateLimitRisk, ["low", "medium", "high", "unknown"] as const, "unknown"),
          costRisk: oneOf(item.costRisk, ["low", "medium", "high", "unknown"] as const, "unknown"),
          termsRisk: oneOf(item.termsRisk, ["low", "medium", "high", "unknown"] as const, "unknown"),
        }))
      : [],
    ...(isRecord(value.mockFidelity)
      ? {
          mockFidelity: {
            ...(isNonEmptyString(value.mockFidelity.samplePayloadPath)
              ? { samplePayloadPath: value.mockFidelity.samplePayloadPath.replace(/\\/g, "/") }
              : {}),
            simulatedBehaviors: asStringArray(value.mockFidelity.simulatedBehaviors),
            omittedBehaviors: asStringArray(value.mockFidelity.omittedBehaviors),
            failureCasesIncluded: asStringArray(value.mockFidelity.failureCasesIncluded),
          },
        }
      : {}),
    claimBoundary: {
      publicCopyMustSay: asStringArray(claimBoundary.publicCopyMustSay),
      publicCopyMustNotSay: asStringArray(claimBoundary.publicCopyMustNotSay),
    },
    renderVerification: {
      required: true,
      checks: checks.length > 0 ? checks : ["render", "click", "state_change", "screenshot"],
      ...(isNonEmptyString(renderVerification.screenshotPath)
        ? { screenshotPath: renderVerification.screenshotPath.replace(/\\/g, "/") }
        : {}),
    },
    humanReviewTriggers: asStringArray(value.humanReviewTriggers),
  };
};

const checkRequiredContractFields = (checks: Check[], contract: MvpContractV2) => {
  for (const field of [
    "firstScreenValue",
    "coreInteraction",
    "stateChange",
    "inspectableOutput",
    "staticDataBoundary",
  ] as const) {
    addCheck(
      checks,
      `contract.${field}`,
      isNonEmptyString(contract[field]) ? "pass" : "fail",
      isNonEmptyString(contract[field])
        ? `${field} is non-empty`
        : `${field} is missing or empty`,
    );
  }
  for (const field of ["requiredFiles", "nonGoals", "forbiddenDependencies"] as const) {
    addCheck(
      checks,
      `contract.${field}`,
      contract[field].length > 0 ? "pass" : "fail",
      contract[field].length > 0
        ? `${field} contains ${contract[field].length} item(s)`
        : `${field} must contain at least one item`,
    );
  }
};

const checkRuntimeBoundary = (
  checks: Check[],
  contract: MvpContractV2,
  sourceText: string,
  demoSourceText: string,
) => {
  const liveMode =
    contract.externalDependencyMode === "live_required" ||
    contract.artifactTier === "live_integration_candidate";
  addCheck(
    checks,
    "external_dependency.auto_publishable_mode",
    liveMode ? "fail" : "pass",
    liveMode
      ? "live_required/live_integration_candidate cannot auto-publish"
      : "external dependency mode is auto-publishable",
  );
  addCheck(
    checks,
    "runtime.network_calls",
    contract.runtimeBoundary.networkCalls === "none" ? "pass" : "fail",
    contract.runtimeBoundary.networkCalls === "none"
      ? "runtimeBoundary.networkCalls is none"
      : "runtimeBoundary.networkCalls must be none for MVP auto-publish",
  );
  addCheck(
    checks,
    "runtime.secrets",
    contract.runtimeBoundary.secrets === "none" ? "pass" : "fail",
    contract.runtimeBoundary.secrets === "none"
      ? "runtimeBoundary.secrets is none"
      : "runtimeBoundary.secrets must be none for MVP auto-publish",
  );
  addCheck(
    checks,
    "runtime.external_writes",
    contract.runtimeBoundary.externalWrites !== "live_required" ? "pass" : "fail",
    contract.runtimeBoundary.externalWrites !== "live_required"
      ? "runtimeBoundary.externalWrites is not live_required"
      : "runtimeBoundary.externalWrites=live_required cannot auto-publish",
  );

  // fetch/XHR はデモ側(core/以外)のみ検査。core/** の文書化呼び出しパターンは実行されないため許可。
  // process.env と有償/認証SDK import は core/ 含む全域で禁止（apiKeyは関数引数で受ける契約）。
  const runtimeHits: string[] = [];
  if (/\bfetch\s*\(/.test(demoSourceText)) runtimeHits.push("fetch()");
  if (/\bXMLHttpRequest\b/.test(demoSourceText)) runtimeHits.push("XMLHttpRequest");
  if (/\bprocess\.env\b/.test(sourceText)) runtimeHits.push("process.env");
  if (/from\s+["'](openai|stripe|next-auth|@auth\/)/.test(sourceText)) runtimeHits.push("live SDK/auth import");
  addCheck(
    checks,
    "runtime.source_no_live_dependencies",
    runtimeHits.length === 0 ? "pass" : "fail",
    runtimeHits.length === 0
      ? "no live runtime dependency patterns (network patterns allowed only under source/core/)"
      : `source files contain live runtime dependency pattern(s): ${runtimeHits.join(", ")}`,
  );
};

const checkExternalIntegrations = async (checks: Check[], root: string, contract: MvpContractV2) => {
  const mode = contract.externalDependencyMode;
  if (mode === "none") {
    const liveCalls = contract.externalIntegrations.filter((integration) => integration.currentImplementation === "live_call");
    addCheck(
      checks,
      "external_integrations.none_mode_no_live_call",
      liveCalls.length === 0 ? "pass" : "fail",
      liveCalls.length === 0
        ? "none mode has no live_call integrations"
        : `none mode must not include live_call integrations: ${liveCalls.map((item) => item.service).join(", ")}`,
    );
    return;
  }

  addCheck(
    checks,
    "external_integrations.present",
    contract.externalIntegrations.length > 0 ? "pass" : "fail",
    contract.externalIntegrations.length > 0
      ? `externalIntegrations contains ${contract.externalIntegrations.length} item(s)`
      : `${mode} requires at least one externalIntegrations item`,
  );

  for (const [index, integration] of contract.externalIntegrations.entries()) {
    addCheck(
      checks,
      `external_integrations.${index}.not_live_call`,
      integration.currentImplementation !== "live_call" ? "pass" : "fail",
      integration.currentImplementation !== "live_call"
        ? `${integration.service || `integration ${index}`} is not live_call`
        : `${integration.service || `integration ${index}`} uses live_call and cannot auto-publish`,
    );
  }

  if (mode !== "mocked_adapter") return;

  const mocked = contract.externalIntegrations.filter((integration) =>
    ["mock_adapter", "mock_data"].includes(integration.currentImplementation),
  );
  addCheck(
    checks,
    "external_integrations.mock_present",
    mocked.length > 0 ? "pass" : "fail",
    mocked.length > 0
      ? "mocked_adapter mode has a mock implementation"
      : "mocked_adapter mode requires mock_adapter or mock_data currentImplementation",
  );

  for (const [index, integration] of mocked.entries()) {
    const adapterPath = integration.adapterPath ? path.join(root, integration.adapterPath) : "";
    const sampleDataPath = integration.sampleDataPath ? path.join(root, integration.sampleDataPath) : "";
    addCheck(
      checks,
      `external_integrations.mock.${index}.adapter_path`,
      adapterPath && (await fileExists(adapterPath)) ? "pass" : "fail",
      adapterPath && (await fileExists(adapterPath))
        ? `mock adapter exists: ${integration.adapterPath}`
        : `mocked_adapter integration requires an existing adapterPath (${integration.adapterPath ?? "missing"})`,
      adapterPath || undefined,
    );
    addCheck(
      checks,
      `external_integrations.mock.${index}.sample_data_path`,
      sampleDataPath && (await fileExists(sampleDataPath)) ? "pass" : "fail",
      sampleDataPath && (await fileExists(sampleDataPath))
        ? `mock sample data exists: ${integration.sampleDataPath}`
        : `mocked_adapter integration requires an existing sampleDataPath (${integration.sampleDataPath ?? "missing"})`,
      sampleDataPath || undefined,
    );
  }

  addCheck(
    checks,
    "mock_fidelity.failure_case",
    !!contract.mockFidelity && contract.mockFidelity.failureCasesIncluded.length > 0 ? "pass" : "fail",
    !!contract.mockFidelity && contract.mockFidelity.failureCasesIncluded.length > 0
      ? "mockFidelity includes at least one failure case"
      : "mocked_adapter requires mockFidelity.failureCasesIncluded",
  );
};

const checkComplexityBudget = (checks: Check[], sourceFiles: string[], contract: MvpContractV2) => {
  const budget = contract.mvpComplexityBudget;
  addCheck(
    checks,
    "complexity.source_files",
    sourceFiles.length <= budget.maxSourceFiles ? "pass" : "fail",
    sourceFiles.length <= budget.maxSourceFiles
      ? `source file count ${sourceFiles.length} is within maxSourceFiles=${budget.maxSourceFiles}`
      : `source file count ${sourceFiles.length} exceeds maxSourceFiles=${budget.maxSourceFiles}`,
  );
  addCheck(
    checks,
    "complexity.max_screens",
    budget.maxScreens <= 2 ? "pass" : "fail",
    budget.maxScreens <= 2 ? "maxScreens is within MVP budget" : "maxScreens must be 1 or 2",
  );
  addCheck(
    checks,
    "complexity.max_primary_actions",
    budget.maxPrimaryActions === 1 ? "pass" : "fail",
    budget.maxPrimaryActions === 1 ? "maxPrimaryActions is 1" : "maxPrimaryActions must be 1",
  );
  addCheck(
    checks,
    "complexity.no_new_dependencies",
    budget.maxNewDependencies === 0 ? "pass" : "fail",
    budget.maxNewDependencies === 0 ? "maxNewDependencies is 0" : "maxNewDependencies must be 0",
  );
  addCheck(
    checks,
    "complexity.no_database",
    budget.allowDatabase === false ? "pass" : "fail",
    budget.allowDatabase === false ? "allowDatabase is false" : "allowDatabase must be false",
  );
};

const checkClaimBoundary = async (checks: Check[], root: string, sourceFiles: string[], contract: MvpContractV2) => {
  const readmePath = path.join(root, "README.md");
  const readme = await readTextIfExists(readmePath);
  const demo = await readTextIfExists(path.join(root, "demo-placeholder.md"));
  const sourceTextParts = await Promise.all(
    sourceFiles
      .filter((filePath) => isPublicTextSourceFile(root, filePath))
      .map((filePath) => readTextIfExists(filePath)),
  );
  const publicText = [readme, demo, ...sourceTextParts].join("\n").toLowerCase();

  addCheck(
    checks,
    "claim_boundary.must_say",
    contract.claimBoundary.publicCopyMustSay.length > 0 ? "pass" : "fail",
    contract.claimBoundary.publicCopyMustSay.length > 0
      ? "claimBoundary.publicCopyMustSay is declared"
      : "claimBoundary.publicCopyMustSay must be declared",
  );
  addCheck(
    checks,
    "claim_boundary.must_not_say",
    contract.claimBoundary.publicCopyMustNotSay.length > 0 ? "pass" : "fail",
    contract.claimBoundary.publicCopyMustNotSay.length > 0
      ? "claimBoundary.publicCopyMustNotSay is declared"
      : "claimBoundary.publicCopyMustNotSay must be declared",
  );

  for (const mustSay of contract.claimBoundary.publicCopyMustSay) {
    addCheck(
      checks,
      `claim_boundary.must_say_present.${mustSay.slice(0, 32)}`,
      readme.toLowerCase().includes(mustSay.toLowerCase()) ? "pass" : "warn",
      readme.toLowerCase().includes(mustSay.toLowerCase())
        ? `README includes required boundary copy: ${mustSay}`
        : `README should include boundary copy before public display: ${mustSay}`,
      readmePath,
    );
  }

  for (const mustNotSay of contract.claimBoundary.publicCopyMustNotSay) {
    const needle = mustNotSay.trim().toLowerCase();
    if (needle.length < 3) continue;
    addCheck(
      checks,
      `claim_boundary.must_not_absent.${mustNotSay.slice(0, 32)}`,
      publicText.includes(needle) ? "fail" : "pass",
      publicText.includes(needle)
        ? `Public artifact text contains prohibited claim: ${mustNotSay}`
        : `Public artifact text does not contain prohibited claim: ${mustNotSay}`,
    );
  }
};

const checkRenderVerification = async (checks: Check[], root: string, contract: MvpContractV2) => {
  addCheck(
    checks,
    "render_verification.required",
    contract.renderVerification.required === true ? "pass" : "fail",
    contract.renderVerification.required === true
      ? "renderVerification.required is true"
      : "renderVerification.required must be true",
  );
  addCheck(
    checks,
    "render_verification.checks",
    contract.renderVerification.checks.length > 0 ? "pass" : "fail",
    contract.renderVerification.checks.length > 0
      ? `renderVerification declares ${contract.renderVerification.checks.join(", ")}`
      : "renderVerification.checks must contain at least one check",
  );

  const renderReportPath = path.join(root, "validation", "render-verification.json");
  const renderReportExists = await fileExists(renderReportPath);
  addCheck(
    checks,
    "render_verification.report",
    renderReportExists ? "pass" : "warn",
    renderReportExists
      ? "validation/render-verification.json exists"
      : "render verification has not run yet; initial V2 rollout treats this as warning/hold",
    renderReportPath,
  );

  if (contract.renderVerification.screenshotPath) {
    const screenshotPath = path.join(root, contract.renderVerification.screenshotPath);
    addCheck(
      checks,
      "render_verification.screenshot_path",
      await fileExists(screenshotPath) ? "pass" : "warn",
      (await fileExists(screenshotPath))
        ? `screenshot exists: ${contract.renderVerification.screenshotPath}`
        : `screenshotPath is declared but missing: ${contract.renderVerification.screenshotPath}`,
      screenshotPath,
    );
  }
};

async function main() {
  const args = parseArgs();
  const root = path.resolve(process.cwd(), args.artifactPath);
  const checks: Check[] = [];

  try {
    const info = await stat(root);
    addCheck(checks, "artifact_dir", info.isDirectory() ? "pass" : "fail", info.isDirectory() ? "artifact directory exists" : "artifact path is not a directory", root);
  } catch {
    addCheck(checks, "artifact_dir", "fail", "artifact directory is missing", root);
  }

  const metadataPath = path.join(root, "metadata.json");
  const validationPath = path.join(root, "validation", "mvp-contract-v2.json");
  const metadata = await readJson<JsonRecord>(metadataPath);
  const validationReport = await readJson<JsonRecord>(validationPath);
  addCheck(
    checks,
    "metadata_json",
    isRecord(metadata) ? "pass" : "fail",
    isRecord(metadata) ? "metadata.json exists" : "metadata.json is missing or invalid JSON",
    metadataPath,
  );

  const { contract: contractCandidate, source } = getContractCandidate(metadata, validationReport);
  if (source === "v1_fallback") {
    addCheck(
      checks,
      "contract.source_v1_fallback",
      "warn",
      "mvpContractV2 is missing; generated a static_mvp fallback from legacy mvpContract",
      metadataPath,
    );
  } else {
    addCheck(
      checks,
      "contract.source",
      contractCandidate ? "pass" : "fail",
      contractCandidate
        ? `contract source is ${source}`
        : "mvpContractV2 or legacy mvpContract is required",
      contractCandidate ? validationPath : metadataPath,
    );
  }

  const sourceFiles = await collectFiles(path.join(root, "source"));
  const implementationSourceFiles = sourceFiles.filter((filePath) => isImplementationSourceFile(root, filePath));
  const sourceTextParts = await Promise.all(
    sourceFiles
      .filter((filePath) => isPublicTextSourceFile(root, filePath))
      .map((filePath) => readTextIfExists(filePath)),
  );
  const sourceText = sourceTextParts.join("\n");
  // コアロジックファースト契約（2026-07-07）: source/core/** は文書化された実呼び出しパターン層で、
  // エントリポイントから一切importされずデモ実行時には走らない。runtime境界のfetch/XHR検査は
  // 「デモが実際に実行しうるソース」= core/ 以外に限定する（process.env/SDK importは全域のまま）。
  const isCorePatternFile = (filePath: string) =>
    toPortableRel(root, filePath).startsWith("source/core/");
  const demoSourceTextParts = await Promise.all(
    sourceFiles
      .filter((filePath) => isPublicTextSourceFile(root, filePath) && !isCorePatternFile(filePath))
      .map((filePath) => readTextIfExists(filePath)),
  );
  const demoSourceText = demoSourceTextParts.join("\n");

  const contract = contractCandidate ? normalizeContract(contractCandidate) : null;
  if (contract) {
    addCheck(
      checks,
      "contract.version",
      contractCandidate?.contractVersion === "mvp-contract-v2" ? "pass" : "fail",
      contractCandidate?.contractVersion === "mvp-contract-v2"
        ? "contractVersion is mvp-contract-v2"
        : "contractVersion must be mvp-contract-v2",
    );
    addCheck(
      checks,
      "contract.artifact_tier",
      (artifactTiers as readonly string[]).includes(contract.artifactTier) ? "pass" : "fail",
      `artifactTier is ${contract.artifactTier}`,
    );
    addCheck(
      checks,
      "contract.external_dependency_mode",
      (externalDependencyModes as readonly string[]).includes(contract.externalDependencyMode) ? "pass" : "fail",
      `externalDependencyMode is ${contract.externalDependencyMode}`,
    );
    checkRequiredContractFields(checks, contract);
    checkRuntimeBoundary(checks, contract, sourceText, demoSourceText);
    await checkExternalIntegrations(checks, root, contract);
    checkComplexityBudget(checks, implementationSourceFiles, contract);
    await checkClaimBoundary(checks, root, sourceFiles, contract);
    await checkRenderVerification(checks, root, contract);
  }

  const failChecks = checks.filter((check) => check.status === "fail");
  const warnChecks = checks.filter((check) => check.status === "warn");
  const liveBoundary =
    contract?.externalDependencyMode === "live_required" ||
    contract?.artifactTier === "live_integration_candidate" ||
    contract?.runtimeBoundary.networkCalls === "live_required" ||
    contract?.runtimeBoundary.secrets === "required" ||
    contract?.runtimeBoundary.externalWrites === "live_required";
  const result: CheckResult = {
    version: 1,
    generatedAt: new Date().toISOString(),
    checkKey: "mvp_contract_v2",
    path: toRel(root),
    result: failChecks.length > 0 ? "fail" : warnChecks.length > 0 ? "warn" : "pass",
    status: failChecks.length > 0 ? "fail" : warnChecks.length > 0 ? "warn" : "pass",
    source,
    artifactTier: contract?.artifactTier ?? null,
    externalDependencyMode: contract?.externalDependencyMode ?? null,
    autoPublishable: !!contract && failChecks.length === 0 && !liveBoundary,
    checks,
    findings: checks.filter((check) => check.status !== "pass").map((check) => `${check.id}: ${check.message}`),
    contract,
  };

  if (args.write) {
    const outputPath = args.output ? path.resolve(process.cwd(), args.output) : validationPath;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(result, null, 2));
  if (!args.jsonOnly) {
    console.log("");
    console.log(`Result: ${result.result.toUpperCase()} - ${failChecks.length} fail(s), ${warnChecks.length} warning(s)`);
  }

  if (result.result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
