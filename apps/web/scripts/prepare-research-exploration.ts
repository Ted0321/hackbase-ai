import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

  return {
    input: values.get("input") ?? "data/research-collector-input.json",
    outputDir: values.get("output-dir") ?? "data/research-exploration",
    sourceCategory: values.get("source-category") ?? "general",
    brief:
      values.get("brief") ??
      "Explore beyond the fixed baseline collector. Find additional timely research signals that could diversify Hackbase.ai beyond technical productivity tools.",
  };
};

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;

const promptFileForCategory = (sourceCategory: string) => {
  const promptByCategory: Record<string, string> = {
    general: "research-explorer.md",
    hackathon: "research-source-hackathon.md",
    github: "research-source-github.md",
    gallery: "research-source-gallery.md",
  };

  const promptFile = promptByCategory[sourceCategory];
  if (!promptFile) {
    throw new Error("--source-category must be one of: general, hackathon, github, gallery");
  }
  return promptFile;
};

const defaultBriefForCategory = (sourceCategory: string, fallback: string) => {
  const briefByCategory: Record<string, string> = {
    general: fallback,
    hackathon:
      "Collect recent hackathon winners, finalists, and demos worldwide. Focus on small projects with sharp value mechanisms, not established products.",
    github:
      "Collect recently rising GitHub projects with product-like demos or workflows. Focus on small-to-mid-size projects, not mega products.",
    gallery:
      "Collect small rising products from product galleries and maker launch surfaces. Focus on visible demos, early traction, and transferable value mechanisms.",
  };

  return briefByCategory[sourceCategory] ?? fallback;
};

async function main() {
  const args = parseArgs();
  const promptFile = promptFileForCategory(args.sourceCategory);
  const prompt = await readFile(path.resolve(process.cwd(), "scripts", "prompts", promptFile), "utf8");
  const baseline = await readJson(args.input);
  const now = new Date();
  const runId = `research_explore_${args.sourceCategory}_${now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  const outputDir = path.resolve(process.cwd(), args.outputDir, runId);
  const input = {
    version: 1,
    explorationRunId: runId,
    sourceCategory: args.sourceCategory,
    generatedAt: now.toISOString(),
    explorationBrief: defaultBriefForCategory(args.sourceCategory, args.brief),
    baselineCollectorInput: baseline,
    instructions: {
      returnFormat: "strict_json_only",
      doNotDecideFinalConcept: true,
      doNotWriteRequirements: true,
      noExternalPublish: true,
      noPaidApiRequired: true,
      noSecrets: true,
      focusOnSmallRisingProducts: true,
      excludeEstablishedMajorProducts: true,
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "prompt.md"), prompt.endsWith("\n") ? prompt : `${prompt}\n`);
  await writeFile(path.join(outputDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`);
  await writeFile(
    path.join(outputDir, "handoff.md"),
    [
      `# Research Exploration Handoff: ${runId}`,
      "",
      "1. Open `prompt.md`.",
      "2. Provide `input.json` as the structured input.",
      "3. Save the LLM output as `response.json` in this directory.",
      "4. Run `npm run research:collect` to merge baseline and exploration material.",
      "",
      "The output must remain research-only. Do not ask the LLM to choose a final product concept.",
      "",
    ].join("\n"),
  );

  console.log(`Prepared research exploration drive: ${path.relative(process.cwd(), outputDir)}`);
  console.log(`Source category: ${args.sourceCategory}`);
  console.log(`Prompt template: scripts/prompts/${promptFile}`);
  console.log(`Prompt: ${path.relative(process.cwd(), path.join(outputDir, "prompt.md"))}`);
  console.log(`Input: ${path.relative(process.cwd(), path.join(outputDir, "input.json"))}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
