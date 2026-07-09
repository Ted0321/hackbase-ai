import { access, readFile } from "node:fs/promises";
import path from "node:path";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
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
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const runId = typeof values.get("run") === "string" ? String(values.get("run")) : "";
  const requirePublisher = values.get("require-publisher") === true || values.get("require-publisher") === "true";
  const publisherOnly = values.get("publisher-only") === true || values.get("publisher-only") === "true";

  if (!runId) {
    console.error("Usage: tsx scripts/check-self-directed-publish-dry-run.ts --run <runId> [--require-publisher]");
    process.exit(1);
  }

  return { runId, requirePublisher, publisherOnly };
};

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonOptional = async <T = unknown>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const push = (checks: Check[], id: string, status: CheckStatus, message: string) => {
  checks.push({ id, status, message });
};

const runRoot = (runId: string) => path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId);

async function main() {
  const { runId, requirePublisher, publisherOnly } = parseArgs();
  const root = runRoot(runId);
  const checks: Check[] = [];

  if (!publisherOnly) {
    const planPath = path.join(root, "self-directed-plan.json");
    const planExists = await exists(planPath);
    push(
      checks,
      "selfDirectedPlan",
      planExists ? "pass" : "fail",
      planExists ? "self-directed-plan.json exists" : "self-directed-plan.json is missing",
    );

    // reviewer/rewriter は step3b の review/rewrite ループが dry-run で prepare する。
    for (const step of [
      "research",
      "combination",
      "concept",
      "requirements",
      "builder",
      "reviewer",
      "rewriter",
    ]) {
      const dir = path.join(root, step);
      const prompt = path.join(dir, "prompt.md");
      const input = path.join(dir, "input.json");
      const dryRun = path.join(dir, "gemini-dry-run.json");
      push(checks, `${step}.prompt`, (await exists(prompt)) ? "pass" : "fail", `${step}/prompt.md`);
      push(checks, `${step}.input`, (await exists(input)) ? "pass" : "fail", `${step}/input.json`);
      push(checks, `${step}.dryRun`, (await exists(dryRun)) ? "pass" : "fail", `${step}/gemini-dry-run.json`);
    }
  }

  const publisherInputPath = path.join(root, "publisher", "input.json");
  const publisherInput = await readJsonOptional<Record<string, unknown>>(publisherInputPath);
  if (!publisherInput) {
    push(
      checks,
      "publisher.input",
      requirePublisher ? "fail" : "warn",
      requirePublisher
        ? "publisher/input.json is required but missing"
        : "publisher/input.json is not present yet; this is expected before materialize + MVP validation",
    );
  } else {
    push(checks, "publisher.input", "pass", "publisher/input.json exists");
    const validationSummary = publisherInput.validationSummary;
    if (!isRecord(validationSummary)) {
      push(checks, "publisher.validationSummary", "fail", "publisher input has no validationSummary object");
    } else {
      const status = typeof validationSummary.status === "string" ? validationSummary.status : "";
      push(
        checks,
        "publisher.validationSummary.status",
        status && status !== "not_run" ? "pass" : "fail",
        status && status !== "not_run"
          ? `publisher validationSummary.status=${status}`
          : "publisher validationSummary must come from check-mvp-artifact before autonomous publish",
      );
      push(
        checks,
        "publisher.validationSummary.validator",
        validationSummary.validator === "check-mvp-artifact" ? "pass" : "fail",
        validationSummary.validator === "check-mvp-artifact"
          ? "publisher validationSummary.validator=check-mvp-artifact"
          : "publisher validationSummary.validator must be check-mvp-artifact",
      );
    }
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  console.log(JSON.stringify({ result, checks, summary: `${passCount} pass, ${failCount} fail, ${warnCount} warn` }, null, 2));
  console.log("");
  console.log(`Self-directed publish dry-run check: ${result.toUpperCase()} - ${passCount} pass, ${failCount} fail, ${warnCount} warn`);

  if (result === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
