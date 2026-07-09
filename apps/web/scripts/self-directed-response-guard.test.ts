import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPipelineResponsesWritten } from "./self-directed-response-guard";

const root = path.join(process.cwd(), "artifacts", "llm-pipeline-runs");

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const expectRejects = async (label: string, fn: () => Promise<void>, expectedMessage: string) => {
  try {
    await fn();
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`${label}: expected message to include ${expectedMessage}, got ${message}`);
    }
    return;
  }
  throw new Error(`${label}: expected rejection`);
};

async function main() {
  const runId = "__self_directed_response_guard_test";
  const runRoot = path.join(root, runId);
  await rm(runRoot, { recursive: true, force: true });

  await writeJson(path.join(runRoot, "research", "response.json"), { status: "ok" });
  await assertPipelineResponsesWritten(runId, "research");

  await writeJson(path.join(runRoot, "combination", "gemini-dry-run.json"), { dryRun: true });
  await expectRejects(
    "dry-run artifact only",
    () => assertPipelineResponsesWritten(runId, "research,combination"),
    "dry-run artifacts only: combination",
  );

  await expectRejects(
    "missing response",
    () => assertPipelineResponsesWritten(runId, "research,concept"),
    "missing response.json: concept",
  );

  await rm(runRoot, { recursive: true, force: true });
  console.log("self-directed response guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
