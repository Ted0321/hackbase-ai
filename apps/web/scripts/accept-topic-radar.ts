import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TopicRadar = {
  version?: number;
  generatedAt?: string;
  purpose?: string;
  topicCards?: unknown[];
  coverageGaps?: string[];
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    values.set(item.slice(2), raw[index + 1] ?? "");
    index += 1;
  }

  const response = values.get("response");
  if (!response) {
    throw new Error("Usage: npm run research:topics:accept -- --response <path-to-response.json>");
  }

  return {
    response,
    output: values.get("output") ?? "data/topic-research/current-topic-radar.json",
  };
};

async function main() {
  const args = parseArgs();
  const responsePath = path.resolve(process.cwd(), args.response);
  const outputPath = path.resolve(process.cwd(), args.output);
  const radar = JSON.parse(await readFile(responsePath, "utf8")) as TopicRadar;

  if (!Array.isArray(radar.topicCards)) {
    throw new Error("Topic radar response must contain topicCards array.");
  }

  const output = {
    version: radar.version ?? 1,
    generatedAt: radar.generatedAt ?? new Date().toISOString(),
    purpose: radar.purpose ?? "Daily topic radar for pairing with product-source-index value cores.",
    topicCards: radar.topicCards,
    coverageGaps: radar.coverageGaps ?? [],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Accepted topic radar: ${args.output}`);
  console.log(`Topic cards: ${output.topicCards.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
