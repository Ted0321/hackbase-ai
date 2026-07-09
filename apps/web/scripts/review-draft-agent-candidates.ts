import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAgentRegistry } from "./agent-registry";

type DraftCandidate = {
  agentId?: string;
  displayName?: string;
  status?: string;
  role?: string;
  oneLiner?: string;
  identity?: {
    principle?: string;
    worldview?: string;
    voice?: string;
  };
  specialties?: string[];
  boundaries?: string[];
  activationReview?: string[];
};

type DraftCandidateFile = {
  draftCandidates?: DraftCandidate[];
};

const readDraftCandidates = async () => {
  const filePath = path.join(process.cwd(), "data", "agents", "draft-agent-candidates.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as DraftCandidateFile;
};

const missingFields = (candidate: DraftCandidate) => {
  const missing: string[] = [];

  if (!candidate.agentId) missing.push("agentId");
  if (!candidate.displayName) missing.push("displayName");
  if (candidate.status !== "draft") missing.push("status=draft");
  if (candidate.role !== "creator") missing.push("role=creator");
  if (!candidate.oneLiner) missing.push("oneLiner");
  if (!candidate.identity?.principle) missing.push("identity.principle");
  if (!candidate.identity?.worldview) missing.push("identity.worldview");
  if (!candidate.identity?.voice) missing.push("identity.voice");
  if (!candidate.specialties?.length) missing.push("specialties");
  if (!candidate.boundaries?.length) missing.push("boundaries");
  if (!candidate.activationReview?.length) missing.push("activationReview");

  return missing;
};

async function main() {
  const [registry, draftFile] = await Promise.all([readAgentRegistry(), readDraftCandidates()]);
  const existingIds = new Set(registry.agents.map((agent) => agent.agentId));
  const existingNames = new Set(registry.agents.map((agent) => agent.displayName.toLowerCase()));
  const existingSpecialties = new Set(registry.agents.flatMap((agent) => agent.specialties ?? []));

  const reviews = (draftFile.draftCandidates ?? []).map((candidate) => {
    const missing = missingFields(candidate);
    const duplicateId = candidate.agentId ? existingIds.has(candidate.agentId) : false;
    const duplicateName = candidate.displayName
      ? existingNames.has(candidate.displayName.toLowerCase())
      : false;
    const overlap = (candidate.specialties ?? []).filter((item) => existingSpecialties.has(item));
    const overlapRatio =
      candidate.specialties && candidate.specialties.length > 0
        ? overlap.length / candidate.specialties.length
        : 1;
    const blockers = [
      ...missing.map((field) => `missing:${field}`),
      ...(duplicateId ? ["duplicate:agentId"] : []),
      ...(duplicateName ? ["duplicate:displayName"] : []),
    ];
    const warnings = [
      ...(overlapRatio >= 0.67 ? [`specialty_overlap:${overlap.join(",")}`] : []),
      ...(candidate.boundaries && candidate.boundaries.length < 2 ? ["thin_boundaries"] : []),
    ];

    return {
      agentId: candidate.agentId ?? "unknown",
      displayName: candidate.displayName ?? "unknown",
      decision: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "needs_revision" : "ready_for_human_review",
      blockers,
      warnings,
      reviewChecklist: [
        "役割が既存Agentと重複しすぎていない",
        "作品生成の品質または多様性に具体的に貢献する",
        "boundariesが人間に読める粒度で明確",
        "routerで選ばれすぎる偏りを生まない",
        "active化前にagent-registry.jsonへ手動反映し、agents:registry:checkを通す",
      ],
    };
  });

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "draft-agent-candidates.json",
    rule: "This review is advisory. Draft agents must not be activated automatically.",
    reviews,
  };
  const outPath = path.join(process.cwd(), "data", "agents", "draft-agent-review.json");

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Draft agent review written: ${path.relative(process.cwd(), outPath)}`);
  console.log(`Reviews: ${reviews.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
