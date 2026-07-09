import { readFile } from "node:fs/promises";
import path from "node:path";

type SourceProductCard = {
  id?: string;
  name?: string;
  sourceType?: string;
  sourceCategory?: string;
  url?: string;
  productUrl?: string;
  codeUrl?: string | null;
  evidenceLevel?: string;
  observedFields?: string[];
  inferredFields?: string[];
  missingFields?: string[];
  usePolicy?: string;
  attentionProof?: string[];
  evidenceRefs?: string[];
};

type ExplorationResponse = {
  sourceProductCards?: SourceProductCard[];
};

const CRITICAL_FACT_FIELDS = new Set([
  "name",
  "url",
  "productUrl",
  "codeUrl",
  "attentionProof",
  "adoptionOrAttentionProof",
  "evidenceRefs",
  "whyItGotAttention",
]);

const CRITICAL_SOURCE_CORE_FIELDS = new Set([
  "coreMechanism",
  "transferableStructure",
  "whyItGotAttention",
  "antiCloneBoundary",
]);

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) continue;
    values.set(key, next);
    index += 1;
  }

  const explorationDir = values.get("exploration-dir");
  const response = values.get("response");
  const responsePath = response ?? (explorationDir ? path.join(explorationDir, "response.json") : "");

  if (!responsePath) {
    throw new Error("Usage: npm run research:product-index:review -- --exploration-dir <dir> OR --response <response.json>");
  }

  return { responsePath };
};

const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

const promotionFindingsFor = (card: SourceProductCard) => {
  const issues: string[] = [];
  const evidenceLevel = card.evidenceLevel ?? "";
  const observedFields = list(card.observedFields);
  const inferredFields = list(card.inferredFields);
  const missingFields = list(card.missingFields);

  if (evidenceLevel !== "A" && evidenceLevel !== "B") issues.push("evidenceLevel must be A or B");
  if (observedFields.length < 3) issues.push("needs at least three observedFields");
  if (list(card.attentionProof).length === 0) issues.push("attentionProof is empty");
  if (list(card.evidenceRefs).length === 0) issues.push("evidenceRefs is empty");

  const inferredFacts = inferredFields.filter((field) => CRITICAL_FACT_FIELDS.has(field));
  if (inferredFacts.length > 0) issues.push(`critical facts are inferred: ${inferredFacts.join(", ")}`);

  const missingCore = missingFields.filter((field) => CRITICAL_SOURCE_CORE_FIELDS.has(field));
  if (missingCore.length > 0) issues.push(`required source-core fields are missing: ${missingCore.join(", ")}`);

  return issues;
};

const main = async () => {
  const args = parseArgs();
  const absolutePath = path.resolve(process.cwd(), args.responsePath);
  const payload = JSON.parse(await readFile(absolutePath, "utf8")) as ExplorationResponse;
  const cards = payload.sourceProductCards ?? [];
  const counts = new Map<string, number>();

  for (const card of cards) {
    const key = `${card.usePolicy ?? "missing"}:${card.evidenceLevel ?? "missing"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.log(`Product source candidate review: ${path.relative(process.cwd(), absolutePath)}`);
  console.log(`Candidates: ${cards.length}`);
  console.log(
    `Breakdown: ${[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `${key}=${count}`)
      .join(", ") || "none"}`,
  );
  console.log("");

  for (const card of cards) {
    const issues = promotionFindingsFor(card);
    const status = issues.length === 0 ? "PROMOTABLE_AFTER_HUMAN_REVIEW" : "KEEP_AS_CANDIDATE";
    console.log(`- ${status}: ${card.name ?? card.id ?? "(unnamed)"}`);
    console.log(`  source=${card.sourceCategory ?? "unknown"}/${card.sourceType ?? "unknown"} evidence=${card.evidenceLevel ?? "missing"} policy=${card.usePolicy ?? "missing"}`);
    console.log(`  url=${card.productUrl || card.url || "missing"}`);
    if (issues.length > 0) console.log(`  issues=${issues.join("; ")}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
