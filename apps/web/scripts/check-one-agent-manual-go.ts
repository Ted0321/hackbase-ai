import { access, readFile } from "node:fs/promises";
import path from "node:path";
import "./load-local-env";
import { createPrismaClient } from "./prisma-client";
import { readAdminAgentRegistryWithContracts } from "../src/lib/agent-operating-contract-store";
import { activationChecklist } from "../src/lib/admin-agent-registry";

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasFlag = (flag: string) => process.argv.includes(flag);

const push = (checks: Check[], id: string, status: CheckStatus, message: string) => {
  checks.push({ id, status, message });
};

const exists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const fileIncludes = async (filePath: string, needles: string[]) => {
  const body = await readFile(filePath, "utf8");
  return needles.every((needle) => body.includes(needle));
};

async function main() {
  const agentId = arg("--agent");
  const runId = arg("--run");
  const publish = hasFlag("--publish");
  const write = hasFlag("--write");
  const checks: Check[] = [];

  if (!agentId) {
    throw new Error("Usage: tsx scripts/check-one-agent-manual-go.ts --agent <agentId> [--run <runId>] [--write] [--publish]");
  }

  const prisma = createPrismaClient();
  try {
    const registry = await readAdminAgentRegistryWithContracts(prisma);
    const agent = registry.agents.find((item) => item.agentId === agentId);
    push(
      checks,
      "agent.exists",
      agent ? "pass" : "fail",
      agent ? `${agentId} exists in operating contracts` : `${agentId} is not found in operating contracts`,
    );
    if (agent) {
      const checklist = activationChecklist(agent);
      push(
        checks,
        "agent.creator",
        (agent.role ?? "creator") === "creator" ? "pass" : "fail",
        `role=${agent.role ?? "creator"}`,
      );
      push(
        checks,
        "agent.active",
        (agent.status ?? "active") === "active" ? "pass" : "fail",
        `status=${agent.status ?? "active"}`,
      );
      push(
        checks,
        "agent.activation",
        checklist.every((item) => item.passed) ? "pass" : "fail",
        checklist.every((item) => item.passed)
          ? "activation checklist is complete"
          : "activation checklist has failing items",
      );
    }

    push(
      checks,
      "contracts.db",
      registry.contractSourceSummary.db === registry.agents.length &&
        registry.contractSourceSummary.registry === 0
        ? "pass"
        : "warn",
      `contractSource db=${registry.contractSourceSummary.db} registry=${registry.contractSourceSummary.registry}`,
    );
  } finally {
    await prisma.$disconnect();
  }

  const promptContracts = [
    ["scripts/prompts/requirements.md", ["visualIdentity", "logoPrompt", "thumbnailPrompt", "visualReadiness"]],
    ["scripts/prompts/builder.md", ["visualIdentity", "screenshotDescription", "visualReadiness"]],
    ["scripts/prompts/reviewer.md", ["visualIdentity", "generic placeholder logo"]],
  ] as const;
  for (const [filePath, needles] of promptContracts) {
    push(
      checks,
      `prompt.${path.basename(filePath)}`,
      (await fileIncludes(path.join(process.cwd(), filePath), [...needles])) ? "pass" : "fail",
      `${filePath} contains visualIdentity contract terms`,
    );
  }

  if (write) {
    push(
      checks,
      "env.gemini",
      process.env.GEMINI_API_KEY ? "pass" : "fail",
      process.env.GEMINI_API_KEY
        ? "GEMINI_API_KEY is present"
        : "GEMINI_API_KEY is required before --write can call the LLM",
    );
    push(
      checks,
      "approval.write",
      process.env.PRODIA_MANUAL_TRIGGER_APPROVED === "1" ? "pass" : "fail",
      process.env.PRODIA_MANUAL_TRIGGER_APPROVED === "1"
        ? "PRODIA_MANUAL_TRIGGER_APPROVED=1"
        : "Set PRODIA_MANUAL_TRIGGER_APPROVED=1 for an intentional one-agent real LLM run",
    );
  } else {
    push(checks, "mode.write", "pass", "dry-run/check mode; no LLM call required");
  }

  if (publish) {
    push(
      checks,
      "approval.publish",
      process.env.PRODIA_MANUAL_PUBLISH_APPROVED === "1" ? "pass" : "fail",
      process.env.PRODIA_MANUAL_PUBLISH_APPROVED === "1"
        ? "PRODIA_MANUAL_PUBLISH_APPROVED=1"
        : "Set PRODIA_MANUAL_PUBLISH_APPROVED=1 before allowing publish gates to write DB rows",
    );
  }

  if (runId) {
    const runRoot = path.join(process.cwd(), "artifacts", "llm-pipeline-runs", runId);
    const runRootExists = await exists(runRoot);
    push(
      checks,
      "run.collision",
      write && runRootExists ? "fail" : "pass",
      runRootExists
        ? `run artifact root already exists: ${path.relative(process.cwd(), runRoot)}`
        : `run artifact root is available: ${path.relative(process.cwd(), runRoot)}`,
    );
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const result = failCount > 0 ? "no-go" : "go";

  console.log(JSON.stringify({ result, summary: `${passCount} pass, ${warnCount} warn, ${failCount} fail`, checks }, null, 2));
  console.log("");
  console.log(`Manual one-agent Go/No-Go: ${result.toUpperCase()} - ${passCount} pass, ${warnCount} warn, ${failCount} fail`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
