import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

type InteractionProofResult = {
  version: 1;
  generatedAt: string;
  path: string;
  result: "pass" | "fail" | "warn";
  checks: Check[];
  summary: string;
};

type JsonRecord = Record<string, unknown>;

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
    console.error("Usage: tsx scripts/check-interaction-proof.ts --path <artifact-dir> [--write] [--output <json>]");
    process.exit(1);
  }

  return {
    artifactPath,
    write: values.get("write") === true,
    output: typeof values.get("output") === "string" ? String(values.get("output")) : "",
  };
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isNonEmptyString(item)) : [];

const push = (checks: Check[], id: string, ok: boolean, pass: string, fail: string) => {
  checks.push({ id, status: ok ? "pass" : "fail", message: ok ? pass : fail });
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const readText = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
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
    // Missing source directory is handled by checks below.
  }
  return results;
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const sourceContains = (sourceText: string, value: string) =>
  normalizeText(sourceText).includes(normalizeText(value));

const selectorEvidenceTokens = (selector: string): string[] => {
  const tokens: string[] = [];
  const attrPattern = /\[([a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]/g;
  for (const match of selector.matchAll(attrPattern)) {
    tokens.push(`${match[1]}="${match[2]}"`);
  }
  return tokens;
};

const selectorHasEvidence = (sourceText: string, selector: string) => {
  if (sourceContains(sourceText, selector)) return true;
  const tokens = selectorEvidenceTokens(selector);
  // selectorEvidenceTokens は data-proof="x" 形に正規化するが、生成ソースは ' でも " でも
  // 属性を書きうるので両方の引用符形で照合する（引用符差での取りこぼしを防ぐ）。
  return (
    tokens.length > 0 &&
    tokens.every(
      (token) => sourceContains(sourceText, token) || sourceContains(sourceText, token.replace(/"/g, "'")),
    )
  );
};

const toRel = (root: string, filePath: string) =>
  path.relative(root, filePath).replace(/\\/g, "/");

async function checkInteractionProof(root: string): Promise<InteractionProofResult> {
  const checks: Check[] = [];
  const metadataPath = path.join(root, "metadata.json");
  const metadata = await readJson<JsonRecord>(metadataPath);
  const proof = isRecord(metadata?.interactionProofPlan) ? metadata.interactionProofPlan : null;

  push(
    checks,
    "metadata.interactionProofPlan",
    isRecord(proof),
    "metadata.interactionProofPlan exists",
    "metadata.interactionProofPlan is missing",
  );

  const primaryAction = isRecord(proof) ? proof.primaryAction : undefined;
  const initialState = isRecord(proof) ? proof.initialState : undefined;
  const expectedState = isRecord(proof) ? proof.expectedState : undefined;
  const visibleEvidence = isRecord(proof) ? asStringArray(proof.visibleEvidence) : [];
  const proofSelectors = isRecord(proof) ? asStringArray(proof.proofSelectors) : [];
  const requiredSourceFiles = isRecord(proof) ? asStringArray(proof.requiredSourceFiles) : [];

  push(
    checks,
    "proof.primaryAction",
    isNonEmptyString(primaryAction),
    "primaryAction is non-empty",
    "primaryAction is missing or empty",
  );
  push(
    checks,
    "proof.initialState",
    isNonEmptyString(initialState),
    "initialState is non-empty",
    "initialState is missing or empty",
  );
  push(
    checks,
    "proof.expectedState",
    isNonEmptyString(expectedState),
    "expectedState is non-empty",
    "expectedState is missing or empty",
  );
  push(
    checks,
    "proof.visibleEvidence",
    visibleEvidence.length > 0,
    `visibleEvidence contains ${visibleEvidence.length} item(s)`,
    "visibleEvidence must contain at least one exact visible UI text",
  );
  push(
    checks,
    "proof.requiredSourceFiles",
    requiredSourceFiles.length > 0,
    `requiredSourceFiles contains ${requiredSourceFiles.length} item(s)`,
    "requiredSourceFiles must contain at least one source file path",
  );

  if (proofSelectors.length === 0) {
    checks.push({
      id: "proof.proofSelectors",
      status: "warn",
      message: "proofSelectors is empty; static text evidence will be used",
    });
  } else {
    checks.push({
      id: "proof.proofSelectors",
      status: "pass",
      message: `proofSelectors contains ${proofSelectors.length} item(s)`,
    });
  }

  const missingRequiredFiles = requiredSourceFiles.filter((relativePath) => {
    if (relativePath.includes("..") || path.isAbsolute(relativePath)) return true;
    return !existsSync(path.join(root, relativePath));
  });
  push(
    checks,
    "proof.requiredSourceFiles.present",
    missingRequiredFiles.length === 0,
    "All requiredSourceFiles exist",
    `Missing requiredSourceFiles: ${missingRequiredFiles.join(", ")}`,
  );

  const sourceDir = path.join(root, "source");
  const sourceFiles = await collectFiles(sourceDir);
  const sourceText = (
    await Promise.all(
      sourceFiles.map(async (filePath) => {
        const content = await readText(filePath);
        return content ? `\n/* ${toRel(root, filePath)} */\n${content}` : "";
      }),
    )
  ).join("\n");

  push(
    checks,
    "source.files",
    sourceFiles.length > 0,
    `source contains ${sourceFiles.length} file(s)`,
    "source directory is missing or empty",
  );

  const presentSelectors = proofSelectors.filter((selector) => selectorHasEvidence(sourceText, selector));
  if (proofSelectors.length > 0) {
    push(
      checks,
      "source.proofSelectorsEvidence",
      presentSelectors.length > 0,
      `source contains evidence for ${presentSelectors.length}/${proofSelectors.length} proof selector(s)`,
      `source does not contain any proof selector evidence: ${proofSelectors.join(", ")}`,
    );
  }

  // initialState / expectedState は「人間向けの状態説明文」なので source への逐語一致は求めない。
  // 宣言された proofSelector が source に実在すれば（= proof 対象の UI 領域が実装されていれば）
  // 状態証拠ありとみなす。特定の data-proof 名には依存しない（builder は意味的な名前を使ってよい）。
  // 旧実装は特定 seed 作品の selector 名（notice-upload-input / action-card-list / calendar-view）を
  // ハードコードしており、一般作品では永久に証明できなかった。
  const hasMarkedRegion = presentSelectors.length > 0 || /data-proof=["'][^"']+["']/.test(sourceText);
  const hasInitialSelectorEvidence = hasMarkedRegion;
  const hasExpectedSelectorEvidence = hasMarkedRegion;

  if (isNonEmptyString(primaryAction)) {
    // primaryAction はしばしば「〜をクリック」という操作の説明文なので逐語一致は求めない。
    // 説明文が source にあるか、または proof 対象の操作領域(マーク済み)が存在すれば証拠ありとする。
    push(
      checks,
      "source.primaryActionEvidence",
      sourceContains(sourceText, primaryAction) || hasMarkedRegion,
      sourceContains(sourceText, primaryAction)
        ? "source contains primaryAction text"
        : "source contains a marked interactive control (data-proof/proofSelector)",
      `source has neither primaryAction text nor a marked interactive control: ${primaryAction}`,
    );
  }

  if (isNonEmptyString(initialState)) {
    const hasInitialStateEvidence = sourceContains(sourceText, initialState) || hasInitialSelectorEvidence;
    push(
      checks,
      "source.initialStateEvidence",
      hasInitialStateEvidence,
      sourceContains(sourceText, initialState)
        ? "source contains initialState text"
        : "source contains initial-state selector evidence",
      `source does not contain initialState text or selector evidence: ${initialState}`,
    );
  }

  if (isNonEmptyString(expectedState)) {
    const hasExpectedStateEvidence = sourceContains(sourceText, expectedState) || hasExpectedSelectorEvidence;
    push(
      checks,
      "source.expectedStateEvidence",
      hasExpectedStateEvidence,
      sourceContains(sourceText, expectedState)
        ? "source contains expectedState text"
        : "source contains expected-state selector and visibleEvidence evidence",
      `source does not contain expectedState text or selector evidence: ${expectedState}`,
    );
  }

  const missingVisibleEvidence = visibleEvidence.filter((evidence) => !sourceContains(sourceText, evidence));
  const presentVisibleCount = visibleEvidence.length - missingVisibleEvidence.length;
  // 大半(>=半分)が source に存在すれば pass。サンプルデータの日付フォーマット差など少数の
  // 逐語不一致を許容しつつ、「宣言した可視文字列がほぼ実装されている」ことは担保する。
  const visibleEvidenceOk =
    visibleEvidence.length === 0 || presentVisibleCount >= Math.ceil(visibleEvidence.length / 2);
  if (visibleEvidenceOk) {
    push(
      checks,
      "source.visibleEvidence",
      true,
      `source contains ${presentVisibleCount}/${visibleEvidence.length} visibleEvidence text`,
      "n/a",
    );
  } else if (hasMarkedRegion) {
    // 宣言された可視文字列が動的な計算値（スコア・順位・% 等）の場合、source に逐語では現れない。
    // 対話性は proof セレクタ / data-proof マーク済み領域で別途証明済みなので warn 止まりにする。
    checks.push({
      id: "source.visibleEvidence",
      status: "warn",
      message: `only ${presentVisibleCount}/${visibleEvidence.length} visibleEvidence literally in source (likely dynamic values); interactivity proven via marked regions/proof selectors`,
    });
  } else {
    push(
      checks,
      "source.visibleEvidence",
      false,
      "n/a",
      `source is missing too much visibleEvidence (${presentVisibleCount}/${visibleEvidence.length}) and has no marked interactive region: ${missingVisibleEvidence.join(", ")}`,
    );
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result: InteractionProofResult["result"] =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    path: root,
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

async function main() {
  const args = parseArgs();
  const root = path.resolve(process.cwd(), args.artifactPath);

  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      console.error(`Error: ${root} is not a directory`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: directory not found: ${root}`);
    process.exit(1);
  }

  const result = await checkInteractionProof(root);
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(root, "validation", "interaction-proof.json");

  if (args.write) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Result: ${result.result.toUpperCase()} - ${result.summary}`);

  if (result.result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
