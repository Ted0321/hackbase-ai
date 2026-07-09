import path from "node:path";
import { access, readFile } from "node:fs/promises";

type Metadata = {
  version: number;
  artifactId: string;
  demoPath?: string;
  sourceFiles?: Array<{
    relativePath: string;
    purpose: string;
    sizeBytes: number;
    checksum: string;
    generatedFrom: string;
  }>;
  demo?: {
    path: string;
    purpose: string;
  };
  readiness?: Record<string, unknown>;
  dbWrite?: {
    status: string;
    reason: string;
  };
};

type Issue = {
  level: "error" | "warning";
  message: string;
};

const parseArgs = () => {
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
    path: typeof values.get("path") === "string" ? String(values.get("path")) : "",
  };
};

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const safeRelativePath = (value: string) =>
  value.length > 0 && !value.includes("..") && !path.isAbsolute(value);

const candidatePaths = (root: string, value: string) => [
  path.join(root, value),
  path.join(process.cwd(), value),
  path.join(process.cwd(), "artifacts", value),
];

const existsInCandidates = async (root: string, value: string) => {
  for (const filePath of candidatePaths(root, value)) {
    if (await exists(filePath)) return true;
  }
  return false;
};

async function main() {
  const args = parseArgs();
  if (!args.path) {
    throw new Error("--path is required");
  }

  const root = path.resolve(process.cwd(), args.path);
  const issues: Issue[] = [];

  for (const required of ["README.md", "metadata.json"]) {
    if (!(await exists(path.join(root, required)))) {
      issues.push({ level: "error", message: `Missing ${required}` });
    }
  }

  const metadataPath = path.join(root, "metadata.json");
  const metadata = await readJson<Metadata>(metadataPath);
  if (!metadata) {
    issues.push({ level: "error", message: "metadata.json is missing or invalid JSON" });
  } else {
    if (metadata.version !== undefined && metadata.version !== 1) {
      issues.push({ level: "error", message: "metadata.version must be 1" });
    }
    if (!metadata.artifactId && !(metadata as Record<string, unknown>).projectId) {
      issues.push({ level: "error", message: "metadata.artifactId is required" });
    }
    const demoPath = metadata.demo?.path ?? metadata.demoPath;
    if (!demoPath || !safeRelativePath(demoPath)) {
      issues.push({ level: "error", message: "metadata demo path must be a safe relative path" });
    } else if (!(await existsInCandidates(root, demoPath))) {
      issues.push({ level: "error", message: `Missing demo file: ${demoPath}` });
    }
    const sourcePath = (metadata as Record<string, unknown>).sourcePath;
    if ((!Array.isArray(metadata.sourceFiles) || metadata.sourceFiles.length === 0) && typeof sourcePath !== "string") {
      issues.push({ level: "error", message: "metadata.sourceFiles must contain at least one file" });
    } else if (Array.isArray(metadata.sourceFiles) && metadata.sourceFiles.length > 0) {
      for (const file of metadata.sourceFiles) {
        if (!safeRelativePath(file.relativePath)) {
          issues.push({ level: "error", message: `Unsafe source file path: ${file.relativePath}` });
          continue;
        }
        if (!(await existsInCandidates(root, file.relativePath))) {
          issues.push({ level: "error", message: `Missing source file: ${file.relativePath}` });
        }
        if (!file.purpose) {
          issues.push({ level: "warning", message: `Missing purpose for source file: ${file.relativePath}` });
        }
      }
    } else if (typeof sourcePath === "string") {
      if (!safeRelativePath(sourcePath)) {
        issues.push({ level: "error", message: `Unsafe source file path: ${sourcePath}` });
      } else if (!(await existsInCandidates(root, sourcePath))) {
        issues.push({ level: "error", message: `Missing source file: ${sourcePath}` });
      }
    }
    if (metadata.dbWrite?.status !== "skipped") {
      issues.push({ level: "warning", message: "DB write status is not explicitly skipped" });
    }
  }

  for (const issue of issues) {
    console.log(`${issue.level.toUpperCase()}: ${issue.message}`);
  }

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  console.log(`Materialized artifact check: ${errors.length} error(s), ${warnings.length} warning(s)`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
