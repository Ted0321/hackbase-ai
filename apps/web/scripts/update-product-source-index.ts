import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIndexFromTables, exportTablesFromIndex } from "./source-product-index-tables";

type SourceProductCard = {
  id?: string;
  name?: string;
  sourceType?: string;
  sourceCategory?: string;
  url?: string | null;
  productUrl?: string | null;
  codeUrl?: string | null;
  observedAt?: string;
  originalDomain?: string;
  concept?: string;
  targetUser?: string;
  oneLineDescription?: string;
  problemSolved?: string;
  userFriction?: string;
  coreUserInput?: string;
  coreOutput?: string;
  coreMechanism?: string;
  interactionPattern?: string;
  whyItIsInteresting?: string;
  whyItGotAttention?: string;
  adoptionOrAttentionProof?: string[];
  attentionProof?: string[];
  scaleClassification?: string;
  reasonIncluded?: string;
  reasonNotMajorProduct?: string;
  transferableStructure?: string;
  ideaKernel?: string;
  noveltyKernel?: string;
  outputArtifact?: string;
  transformationAxes?: string[];
  cloneRisk?: string;
  antiCloneBoundary?: string;
  doNotCopy?: string[];
  remixableThemes?: string[];
  bestRemixTargets?: string[];
  evidenceRefs?: string[];
  evidenceStrength?: "low" | "medium" | "high";
  confidence?: "low" | "medium" | "high";
  evidenceLevel?: "A" | "B" | "C" | "D";
  observedFields?: string[];
  inferredFields?: string[];
  missingFields?: string[];
  usePolicy?: "primary_source_core" | "weak_context" | "candidate_only" | "exclude";
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

type ProductSourceIndexEntry = Required<
  Pick<
    SourceProductCard,
    | "id"
    | "name"
    | "sourceType"
    | "originalDomain"
    | "oneLineDescription"
    | "coreUserInput"
    | "coreOutput"
    | "coreMechanism"
    | "interactionPattern"
    | "whyItIsInteresting"
    | "transferableStructure"
    | "cloneRisk"
    | "confidence"
  >
> &
  SourceProductCard & {
    canonicalKey: string;
    url: string;
    firstSeenAt: string;
    lastSeenAt: string;
    lastUpdatedAt: string;
    status: string;
    sourceCategories: string[];
    discoverySources: SourceArchiveIndexItem[];
    valueKnowledgeCardIds: string[];
    sourceCategory: string;
    productUrl: string | null;
    codeUrl: string | null;
    concept: string;
    problemSolved: string;
    targetUser: string;
    userFriction: string;
    whyItGotAttention: string;
    noveltyKernel: string;
    outputArtifact: string;
    ideaKernel: string;
    transformationAxes: string[];
    antiCloneBoundary: string;
    attentionProof: string[];
    bestRemixTargets: string[];
    evidenceStrength: "low" | "medium" | "high";
    evidenceLevel: "A" | "B" | "C" | "D";
    observedFields: string[];
    inferredFields: string[];
    missingFields: string[];
    usePolicy: "primary_source_core" | "weak_context" | "candidate_only" | "exclude";
    duplicateOf: string | null;
    sightingsCount: number;
  };

type ProductSourceIndex = {
  version: number;
  updatedAt: string;
  purpose: string;
  updatePolicy: Record<string, unknown>;
  entries: ProductSourceIndexEntry[];
  sourceArchiveIndex: SourceArchiveIndexItem[];
  valueKnowledgeCards: ValueKnowledgeCard[];
  excludedAsSourceProductCards: string[];
  maintenanceNotes: string[];
};

type ExplorationResponse = {
  sourceCategory?: string;
  sourceProductCards?: SourceProductCard[];
  sourceArchiveIndex?: SourceArchiveIndexItem[];
  valueKnowledgeCards?: ValueKnowledgeCard[];
};

type LoadedExplorationResponse = {
  filePath: string;
  payload: ExplorationResponse;
};

type ValidationIssue = {
  filePath: string;
  cardLabel: string;
  field: string;
  message: string;
};

const MIN_FIELD_LENGTHS = {
  coreMechanism: 40,
  transferableStructure: 35,
  whyItGotAttention: 35,
} as const;

const MAJOR_PRODUCT_MARKERS = [
  "major product",
  "major_product",
  "major-or-established",
  "major_or_established",
  "established product",
  "established_product",
  "established platform",
  "established_platform",
] as const;

const EVIDENCE_LEVELS = ["A", "B", "C", "D"] as const;
const USE_POLICIES = ["primary_source_core", "weak_context", "candidate_only", "exclude"] as const;

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
    index: values.get("index") ?? "data/product-research/source-product-index.json",
    tablesDir: values.get("tables-dir") ?? "data/product-research/index-tables",
    explorationDir: values.get("exploration-dir") ?? "data/research-exploration",
    output: values.get("output") ?? values.get("index") ?? "data/product-research/source-product-index.json",
    dryRun: flags.has("dry-run") || values.get("dry-run") === "true",
  };
};

const readJsonOptional = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const collectResponseFiles = async (dirPath: string): Promise<string[]> => {
  const root = path.resolve(process.cwd(), dirPath);
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return collectResponseFiles(entryPath);
      return entry.isFile() && entry.name === "response.json" ? [entryPath] : [];
    }),
  );

  return nested.flat();
};

const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "");

const normalizeUrl = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\/+$/g, "").toLowerCase();

const textValue = (value: string | null | undefined) => (value ?? "").trim();

const compactTextLength = (value: string | null | undefined) => textValue(value).replace(/\s+/g, "").length;

const stringList = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

const isEvidenceLevel = (value: unknown): value is SourceProductCard["evidenceLevel"] =>
  typeof value === "string" && (EVIDENCE_LEVELS as readonly string[]).includes(value);

const isUsePolicy = (value: unknown): value is SourceProductCard["usePolicy"] =>
  typeof value === "string" && (USE_POLICIES as readonly string[]).includes(value);

const shouldWriteCard = (card: SourceProductCard) => card.usePolicy === "primary_source_core";

const inferredProductUrl = (card: SourceProductCard) => {
  if (card.productUrl) return card.productUrl;

  const url = card.url ?? "";
  const category = `${card.sourceCategory ?? ""} ${card.sourceType ?? ""}`.toLowerCase();
  if (category.includes("github") || normalizeUrl(url).includes("github.com/")) return url;

  return null;
};

const canonicalKeyFor = (card: SourceProductCard) => {
  const productUrl = normalizeUrl(inferredProductUrl(card));
  if (productUrl) return `product-url:${productUrl}`;

  const codeUrl = normalizeUrl(card.codeUrl);
  if (codeUrl) return `code-url:${codeUrl}`;

  const name = normalizeName(card.name ?? card.id ?? "unknown");
  const sourceUrl = normalizeUrl(card.url);
  if (sourceUrl) return `source-url-name:${sourceUrl}:${name}`;

  const sourceType = normalizeName(card.sourceType ?? "unknown");
  return `name:${sourceType}:${name}`;
};

const unique = <T>(items: T[]) => [...new Set(items.filter(Boolean))];

const isExcluded = (card: SourceProductCard, excluded: string[]) => {
  const name = normalizeName(card.name ?? "");
  return excluded.some((item) => normalizeName(item) === name);
};

const includesMajorProductMarker = (card: SourceProductCard) =>
  [
    card.sourceType,
    card.sourceCategory,
    card.scaleClassification,
  ]
    .map((value) => textValue(value).toLowerCase())
    .some((value) => MAJOR_PRODUCT_MARKERS.some((marker) => value.includes(marker)));

const cardLabelFor = (card: SourceProductCard, index: number) =>
  card.name ?? card.id ?? `sourceProductCards[${index}]`;

const pushIssue = (
  issues: ValidationIssue[],
  filePath: string,
  cardLabel: string,
  field: string,
  message: string,
) => {
  issues.push({ filePath, cardLabel, field, message });
};

const validateSourceProductCards = (
  responses: LoadedExplorationResponse[],
  excludedProducts: string[],
) => {
  const issues: ValidationIssue[] = [];
  const canonicalKeys = new Map<string, Array<{ filePath: string; cardLabel: string }>>();

  for (const response of responses) {
    const cards = response.payload.sourceProductCards ?? [];

    cards.forEach((card, index) => {
      const cardLabel = cardLabelFor(card, index);

      if (!textValue(card.name)) {
        pushIssue(issues, response.filePath, cardLabel, "name", "sourceProductCards row needs a product name.");
      }

      if (!textValue(card.url) && !textValue(card.productUrl) && !textValue(card.codeUrl)) {
        pushIssue(issues, response.filePath, cardLabel, "url", "sourceProductCards row needs url, productUrl, or codeUrl.");
      }

      if (isExcluded(card, excludedProducts) || includesMajorProductMarker(card)) {
        pushIssue(issues, response.filePath, cardLabel, "majorProduct", "major or established products must not be written to source-products.tsv.");
      }

      if (!isEvidenceLevel(card.evidenceLevel)) {
        pushIssue(issues, response.filePath, cardLabel, "evidenceLevel", "evidenceLevel must be A, B, C, or D.");
      }

      if (!isUsePolicy(card.usePolicy)) {
        pushIssue(
          issues,
          response.filePath,
          cardLabel,
          "usePolicy",
          "usePolicy must be primary_source_core, weak_context, candidate_only, or exclude.",
        );
      }

      if (!Array.isArray(card.observedFields)) {
        pushIssue(issues, response.filePath, cardLabel, "observedFields", "observedFields must list fact fields directly observed from sources.");
      }

      if (!Array.isArray(card.inferredFields)) {
        pushIssue(issues, response.filePath, cardLabel, "inferredFields", "inferredFields must list fields inferred by AI or scripts.");
      }

      if (!Array.isArray(card.missingFields)) {
        pushIssue(issues, response.filePath, cardLabel, "missingFields", "missingFields must list unavailable fields instead of silently fabricating them.");
      }

      if (!shouldWriteCard(card)) {
        return;
      }

      if (card.evidenceLevel === "C" || card.evidenceLevel === "D") {
        pushIssue(
          issues,
          response.filePath,
          cardLabel,
          "evidenceLevel",
          "primary_source_core requires evidenceLevel A or B; C/D can only be weak_context or candidate_only.",
        );
      }

      if (stringList(card.observedFields).length < 3) {
        pushIssue(
          issues,
          response.filePath,
          cardLabel,
          "observedFields",
          "primary_source_core needs at least three observed fact fields before TSV write.",
        );
      }

      const inferredFacts = stringList(card.inferredFields).filter((field) => CRITICAL_FACT_FIELDS.has(field));
      if (inferredFacts.length > 0) {
        pushIssue(
          issues,
          response.filePath,
          cardLabel,
          "inferredFields",
          `critical fact fields must be observed, not inferred: ${inferredFacts.join(", ")}`,
        );
      }

      const missingCoreFields = stringList(card.missingFields).filter((field) => CRITICAL_SOURCE_CORE_FIELDS.has(field));
      if (missingCoreFields.length > 0) {
        pushIssue(
          issues,
          response.filePath,
          cardLabel,
          "missingFields",
          `primary_source_core cannot miss required source-core fields: ${missingCoreFields.join(", ")}`,
        );
      }

      if (!textValue(card.antiCloneBoundary)) {
        pushIssue(issues, response.filePath, cardLabel, "antiCloneBoundary", "antiCloneBoundary is required before adding a source card.");
      }

      if (!Array.isArray(card.attentionProof) || card.attentionProof.length === 0) {
        pushIssue(issues, response.filePath, cardLabel, "attentionProof", "primary_source_core requires observed attentionProof.");
      }

      if (!Array.isArray(card.evidenceRefs) || card.evidenceRefs.length === 0) {
        pushIssue(issues, response.filePath, cardLabel, "evidenceRefs", "primary_source_core requires evidenceRefs.");
      }

      for (const [field, minLength] of Object.entries(MIN_FIELD_LENGTHS)) {
        const value = card[field as keyof typeof MIN_FIELD_LENGTHS];
        if (compactTextLength(value) < minLength) {
          pushIssue(
            issues,
            response.filePath,
            cardLabel,
            field,
            `${field} is too thin; write a concrete mechanism or transfer rule before adding it.`,
          );
        }
      }

      const key = canonicalKeyFor(card);
      const locations = canonicalKeys.get(key) ?? [];
      locations.push({ filePath: response.filePath, cardLabel });
      canonicalKeys.set(key, locations);
    });
  }

  for (const [key, locations] of canonicalKeys.entries()) {
    if (locations.length < 2) continue;
    for (const location of locations) {
      pushIssue(
        issues,
        location.filePath,
        location.cardLabel,
        "canonicalKey",
        `duplicate canonical key in incoming research responses: ${key}`,
      );
    }
  }

  if (issues.length === 0) return;

  const details = issues
    .slice(0, 30)
    .map((issue) => `- ${issue.filePath} :: ${issue.cardLabel} :: ${issue.field}: ${issue.message}`)
    .join("\n");
  const suffix = issues.length > 30 ? `\n...and ${issues.length - 30} more issue(s).` : "";
  throw new Error(`Research source product validation failed before TSV write.\n${details}${suffix}`);
};

const archiveItemsForCard = (
  card: SourceProductCard,
  sourceCategory: string,
  sourceArchiveIndex: SourceArchiveIndexItem[],
) => {
  const byCard = sourceArchiveIndex.filter((item) => item.sourceProductCardId === card.id);
  if (byCard.length > 0) return byCard;

  return [
    {
      id: `archive_${card.id ?? normalizeName(card.name ?? "unknown")}`,
      sourceProductCardId: card.id,
      sourceCategory,
      sourceName: card.sourceType ?? sourceCategory,
      sourceUrl: card.productUrl ?? card.url ?? card.codeUrl ?? null,
      retrievalQueryOrPath: sourceCategory,
      observedAt: card.observedAt,
      revisitCadence: "weekly",
      storedEvidenceSummary: card.oneLineDescription ?? card.whyItIsInteresting ?? "",
      evidenceStrength: card.confidence ?? "medium",
    },
  ];
};

const valueCardsForCard = (card: SourceProductCard, valueKnowledgeCards: ValueKnowledgeCard[]) =>
  valueKnowledgeCards.filter((item) => item.sourceProductCardId === card.id);

const buildEntry = (
  card: SourceProductCard,
  sourceCategory: string,
  archiveItems: SourceArchiveIndexItem[],
  valueCards: ValueKnowledgeCard[],
  now: string,
): ProductSourceIndexEntry => {
  const cardId = card.id ?? normalizeName(card.name ?? `product_${Date.now()}`);
  const valueKnowledgeCardIds = valueCards.map((item) => item.id).filter((id): id is string => Boolean(id));

  return {
    ...card,
    id: cardId,
    canonicalKey: canonicalKeyFor(card),
    name: card.name ?? cardId,
    sourceType: card.sourceType ?? sourceCategory,
    sourceCategory: card.sourceCategory ?? sourceCategory,
    url: card.url ?? "",
    productUrl: inferredProductUrl(card),
    codeUrl: card.codeUrl ?? null,
    firstSeenAt: card.observedAt ?? now,
    lastSeenAt: card.observedAt ?? now,
    lastUpdatedAt: now,
    status: "active",
    sourceCategories: [sourceCategory],
    discoverySources: archiveItems,
    valueKnowledgeCardIds,
    originalDomain: card.originalDomain ?? "",
    concept: card.concept ?? card.oneLineDescription ?? "",
    oneLineDescription: card.oneLineDescription ?? "",
    problemSolved: card.problemSolved ?? card.oneLineDescription ?? "",
    targetUser: card.targetUser ?? "",
    userFriction: card.userFriction ?? card.whyItIsInteresting ?? "",
    coreUserInput: card.coreUserInput ?? "",
    coreOutput: card.coreOutput ?? "",
    coreMechanism: card.coreMechanism ?? "",
    interactionPattern: card.interactionPattern ?? "",
    whyItIsInteresting: card.whyItIsInteresting ?? "",
    whyItGotAttention: card.whyItGotAttention ?? card.whyItIsInteresting ?? "",
    adoptionOrAttentionProof: card.adoptionOrAttentionProof ?? card.attentionProof ?? [],
    attentionProof: card.attentionProof ?? card.adoptionOrAttentionProof ?? [],
    transferableStructure: card.transferableStructure ?? "",
    cloneRisk: card.cloneRisk ?? card.antiCloneBoundary ?? "",
    antiCloneBoundary: card.antiCloneBoundary ?? card.cloneRisk ?? "",
    doNotCopy: card.doNotCopy ?? [],
    remixableThemes: card.remixableThemes ?? card.bestRemixTargets ?? [],
    bestRemixTargets: card.bestRemixTargets ?? card.remixableThemes ?? [],
    evidenceRefs: card.evidenceRefs ?? [],
    evidenceStrength: card.evidenceStrength ?? card.confidence ?? "medium",
    confidence: card.confidence ?? "medium",
    evidenceLevel: card.evidenceLevel ?? "C",
    observedFields: card.observedFields ?? [],
    inferredFields: card.inferredFields ?? [],
    missingFields: card.missingFields ?? [],
    usePolicy: card.usePolicy ?? "candidate_only",
    noveltyKernel: card.noveltyKernel ?? card.whyItIsInteresting ?? "",
    outputArtifact: card.outputArtifact ?? card.coreOutput ?? "",
    ideaKernel: card.ideaKernel ?? card.transferableStructure ?? card.coreMechanism ?? "",
    transformationAxes: card.transformationAxes ?? unique([
      card.coreMechanism ? "mechanism_transfer" : "",
      card.coreOutput ? "output_form_shift" : "",
      card.interactionPattern ? "interaction_pattern_shift" : "",
    ]),
    duplicateOf: null,
    sightingsCount: 1,
  };
};

const mergeArchiveItems = (existing: SourceArchiveIndexItem[], incoming: SourceArchiveIndexItem[]) => {
  const seen = new Set(existing.map((item) => item.id ?? item.sourceUrl ?? item.storedEvidenceSummary ?? ""));
  const merged = [...existing];

  for (const item of incoming) {
    const key = item.id ?? item.sourceUrl ?? item.storedEvidenceSummary ?? "";
    if (key && seen.has(key)) continue;
    merged.push(item);
    if (key) seen.add(key);
  }

  return merged;
};

const mergeEntry = (
  existing: ProductSourceIndexEntry,
  incoming: ProductSourceIndexEntry,
  valueCards: ValueKnowledgeCard[],
  now: string,
): ProductSourceIndexEntry => ({
  ...existing,
  lastSeenAt: incoming.lastSeenAt,
  lastUpdatedAt: now,
  status: existing.status === "excluded" ? existing.status : "active",
  productUrl: existing.productUrl || incoming.productUrl,
  codeUrl: existing.codeUrl || incoming.codeUrl,
  sourceCategory: existing.sourceCategory || incoming.sourceCategory,
  concept: existing.concept || incoming.concept,
  problemSolved: existing.problemSolved || incoming.problemSolved,
  targetUser: existing.targetUser || incoming.targetUser,
  userFriction: existing.userFriction || incoming.userFriction,
  whyItGotAttention: existing.whyItGotAttention || incoming.whyItGotAttention,
  noveltyKernel: existing.noveltyKernel || incoming.noveltyKernel,
  outputArtifact: existing.outputArtifact || incoming.outputArtifact,
  ideaKernel: existing.ideaKernel || incoming.ideaKernel,
  antiCloneBoundary: existing.antiCloneBoundary || incoming.antiCloneBoundary,
  transformationAxes: unique([...(existing.transformationAxes ?? []), ...(incoming.transformationAxes ?? [])]),
  sourceCategories: unique([...existing.sourceCategories, ...incoming.sourceCategories]),
  discoverySources: mergeArchiveItems(existing.discoverySources ?? [], incoming.discoverySources ?? []),
  valueKnowledgeCardIds: unique([
    ...(existing.valueKnowledgeCardIds ?? []),
    ...(incoming.valueKnowledgeCardIds ?? []),
    ...valueCards.map((item) => item.id ?? ""),
  ]),
  adoptionOrAttentionProof: unique([
    ...(existing.adoptionOrAttentionProof ?? []),
    ...(incoming.adoptionOrAttentionProof ?? []),
  ]),
  attentionProof: unique([...(existing.attentionProof ?? []), ...(incoming.attentionProof ?? [])]),
  evidenceRefs: unique([...(existing.evidenceRefs ?? []), ...(incoming.evidenceRefs ?? [])]),
  remixableThemes: unique([...(existing.remixableThemes ?? []), ...(incoming.remixableThemes ?? [])]),
  bestRemixTargets: unique([...(existing.bestRemixTargets ?? []), ...(incoming.bestRemixTargets ?? [])]),
  doNotCopy: unique([...(existing.doNotCopy ?? []), ...(incoming.doNotCopy ?? [])]),
  sightingsCount: (existing.sightingsCount ?? 1) + 1,
  confidence:
    existing.confidence === "high" || incoming.confidence === "high"
      ? "high"
      : existing.confidence === "medium" || incoming.confidence === "medium"
        ? "medium"
        : "low",
  evidenceStrength:
    existing.evidenceStrength === "high" || incoming.evidenceStrength === "high"
      ? "high"
      : existing.evidenceStrength === "medium" || incoming.evidenceStrength === "medium"
        ? "medium"
        : "low",
  evidenceLevel:
    existing.evidenceLevel === "A" || incoming.evidenceLevel === "A"
      ? "A"
      : existing.evidenceLevel === "B" || incoming.evidenceLevel === "B"
        ? "B"
        : existing.evidenceLevel === "C" || incoming.evidenceLevel === "C"
          ? "C"
          : "D",
  observedFields: unique([...(existing.observedFields ?? []), ...(incoming.observedFields ?? [])]),
  inferredFields: unique([...(existing.inferredFields ?? []), ...(incoming.inferredFields ?? [])]),
  missingFields: unique([...(existing.missingFields ?? []), ...(incoming.missingFields ?? [])]),
  usePolicy: existing.usePolicy === "primary_source_core" || incoming.usePolicy === "primary_source_core"
    ? "primary_source_core"
    : existing.usePolicy ?? incoming.usePolicy ?? "candidate_only",
});

async function main() {
  const args = parseArgs();
  const now = new Date().toISOString();
  const tableIndex = await buildIndexFromTables(args.tablesDir, args.output, true, false)
    .then((builtIndex) => builtIndex as unknown as ProductSourceIndex)
    .catch(() => null);
  const jsonIndex = await readJsonOptional<ProductSourceIndex>(args.index);
  const index = tableIndex && tableIndex.entries.length > 0 ? tableIndex : jsonIndex;
  if (!index) throw new Error(`Product source index not found: ${args.index}`);

  const responseFiles = await collectResponseFiles(args.explorationDir);
  const loaded = await Promise.all(
    responseFiles.map(async (filePath) => ({
      filePath,
      payload: await readJsonOptional<ExplorationResponse>(filePath),
    })),
  );
  const responses = loaded.filter((entry): entry is LoadedExplorationResponse =>
    Boolean(entry.payload),
  );

  validateSourceProductCards(responses, index.excludedAsSourceProductCards);

  const entriesByKey = new Map(index.entries.map((entry) => [entry.canonicalKey, entry]));
  const archiveIndex = [...index.sourceArchiveIndex];
  const valueKnowledgeCards = [...index.valueKnowledgeCards];
  let added = 0;
  let updated = 0;
  let excluded = 0;
  let skipped = 0;

  for (const response of responses) {
    const responseSourceCategory = response.payload.sourceCategory ?? "other";
    const sourceArchiveIndex = response.payload.sourceArchiveIndex ?? [];
    const sourceProductCards = response.payload.sourceProductCards ?? [];
    const responseValueCards = response.payload.valueKnowledgeCards ?? [];

    for (const card of sourceProductCards) {
      if (isExcluded(card, index.excludedAsSourceProductCards) || card.usePolicy === "exclude") {
        excluded += 1;
        continue;
      }

      if (!shouldWriteCard(card)) {
        skipped += 1;
        continue;
      }

      const sourceCategory = card.sourceCategory ?? card.sourceType ?? responseSourceCategory;
      const archiveItems = archiveItemsForCard(card, sourceCategory, sourceArchiveIndex);
      const valueCards = valueCardsForCard(card, responseValueCards);
      const incoming = buildEntry(card, sourceCategory, archiveItems, valueCards, now);
      const existing = entriesByKey.get(incoming.canonicalKey);

      if (existing) {
        entriesByKey.set(incoming.canonicalKey, mergeEntry(existing, incoming, valueCards, now));
        updated += 1;
      } else {
        entriesByKey.set(incoming.canonicalKey, incoming);
        added += 1;
      }

      archiveIndex.push(...archiveItems);
      valueKnowledgeCards.push(...valueCards);
    }
  }

  const nextIndex: ProductSourceIndex = {
    ...index,
    updatedAt: now,
    entries: [...entriesByKey.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sourceArchiveIndex: mergeArchiveItems([], archiveIndex),
    valueKnowledgeCards: [
      ...new Map(
        valueKnowledgeCards
          .filter((item) => item.id)
          .map((item) => [item.id as string, item]),
      ).values(),
    ],
  };

  if (!args.dryRun) {
    const outputPath = path.resolve(process.cwd(), args.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await exportTablesFromIndex(nextIndex, args.tablesDir, false, false);
    await writeFile(outputPath, `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");
  }

  console.log(args.dryRun ? "Product source index TSV update dry run complete." : "Product source index TSV and JSON updated.");
  console.log(`Baseline: ${tableIndex && tableIndex.entries.length > 0 ? "tsv_tables" : "json_index"}`);
  console.log(`Responses scanned: ${responses.length}`);
  console.log(`Added: ${added}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped non-primary candidates: ${skipped}`);
  console.log(`Excluded major products: ${excluded}`);
  console.log(`Index entries: ${nextIndex.entries.length}`);
  console.log(`Tables: ${args.tablesDir}`);
  console.log(`Output: ${args.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
