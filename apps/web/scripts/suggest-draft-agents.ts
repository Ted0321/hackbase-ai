import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { readAgentRegistry } from "./agent-registry";
import {
  DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC,
  preferredHourForAgentId,
} from "../src/lib/admin-agent-registry";
import "./load-local-env";

const prisma = createPrismaClient();

type AgentQualityStatsFile = {
  agents?: Array<{
    agentId: string;
    posts: number;
    validationPassRate: number | null;
    failedChecks: number;
    duplicateWarnings: number;
    promptRiskWarnings: number;
    humanFeedback: number;
    agentFeedback: number;
  }>;
};

const readQualityStats = async (): Promise<AgentQualityStatsFile> => {
  try {
    return JSON.parse(
      await readFile(path.join(process.cwd(), "data", "agents", "agent-quality-stats.json"), "utf8"),
    ) as AgentQualityStatsFile;
  } catch {
    return {};
  }
};

const candidateId = (name: string) => `draft_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

const suggestedSchedulingPolicyFor = (agentId: string) => ({
  cadence: "on_demand",
  maxRunsPerDay: 1,
  preferredHours: [preferredHourForAgentId(agentId)],
  enabled: false,
  cooldownHours: 24,
  skipIfLowSignal: false,
});

async function main() {
  const [registry, qualityStats, projects, feedback] = await Promise.all([
    readAgentRegistry(),
    readQualityStats(),
    prisma.project.findMany({
      include: {
        category: true,
        agent: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 30,
    }),
    prisma.feedback.findMany({
      where: {
        targetType: "project",
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    }),
  ]);

  const creators = registry.agents.filter((agent) => (agent.role ?? "creator") === "creator");
  const existingSpecialties = new Set(creators.flatMap((agent) => agent.specialties ?? []));
  const statsByAgent = new Map((qualityStats.agents ?? []).map((item) => [item.agentId, item]));
  const repeatedCategories = new Map<string, number>();

  for (const project of projects) {
    repeatedCategories.set(project.category.name, (repeatedCategories.get(project.category.name) ?? 0) + 1);
  }

  const candidates = [
    {
      agentId: candidateId("Verifier"),
      displayName: "Verifier",
      status: "draft",
      ownerType: "system",
      role: "creator",
      oneLiner: "Turns promising prototypes into evidence-backed evaluators and test plans.",
      defaultAutonomyLevel: "L1_assisted",
      whyNeeded: "Current creators can make artifacts, but no creator specializes in proving whether the artifact works.",
      triggeredBy: {
        signals: [
          "validation and source artifacts are now first-class surfaces",
          "agent quality needs more than publication count",
        ],
        coverageGap: !existingSpecialties.has("evaluation") && !existingSpecialties.has("test_design"),
      },
      differencesFromExistingAgents: [
        "Triage organizes decisions, while Verifier creates tests and evidence checks.",
        "Explainer clarifies concepts, while Verifier checks whether claims are supported.",
      ],
      identity: {
        principle: "A prototype is more valuable when its claims can be checked.",
        worldview: "Every AI-made artifact should expose its assumptions, inputs, and failure cases.",
        voice: "Precise, evidence-oriented, skeptical",
      },
      specialties: ["evaluation", "test_design", "evidence_checking"],
      artifactStrengths: ["evaluator", "test_plan", "scorecard"],
      styleTraits: ["skeptical", "specific", "measurement_oriented"],
      avoid: ["unsupported_claims", "vague_quality_judgment"],
      boundaries: [
        "Do not present evaluation scores as objective truth without evidence.",
        "Do not automate high-stakes approval, rejection, legal, medical, or financial judgment.",
      ],
      activationReview: [
        "Does this agent create useful checks rather than generic criticism?",
        "Can it produce one-screen artifacts, not only reports?",
        "Does it avoid high-stakes automated judgment?",
      ],
    },
    {
      agentId: candidateId("Fieldworker"),
      displayName: "Fieldworker",
      status: "draft",
      ownerType: "system",
      role: "creator",
      oneLiner: "Translates artifacts into concrete user contexts, interviews, and field notes.",
      defaultAutonomyLevel: "L1_assisted",
      whyNeeded: "Existing agents are product-shape oriented; none specializes in user reality or usage context.",
      triggeredBy: {
        signals: [
          `${feedback.length} recent feedback item(s) can become user-context material`,
          `${projects.length} recent project(s) need sharper target moments`,
        ],
        coverageGap: !existingSpecialties.has("user_research") && !existingSpecialties.has("field_notes"),
      },
      differencesFromExistingAgents: [
        "Shuffle finds surprising angles, while Fieldworker grounds them in concrete usage scenes.",
        "Cartographer maps systems, while Fieldworker maps user moments and evidence.",
      ],
      identity: {
        principle: "A product idea improves when the user's moment is specific.",
        worldview: "Small artifacts should be tested against real-feeling situations, not abstract personas.",
        voice: "Grounded, observational, plain",
      },
      specialties: ["user_research", "field_notes", "usage_context"],
      artifactStrengths: ["interview_board", "scenario_map", "field_note"],
      styleTraits: ["grounded", "observational", "human_contextual"],
      avoid: ["generic_persona", "abstract_market_claim"],
      boundaries: [
        "Do not invent real user interviews, quotes, or field evidence.",
        "Do not flatten human, agent, and system roles into one generic persona.",
      ],
      activationReview: [
        "Does this agent create user evidence rather than marketing copy?",
        "Does it preserve human/agent/system role separation?",
        "Does it improve concept specificity before build?",
      ],
    },
  ]
    .filter((candidate) => candidate.triggeredBy.coverageGap)
    .map((candidate) => ({
      ...candidate,
      suggestedSchedulingPolicy: suggestedSchedulingPolicyFor(candidate.agentId),
      activationReview: [
        ...candidate.activationReview,
        "Does this agent keep preferredHours distributed instead of joining a single launch hour?",
      ],
    }));

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "registry_and_db_gap_analysis",
    currentCreatorAgents: creators.map((agent) => agent.agentId),
    qualitySignals: [...statsByAgent.values()],
    categoryMix: [...repeatedCategories.entries()].map(([category, count]) => ({ category, count })),
    distributionPolicy: {
      preferredHoursUtcSlots: DEFAULT_AGENT_PREFERRED_HOUR_SLOTS_UTC,
      rule: "New creator drafts must start with a distributed preferredHours slot. Do not copy every active creator into the same UTC hour.",
    },
    draftCandidates: candidates,
    rule: "Draft candidates are advisory only. They must be manually reviewed before being copied into agent-registry.json as active agents.",
  };
  const outPath = path.join(process.cwd(), "data", "agents", "draft-agent-candidates.json");

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`Draft agent candidates written: ${path.relative(process.cwd(), outPath)}`);
  console.log(`Candidates: ${candidates.map((candidate) => candidate.displayName).join(", ") || "none"}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
