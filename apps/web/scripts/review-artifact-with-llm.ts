import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import "./load-local-env";

type Args = {
  artifactDir: string;
  output: string;
  model: string;
  dryRun: boolean;
};

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  const artifactDir = values.get("artifact-dir");
  if (!artifactDir) {
    throw new Error("Usage: npm run review:artifact -- --artifact-dir <path>");
  }

  return {
    artifactDir,
    output: values.get("output") ?? path.join(artifactDir, "validation", "llm-review.json"),
    model: values.get("model") ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true" || !process.env.OPENAI_API_KEY,
  };
};

const readOptional = async (filePath: string) => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const buildPrompt = async (artifactDir: string) => {
  const files = {
    contract: await readOptional(path.join(artifactDir, "llm", "contract.json")),
    readme: await readOptional(path.join(artifactDir, "README.md")),
    manifest: await readOptional(path.join(artifactDir, "manifest.json")),
    sourcePage: await readOptional(path.join(artifactDir, "source", "app", "page.tsx")),
    sourceComponent: await readOptional(
      path.join(artifactDir, "source", "components", "ProductWorkspace.tsx"),
    ),
    sourceData: await readOptional(path.join(artifactDir, "source", "data", "product.ts")),
  };

  const system = [
    "You are Hackbase.ai's validation worker.",
    "Review a generated Hackbase.ai product artifact against the teacher sample direction.",
    "The teacher sample is an AI investment meeting dashboard: AI roles behave like a small team, process and architecture are clearly separated, and the page explains what is interesting before implementation details.",
    "Return strict JSON only. Do not include Markdown.",
  ].join("\n");

  const user = JSON.stringify(
    {
      task: "Score this generated artifact and explain what must improve before it becomes a strong Hackbase.ai post.",
      scoring: {
        maxScore: 35,
        rubrics: [
          "clarity",
          "interestingness",
          "novelty",
          "process_architecture_split",
          "mockup_story",
          "code_plan_reusability",
          "safety",
        ],
      },
      expectedJsonShape: {
        status: "pass | needs_revision",
        totalScore: "number",
        maxScore: 35,
        rubrics: [
          {
            key: "string",
            score: "1-5",
            comment: "string",
          },
        ],
        strengths: ["string"],
        revisions: ["string"],
        summary: "string",
      },
      artifact: files,
    },
    null,
    2,
  );

  return { system, user };
};

const callOpenAI = async (model: string, prompt: { system: string; user: string }) => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI review failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as Record<string, unknown>;
};

async function main() {
  const args = parseArgs();
  const prompt = await buildPrompt(args.artifactDir);
  const now = new Date().toISOString();

  await mkdir(path.dirname(args.output), { recursive: true });

  if (args.dryRun) {
    await writeFile(
      args.output,
      JSON.stringify(
        {
          version: 1,
          dryRun: true,
          model: args.model,
          generatedAt: now,
          prompt,
          status: "prompt_ready",
          summary:
            "OPENAI_API_KEYがない、または--dry-run指定のため、LLMレビューは実行せずプロンプトを保存しました。",
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`LLM review prompt written: ${args.output}`);
    return;
  }

  const response = await callOpenAI(args.model, prompt);
  await writeFile(
    args.output,
    JSON.stringify(
      {
        version: 1,
        dryRun: false,
        model: args.model,
        generatedAt: now,
        response,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`LLM review written: ${args.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
