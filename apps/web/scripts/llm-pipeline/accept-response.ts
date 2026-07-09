import path from "node:path";
import {
  ensureRun,
  ensureStepDir,
  artifactRoot,
  parseArgs,
  readJson,
  requireStep,
  writeJson,
  writeText,
} from "./shared";
import { buildAgentProfileSnapshot } from "../agent-registry";

type AgentRouterResponse = {
  selectedAgentIds?: unknown;
};

const selectedAgentIdsFrom = (value: unknown) => {
  const response = value as AgentRouterResponse;

  return Array.isArray(response.selectedAgentIds)
    ? response.selectedAgentIds.filter((item): item is string => typeof item === "string")
    : [];
};

async function main() {
  const args = parseArgs();
  const step = requireStep(args.step);
  const runId = typeof args.run === "string" ? args.run : "";
  const responsePath = typeof args.response === "string" ? args.response : "";

  if (!runId) {
    throw new Error("--run is required");
  }
  if (!responsePath) {
    throw new Error("--response is required");
  }

  await ensureRun(runId);
  const dir = await ensureStepDir(runId, step);
  const response = await readJson(path.resolve(process.cwd(), responsePath));
  const target = path.join(dir, "response.json");
  const accepted = path.join(dir, "accepted.json");

  await writeJson(target, response);
  if (step === "agent-router") {
    const selectedAgentIds = selectedAgentIdsFrom(response);
    await writeJson(
      path.join(artifactRoot(runId), "agent-profile-snapshot.json"),
      await buildAgentProfileSnapshot(selectedAgentIds, `llm-pipeline:${runId}:agent-router`),
    );
  }
  await writeJson(accepted, {
    version: 1,
    runId,
    step,
    acceptedAt: new Date().toISOString(),
    sourceResponsePath: path.relative(process.cwd(), path.resolve(process.cwd(), responsePath)),
    targetResponsePath: path.relative(process.cwd(), target),
    note: "This file records that a manual LLM response was accepted for the pipeline step.",
  });
  await writeText(
    path.join(dir, "next-step.md"),
    [
      `# Accepted: ${step}`,
      "",
      "Prepare the next step with:",
      "",
      "```powershell",
      `npm run llm:pipeline:prepare -- --run ${runId} --step <next-step>`,
      "```",
    ].join("\n"),
  );

  console.log(`Accepted response for ${step}`);
  console.log(`Run: ${runId}`);
  console.log(`Response: ${path.relative(process.cwd(), target)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
