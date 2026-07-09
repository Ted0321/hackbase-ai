import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import "./load-local-env";

type SignalFile = {
  version: string;
  signals: Array<{
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
  }>;
};

type LlmPlanOutput = {
  generatedAt: string;
  model: string;
  input: string;
  dryRun: boolean;
  prompt: {
    system: string;
    user: string;
  };
  plan?: unknown;
  response?: unknown;
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) {
      continue;
    }

    const key = item.slice(2);
    const next = raw[index + 1];

    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return {
    input: values.get("input") ?? "data/mock-signals.json",
    output: values.get("output") ?? "data/llm-plan-output.json",
    model: values.get("model") ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true" || !process.env.OPENAI_API_KEY,
  };
};

const buildPrompt = (file: SignalFile) => {
  const system = [
    "You are Hackbase.ai's autonomous planning worker.",
    "Your job is not to publish posts directly. Your job is to turn observed signals into a selected theme and agent-specific project briefs.",
    "Keep human, agent, system, and validation_worker roles separate.",
    "Humans are observers, curators, and owners. Agents are creators and interpreters. The system selects, routes, and records. Validation workers check artifacts.",
    "Avoid external publishing, paid APIs, secret handling, and workspace-external writes.",
    "Prefer small web artifacts that can be generated and validated locally.",
    "Return strict JSON only.",
  ].join("\n");

  const user = JSON.stringify(
    {
      task: "Select one daily Hackbase.ai theme and create four agent-specific project briefs.",
      generationOrder: [
        "First decide what is interesting or novel about the artifact.",
        "Then design the smallest screen structure that makes that interestingness visible.",
        "Finally expand it into README-style sections without operational run details.",
      ],
      selectionPrinciples: [
        "fresh and timely",
        "clear user pain or operator question",
        "small enough for a one-screen web artifact",
        "safe without external accounts, paid APIs, secrets, or live integrations",
        "branchable so multiple AI agents can interpret the same theme differently",
        "observable so run history, validation, and publish decision remain legible",
      ],
      expectedJsonShape: {
        signalAnalyses: [
          {
            signalId: "string",
            coreChange: "string",
            userPain: "string",
            prototypeOpportunity: "string",
            riskNotes: "string",
            scores: {
              freshness: "1-5",
              momentum: "1-5",
              pain: "1-5",
              prototypeability: "1-5",
              branchability: "1-5",
              riskLow: "1-5",
              fitToProdia: "1-5",
            },
          },
        ],
        themeCandidates: [
          {
            title: "string",
            sourceSignalIds: ["string"],
            problemStatement: "string",
            prototypeQuestion: "string",
            expectedUsers: ["operator"],
            expectedCategories: ["cat_automation", "cat_operations", "cat_decision"],
            whyNow: "string",
            riskNotes: "string",
            evaluationScores: {
              prototypeability: "1-5",
              novelty: "1-5",
              riskLow: "1-5",
              fitToProdia: "1-5",
              branchability: "1-5",
              clarity: "1-5",
            },
            selectionArgument: "string",
            rejectionRisk: "string",
          },
        ],
        selectedTheme: {
          title: "string",
          sourceSignalIds: ["string"],
          problemStatement: "string",
          prototypeQuestion: "string",
          selectionReason: "string",
          riskNotes: "string",
          aiBranchingHints: {
            "AI-A": "string",
            "AI-B": "string",
            "AI-C": "string",
            "AI-D": "string",
          },
        },
        projectBriefs: [
          {
            agentCode: "AI-A",
            title: "string",
            oneLiner: "string",
            concept: "string",
            interestingness: "string: explain what is interesting or novel, not a generic use case",
            targetUser: "string",
            userMoment: "string",
            artifactKind: "board | roulette | explainer | map | scorecard",
            coreInteraction: "string: describe the smallest visible screen interaction",
            sections: ["README-style section names, not operational run metadata"],
            dataInputs: ["string"],
            validationFocus: [
              "metadata_complete",
              "artifact_exists",
              "duplicate_like",
              "prompt_injection_like",
              "external_dependency_like",
            ],
            riskNotes: "string",
            successCriteria: ["string"],
          },
        ],
      },
      signals: file.signals,
    },
    null,
    2,
  );

  return { system, user };
};

const callOpenAiResponses = async (args: ReturnType<typeof parseArgs>, prompt: LlmPlanOutput["prompt"]) => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      input: [
        {
          role: "system",
          content: prompt.system,
        },
        {
          role: "user",
          content: prompt.user,
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
};

const extractResponseText = (response: unknown): string => {
  if (typeof response === "string") {
    return response;
  }

  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;

  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }

      const text = (contentItem as Record<string, unknown>).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
};

const parsePlanJson = (response: unknown) => {
  const text = extractResponseText(response);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
};

async function main() {
  const args = parseArgs();
  const inputPath = path.resolve(process.cwd(), args.input);
  const raw = await readFile(inputPath, "utf8");
  const file = JSON.parse(raw) as SignalFile;
  const prompt = buildPrompt(file);
  const output: LlmPlanOutput = {
    generatedAt: new Date().toISOString(),
    model: args.model,
    input: args.input,
    dryRun: args.dryRun,
    prompt,
  };

  if (!args.dryRun) {
    output.response = await callOpenAiResponses(args, prompt);
    output.plan = parsePlanJson(output.response);
  }

  const outputPath = path.resolve(process.cwd(), args.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(
    args.dryRun
      ? `Wrote LLM planning dry-run prompt to ${args.output}`
      : `Wrote LLM planning response to ${args.output}`,
  );
  console.log(`Input signals: ${file.signals.length}`);
  console.log(`Model: ${args.model}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
