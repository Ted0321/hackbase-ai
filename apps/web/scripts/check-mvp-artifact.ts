import path from "node:path";
import { access, readFile, readdir, stat } from "node:fs/promises";
import ts from "typescript";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

type MvpContract = {
  firstScreenValue?: unknown;
  coreInteraction?: unknown;
  stateChange?: unknown;
  inspectableOutput?: unknown;
  staticDataBoundary?: unknown;
  requiredFiles?: unknown;
  nonGoals?: unknown;
  forbiddenDependencies?: unknown;
};

type Metadata = {
  version?: unknown;
  artifactId?: unknown;
  sourceFiles?: Array<{
    relativePath?: unknown;
    purpose?: unknown;
  }>;
  demo?: {
    path?: unknown;
    purpose?: unknown;
  };
  readiness?: Record<string, unknown>;
  mvpContract?: MvpContract;
};

type Manifest = {
  entrypoint?: unknown;
  files?: unknown;
};

type SelfReview = {
  status?: unknown;
  checks?: Record<string, unknown>;
};

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

type MvpArtifactResult = {
  path: string;
  strictAutoPublish: boolean;
  result: "pass" | "fail" | "warn";
  checks: Check[];
  summary: string;
};

// Forbidden dependency patterns scanned in source files (P0-7)
const forbiddenSourcePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "external API fetch", pattern: /\bfetch\s*\(/ },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { label: "axios call", pattern: /\baxios\.(get|post|put|patch|delete)\s*\(/ },
  { label: "secret/env var", pattern: /\bprocess\.env\b/ },
  { label: "OpenAI SDK", pattern: /from\s+["']openai["']|require\(["']openai["']\)/ },
  { label: "Stripe (paid API)", pattern: /from\s+["']stripe["']|require\(["']stripe["']\)/ },
  { label: "login-only (auth)", pattern: /from\s+["'](passport|next-auth|@auth\/|express-session)["']/ },
  { label: "unsupported chart.js dependency", pattern: /from\s+["']chart\.js(?:\/auto)?["']|require\(["']chart\.js(?:\/auto)?["']\)/ },
  { label: "private key", pattern: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { label: "external publishing", pattern: /\b(vercel|firebase|gcloud|netlify)\s+(deploy|app|run|hosting)\b/i },
];

// コアロジックファースト契約（2026-07-07）: source/core/** は「文書化された実呼び出しパターン」層
// （エントリポイントから一切importされず、デモ実行時には走らない）。そこに限りネットワーク系
// パターンを許可する。秘密情報(process.env/秘密鍵)・有償/認証SDK・外部公開は全域で禁止のまま。
const corePatternExemptLabels = new Set(["external API fetch", "XMLHttpRequest", "axios call"]);

const textQualityFilePattern = /\.(md|json|tsx?|jsx?|css)$/;

const parseArgs = (): {
  artifactPath: string;
  dryRun: boolean;
  strictAutoPublish: boolean;
  jsonOnly: boolean;
} => {
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

  const artifactPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  if (!artifactPath) {
    console.error(
      "Usage: tsx scripts/check-mvp-artifact.ts --path <artifact-dir> [--dry-run] [--strict-auto-publish] [--json-only]",
    );
    process.exit(1);
  }

  return {
    artifactPath,
    dryRun: values.get("dry-run") === true,
    strictAutoPublish: values.get("strict-auto-publish") === true,
    jsonOnly: values.get("json-only") === true,
  };
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

const readText = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  const raw = await readText(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isNonEmptyString(item)) : [];

const toRel = (root: string, filePath: string) => path.relative(root, filePath).replace(/\\/g, "/");

const isSafeRelativePath = (value: string) =>
  value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");

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
    // directory missing — separate check handles this
  }
  return results;
};

const scriptKindFor = (filePath: string) => {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const checkCssSyntax = (text: string) => {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return "unclosed CSS comment";
      index = end + 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return "unexpected closing brace";
  }
  return depth === 0 ? null : "unclosed CSS block";
};

const checkGeneratedSourceSyntax = async (root: string, sourceFiles: string[]) => {
  const issues: string[] = [];
  for (const filePath of sourceFiles) {
    const rel = toRel(root, filePath);
    const text = await readText(filePath);
    if (text === null) {
      issues.push(`${rel}: could not read`);
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(filePath)) {
      const parsed = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
      const parseDiagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
        .parseDiagnostics ?? [];
      for (const diagnostic of parseDiagnostics.slice(0, 3)) {
        const pos = typeof diagnostic.start === "number" ? parsed.getLineAndCharacterOfPosition(diagnostic.start) : null;
        const location = pos ? `${pos.line + 1}:${pos.character + 1}` : "unknown";
        issues.push(`${rel}:${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
      }
      continue;
    }
    if (filePath.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (error) {
        issues.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : "parse failed"})`);
      }
      continue;
    }
    if (filePath.endsWith(".css")) {
      const cssIssue = checkCssSyntax(text);
      if (cssIssue) issues.push(`${rel}: ${cssIssue}`);
    }
  }
  return issues;
};

async function checkMvpArtifact(
  root: string,
  options: { strictAutoPublish?: boolean } = {},
): Promise<MvpArtifactResult> {
  const checks: Check[] = [];

  // ── P0-1: README.md ──────────────────────────────────────────────────────
  const readmeExists = await fileExists(path.join(root, "README.md"));
  checks.push({
    id: "readme_exists",
    status: readmeExists ? "pass" : "fail",
    message: readmeExists ? "README.md exists" : "README.md is missing",
  });

  // ── P0-2: metadata.json with mvpContract ─────────────────────────────────
  const metadata = await readJson<Metadata>(path.join(root, "metadata.json"));
  const hasMvpContract = !!metadata?.mvpContract && typeof metadata.mvpContract === "object";
  checks.push({
    id: "metadata_exists",
    status: metadata && hasMvpContract ? "pass" : "fail",
    message: !metadata
      ? "metadata.json is missing or invalid JSON"
      : !hasMvpContract
        ? "metadata.json exists but does not contain mvpContract"
        : "metadata.json exists and contains mvpContract",
  });

  // ── P0-3: MvpContract required fields ────────────────────────────────────
  const contract = metadata?.mvpContract ?? null;
  for (const field of ["firstScreenValue", "coreInteraction", "stateChange", "staticDataBoundary"] as const) {
    const ok = isNonEmptyString(contract?.[field]);
    checks.push({
      id: `mvp_contract_${field}`,
      status: ok ? "pass" : "fail",
      message: ok
        ? `mvpContract.${field} is non-empty`
        : `mvpContract.${field} is missing or empty`,
    });
  }

  // ── P0-4: manifest.json with entrypoint ──────────────────────────────────
  const manifest = await readJson<Manifest>(path.join(root, "manifest.json"));
  const hasEntrypoint = isNonEmptyString(manifest?.entrypoint);
  checks.push({
    id: "manifest_exists",
    status: manifest && hasEntrypoint ? "pass" : "fail",
    message: !manifest
      ? "manifest.json is missing or invalid JSON"
      : !hasEntrypoint
        ? "manifest.json exists but entrypoint is missing or empty"
        : `manifest.json exists with entrypoint: ${manifest.entrypoint}`,
  });

  // ── P0-5: entrypoint file exists ─────────────────────────────────────────
  const entrypointRel = isNonEmptyString(manifest?.entrypoint) ? String(manifest!.entrypoint) : "";
  const metadataSourceFilePaths = Array.isArray(metadata?.sourceFiles)
    ? metadata.sourceFiles
        .map((file) => (isNonEmptyString(file.relativePath) ? String(file.relativePath) : ""))
        .filter((value) => value.length > 0)
    : [];
  const requiredFiles = asStringArray(contract?.requiredFiles);
  const declaredPaths = [entrypointRel, ...metadataSourceFilePaths, ...requiredFiles].filter((value) => value.length > 0);
  const unsafeDeclaredPaths = declaredPaths.filter((value) => !isSafeRelativePath(value));

  checks.push({
    id: "declared_paths_safe",
    status: unsafeDeclaredPaths.length === 0 ? "pass" : "fail",
    message:
      unsafeDeclaredPaths.length === 0
        ? `All ${declaredPaths.length} declared artifact path(s) are safe relative paths`
        : `Unsafe declared artifact path(s): ${unsafeDeclaredPaths.join(", ")}`,
  });

  if (entrypointRel) {
    const entrypointExists = await fileExists(path.join(root, entrypointRel));
    checks.push({
      id: "entrypoint_exists",
      status: entrypointExists ? "pass" : "fail",
      message: entrypointExists
        ? `Entrypoint file exists: ${entrypointRel}`
        : `Entrypoint file not found: ${entrypointRel}`,
    });
  } else {
    checks.push({
      id: "entrypoint_exists",
      status: "fail",
      message: "Entrypoint could not be checked (manifest.entrypoint missing)",
    });
  }

  // ── P0-6: validation/self-review.json ────────────────────────────────────
  const selfReview = await readJson<SelfReview>(path.join(root, "validation", "self-review.json"));
  checks.push({
    id: "self_review_exists",
    status: selfReview ? "pass" : "fail",
    message: selfReview
      ? "validation/self-review.json exists"
      : "validation/self-review.json is missing or invalid JSON",
  });

  // ── P0-7: forbidden dependencies in source files ──────────────────────────
  // ファイル単位で走査し、source/core/**（文書化呼び出しパターン層）だけネットワーク系ラベルを免除。
  const sourceDir = path.join(root, "source");
  const sourceFiles = await collectFiles(sourceDir);
  const sourceContents = await Promise.all(sourceFiles.map((f) => readText(f)));
  const isCorePatternFile = (filePath: string) => toRel(root, filePath).startsWith("source/core/");

  const forbiddenHits: string[] = [];
  for (const { label, pattern } of forbiddenSourcePatterns) {
    const hitIndex = sourceFiles.findIndex((filePath, index) => {
      const content = sourceContents[index];
      if (!content) return false;
      if (corePatternExemptLabels.has(label) && isCorePatternFile(filePath)) return false;
      return pattern.test(content);
    });
    if (hitIndex >= 0) {
      forbiddenHits.push(`${label} (${toRel(root, sourceFiles[hitIndex])})`);
    }
  }
  checks.push({
    id: "forbidden_dependencies",
    status: forbiddenHits.length === 0 ? "pass" : "fail",
    message:
      forbiddenHits.length === 0
        ? "No forbidden dependencies found in source files (network patterns allowed only under source/core/)"
        : `Forbidden dependency pattern(s) found: ${forbiddenHits.join(", ")}`,
  });

  // ── P0-8: source/ has at least 1 file ────────────────────────────────────
  checks.push({
    id: "source_files_exist",
    status: sourceFiles.length > 0 ? "pass" : "fail",
    message:
      sourceFiles.length > 0
        ? `source/ contains ${sourceFiles.length} file(s)`
        : "source/ directory is empty or missing",
  });

  // ── P1: source/ has .ts or .tsx files ────────────────────────────────────
  const syntaxIssues = await checkGeneratedSourceSyntax(root, sourceFiles);
  checks.push({
    id: "generated_source_syntax",
    status: syntaxIssues.length === 0 ? "pass" : "fail",
    message:
      syntaxIssues.length === 0
        ? "Generated .ts/.tsx/.js/.jsx/.json/.css source files have no syntax issues"
        : `Generated source syntax issue(s): ${syntaxIssues.slice(0, 8).join("; ")}`,
  });

  const artifactTextFiles = (await collectFiles(root)).filter((file) => textQualityFilePattern.test(file));
  const textQualityIssues: string[] = [];
  for (const file of artifactTextFiles) {
    const rel = toRel(root, file);
    const text = await readText(file);
    if (text === null) continue;
    const issues = findMojibakeLikeTextIssues(text, { maxIssues: 3, path: rel });
    textQualityIssues.push(...issues.map((issue) => `${issue.path}:${issue.term}`));
    if (textQualityIssues.length >= 12) break;
  }
  checks.push({
    id: "artifact_text_quality",
    status: textQualityIssues.length === 0 ? "pass" : "fail",
    message:
      textQualityIssues.length === 0
        ? `No mojibake-like text found in ${artifactTextFiles.length} text artifact file(s)`
        : `Mojibake-like text found in artifact files: ${textQualityIssues.slice(0, 12).join(", ")}`,
  });

  const tsFiles = sourceFiles.filter((f) => /\.(tsx?|jsx?)$/.test(f));
  checks.push({
    id: "source_has_ts_files",
    status: tsFiles.length > 0 ? "pass" : "warn",
    message:
      tsFiles.length > 0
        ? `source/ contains ${tsFiles.length} TypeScript/JSX file(s)`
        : "source/ has no .ts/.tsx files (expected at least one)",
  });

  // ── P1: mvpContract.requiredFiles all present ─────────────────────────────
  if (requiredFiles.length > 0) {
    const missing: string[] = [];
    for (const rel of requiredFiles) {
      if (!rel.includes("..") && !path.isAbsolute(rel)) {
        const exists = await fileExists(path.join(root, rel));
        if (!exists) missing.push(rel);
      }
    }
    checks.push({
      id: "required_files_present",
      status: missing.length === 0 ? "pass" : "warn",
      message:
        missing.length === 0
          ? `All ${requiredFiles.length} mvpContract.requiredFiles are present`
          : `Missing required files: ${missing.join(", ")}`,
    });
  } else {
    checks.push({
      id: "required_files_present",
      status: "warn",
      message: "mvpContract.requiredFiles is empty or not available to check",
    });
  }

  // ── P1: placeholder-only file warning ────────────────────────────────────
  const placeholderPattern = /materializedPlanFile/;
  const placeholderFiles = sourceFiles
    .filter((_, i) => {
      const content = sourceContents[i];
      return content ? placeholderPattern.test(content) : false;
    })
    .map((f) => path.relative(root, f).replace(/\\/g, "/"));

  checks.push({
    id: "placeholder_files",
    status: placeholderFiles.length > 0 ? "fail" : "pass",
    message:
      placeholderFiles.length > 0
        ? `${placeholderFiles.length} source file(s) are placeholder-only (contain "materializedPlanFile"): ${placeholderFiles.join(", ")}`
        : "No placeholder-only source files detected",
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  if (options.strictAutoPublish) {
    const warningChecks = checks.filter((check) => check.status === "warn");
    checks.push({
      id: "strict_auto_publish_no_warnings",
      status: warningChecks.length === 0 ? "pass" : "fail",
      message:
        warningChecks.length === 0
          ? "No warnings remain under strict auto-publish mode"
          : `Strict auto-publish blocks ${warningChecks.length} warning(s): ${warningChecks
              .map((check) => check.id)
              .join(", ")}`,
    });
  }

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const passCount = checks.filter((c) => c.status === "pass").length;
  const result: MvpArtifactResult["result"] = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    path: root,
    strictAutoPublish: options.strictAutoPublish === true,
    result,
    checks,
    summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn`,
  };
}

async function main() {
  const { artifactPath, strictAutoPublish, jsonOnly } = parseArgs();
  const root = path.resolve(process.cwd(), artifactPath);

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

  const result = await checkMvpArtifact(root, { strictAutoPublish });

  console.log(JSON.stringify(result, null, 2));
  if (!jsonOnly) console.log("");
  if (!jsonOnly) console.log(`Result: ${result.result.toUpperCase()} - ${result.summary}`);

  if (result.result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
