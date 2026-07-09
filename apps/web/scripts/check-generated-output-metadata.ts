import { readFile } from "node:fs/promises";
import path from "node:path";
import { findMojibakeLikeTextIssues } from "./llm-response-quality";

type Check = {
  label: string;
  status: "pass" | "fail";
  detail: string;
};

const appRoot = path.resolve(import.meta.dirname, "..");
const metadataFiles = [
  path.join(appRoot, "data", "agents", "generated-output-metadata.json"),
  path.join(appRoot, "data", "agents", "manual-seed-output-metadata.json"),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pass = (label: string, detail: string): Check => ({ label, status: "pass", detail });
const fail = (label: string, detail: string): Check => ({ label, status: "fail", detail });

async function checkFile(filePath: string): Promise<Check[]> {
  const relative = path.relative(process.cwd(), filePath);
  const checks: Check[] = [];
  let parsed: unknown;

  try {
    const body = await readFile(filePath, "utf8");
    parsed = JSON.parse(body.replace(/^\uFEFF/, ""));
    checks.push(pass(`${relative} JSON`, "parseable JSON"));
  } catch (error) {
    return [fail(`${relative} JSON`, String(error))];
  }

  if (!isRecord(parsed)) {
    checks.push(fail(`${relative} shape`, "root must be an object"));
    return checks;
  }

  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  checks.push(
    typeof parsed.version === "number" && Array.isArray(parsed.projects)
      ? pass(`${relative} shape`, `${projects.length} project(s)`)
      : fail(`${relative} shape`, "version and projects[] are required"),
  );

  const malformed = projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => {
      if (!isRecord(project)) return true;
      return typeof project.projectId !== "string" || project.projectId.trim().length === 0;
    });
  checks.push(
    malformed.length === 0
      ? pass(`${relative} project rows`, "all rows have projectId")
      : fail(`${relative} project rows`, `malformed index(es): ${malformed.map((item) => item.index).join(", ")}`),
  );

  const textIssues = findMojibakeLikeTextIssues(parsed, { maxIssues: 10 });
  checks.push(
    textIssues.length === 0
      ? pass(`${relative} text quality`, "no mojibake-like text found")
      : fail(
          `${relative} text quality`,
          textIssues.map((issue) => `${issue.path}: ${issue.term} (${issue.sample})`).join("; "),
        ),
  );

  return checks;
}

async function main() {
  const results = (await Promise.all(metadataFiles.map(checkFile))).flat();
  for (const check of results) {
    console.log(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
  }

  const failures = results.filter((check) => check.status === "fail");
  console.log("");
  console.log(`Summary: ${results.length - failures.length} pass, ${failures.length} fail`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
