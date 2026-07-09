import { spawn } from "node:child_process";
import path from "node:path";
import { readAdminAgentRegistryWithContracts } from "../src/lib/agent-operating-contract-store";
import { createPrismaClient } from "./prisma-client";

const appRoot = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.PRODIA_ADMIN_AGENT_E2E_PORT ?? 3329);
const existingDevBaseUrl = process.env.PRODIA_ADMIN_AGENT_E2E_BASE_URL ?? "http://localhost:3012";
let baseUrl = existingDevBaseUrl;
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const timeoutMs = 45_000;

type RouteExpectation = {
  path: string;
  includes: string[];
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const npmCommand = (args: string[]) =>
  process.platform === "win32"
    ? { command: "cmd.exe", args: ["/c", npmBin, ...args] }
    : { command: npmBin, args };

async function assertContractsReady() {
  const prisma = createPrismaClient();
  try {
    const registry = await readAdminAgentRegistryWithContracts(prisma);
    if (registry.contractSourceSummary.db !== 22 || registry.contractSourceSummary.registry !== 0) {
      throw new Error(
        `admin agent console e2e requires imported contracts; run "npm.cmd run agents:contracts:import" first. current db=${registry.contractSourceSummary.db} registry=${registry.contractSourceSummary.registry}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await wait(500);
  }
  throw new Error(`Admin agent E2E server did not become ready at ${baseUrl}`);
}

async function serverReady(url: string) {
  try {
    const response = await fetch(`${url}/human/agents`);
    return response.ok;
  } catch {
    return false;
  }
}

async function assertRoute(expectation: RouteExpectation) {
  const response = await fetch(`${baseUrl}${expectation.path}`);
  const body = await response.text();
  const normalizedBody = body.replaceAll("<!-- -->", "").replace(/\s+/g, " ");
  if (!response.ok) {
    throw new Error(`${expectation.path}: expected 2xx, got ${response.status}`);
  }
  for (const text of expectation.includes) {
    const normalizedText = text.replace(/\s+/g, " ");
    if (!body.includes(text) && !normalizedBody.includes(normalizedText)) {
      throw new Error(`${expectation.path}: expected body to include ${JSON.stringify(text)}`);
    }
  }
  console.log(`PASS ${expectation.path} ${response.status} ${body.length} bytes`);
}

async function main() {
  await assertContractsReady();

  let server: ReturnType<typeof spawn> | null = null;
  const serverOutput: string[] = [];
  if (await serverReady(existingDevBaseUrl)) {
    baseUrl = existingDevBaseUrl;
    console.log(`Using existing dev server: ${baseUrl}`);
  } else {
    baseUrl = `http://127.0.0.1:${port}`;
    const serverCommand = npmCommand(["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)]);
    server = spawn(serverCommand.command, serverCommand.args, {
      cwd: appRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
        PRODIA_ADMIN_WRITE_KEY: "admin-agent-console-e2e-key",
      },
      shell: false,
      stdio: "pipe",
    });
    server.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
    server.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));
  }

  try {
    await waitForServer();
    await Promise.all([
      assertRoute({
        path: "/human/agents",
        includes: ["AIエージェント管理", "DB 22 / registry fallback 0", "DB正本"],
      }),
      assertRoute({
        path: "/human/agents/new",
        includes: ["draft Agent作成", "管理者ガード", "PRODIA_ADMIN_WRITE_KEY"],
      }),
      assertRoute({
        path: "/human/agents/agent_a?tab=settings",
        includes: ["Settings", "次回scheduler判定プレビュー", "Activation gate", "DB sync", "adminWriteKey"],
      }),
      assertRoute({
        path: "/human/agents/agent_a",
        includes: ["Agent Console", "Current settings", "Generation Logs", "Reaction Logs"],
      }),
    ]);
    console.log("admin agent console e2e passed");
  } catch (error) {
    console.error(serverOutput.slice(-80).join(""));
    throw error;
  } finally {
    if (server && !server.killed) {
      server.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
