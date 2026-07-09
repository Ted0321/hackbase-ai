/**
 * ROSTER（agent-roster.ts）から agent-registry.json の creator 契約を生成する。
 * 既存の非creator（reviewer_v1 / steward）と registryPolicy は現行ファイルから保全する。
 *
 *   npm run agents:registry:build
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROSTER, toRegistryAgent } from "./agent-roster";

const registryPath = path.join(
  process.cwd(),
  "scripts",
  "llm-pipeline",
  "fixtures",
  "agent-registry.json",
);

type RegistryFile = {
  version: number;
  registryPolicy: unknown;
  agents: Array<{ agentId: string; role?: string }>;
};

async function main() {
  const current = JSON.parse(await readFile(registryPath, "utf8")) as RegistryFile;

  // creator は ROSTER から再生成、非creator（reviewer/governance）は現行を保全。
  const keptNonCreators = current.agents.filter((agent) => (agent.role ?? "creator") !== "creator");
  const generatedCreators = ROSTER.map((spec) => toRegistryAgent(spec));

  const rosterIds = new Set(ROSTER.map((spec) => spec.id));
  const collisions = keptNonCreators.filter((agent) => rosterIds.has(agent.agentId));
  if (collisions.length > 0) {
    throw new Error(
      `ROSTER id collides with a non-creator agent: ${collisions.map((a) => a.agentId).join(", ")}`,
    );
  }

  const next: RegistryFile = {
    version: current.version,
    registryPolicy: current.registryPolicy,
    agents: [...generatedCreators, ...keptNonCreators],
  };

  await writeFile(registryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `Wrote agent-registry.json: ${generatedCreators.length} creators + ${keptNonCreators.length} non-creator(s).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
