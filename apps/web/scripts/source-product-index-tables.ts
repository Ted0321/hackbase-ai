import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TableRow = Record<string, string>;
type JsonRecord = Record<string, unknown>;

type SourceProductIndexEntry = JsonRecord & {
  id: string;
  canonicalKey: string;
  name: string;
  sourceCategory?: string;
  sourceType?: string;
  url?: string;
  productUrl?: string | null;
  codeUrl?: string | null;
  observedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastUpdatedAt?: string;
  status?: string;
  originalDomain?: string;
  concept?: string;
  oneLineDescription?: string;
  problemSolved?: string;
  targetUser?: string;
  userFriction?: string;
  coreUserInput?: string;
  coreOutput?: string;
  outputArtifact?: string;
  coreMechanism?: string;
  interactionPattern?: string;
  whyItIsInteresting?: string;
  whyItGotAttention?: string;
  noveltyKernel?: string;
  transferableStructure?: string;
  ideaKernel?: string;
  transformationAxes?: string[];
  cloneRisk?: string;
  antiCloneBoundary?: string;
  doNotCopy?: string[];
  remixableThemes?: string[];
  bestRemixTargets?: string[];
  adoptionOrAttentionProof?: string[];
  attentionProof?: string[];
  evidenceRefs?: string[];
  evidenceStrength?: "low" | "medium" | "high";
  confidence?: "low" | "medium" | "high";
  evidenceLevel?: "A" | "B" | "C" | "D";
  observedFields?: string[];
  inferredFields?: string[];
  missingFields?: string[];
  usePolicy?: "primary_source_core" | "weak_context" | "candidate_only" | "exclude";
  scaleClassification?: string;
  reasonIncluded?: string;
  reasonNotMajorProduct?: string;
  discoverySources?: SourceArchiveIndexItem[];
  valueKnowledgeCardIds?: string[];
  duplicateOf?: string | null;
  sightingsCount?: number;
};

type SourceArchiveIndexItem = {
  id?: string;
  sourceProductCardId?: string;
  sourceCategory?: string;
  sourceName?: string;
  sourceUrl?: string | null;
  retrievalQueryOrPath?: string;
  observedAt?: string;
  revisitCadence?: string;
  storedEvidenceSummary?: string;
  evidenceStrength?: "low" | "medium" | "high";
};

type ValueKnowledgeCard = {
  id?: string;
  sourceProductCardId?: string;
  valueName?: string;
  whatIsValuable?: string;
  whyPeopleReact?: string;
  underlyingMechanism?: string;
  transferableRule?: string;
  antiCloneBoundary?: string;
  bestRemixTargets?: string[];
  confidence?: "low" | "medium" | "high";
};

export type ProductSourceIndex = {
  version: number;
  updatedAt: string;
  purpose: string;
  updatePolicy: Record<string, unknown>;
  entries: SourceProductIndexEntry[];
  sourceArchiveIndex: SourceArchiveIndexItem[];
  valueKnowledgeCards: ValueKnowledgeCard[];
  excludedAsSourceProductCards: string[];
  maintenanceNotes: string[];
};

const productColumns = [
  "id",
  "name",
  "source_category",
  "source_type",
  "source_url",
  "product_url",
  "code_url",
  "observed_at",
  "first_seen_at",
  "last_seen_at",
  "last_updated_at",
  "status",
  "original_domain",
  "concept",
  "one_line_description",
  "problem_solved",
  "target_user",
  "user_friction",
  "core_user_input",
  "core_output",
  "output_artifact",
  "core_mechanism",
  "interaction_pattern",
  "why_it_is_interesting",
  "why_it_got_attention",
  "novelty_kernel",
  "transferable_structure",
  "idea_kernel",
  "transformation_axes",
  "clone_risk",
  "anti_clone_boundary",
  "do_not_copy",
  "remixable_themes",
  "best_remix_targets",
  "attention_proof",
  "evidence_refs",
  "evidence_strength",
  "confidence",
  "evidence_level",
  "observed_fields",
  "inferred_fields",
  "missing_fields",
  "use_policy",
  "scale_classification",
  "reason_included",
  "reason_not_major_product",
  "notes",
];

const evidenceColumns = [
  "id",
  "source_product_card_id",
  "source_category",
  "source_name",
  "source_url",
  "retrieval_query_or_path",
  "observed_at",
  "revisit_cadence",
  "stored_evidence_summary",
  "evidence_strength",
];

const valueColumns = [
  "id",
  "source_product_card_id",
  "value_name",
  "what_is_valuable",
  "why_people_react",
  "underlying_mechanism",
  "transferable_rule",
  "anti_clone_boundary",
  "best_remix_targets",
  "confidence",
];

const excludedColumns = ["name", "reason"];

const purpose =
  "Persistent index of small rising products, hackathon projects, GitHub projects, and product-gallery launches used as idea source material for Hackbase.ai.";

const updatePolicy = {
  cadence: "daily",
  sourceOfTruth: "data/product-research/index-tables/*.tsv",
  generatedArtifact: "data/product-research/source-product-index.json",
  dedupeKey: "productUrl first, codeUrl second, then sourceUrl + normalized name + source category",
  addWhen: [
    "The source is a recent hackathon winner/finalist/demo, recently rising GitHub project, or small product-gallery launch.",
    "The product has a clear input-output transformation, interaction pattern, or value mechanism.",
    "The product is not an established major product.",
  ],
  updateWhen: [
    "The same product appears again with stronger evidence, a new source, new traction, public code, or clearer value knowledge.",
    "The product's category, URL, target user, evidence, or value frame becomes more precise.",
  ],
  excludeWhen: [
    "The item is an established major product rather than a small rising product.",
    "The item is only a broad platform, framework, or directory listing with no product-shaped demo.",
    "The item duplicates an existing canonical entry without adding evidence.",
  ],
};

const parseArgs = () => {
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

  return {
    fromJson: values.get("from-json"),
    tablesDir: values.get("tables-dir") ?? "data/product-research/index-tables",
    output: values.get("output") ?? "data/product-research/source-product-index.json",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
  };
};

const readJson = async <T,>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;

const readOptionalText = async (filePath: string) => {
  try {
    return await readFile(path.resolve(process.cwd(), filePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const normalizeCell = (value: unknown) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join(" | ");
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r?\n/g, " ").replace(/\t/g, " ").trim();
};

const writeTable = async (filePath: string, columns: string[], rows: TableRow[], dryRun: boolean) => {
  const body = [
    columns.join("\t"),
    ...rows.map((row) => columns.map((column) => normalizeCell(row[column])).join("\t")),
  ].join("\n");

  if (dryRun) return;

  const resolved = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${body}\n`, "utf8");
};

const parseTable = (text: string): TableRow[] => {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (lines.length === 0) return [];

  const columns = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]?.trim() ?? ""]));
  });
};

const parseList = (value: string | undefined) =>
  (value ?? "")
    .split(/\s*\|\s*/g)
    .map((item) => item.trim())
    .filter(Boolean);

const stringValue = (value: unknown) => (typeof value === "string" ? value : "");

const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "");

const normalizeUrl = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\/+$/g, "").toLowerCase();

const canonicalKeyFor = (entry: Pick<SourceProductIndexEntry, "name" | "sourceCategory" | "url" | "productUrl" | "codeUrl">) => {
  const productUrl = normalizeUrl(entry.productUrl);
  if (productUrl) return `product-url:${productUrl}`;

  const codeUrl = normalizeUrl(entry.codeUrl);
  if (codeUrl) return `code-url:${codeUrl}`;

  const name = normalizeName(entry.name);
  const sourceUrl = normalizeUrl(entry.url);
  if (sourceUrl) return `source-url-name:${sourceUrl}:${name}`;

  const sourceCategory = normalizeName(entry.sourceCategory ?? "unknown");
  return `name:${sourceCategory}:${name}`;
};

const validStrength = (value: string, fallback: "low" | "medium" | "high" = "medium") =>
  value === "low" || value === "medium" || value === "high" ? value : fallback;

const validEvidenceLevel = (value: string, evidenceStrength?: string): "A" | "B" | "C" | "D" => {
  if (value === "A" || value === "B" || value === "C" || value === "D") return value;
  if (evidenceStrength === "high") return "A";
  return "B";
};

const validUsePolicy = (value: string): "primary_source_core" | "weak_context" | "candidate_only" | "exclude" =>
  value === "primary_source_core" || value === "weak_context" || value === "candidate_only" || value === "exclude"
    ? value
    : "primary_source_core";

const latestTimestamp = (rows: TableRow[]) => {
  const timestamps = rows
    .flatMap((row) => [row.last_updated_at, row.last_seen_at, row.observed_at])
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return new Date().toISOString();
  return new Date(Math.max(...timestamps)).toISOString();
};

const tablePath = (tablesDir: string, fileName: string) => path.join(tablesDir, fileName).replace(/\\/g, "/");

const productRowFromEntry = (entry: SourceProductIndexEntry): TableRow => ({
  id: stringValue(entry.id),
  name: stringValue(entry.name),
  source_category: stringValue(entry.sourceCategory),
  source_type: stringValue(entry.sourceType),
  source_url: stringValue(entry.url),
  product_url: stringValue(entry.productUrl),
  code_url: stringValue(entry.codeUrl),
  observed_at: stringValue(entry.observedAt),
  first_seen_at: stringValue(entry.firstSeenAt),
  last_seen_at: stringValue(entry.lastSeenAt),
  last_updated_at: stringValue(entry.lastUpdatedAt),
  status: stringValue(entry.status),
  original_domain: stringValue(entry.originalDomain),
  concept: stringValue(entry.concept),
  one_line_description: stringValue(entry.oneLineDescription),
  problem_solved: stringValue(entry.problemSolved),
  target_user: stringValue(entry.targetUser),
  user_friction: stringValue(entry.userFriction),
  core_user_input: stringValue(entry.coreUserInput),
  core_output: stringValue(entry.coreOutput),
  output_artifact: stringValue(entry.outputArtifact),
  core_mechanism: stringValue(entry.coreMechanism),
  interaction_pattern: stringValue(entry.interactionPattern),
  why_it_is_interesting: stringValue(entry.whyItIsInteresting),
  why_it_got_attention: stringValue(entry.whyItGotAttention),
  novelty_kernel: stringValue(entry.noveltyKernel),
  transferable_structure: stringValue(entry.transferableStructure),
  idea_kernel: stringValue(entry.ideaKernel),
  transformation_axes: normalizeCell(entry.transformationAxes),
  clone_risk: stringValue(entry.cloneRisk),
  anti_clone_boundary: stringValue(entry.antiCloneBoundary),
  do_not_copy: normalizeCell(entry.doNotCopy),
  remixable_themes: normalizeCell(entry.remixableThemes),
  best_remix_targets: normalizeCell(entry.bestRemixTargets),
  attention_proof: normalizeCell(entry.attentionProof ?? entry.adoptionOrAttentionProof),
  evidence_refs: normalizeCell(entry.evidenceRefs),
  evidence_strength: stringValue(entry.evidenceStrength),
  confidence: stringValue(entry.confidence),
  evidence_level: stringValue(entry.evidenceLevel),
  observed_fields: normalizeCell(entry.observedFields),
  inferred_fields: normalizeCell(entry.inferredFields),
  missing_fields: normalizeCell(entry.missingFields),
  use_policy: stringValue(entry.usePolicy),
  scale_classification: stringValue(entry.scaleClassification),
  reason_included: stringValue(entry.reasonIncluded),
  reason_not_major_product: stringValue(entry.reasonNotMajorProduct),
  notes: "",
});

const evidenceRowFromItem = (item: SourceArchiveIndexItem): TableRow => ({
  id: stringValue(item.id),
  source_product_card_id: stringValue(item.sourceProductCardId),
  source_category: stringValue(item.sourceCategory),
  source_name: stringValue(item.sourceName),
  source_url: stringValue(item.sourceUrl),
  retrieval_query_or_path: stringValue(item.retrievalQueryOrPath),
  observed_at: stringValue(item.observedAt),
  revisit_cadence: stringValue(item.revisitCadence),
  stored_evidence_summary: stringValue(item.storedEvidenceSummary),
  evidence_strength: stringValue(item.evidenceStrength),
});

const valueRowFromCard = (card: ValueKnowledgeCard): TableRow => ({
  id: stringValue(card.id),
  source_product_card_id: stringValue(card.sourceProductCardId),
  value_name: stringValue(card.valueName),
  what_is_valuable: stringValue(card.whatIsValuable),
  why_people_react: stringValue(card.whyPeopleReact),
  underlying_mechanism: stringValue(card.underlyingMechanism),
  transferable_rule: stringValue(card.transferableRule),
  anti_clone_boundary: stringValue(card.antiCloneBoundary),
  best_remix_targets: normalizeCell(card.bestRemixTargets),
  confidence: stringValue(card.confidence),
});

export const exportTablesFromIndex = async (
  index: ProductSourceIndex,
  tablesDir: string,
  dryRun: boolean,
  log = true,
) => {
  const productRows = index.entries.map(productRowFromEntry);
  const evidenceRows = index.sourceArchiveIndex.map(evidenceRowFromItem);
  const valueRows = index.valueKnowledgeCards.map(valueRowFromCard);
  const excludedRows = index.excludedAsSourceProductCards.map((name) => ({ name, reason: "major_or_established_product" }));

  await Promise.all([
    writeTable(tablePath(tablesDir, "source-products.tsv"), productColumns, productRows, dryRun),
    writeTable(tablePath(tablesDir, "source-evidence.tsv"), evidenceColumns, evidenceRows, dryRun),
    writeTable(tablePath(tablesDir, "value-knowledge.tsv"), valueColumns, valueRows, dryRun),
    writeTable(tablePath(tablesDir, "excluded-products.tsv"), excludedColumns, excludedRows, dryRun),
  ]);

  if (log) {
    console.log(dryRun ? "Source index table export dry run complete." : "Source index tables exported.");
    console.log(`Products: ${productRows.length}`);
    console.log(`Evidence items: ${evidenceRows.length}`);
    console.log(`Value cards: ${valueRows.length}`);
    console.log(`Excluded products: ${excludedRows.length}`);
    console.log(`Tables dir: ${tablesDir}`);
  }
};

export const exportTablesFromJson = async (jsonPath: string, tablesDir: string, dryRun: boolean) => {
  const index = await readJson<ProductSourceIndex>(jsonPath);
  await exportTablesFromIndex(index, tablesDir, dryRun);
};

const groupByProductId = <T extends { sourceProductCardId?: string }>(items: T[]) =>
  items.reduce<Record<string, T[]>>((acc, item) => {
    if (!item.sourceProductCardId) return acc;
    acc[item.sourceProductCardId] ??= [];
    acc[item.sourceProductCardId].push(item);
    return acc;
  }, {});

const evidenceFromRow = (row: TableRow): SourceArchiveIndexItem => ({
  id: row.id || undefined,
  sourceProductCardId: row.source_product_card_id || undefined,
  sourceCategory: row.source_category || undefined,
  sourceName: row.source_name || undefined,
  sourceUrl: row.source_url || null,
  retrievalQueryOrPath: row.retrieval_query_or_path || undefined,
  observedAt: row.observed_at || undefined,
  revisitCadence: row.revisit_cadence || undefined,
  storedEvidenceSummary: row.stored_evidence_summary || undefined,
  evidenceStrength: validStrength(row.evidence_strength),
});

const valueCardFromRow = (row: TableRow): ValueKnowledgeCard => ({
  id: row.id || undefined,
  sourceProductCardId: row.source_product_card_id || undefined,
  valueName: row.value_name || undefined,
  whatIsValuable: row.what_is_valuable || undefined,
  whyPeopleReact: row.why_people_react || undefined,
  underlyingMechanism: row.underlying_mechanism || undefined,
  transferableRule: row.transferable_rule || undefined,
  antiCloneBoundary: row.anti_clone_boundary || undefined,
  bestRemixTargets: parseList(row.best_remix_targets),
  confidence: validStrength(row.confidence),
});

const fallbackEvidenceFor = (row: TableRow, sourceCategory: string): SourceArchiveIndexItem => ({
  id: `archive_${row.id}`,
  sourceProductCardId: row.id,
  sourceCategory,
  sourceName: row.source_type || sourceCategory,
  sourceUrl: row.product_url || row.source_url || row.code_url || null,
  retrievalQueryOrPath: sourceCategory,
  observedAt: row.observed_at || row.first_seen_at,
  revisitCadence: "weekly",
  storedEvidenceSummary: row.one_line_description || row.why_it_is_interesting || row.concept,
  evidenceStrength: validStrength(row.evidence_strength || row.confidence),
});

const entryFromRow = (
  row: TableRow,
  discoverySources: SourceArchiveIndexItem[],
  valueCards: ValueKnowledgeCard[],
  updatedAt: string,
): SourceProductIndexEntry => {
  const sourceCategory = row.source_category || row.source_type || "other";
  const sourceType = row.source_type || sourceCategory;
  const url = row.source_url || row.product_url || row.code_url || "";
  const productUrl = row.product_url || null;
  const codeUrl = row.code_url || null;
  const valueKnowledgeCardIds = valueCards.map((card) => card.id).filter((id): id is string => Boolean(id));
  const entry = {
    id: row.id,
    canonicalKey: "",
    name: row.name,
    sourceCategory,
    sourceType,
    sourceCategories: [sourceCategory],
    url,
    productUrl,
    codeUrl,
    observedAt: row.observed_at || undefined,
    firstSeenAt: row.first_seen_at || row.observed_at || updatedAt,
    lastSeenAt: row.last_seen_at || row.observed_at || updatedAt,
    lastUpdatedAt: row.last_updated_at || updatedAt,
    status: row.status || "active",
    originalDomain: row.original_domain || "",
    concept: row.concept || row.one_line_description || "",
    oneLineDescription: row.one_line_description || "",
    problemSolved: row.problem_solved || row.one_line_description || "",
    targetUser: row.target_user || "",
    userFriction: row.user_friction || row.why_it_is_interesting || "",
    coreUserInput: row.core_user_input || "",
    coreOutput: row.core_output || "",
    outputArtifact: row.output_artifact || row.core_output || "",
    coreMechanism: row.core_mechanism || "",
    interactionPattern: row.interaction_pattern || "",
    whyItIsInteresting: row.why_it_is_interesting || "",
    whyItGotAttention: row.why_it_got_attention || row.why_it_is_interesting || "",
    noveltyKernel: row.novelty_kernel || row.why_it_is_interesting || "",
    transferableStructure: row.transferable_structure || "",
    ideaKernel: row.idea_kernel || row.transferable_structure || row.core_mechanism || "",
    transformationAxes: parseList(row.transformation_axes),
    cloneRisk: row.clone_risk || row.anti_clone_boundary || "",
    antiCloneBoundary: row.anti_clone_boundary || row.clone_risk || "",
    doNotCopy: parseList(row.do_not_copy),
    remixableThemes: parseList(row.remixable_themes),
    bestRemixTargets: parseList(row.best_remix_targets),
    adoptionOrAttentionProof: parseList(row.attention_proof),
    attentionProof: parseList(row.attention_proof),
    evidenceRefs: parseList(row.evidence_refs),
    evidenceStrength: validStrength(row.evidence_strength || row.confidence),
    confidence: validStrength(row.confidence),
    evidenceLevel: validEvidenceLevel(row.evidence_level, row.evidence_strength || row.confidence),
    observedFields: parseList(row.observed_fields),
    inferredFields: parseList(row.inferred_fields),
    missingFields: parseList(row.missing_fields),
    usePolicy: validUsePolicy(row.use_policy),
    scaleClassification: row.scale_classification || "",
    reasonIncluded: row.reason_included || "",
    reasonNotMajorProduct: row.reason_not_major_product || "",
    discoverySources,
    valueKnowledgeCardIds,
    duplicateOf: null,
    sightingsCount: Math.max(1, discoverySources.length),
  } satisfies SourceProductIndexEntry;

  return {
    ...entry,
    canonicalKey: canonicalKeyFor(entry),
  };
};

export const buildIndexFromTables = async (
  tablesDir: string,
  outputPath: string,
  dryRun: boolean,
  log = true,
): Promise<ProductSourceIndex> => {
  const [productRows, evidenceRows, valueRows, excludedRows] = await Promise.all([
    readOptionalText(tablePath(tablesDir, "source-products.tsv")).then(parseTable),
    readOptionalText(tablePath(tablesDir, "source-evidence.tsv")).then(parseTable),
    readOptionalText(tablePath(tablesDir, "value-knowledge.tsv")).then(parseTable),
    readOptionalText(tablePath(tablesDir, "excluded-products.tsv")).then(parseTable),
  ]);

  const duplicateIds = productRows
    .map((row) => row.id)
    .filter((id, index, ids) => id && ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`Duplicate product ids: ${[...new Set(duplicateIds)].join(", ")}`);

  const invalidRows = productRows.filter((row) => !row.id || !row.name);
  if (invalidRows.length > 0) throw new Error("Every source-products.tsv row needs id and name.");

  const updatedAt = latestTimestamp(productRows);
  const archiveItems = evidenceRows.map(evidenceFromRow);
  const valueKnowledgeCards = valueRows.map(valueCardFromRow);
  const archiveByProduct = groupByProductId(archiveItems);
  const valueByProduct = groupByProductId(valueKnowledgeCards);

  const entries = productRows.map((row) => {
    const sourceCategory = row.source_category || row.source_type || "other";
    const discoverySources = archiveByProduct[row.id] ?? [fallbackEvidenceFor(row, sourceCategory)];
    return entryFromRow(row, discoverySources, valueByProduct[row.id] ?? [], updatedAt);
  });

  const entriesByCanonicalKey = entries.reduce<Record<string, string[]>>((acc, entry) => {
    acc[entry.canonicalKey] ??= [];
    acc[entry.canonicalKey].push(entry.id);
    return acc;
  }, {});
  const duplicateCanonicalKeys = Object.entries(entriesByCanonicalKey).filter(([, ids]) => ids.length > 1);
  if (duplicateCanonicalKeys.length > 0) {
    throw new Error(
      `Duplicate product canonical keys: ${duplicateCanonicalKeys
        .map(([key, ids]) => `${key} (${ids.join(", ")})`)
        .join("; ")}`,
    );
  }

  const index: ProductSourceIndex = {
    version: 3,
    updatedAt,
    purpose,
    updatePolicy,
    entries,
    sourceArchiveIndex: archiveItems.length > 0 ? archiveItems : entries.flatMap((entry) => entry.discoverySources ?? []),
    valueKnowledgeCards,
    excludedAsSourceProductCards: excludedRows.map((row) => row.name).filter(Boolean),
    maintenanceNotes: [
      "TSV files under data/product-research/index-tables are the human-editable source of truth.",
      "source-product-index.json is generated for LLM pipeline consumption. Do not hand-edit it directly.",
      "List-valued TSV cells use ` | ` as the delimiter.",
    ],
  };

  if (!dryRun) {
    const resolved = path.resolve(process.cwd(), outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  if (log) {
    console.log(dryRun ? "Source product index build dry run complete." : "Source product index built.");
    console.log(`Products: ${index.entries.length}`);
    console.log(`Evidence items: ${index.sourceArchiveIndex.length}`);
    console.log(`Value cards: ${index.valueKnowledgeCards.length}`);
    console.log(`Excluded products: ${index.excludedAsSourceProductCards.length}`);
    console.log(`Output: ${outputPath}`);
  }

  return index;
};

async function main() {
  const args = parseArgs();

  if (args.fromJson) {
    await exportTablesFromJson(args.fromJson, args.tablesDir, args.dryRun);
    return;
  }

  await buildIndexFromTables(args.tablesDir, args.output, args.dryRun);
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
