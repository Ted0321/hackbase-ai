import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    values.set(item.slice(2), raw[index + 1] ?? "");
    index += 1;
  }

  return {
    outputDir: values.get("output-dir") ?? "data/topic-research",
    brief:
      values.get("brief") ??
      "Collect today's current topics across technology, social trends, civic/SDGs, education, research, culture/sports, and consumer life. Return topic cards only.",
  };
};

async function main() {
  const args = parseArgs();
  const now = new Date();
  const runId = `topic_research_${now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  const outputDir = path.resolve(process.cwd(), args.outputDir, runId);
  const prompt = await readFile(path.resolve(process.cwd(), "scripts", "prompts", "topic-researcher.md"), "utf8");
  const input = {
    version: 1,
    topicResearchRunId: runId,
    generatedAt: now.toISOString(),
    topicResearchBrief: args.brief,
    coverageTargets: [
      "technology",
      "social_trend",
      "sdgs_civic",
      "education",
      "research",
      "culture_sports",
      "consumer_life",
    ],
    topicCardContract: {
      keepProductSourcesOut: true,
      downstreamConsumer: "Step2 combination strategist reads currentTopicRadar.topicCards.",
      requiredCombinationFields: [
        "whyHotNow",
        "targetAudience",
        "userFrictionOrDesire",
        "friction",
        "possibleInputs",
        "riskBoundary",
        "bestFitSourceMechanisms",
      ],
      bestFitSourceMechanisms: [
        "messy_information_to_action_cards",
        "evidence_weighted_decision",
        "comparison_or_ranking",
        "constraint_checklist",
        "personalized_plan",
        "public_data_explainer",
        "draft_preflight",
        "simulation_or_what_if",
        "map_or_timeline",
        "other",
      ],
    },
    instructions: {
      returnFormat: "strict_json_only",
      doNotCollectProductSources: true,
      doNotDecideFinalConcept: true,
      doNotWriteRequirements: true,
      noExternalPublish: true,
      noPaidApiRequired: true,
      noSecrets: true,
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "prompt.md"), prompt.endsWith("\n") ? prompt : `${prompt}\n`, "utf8");
  await writeFile(path.join(outputDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(outputDir, "handoff.md"),
    [
      `# Topic Research Handoff: ${runId}`,
      "",
      "1. Open `prompt.md`.",
      "2. Provide `input.json` as structured input.",
      "3. Save the LLM output as `response.json` in this directory.",
      "4. If this is the selected daily topic radar, copy or accept it into `data/topic-research/current-topic-radar.json`.",
      "",
      "This output is topic material only. Do not ask the LLM to choose a final product concept.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Prepared topic research drive: ${path.relative(process.cwd(), outputDir)}`);
  console.log(`Prompt: ${path.relative(process.cwd(), path.join(outputDir, "prompt.md"))}`);
  console.log(`Input: ${path.relative(process.cwd(), path.join(outputDir, "input.json"))}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
