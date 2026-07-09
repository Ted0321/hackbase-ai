import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";

type SignalInput = {
  id: string;
  sourceType: string;
  sourceName: string;
  title: string;
  summary: string;
  url: string | null;
  observedAt: string;
  topics: string[];
  audience: string[];
  metrics?: Record<string, number>;
  whyItMatters: string;
  prototypeHint: string;
  riskNotes: string;
  rawExcerpt?: string;
};

type SignalFile = {
  version: string;
  signals: SignalInput[];
};

type SignalAnalysis = {
  signalId: string;
  coreChange: string;
  userPain: string;
  prototypeOpportunity: string;
  riskNotes: string;
  scores: {
    freshness: number;
    momentum: number;
    pain: number;
    prototypeability: number;
    branchability: number;
    riskLow: number;
    fitToProdia: number;
  };
};

type ThemeCandidatePlan = {
  title: string;
  sourceSignalIds: string[];
  problemStatement: string;
  prototypeQuestion: string;
  expectedUsers: string[];
  expectedCategories: string[];
  whyNow: string;
  riskNotes: string;
  evaluationScores: {
    prototypeability: number;
    novelty: number;
    riskLow: number;
    fitToProdia: number;
    branchability: number;
    clarity: number;
  };
  selectionArgument: string;
  rejectionRisk: string;
};

type ProjectBrief = {
  agentCode: string;
  agentId: string;
  agentName: string;
  title: string;
  oneLiner: string;
  concept: string;
  targetUser: string;
  userMoment: string;
  artifactKind: string;
  templatePatternId: string;
  templatePatternReason: string;
  coreInteraction: string;
  sections: string[];
  dataInputs: string[];
  validationFocus: string[];
  riskNotes: string;
  successCriteria: string[];
};

type AgentSelectionMode = "ordered" | "random" | "rotation";

const isAgentSelectionMode = (value: string): value is AgentSelectionMode =>
  value === "ordered" || value === "random" || value === "rotation";

const templatePatternRotation = [
  "source_to_mission",
  "evidence_decision_board",
  "signal_map",
  "transformation_studio",
  "boundary_simulator",
  "guided_explainer_path",
  "remix_roulette",
  "ops_steward_console",
] as const;

const artifactKindByPattern: Record<(typeof templatePatternRotation)[number], string> = {
  source_to_mission: "map",
  evidence_decision_board: "board",
  signal_map: "map",
  transformation_studio: "explainer",
  boundary_simulator: "board",
  guided_explainer_path: "explainer",
  remix_roulette: "roulette",
  ops_steward_console: "board",
};

const prisma = createPrismaClient();

const systemActor = {
  actorType: "system",
  actorId: "signal_planner",
  actorName: "Signal Planner",
};

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item.startsWith("--")) {
      values.set(item.slice(2), raw[index + 1] ?? "");
      index += 1;
    }
  }

  const agentSelection = values.get("agent-selection") ?? "rotation";

  return {
    input: values.get("input") ?? "data/mock-signals.json",
    projectCount: Math.max(1, Math.min(4, Number.parseInt(values.get("project-count") ?? "4", 10) || 4)),
    agentSelection: isAgentSelectionMode(agentSelection) ? agentSelection : "rotation",
  };
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 52);

const clamp = (value: number) => Math.max(1, Math.min(5, value));

const readMostRecentTemplatePatternId = async () => {
  const recentProjects = await prisma.project.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 12,
  });

  for (const project of recentProjects) {
    if (!project.artifactRoot) continue;

    try {
      const raw = await readFile(
        path.join(process.cwd(), "artifacts", project.artifactRoot, "metadata.json"),
        "utf8",
      );
      const metadata = JSON.parse(raw) as { templatePatternId?: string };

      if (metadata.templatePatternId && (templatePatternRotation as readonly string[]).includes(metadata.templatePatternId)) {
        return metadata.templatePatternId;
      }
    } catch {
      continue;
    }
  }

  return null;
};

const chooseTemplatePatterns = (count: number, recentPatternId: string | null) => {
  const recentIndex = recentPatternId
    ? templatePatternRotation.findIndex((patternId) => patternId === recentPatternId)
    : -1;
  const startIndex = recentIndex >= 0 ? (recentIndex + 1) % templatePatternRotation.length : 0;

  return Array.from({ length: count }, (_, index) => {
    const patternId =
      templatePatternRotation[(startIndex + index) % templatePatternRotation.length];

    return {
      templatePatternId: patternId,
      artifactKind: artifactKindByPattern[patternId],
      templatePatternReason:
        recentPatternId && index === 0
          ? `直近生成物の ${recentPatternId} を避け、${patternId} からローテーションしています。`
          : `${patternId} を使い、同じテーマから違う体験形式のMVPに分岐します。`,
    };
  });
};

const readMostRecentAgentId = async () => {
  const recentProject = await prisma.project.findFirst({
    orderBy: {
      createdAt: "desc",
    },
    select: {
      agentId: true,
    },
  });

  return recentProject?.agentId ?? null;
};

const shuffledAgents = <T>(items: T[]) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

const selectAgents = async <T extends { id: string }>(
  agents: T[],
  projectCount: number,
  mode: AgentSelectionMode,
) => {
  const count = Math.min(projectCount, agents.length);
  if (count <= 0) return [];

  if (mode === "ordered") {
    return agents.slice(0, count);
  }

  if (mode === "random") {
    return shuffledAgents(agents).slice(0, count);
  }

  const recentAgentId = await readMostRecentAgentId();
  const recentIndex = recentAgentId
    ? agents.findIndex((agent) => agent.id === recentAgentId)
    : -1;
  const startIndex = recentIndex >= 0 ? (recentIndex + 1) % agents.length : 0;

  return Array.from({ length: count }, (_, index) => agents[(startIndex + index) % agents.length]);
};

const metricValue = (signal: SignalInput, keys: string[]) =>
  keys.reduce((sum, key) => sum + (signal.metrics?.[key] ?? 0), 0);

const analyzeSignal = (signal: SignalInput, now: Date): SignalAnalysis => {
  const observedAt = new Date(signal.observedAt);
  const ageHours = Math.max(1, (now.getTime() - observedAt.getTime()) / 1000 / 60 / 60);
  const momentumMetric = metricValue(signal, [
    "starDelta7d",
    "comments",
    "repeatedQuestions",
    "workflowHelpers",
    "wantToGrow",
  ]);
  const hasAgentTopic = signal.topics.some((topic) =>
    ["agent", "workflow", "tool-use", "eval", "planning", "validation"].includes(topic),
  );
  const hasPrototypeHint = signal.prototypeHint.length > 24;
  const hasRiskWarning = /secret|api key|login|payment|external/i.test(signal.riskNotes);

  return {
    signalId: signal.id,
    coreChange: signal.summary,
    userPain: signal.whyItMatters,
    prototypeOpportunity: signal.prototypeHint,
    riskNotes: signal.riskNotes,
    scores: {
      freshness: clamp(ageHours < 36 ? 5 : ageHours < 96 ? 4 : 3),
      momentum: clamp(Math.ceil(momentumMetric / 25)),
      pain: clamp(signal.whyItMatters.length > 80 ? 5 : 4),
      prototypeability: clamp(hasPrototypeHint ? 5 : 3),
      branchability: clamp(hasAgentTopic ? 5 : 4),
      riskLow: clamp(hasRiskWarning ? 4 : 5),
      fitToProdia: clamp(hasAgentTopic || signal.sourceType === "internal_feedback" ? 5 : 4),
    },
  };
};

const totalScore = (analysis: SignalAnalysis) =>
  Object.values(analysis.scores).reduce((sum, value) => sum + value, 0);

const makeThemeCandidates = (
  signals: SignalInput[],
  analyses: SignalAnalysis[],
): ThemeCandidatePlan[] => {
  const ranked = [...analyses].sort((a, b) => totalScore(b) - totalScore(a));
  const topSignals = ranked
    .slice(0, 3)
    .map((analysis) => signals.find((signal) => signal.id === analysis.signalId))
    .filter((signal): signal is SignalInput => Boolean(signal));
  const topSignal = topSignals[0] ?? signals[0];
  const supportingSignals = topSignals.slice(1).map((signal) => signal.id);
  const sharedTopics = [...new Set(topSignals.flatMap((signal) => signal.topics))].slice(0, 6);

  return [
    {
      title: "Agent run observability workbench",
      sourceSignalIds: [topSignal.id, ...supportingSignals],
      problemStatement:
        "Agent builders and operators need to see how signals become themes, how agents interpret them, and where validation or feedback changes the next run.",
      prototypeQuestion:
        "Can a small web artifact make the input-to-idea-to-run path inspectable at a glance?",
      expectedUsers: ["operator", "agent-builder", "human-curator"],
      expectedCategories: ["cat_automation", "cat_research"],
      whyNow: `${topSignal.title}. Related topics: ${sharedTopics.join(", ")}.`,
      riskNotes:
        "Use mock/local data only. Do not require external accounts, paid APIs, secrets, or repository cloning.",
      evaluationScores: {
        prototypeability: 5,
        novelty: 4,
        riskLow: 5,
        fitToProdia: 5,
        branchability: 5,
        clarity: 5,
      },
      selectionArgument:
        "This directly strengthens Hackbase.ai's core loop: signals become themes, themes become agent-specific artifacts, and humans observe the process.",
      rejectionRisk: "Could become too operational if the artifact forgets to show a concrete user-facing product angle.",
    },
    {
      title: "Narrow workflow helper picker",
      sourceSignalIds: signals
        .filter((signal) => signal.sourceType === "hackathon_case" || signal.topics.includes("workflow"))
        .map((signal) => signal.id)
        .slice(0, 3),
      problemStatement:
        "Broad AI product ideas often fail because they are too large; makers need help shrinking them into one-screen workflow helpers.",
      prototypeQuestion:
        "Can a picker turn broad AI ideas into narrow web artifacts that are buildable in one run?",
      expectedUsers: ["maker", "student", "operator"],
      expectedCategories: ["cat_ideation", "cat_learning"],
      whyNow: "Hackathon-style prototypes show that narrow workflow helpers are easier to understand and ship.",
      riskNotes: "Avoid copying specific hackathon brands or claiming external results as fact.",
      evaluationScores: {
        prototypeability: 5,
        novelty: 3,
        riskLow: 5,
        fitToProdia: 4,
        branchability: 4,
        clarity: 4,
      },
      selectionArgument:
        "Useful for keeping Hackbase.ai artifacts small, but less directly tied to run observability.",
      rejectionRisk: "May produce generic idea-generation UI rather than a Hackbase.ai-specific artifact.",
    },
    {
      title: "Agent quality scorecard",
      sourceSignalIds: signals
        .filter((signal) => signal.topics.includes("eval") || signal.topics.includes("feedback"))
        .map((signal) => signal.id)
        .slice(0, 3),
      problemStatement:
        "Teams need practical ways to compare agent quality without pretending they have a formal benchmark.",
      prototypeQuestion:
        "Can a small scorecard compare pass rate, duplicate warnings, and human reactions for each agent?",
      expectedUsers: ["operator", "team-lead", "agent-builder"],
      expectedCategories: ["cat_research", "cat_decision"],
      whyNow: "Community feedback shows that people care about whether agents are improving, not just whether they post more.",
      riskNotes: "Do not present the scorecard as a rigorous benchmark.",
      evaluationScores: {
        prototypeability: 4,
        novelty: 4,
        riskLow: 5,
        fitToProdia: 5,
        branchability: 3,
        clarity: 5,
      },
      selectionArgument:
        "Strong follow-up for Observatory, but it is closer to analytics than theme-to-artifact planning.",
      rejectionRisk: "Could overlap with existing Observatory analytics.",
    },
  ];
};

const scoreCandidate = (candidate: ThemeCandidatePlan) =>
  Object.values(candidate.evaluationScores).reduce((sum, value) => sum + value, 0);

const makeProjectBriefs = async (
  selected: ThemeCandidatePlan,
  signals: SignalInput[],
  projectCount: number,
  agentSelection: AgentSelectionMode,
): Promise<ProjectBrief[]> => {
  const agents = await prisma.agent.findMany({
    where: {
      active: true,
    },
    orderBy: {
      code: "asc",
    },
  });
  const selectedSignals = signals.filter((signal) => selected.sourceSignalIds.includes(signal.id));
  const dataInputs = selectedSignals.map((signal) => `${signal.sourceType}: ${signal.title}`);
  const fallbackAgents = [
    { id: "agent_a", code: "AI-A", name: "Triage" },
    { id: "agent_b", code: "AI-B", name: "Shuffle" },
    { id: "agent_c", code: "AI-C", name: "Explainer" },
    { id: "agent_d", code: "AI-D", name: "Cartographer" },
  ];
  const sourceAgents = agents.length > 0 ? agents : fallbackAgents;
  const selectedAgents = await selectAgents(sourceAgents, projectCount, agentSelection);
  const patternAssignments = chooseTemplatePatterns(
    Math.min(projectCount, selectedAgents.length),
    await readMostRecentTemplatePatternId(),
  );

  return selectedAgents.map((agent, index) => {
    const code = agent.code;
    const patternAssignment = patternAssignments[index] ?? patternAssignments[0];
    const base = {
      agentCode: code,
      agentId: agent.id,
      agentName: agent.name,
      artifactKind: patternAssignment.artifactKind,
      templatePatternId: patternAssignment.templatePatternId,
      templatePatternReason: patternAssignment.templatePatternReason,
      dataInputs,
      validationFocus: [
        "metadata_complete",
        "artifact_exists",
        "duplicate_like",
        "prompt_injection_like",
        "external_dependency_like",
      ],
      riskNotes: selected.riskNotes,
    };

    if (code === "AI-B") {
      return {
        ...base,
        title: "Signal Roulette",
        oneLiner: "A playful card draw that turns raw signals into surprising artifact angles.",
        concept:
          "Let a human curator shuffle through signal-to-product interpretations without manually brainstorming every angle.",
        targetUser: "human curator",
        userMoment: "When the feed feels too operational and needs a more surprising product direction.",
        coreInteraction: "Draw a signal card, reveal an agent angle, keep or skip the idea.",
        sections: ["Signal deck", "Agent angle", "Keep / skip notes", "Next-run hint"],
        successCriteria: [
          "A visitor can understand the selected signal in one card.",
          "The UI creates at least three distinct artifact angles.",
          "No external data fetch is required.",
        ],
      };
    }

    if (code === "AI-C") {
      return {
        ...base,
        title: "Why This Signal Matters",
        oneLiner: "A short explainer that translates technical signals into buildable product questions.",
        concept:
          "Help non-expert observers understand why an AI/OSS signal is worth turning into a small artifact.",
        targetUser: "operator or first-time visitor",
        userMoment: "When someone asks why this run selected this theme.",
        coreInteraction: "Switch between what changed, who cares, and what to build next.",
        sections: ["What changed", "Who is affected", "Prototype question", "Risk notes"],
        successCriteria: [
          "The signal can be understood without reading the source.",
          "The prototype question is visible above the fold.",
          "Risk notes are explicit and short.",
        ],
      };
    }

    if (code === "AI-D") {
      return {
        ...base,
        title: "Input-to-Idea Map",
        oneLiner: "A visual map showing how signals become candidates, a selected theme, and agent briefs.",
        concept:
          "Make Hackbase.ai's planning process observable so humans can see the path from source material to AI-generated artifacts.",
        targetUser: "owner or operator",
        userMoment: "When reviewing whether the AI's theme selection made sense.",
        coreInteraction: "Click a node in the planning path to inspect evidence and decision notes.",
        sections: ["Signals", "Theme candidates", "Selected theme", "Agent briefs"],
        successCriteria: [
          "The full planning chain is visible in one screen.",
          "Each node shows its actor and decision reason.",
          "The map distinguishes input evidence from generated interpretation.",
        ],
      };
    }

    return {
      ...base,
      title: "Signal Triage Board",
      oneLiner: "A board that ranks which signals should become today's Hackbase.ai theme.",
      concept:
        "Give the operator a clear triage view: act now, watch, or ignore, based on prototypeability and risk.",
      targetUser: "operator",
      userMoment: "Before a daily run, when deciding whether the AI's selected theme is sensible.",
      coreInteraction: "Move signals across lanes and inspect why each score was assigned.",
      sections: ["Act now", "Watch", "Ignore", "Scoring notes"],
      successCriteria: [
        "The highest-scoring signal is easy to identify.",
        "The board explains why low-risk and buildable signals are preferred.",
        "Human feedback can be attached as a next-run note.",
      ],
    };
  });
};

async function main() {
  const args = parseArgs();
  const inputPath = path.resolve(process.cwd(), args.input);
  const raw = await readFile(inputPath, "utf8");
  const file = JSON.parse(raw) as SignalFile;
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const runId = `run_signal_plan_${stamp}`;
  const runRoot = `runs/${runId}/planning`;
  const artifactDir = path.join(process.cwd(), "artifacts", runRoot);

  if (!Array.isArray(file.signals) || file.signals.length === 0) {
    throw new Error("mock signal file must include at least one signal");
  }

  const analyses = file.signals.map((signal) => analyzeSignal(signal, now));
  const candidates = makeThemeCandidates(file.signals, analyses);
  const selectedCandidate = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0];
  const themeId = `theme_signal_plan_${stamp}_${slugify(selectedCandidate.title)}`;
  const selectedCandidateId = `cand_signal_plan_${stamp}_${slugify(selectedCandidate.title)}`;
  const projectBriefs = await makeProjectBriefs(
    selectedCandidate,
    file.signals,
    args.projectCount,
    args.agentSelection,
  );
  const briefArtifact = {
    version: file.version,
    generatedAt: now.toISOString(),
    runId,
    signalAnalyses: analyses,
    themeCandidates: candidates,
    selectedTheme: {
      id: themeId,
      title: selectedCandidate.title,
      sourceSignalIds: selectedCandidate.sourceSignalIds,
      problemStatement: selectedCandidate.problemStatement,
      prototypeQuestion: selectedCandidate.prototypeQuestion,
      selectionReason: selectedCandidate.selectionArgument,
      riskNotes: selectedCandidate.riskNotes,
      aiBranchingHints: Object.fromEntries(
        projectBriefs.map((brief) => [brief.agentCode, `${brief.artifactKind}: ${brief.title}`]),
      ),
    },
    projectBriefs,
  };
  const briefJson = JSON.stringify(briefArtifact, null, 2);

  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "project-briefs.json"), briefJson);

  await prisma.run.create({
    data: {
      id: runId,
      status: "completed",
      triggerType: "manual",
      ...systemActor,
      autonomyLevel: "manual_seed",
      approvalRequired: false,
      startedAt: now,
      completedAt: now,
      selectedThemeId: themeId,
      generatedProjectCount: 0,
      publishedProjectCount: 0,
      failedProjectCount: 0,
      summary: `Signal planning run selected: ${selectedCandidate.title}`,
    },
  });

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "run_created",
      ...systemActor,
      summary: "Signal planning run created from mock signals.",
      metadataJson: JSON.stringify({
        input: args.input,
        signalCount: file.signals.length,
      }),
    },
  });

  for (const signal of file.signals) {
    await prisma.signal.create({
      data: {
        id: `${runId}_${signal.id}`,
        runId,
        sourceType: signal.sourceType,
        title: signal.title,
        body: JSON.stringify({
          originalId: signal.id,
          sourceName: signal.sourceName,
          summary: signal.summary,
          topics: signal.topics,
          audience: signal.audience,
          metrics: signal.metrics ?? {},
          whyItMatters: signal.whyItMatters,
          prototypeHint: signal.prototypeHint,
          riskNotes: signal.riskNotes,
          rawExcerpt: signal.rawExcerpt ?? null,
        }),
        url: signal.url,
        collectedAt: new Date(signal.observedAt),
      },
    });
  }

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "signals_ingested",
      ...systemActor,
      summary: `${file.signals.length} normalized signals were ingested.`,
      metadataJson: JSON.stringify({
        sourceTypes: [...new Set(file.signals.map((signal) => signal.sourceType))],
      }),
    },
  });

  for (const [index, candidate] of candidates.entries()) {
    const candidateId =
      candidate.title === selectedCandidate.title
        ? selectedCandidateId
        : `cand_signal_plan_${stamp}_${index}_${slugify(candidate.title)}`;

    await prisma.themeCandidate.create({
      data: {
        id: candidateId,
        runId,
        title: candidate.title,
        problemStatement: candidate.problemStatement,
        prototypeQuestion: candidate.prototypeQuestion,
        expectedUsers: JSON.stringify(candidate.expectedUsers),
        expectedCategories: JSON.stringify(candidate.expectedCategories),
        whyNow: candidate.whyNow,
        riskNotes: candidate.riskNotes,
        evaluationScores: JSON.stringify(candidate.evaluationScores),
        selected: candidate.title === selectedCandidate.title,
        rejectionReason:
          candidate.title === selectedCandidate.title ? null : candidate.rejectionRisk,
      },
    });
  }

  await prisma.theme.create({
    data: {
      id: themeId,
      runId,
      candidateId: selectedCandidateId,
      title: selectedCandidate.title,
      sourceSignals: JSON.stringify(selectedCandidate.sourceSignalIds),
      problemStatement: selectedCandidate.problemStatement,
      prototypeQuestion: selectedCandidate.prototypeQuestion,
      selectionReason: selectedCandidate.selectionArgument,
      riskNotes: selectedCandidate.riskNotes,
      aiBranchingHints: JSON.stringify(briefArtifact.selectedTheme.aiBranchingHints),
      status: "selected",
      selectedAt: now,
    },
  });

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "theme_selected",
      ...systemActor,
      summary: `Selected planning theme: ${selectedCandidate.title}.`,
      metadataJson: JSON.stringify({
        themeId,
        candidateId: selectedCandidateId,
        sourceSignalIds: selectedCandidate.sourceSignalIds,
      }),
    },
  });

  await prisma.artifact.create({
    data: {
      id: randomUUID(),
      runId,
      type: "project_briefs",
      path: `${runRoot}/project-briefs.json`,
      mimeType: "application/json",
      sizeBytes: Buffer.byteLength(briefJson),
      checksum: checksum(briefJson),
    },
  });

  await prisma.runEvent.create({
    data: {
      id: randomUUID(),
      runId,
      type: "project_briefs_generated",
      ...systemActor,
      summary: `${projectBriefs.length} agent-specific project briefs were generated.`,
      metadataJson: JSON.stringify({
        artifactPath: `${runRoot}/project-briefs.json`,
        agentSelection: args.agentSelection,
        agentCodes: projectBriefs.map((brief) => brief.agentCode),
      }),
    },
  });

  console.log(`Created planning run ${runId}`);
  console.log(`Signals: ${file.signals.length}`);
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Selected theme: ${selectedCandidate.title}`);
  console.log(`Project briefs: ${projectBriefs.length}`);
  console.log(`Agent selection: ${args.agentSelection}`);
  console.log(`Agents: ${projectBriefs.map((brief) => brief.agentCode).join(", ")}`);
  console.log(`Artifact: artifacts/${runRoot}/project-briefs.json`);
  console.log(`Open: http://localhost:3000/runs/${runId}`);
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
