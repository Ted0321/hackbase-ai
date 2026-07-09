/**
 * プロンプト前後評価の純関数メトリクス（I/O なし・決定論）。
 *
 * eval-prompt-refinement.ts から呼ばれ、baseline と candidate の
 * pipeline 出力（response.json）や準備済みプロンプト（prompt.md）を比較する。
 * 純関数に切り出してあるのは prompt-eval-metrics.test.ts で単体検証するため。
 */

import { isProductCategoryId } from "./product-categories";
import { normalizeShortTagline, SHORT_TAGLINE_MAX_CHARS } from "./product-copy";

export type StepName =
  | "research"
  | "combination"
  | "concept"
  | "agent-router"
  | "requirements"
  | "builder"
  | "reviewer"
  | "rewriter"
  | "publisher";

export type SchemaShape = { ok: boolean; missing: string[] };

export type ConceptDiversity = {
  candidateCount: number;
  distinctTemplatePatternIds: number;
  distinctSurfacePatterns: number;
  distinctAiMechanismPatterns: number;
  pairwiseTitleJaccard: number;
};

export type ConceptNameQuality = {
  candidatesWithEnoughNameCandidates: number;
  candidatesWithNamePattern: number;
  candidatesWithCompleteNameScores: number;
  candidatesWithSelectedNameRationale: number;
  candidatesWithVisibleAiTransformation: number;
  candidatesWithFirstScreenHook: number;
  candidatesWithCuriosityHook: number;
  candidatesWithBoringNameAvoided: number;
  englishOrMixedTitleCount: number;
  distinctNamePatternsUsed: number;
  genericTitleCount: number;
  overlongTitleCount: number;
};

export type ConceptSharpnessQuality = {
  candidatesWithValidArchetype: number;
  distinctConceptArchetypes: number;
  candidatesWithHumanHook: number;
  candidatesWithBeforeAfter: number;
  candidatesWithSurpriseMoment: number;
  candidatesWithFirstScreenDrama: number;
  candidatesWithShareLine: number;
  candidatesWithBoringVersionAvoided: number;
  candidatesWithRiskScores: number;
  candidatesWithRiskSelectionNote: number;
  conditionalArchetypesUsed: number;
  conditionalArchetypesWithJustification: number;
  selectedAiIntrospectionRisk: number | null;
  selectedDomainOpacityRisk: number | null;
};

export type StepQualityIssue = { check: string; detail: string };
export type StepQuality = {
  ok: boolean;
  score: number;
  passed: number;
  total: number;
  issues: StepQualityIssue[];
  warnings?: StepQualityIssue[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 多言語ざっくりトークナイズ。英数語＋日本語連結を1語として、2文字以上を残す。 */
export const tokenize = (text: string): string[] => {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
};

/** Jaccard 類似度（0=無関係, 1=同一集合）。両方空なら 0。 */
export const jaccard = (a: string[], b: string[]): number => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/** 候補テキスト群の中で最も似ているペアの Jaccard（多様性崩壊の検出に使う）。 */
export const pairwiseMaxJaccard = (texts: string[]): number => {
  const tokenSets = texts.map((text) => tokenize(text));
  let max = 0;
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      const value = jaccard(tokenSets[i], tokenSets[j]);
      if (value > max) max = value;
    }
  }
  return Number(max.toFixed(4));
};

export const distinctCount = (values: Array<string | undefined | null>): number =>
  new Set(values.map((value) => str(value)).filter((value) => value.length > 0)).size;

/** concept レスポンスの候補配列（candidates[] or conceptBriefs[]）を取り出す。 */
export const conceptCandidates = (response: unknown): Record<string, unknown>[] => {
  const record = asRecord(response);
  if (!record) return [];
  const raw = Array.isArray(record.candidates)
    ? record.candidates
    : Array.isArray(record.conceptBriefs)
      ? record.conceptBriefs
      : [];
  return raw.map(asRecord).filter((value): value is Record<string, unknown> => value !== null);
};

/** step ごとの必須キー形状チェック。run-gemini.ts summarizeStep の期待に合わせる。 */
export const schemaShapeForStep = (step: StepName, response: unknown): SchemaShape => {
  const record = asRecord(response);
  if (!record) return { ok: false, missing: ["<non-object response>"] };
  const missing: string[] = [];

  if (step === "concept") {
    const candidates = conceptCandidates(response);
    if (candidates.length === 0) missing.push("candidates[]");
    if (!record.selectedConcept) missing.push("selectedConcept");
    candidates.forEach((candidate, index) => {
      if (!str(candidate.title)) missing.push(`candidates[${index}].title`);
      if (!str(candidate.templatePatternId)) missing.push(`candidates[${index}].templatePatternId`);
    });
  } else if (step === "combination") {
    const selected =
      asArray(record.selectedRemixes).length || asArray(record.selectedCombinations).length;
    const evaluated =
      asArray(record.evaluatedRemixes).length || asArray(record.evaluatedCombinations).length;
    if (!selected) missing.push("selectedRemixes[]|selectedCombinations[]");
    if (!evaluated) missing.push("evaluatedRemixes[]|evaluatedCombinations[]");
  } else if (step === "research") {
    // research プロンプトの実出力は sourceProductCards / topicCards / themeMaterials /
    // winningPatternReports などの素材配列で、旧 researchReports[]/signalCards[] は空のことが多い
    // （concept はこの素材群を消費する）。素材配列のいずれかが非空なら有効とする（過剰ブロック回避）。
    const hasMaterial =
      asArray(record.sourceProductCards).length ||
      asArray(record.topicCards).length ||
      asArray(record.researchReports).length ||
      asArray(record.signalCards).length;
    if (!hasMaterial) {
      missing.push("sourceProductCards[]|topicCards[]|researchReports[]|signalCards[]");
    }
  } else if (step === "requirements") {
    if (!str(record.mvpGoal)) missing.push("mvpGoal");
    if (!asArray(record.screens).length) missing.push("screens[]");
    if (!asArray(record.acceptanceCriteria).length) missing.push("acceptanceCriteria[]");
  } else if (step === "builder") {
    if (!asArray(record.files).length) missing.push("files[]");
    if (!record.submissionReadiness && !record.mvpContract) {
      missing.push("submissionReadiness|mvpContract");
    }
    if (!record.mvpContractV2) missing.push("mvpContractV2");
    if (!asRecord(record.sourceTrace) && !asRecord(record.sourceProvenance)) {
      missing.push("sourceTrace|sourceProvenance");
    }
  } else if (step === "reviewer") {
    if (!str(record.status)) missing.push("status");
    if (!asRecord(record.scores)) missing.push("scores");
    if (!asRecord(record.hackathonDemoChecks)) missing.push("hackathonDemoChecks");
    if (!Array.isArray(record.problems)) missing.push("problems[]");
  } else if (step === "rewriter") {
    if (!str(record.status)) missing.push("status");
    if (!Array.isArray(record.changedFiles)) missing.push("changedFiles[]");
    if (!Array.isArray(record.addressedReviewIssues)) missing.push("addressedReviewIssues[]");
  } else if (step === "publisher") {
    if (!str(record.status)) missing.push("status");
    for (const flag of ["requiredArtifactsPresent", "reviewPass", "validationPass", "mvpContractPass", "sourceTracePass"]) {
      if (typeof record[flag] !== "boolean") missing.push(flag);
    }
    if (!Array.isArray(record.safetyBlockers)) missing.push("safetyBlockers[]");
  } else {
    if (Object.keys(record).length === 0) missing.push("<empty response>");
  }

  return { ok: missing.length === 0, missing };
};

// ---- requirements の確実性（buildable 契約）品質チェック（DOC-71 §6）----
// schemaShapeForStep は「キーの存在」だけを見るが、requirements は確実性の蝶番なので
// 「screen に操作と結果があるか」「dataModel に具体 sampleShape があるか」「証明計画が
// 実装可能な粒度か」「スコープが膨張していないか」まで決定論で測る（judge不要・安い）。

export type RequirementsQualityIssue = { check: string; detail: string };
export type RequirementsQuality = {
  ok: boolean;
  score: number; // 0..1（passed/total）
  passed: number;
  total: number;
  issues: RequirementsQualityIssue[];
};

/** 「smallest screen that proves the concept」を担保する上限。超過＝スコープ膨張。 */
export const DEFAULT_MAX_SCREENS = 4;
/** sampleShape が「具体」と言える最低文字数（プレースホルダ排除）。 */
const MIN_SAMPLE_SHAPE_LEN = 10;
const VALID_EXTERNAL_DEPENDENCY_MODES = ["none", "proposed", "mocked_adapter", "live_required"];

export const requirementsQuality = (
  spec: unknown,
  opts: { maxScreens?: number } = {},
): RequirementsQuality => {
  const maxScreens = opts.maxScreens ?? DEFAULT_MAX_SCREENS;
  const record = asRecord(spec);
  const issues: RequirementsQualityIssue[] = [];
  let passed = 0;
  let total = 0;
  const gate = (check: string, ok: boolean, detail: string) => {
    total += 1;
    if (ok) passed += 1;
    else issues.push({ check, detail });
  };

  if (!record) {
    return { ok: false, score: 0, passed: 0, total: 1, issues: [{ check: "shape", detail: "non-object response" }] };
  }

  const screens = asArray(record.screens)
    .map(asRecord)
    .filter((s): s is Record<string, unknown> => s !== null);
  const dataModel = asArray(record.dataModel)
    .map(asRecord)
    .filter((d): d is Record<string, unknown> => d !== null);
  const proof = asRecord(record.interactionProofPlan);
  const externalDependencyPlan = asRecord(record.externalDependencyPlan);
  const claimBoundary = asRecord(externalDependencyPlan?.claimBoundary);

  gate("mvpGoal", str(record.mvpGoal).trim().length > 0, "mvpGoal is empty");
  gate("screensPresent", screens.length > 0, "screens[] is empty");
  gate(
    "screensWithinBound",
    screens.length <= maxScreens,
    `screens=${screens.length} > maxScreens=${maxScreens} (scope creep; keep the smallest screen that proves the concept)`,
  );

  screens.forEach((s, i) => {
    const label = str(s.name) || `#${i}`;
    gate(`screen[${i}].primaryControl`, str(s.primaryControl).trim().length > 0, `screen "${label}" has no primaryControl (no user action)`);
    gate(`screen[${i}].stateOutput`, str(s.stateOutput).trim().length > 0, `screen "${label}" has no stateOutput (nothing visibly changes)`);
  });

  gate("dataModelPresent", dataModel.length > 0, "dataModel[] is empty (builder will invent the shape)");
  dataModel.forEach((d, i) => {
    const label = str(d.name) || `#${i}`;
    const fields = asArray(d.fields).map(str).filter(Boolean);
    const sampleRecord = asRecord(d.sampleShape);
    const sampleShapeOk =
      str(d.sampleShape).trim().length >= MIN_SAMPLE_SHAPE_LEN ||
      (sampleRecord !== null &&
        fields.length > 0 &&
        fields.every((field) => {
          const value = sampleRecord[field];
          return value !== null && value !== undefined && String(value).trim().length > 0;
        }));
    gate(
      `dataModel[${i}].sampleShape`,
      sampleShapeOk,
      `dataModel "${label}" has a thin/empty sampleShape or is missing field values (builder must not guess the data)`,
    );
  });

  gate("acceptanceCriteria", asArray(record.acceptanceCriteria).length > 0, "acceptanceCriteria[] is empty");

  gate(
    "externalDependencyPlan.present",
    externalDependencyPlan !== null,
    "externalDependencyPlan missing (builder cannot know whether APIs are none/proposed/mocked/live)",
  );
  if (externalDependencyPlan) {
    const mode = str(externalDependencyPlan.externalDependencyMode);
    gate(
      "externalDependencyPlan.mode",
      VALID_EXTERNAL_DEPENDENCY_MODES.includes(mode),
      `externalDependencyMode must be one of ${VALID_EXTERNAL_DEPENDENCY_MODES.join("|")}`,
    );
    gate(
      "externalDependencyPlan.autoPublishableMode",
      mode !== "live_required",
      "live_required should be routed to human review, not initial MVP auto-publish",
    );
    gate(
      "externalDependencyPlan.claimBoundary",
      claimBoundary !== null &&
        asArray(claimBoundary.publicCopyMustSay).length > 0 &&
        asArray(claimBoundary.publicCopyMustNotSay).length > 0,
      "claimBoundary.publicCopyMustSay[] and publicCopyMustNotSay[] are required",
    );
  }

  gate("proofPlan.present", proof !== null, "interactionProofPlan missing (cannot prove it is not a static mockup)");
  if (proof) {
    const hasManualFallback = str(proof.manualFallbackReason).trim().length > 0;
    gate("proofPlan.primaryAction", str(proof.primaryAction).trim().length > 0, "interactionProofPlan.primaryAction empty");
    gate("proofPlan.expectedState", str(proof.expectedState).trim().length > 0, "interactionProofPlan.expectedState empty");
    gate("proofPlan.visibleEvidence", asArray(proof.visibleEvidence).length > 0, "interactionProofPlan.visibleEvidence[] empty");
    // requiredSourceFiles は自動証明前提。manualFallbackReason がある時だけ免除する。
    gate(
      "proofPlan.requiredSourceFiles",
      hasManualFallback || asArray(proof.requiredSourceFiles).length > 0,
      "interactionProofPlan.requiredSourceFiles[] empty (and no manualFallbackReason)",
    );
  }

  const score = total === 0 ? 0 : Number((passed / total).toFixed(4));
  return { ok: issues.length === 0, score, passed, total, issues };
};

/** concept 候補群の多様性指標。 */
export const conceptDiversity = (response: unknown): ConceptDiversity => {
  const candidates = conceptCandidates(response);
  const titles = candidates.map((candidate) => `${str(candidate.title)} ${str(candidate.oneLiner)}`);
  return {
    candidateCount: candidates.length,
    distinctTemplatePatternIds: distinctCount(
      candidates.map((candidate) => str(candidate.templatePatternId)),
    ),
    distinctSurfacePatterns: distinctCount(
      candidates.map((candidate) => str(candidate.surfacePattern)),
    ),
    distinctAiMechanismPatterns: distinctCount(
      candidates.map((candidate) => str(candidate.aiMechanismPattern)),
    ),
    pairwiseTitleJaccard: pairwiseMaxJaccard(titles),
  };
};

const VALID_NAME_PATTERNS = [
  "coined_compound",
  "japanese_rooted",
  "scene_phrase",
  "object_metaphor",
  "trust_repair",
  "ai_pun",
  "everyday_japanese",
  "companion_persona",
  "visible_transformation",
  "ecosystem_callout",
  "plain_utility",
];

const VALID_CONCEPT_ARCHETYPES = [
  "transformation",
  "what_if_simulation",
  "companion_persona",
  "judgment_arena",
  "field_compass",
  "hidden_map",
  "time_machine",
  "maker_kit",
];

const CONDITIONAL_CONCEPT_ARCHETYPES = ["hidden_map", "time_machine", "maker_kit"];

const REQUIRED_NAME_SCORE_KEYS = [
  "pronounceability",
  "scene",
  "curiosity",
  "specificity",
  "aiFit",
  "fieldGroundedness",
  "visibleTransformation",
  "memorability",
  "safetyFit",
];

const GENERIC_TITLE_RE =
  /(^|\s)(AI|Agentic?|Gemini|MCP)?\s*[^、。]{0,18}(支援ツール|支援システム|管理システム|ダッシュボード|サポーター|アシスタント|分析ツール|生成ツール)$/iu;

const TITLE_WITH_AI_PREFIX_RE =
  /^(AI|Agentic?|Gemini|MCP)\s*[\p{L}\p{N}ーぁ-んァ-ン一-龯]{2,}(ツール|支援|サポーター|アシスタント|システム|ダッシュボード)$/iu;

const titleLooksGeneric = (title: string): boolean =>
  GENERIC_TITLE_RE.test(title.trim()) || TITLE_WITH_AI_PREFIX_RE.test(title.trim());

const visibleLength = (text: string): number => Array.from(text.trim()).length;

const titleLooksEnglishOrMixed = (title: string): boolean => {
  const trimmed = title.trim();
  if (!trimmed) return false;
  const asciiLetters = trimmed.match(/[A-Za-z]/g)?.length ?? 0;
  return asciiLetters >= 3;
};

const hasCompleteNameScores = (candidate: Record<string, unknown>): boolean => {
  const scores = asRecord(candidate.nameScores);
  if (!scores) return false;
  return REQUIRED_NAME_SCORE_KEYS.every((key) => {
    const value = num(scores[key]);
    return value !== null && value >= 1 && value <= 5;
  });
};

const hasEnoughStructuredNameCandidates = (candidate: Record<string, unknown>): boolean => {
  const nameCandidates = asArray(candidate.nameCandidates)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  if (nameCandidates.length < 5) return false;

  return nameCandidates.every(
    (entry) =>
      str(entry.name).trim().length > 0 &&
      VALID_NAME_PATTERNS.includes(str(entry.pattern)) &&
      str(entry.reason).trim().length >= 6,
  );
};

const findSelectedConcept = (response: unknown): Record<string, unknown> | null => {
  const record = asRecord(response);
  if (!record) return null;
  const selected = asRecord(record.selectedConcept);
  const selectedId = str(selected?.id || record.selectedConcept);
  if (!selectedId) return null;
  return conceptCandidates(response).find((candidate) => str(candidate.id) === selectedId) ?? null;
};

export const conceptNameQuality = (response: unknown): ConceptNameQuality => {
  const candidates = conceptCandidates(response);
  const count = (predicate: (candidate: Record<string, unknown>) => boolean) =>
    candidates.filter(predicate).length;
  const usedNamePatterns = candidates.map((candidate) => str(candidate.namePatternUsed));

  return {
    candidatesWithEnoughNameCandidates: count(hasEnoughStructuredNameCandidates),
    candidatesWithNamePattern: count((candidate) =>
      VALID_NAME_PATTERNS.includes(str(candidate.namePatternUsed)),
    ),
    candidatesWithCompleteNameScores: count(hasCompleteNameScores),
    candidatesWithSelectedNameRationale: count(
      (candidate) => str(candidate.nameSelectionReason).trim().length >= 12,
    ),
    candidatesWithVisibleAiTransformation: count(
      (candidate) => str(candidate.aiVisibleTransformation).trim().length >= 12,
    ),
    candidatesWithFirstScreenHook: count(
      (candidate) => str(candidate.firstScreenHook).trim().length >= 12,
    ),
    candidatesWithCuriosityHook: count(
      (candidate) => str(candidate.curiosityHook).trim().length >= 12,
    ),
    candidatesWithBoringNameAvoided: count(
      (candidate) => str(candidate.badNameAvoided).trim().length >= 8,
    ),
    englishOrMixedTitleCount: count((candidate) => titleLooksEnglishOrMixed(str(candidate.title))),
    distinctNamePatternsUsed: distinctCount(usedNamePatterns),
    genericTitleCount: count((candidate) => titleLooksGeneric(str(candidate.title))),
    overlongTitleCount: count((candidate) => visibleLength(str(candidate.title)) > 32),
  };
};

export const conceptSharpnessQuality = (response: unknown): ConceptSharpnessQuality => {
  const candidates = conceptCandidates(response);
  const selected = findSelectedConcept(response);
  const count = (predicate: (candidate: Record<string, unknown>) => boolean) =>
    candidates.filter(predicate).length;
  const archetypes = candidates.map((candidate) => str(candidate.conceptArchetype));
  const conditionalCount = count((candidate) =>
    CONDITIONAL_CONCEPT_ARCHETYPES.includes(str(candidate.conceptArchetype)),
  );

  return {
    candidatesWithValidArchetype: count((candidate) =>
      VALID_CONCEPT_ARCHETYPES.includes(str(candidate.conceptArchetype)),
    ),
    distinctConceptArchetypes: distinctCount(archetypes),
    candidatesWithHumanHook: count((candidate) => str(candidate.humanHook).trim().length >= 10),
    candidatesWithBeforeAfter: count((candidate) => str(candidate.beforeAfter).trim().length >= 12),
    candidatesWithSurpriseMoment: count(
      (candidate) => str(candidate.surpriseMoment).trim().length >= 10,
    ),
    candidatesWithFirstScreenDrama: count(
      (candidate) => str(candidate.firstScreenDrama).trim().length >= 12,
    ),
    candidatesWithShareLine: count((candidate) => str(candidate.shareLine).trim().length >= 8),
    candidatesWithBoringVersionAvoided: count(
      (candidate) => str(candidate.boringVersionAvoided).trim().length >= 8,
    ),
    candidatesWithRiskScores: count((candidate) => {
      const aiRisk = num(candidate.aiIntrospectionRisk);
      const domainRisk = num(candidate.domainOpacityRisk);
      return aiRisk !== null && aiRisk >= 1 && aiRisk <= 5 && domainRisk !== null && domainRisk >= 1 && domainRisk <= 5;
    }),
    candidatesWithRiskSelectionNote: count(
      (candidate) => str(candidate.riskSelectionNote).trim().length >= 12,
    ),
    conditionalArchetypesUsed: conditionalCount,
    conditionalArchetypesWithJustification: count((candidate) => {
      if (!CONDITIONAL_CONCEPT_ARCHETYPES.includes(str(candidate.conceptArchetype))) {
        return false;
      }
      return str(candidate.conditionalArchetypeJustification).trim().length >= 12;
    }),
    selectedAiIntrospectionRisk: selected ? num(selected.aiIntrospectionRisk) : null,
    selectedDomainOpacityRisk: selected ? num(selected.domainOpacityRisk) : null,
  };
};

// research出力サイズの決定論ゲート。researcher.mdの出力サイズ規則(sourceProductCards<=12等)は
// プロンプト単独では守りきれない(2026-07-08 eval実測: 上限12を明示しても16カード・重複IDを出力)。
// サイズ超過はMAX_TOKENS切断(=JSON全損)の主因なので、guided retryに乗せて縮小再生成させる。
// researchの内容品質は下流ゲート/judgeの担当で、ここでは切断事故につながるサイズ違反だけを見る。
// なお finishReason=STOP でも件数超過は起き、guided retry が4/4失敗して生成が丸ごと止まる事故が
// 2026-07-09に発生した(agent_s他)。run-gemini はこのゲートの直前で clampResearchOutput() により
// 決定論的にキャップ内へ縮小するため、このゲートは clamp のバックストップとして機能する。
export const RESEARCH_MAX_SOURCE_PRODUCT_CARDS = 12;
export const RESEARCH_MAX_COMBINATION_HINTS = 10;

export const researchQuality = (response: unknown): StepQuality => {
  const record = asRecord(response);
  const issues: StepQualityIssue[] = [];
  let passed = 0;
  let total = 0;
  const gate = (check: string, ok: boolean, detail: string) => {
    total += 1;
    if (ok) passed += 1;
    else issues.push({ check, detail });
  };

  if (!record) {
    return { ok: false, score: 0, passed: 0, total: 1, issues: [{ check: "shape", detail: "non-object response" }] };
  }

  const cards = asArray(record.sourceProductCards);
  const hints = asArray(record.combinationHints);
  gate(
    "sourceProductCardsCap",
    cards.length <= RESEARCH_MAX_SOURCE_PRODUCT_CARDS,
    `sourceProductCards=${cards.length}; expected <=${RESEARCH_MAX_SOURCE_PRODUCT_CARDS} — emit ONLY the entries selected in the index snapshot and drop the weakest extras`,
  );
  const cardIds = cards
    .map((card) => str(asRecord(card)?.id))
    .filter((id) => id.length > 0);
  gate(
    "sourceProductCardIdsUnique",
    new Set(cardIds).size === cardIds.length,
    "duplicate sourceProductCards ids detected; each selected entry must appear exactly once",
  );
  gate(
    "combinationHintsCap",
    hints.length <= RESEARCH_MAX_COMBINATION_HINTS,
    `combinationHints=${hints.length}; expected <=${RESEARCH_MAX_COMBINATION_HINTS}`,
  );

  const score = total === 0 ? 0 : Number((passed / total).toFixed(4));
  return { ok: issues.length === 0, score, passed, total, issues };
};

export type ResearchClampResult = {
  value: unknown;
  cardsOverCap: number;
  hintsOverCap: number;
  dupesRemoved: number;
};

// research出力を決定論的にキャップ内へ正規化する(researchQualityゲートの手前で呼ぶbackstop)。
// sourceProductCardsをidで重複排除し、配列順(=モデルが付けた優先度。researcher.mdで強い順に並べさせる)の
// 先頭からキャップ件数だけ残す。combinationHintsも同様に切り詰める。プロンプト強化だけでは上限を守りきれず、
// guided retryが全滅して生成が止まる事故があったため、ここで確定的に縮小して通す。元の配列がそもそも配列でない
// (欠落)場合は形状を変えない。何も削らなかった場合は入力をそのまま返す。
export const clampResearchOutput = (response: unknown): ResearchClampResult => {
  const record = asRecord(response);
  if (!record) return { value: response, cardsOverCap: 0, hintsOverCap: 0, dupesRemoved: 0 };

  const cards = asArray(record.sourceProductCards);
  const hints = asArray(record.combinationHints);

  const seen = new Set<string>();
  let dupesRemoved = 0;
  const dedupedCards = cards.filter((card) => {
    const id = str(asRecord(card)?.id);
    if (!id) return true; // id無しは一意性ゲートの対象外なので保持する
    if (seen.has(id)) {
      dupesRemoved += 1;
      return false;
    }
    seen.add(id);
    return true;
  });

  const clampedCards = dedupedCards.slice(0, RESEARCH_MAX_SOURCE_PRODUCT_CARDS);
  const clampedHints = hints.slice(0, RESEARCH_MAX_COMBINATION_HINTS);
  const cardsOverCap = dedupedCards.length - clampedCards.length;
  const hintsOverCap = hints.length - clampedHints.length;

  if (cardsOverCap === 0 && hintsOverCap === 0 && dupesRemoved === 0) {
    return { value: response, cardsOverCap: 0, hintsOverCap: 0, dupesRemoved: 0 };
  }

  const value: Record<string, unknown> = { ...record };
  if (Array.isArray(record.sourceProductCards)) value.sourceProductCards = clampedCards;
  if (Array.isArray(record.combinationHints)) value.combinationHints = clampedHints;

  return { value, cardsOverCap, hintsOverCap, dupesRemoved };
};

export const conceptQuality = (response: unknown): StepQuality => {
  const diversity = conceptDiversity(response);
  const nameQuality = conceptNameQuality(response);
  const sharpnessQuality = conceptSharpnessQuality(response);
  const issues: StepQualityIssue[] = [];
  const warnings: StepQualityIssue[] = [];
  let passed = 0;
  let total = 0;
  const gate = (check: string, ok: boolean, detail: string) => {
    total += 1;
    if (ok) passed += 1;
    else issues.push({ check, detail });
  };
  const warnGate = (check: string, ok: boolean, detail: string) => {
    total += 1;
    if (ok) passed += 1;
    else warnings.push({ check, detail });
  };

  gate("candidateCount", diversity.candidateCount >= 3, `candidateCount=${diversity.candidateCount}; expected >=3`);
  gate("distinctTemplatePatternIds", diversity.distinctTemplatePatternIds >= 3, `distinctTemplatePatternIds=${diversity.distinctTemplatePatternIds}; expected >=3`);
  warnGate("distinctSurfacePatterns", diversity.distinctSurfacePatterns >= 3, `distinctSurfacePatterns=${diversity.distinctSurfacePatterns}; expected >=3`);
  gate("distinctAiMechanismPatterns", diversity.distinctAiMechanismPatterns >= 3, `distinctAiMechanismPatterns=${diversity.distinctAiMechanismPatterns}; expected >=3`);
  gate("pairwiseTitleJaccard", diversity.pairwiseTitleJaccard < 0.4, `pairwiseTitleJaccard=${diversity.pairwiseTitleJaccard}; expected <0.4`);
  gate(
    "nameCandidates",
    nameQuality.candidatesWithEnoughNameCandidates === diversity.candidateCount,
    `candidatesWithEnoughNameCandidates=${nameQuality.candidatesWithEnoughNameCandidates}/${diversity.candidateCount}; expected all candidates to provide >=5 nameCandidates`,
  );
  gate(
    "namePatternUsed",
    nameQuality.candidatesWithNamePattern === diversity.candidateCount,
    `candidatesWithNamePattern=${nameQuality.candidatesWithNamePattern}/${diversity.candidateCount}; expected one valid namePatternUsed per candidate`,
  );
  gate(
    "nameScores",
    nameQuality.candidatesWithCompleteNameScores === diversity.candidateCount,
    `candidatesWithCompleteNameScores=${nameQuality.candidatesWithCompleteNameScores}/${diversity.candidateCount}; expected complete 1..5 nameScores`,
  );
  gate(
    "nameSelectionReason",
    nameQuality.candidatesWithSelectedNameRationale === diversity.candidateCount,
    `candidatesWithSelectedNameRationale=${nameQuality.candidatesWithSelectedNameRationale}/${diversity.candidateCount}; expected selected-name rationale`,
  );
  gate(
    "aiVisibleTransformation",
    nameQuality.candidatesWithVisibleAiTransformation === diversity.candidateCount,
    `candidatesWithVisibleAiTransformation=${nameQuality.candidatesWithVisibleAiTransformation}/${diversity.candidateCount}; expected visible AI transformation`,
  );
  gate(
    "firstScreenHook",
    nameQuality.candidatesWithFirstScreenHook === diversity.candidateCount,
    `candidatesWithFirstScreenHook=${nameQuality.candidatesWithFirstScreenHook}/${diversity.candidateCount}; expected first-screen hook`,
  );
  gate(
    "curiosityHook",
    nameQuality.candidatesWithCuriosityHook === diversity.candidateCount,
    `candidatesWithCuriosityHook=${nameQuality.candidatesWithCuriosityHook}/${diversity.candidateCount}; expected curiosity hook`,
  );
  gate(
    "badNameAvoided",
    nameQuality.candidatesWithBoringNameAvoided === diversity.candidateCount,
    `candidatesWithBoringNameAvoided=${nameQuality.candidatesWithBoringNameAvoided}/${diversity.candidateCount}; expected explicit rejected boring name`,
  );
  gate(
    "englishOrMixedTitle",
    nameQuality.englishOrMixedTitleCount >= 1,
    `englishOrMixedTitleCount=${nameQuality.englishOrMixedTitleCount}; expected at least one English/mixed final title`,
  );
  warnGate(
    "distinctNamePatternsUsed",
    nameQuality.distinctNamePatternsUsed >= 3,
    `distinctNamePatternsUsed=${nameQuality.distinctNamePatternsUsed}; expected >=3 namePatternUsed values across candidates`,
  );
  gate("noGenericTitles", nameQuality.genericTitleCount === 0, `genericTitleCount=${nameQuality.genericTitleCount}; avoid AI/support/dashboard/system labels`);
  gate("shortTitles", nameQuality.overlongTitleCount === 0, `overlongTitleCount=${nameQuality.overlongTitleCount}; keep title <=32 visible characters`);
  gate(
    "conceptArchetype",
    sharpnessQuality.candidatesWithValidArchetype === diversity.candidateCount,
    `candidatesWithValidArchetype=${sharpnessQuality.candidatesWithValidArchetype}/${diversity.candidateCount}; expected one of the 8 concept archetypes`,
  );
  gate(
    "distinctConceptArchetypes",
    sharpnessQuality.distinctConceptArchetypes >= 2,
    `distinctConceptArchetypes=${sharpnessQuality.distinctConceptArchetypes}; expected >=2 without forcing weak archetype spread`,
  );
  gate(
    "humanHook",
    sharpnessQuality.candidatesWithHumanHook === diversity.candidateCount,
    `candidatesWithHumanHook=${sharpnessQuality.candidatesWithHumanHook}/${diversity.candidateCount}; expected human-interest hook`,
  );
  gate(
    "beforeAfter",
    sharpnessQuality.candidatesWithBeforeAfter === diversity.candidateCount,
    `candidatesWithBeforeAfter=${sharpnessQuality.candidatesWithBeforeAfter}/${diversity.candidateCount}; expected concrete before/after`,
  );
  gate(
    "surpriseMoment",
    sharpnessQuality.candidatesWithSurpriseMoment === diversity.candidateCount,
    `candidatesWithSurpriseMoment=${sharpnessQuality.candidatesWithSurpriseMoment}/${diversity.candidateCount}; expected visible surprise moment`,
  );
  gate(
    "firstScreenDrama",
    sharpnessQuality.candidatesWithFirstScreenDrama === diversity.candidateCount,
    `candidatesWithFirstScreenDrama=${sharpnessQuality.candidatesWithFirstScreenDrama}/${diversity.candidateCount}; expected first-screen drama`,
  );
  gate(
    "shareLine",
    sharpnessQuality.candidatesWithShareLine === diversity.candidateCount,
    `candidatesWithShareLine=${sharpnessQuality.candidatesWithShareLine}/${diversity.candidateCount}; expected shareable line`,
  );
  gate(
    "boringVersionAvoided",
    sharpnessQuality.candidatesWithBoringVersionAvoided === diversity.candidateCount,
    `candidatesWithBoringVersionAvoided=${sharpnessQuality.candidatesWithBoringVersionAvoided}/${diversity.candidateCount}; expected avoided boring version`,
  );
  gate(
    "riskScores",
    sharpnessQuality.candidatesWithRiskScores === diversity.candidateCount,
    `candidatesWithRiskScores=${sharpnessQuality.candidatesWithRiskScores}/${diversity.candidateCount}; expected 1..5 aiIntrospectionRisk and domainOpacityRisk`,
  );
  gate(
    "riskSelectionNote",
    sharpnessQuality.candidatesWithRiskSelectionNote === diversity.candidateCount,
    `candidatesWithRiskSelectionNote=${sharpnessQuality.candidatesWithRiskSelectionNote}/${diversity.candidateCount}; expected risk selection note`,
  );
  gate(
    "selectedAiIntrospectionRisk",
    sharpnessQuality.selectedAiIntrospectionRisk !== null &&
      sharpnessQuality.selectedAiIntrospectionRisk <= 3,
    `selectedAiIntrospectionRisk=${sharpnessQuality.selectedAiIntrospectionRisk}; selected concept should not be AI-introspection heavy`,
  );
  gate(
    "selectedDomainOpacityRisk",
    sharpnessQuality.selectedDomainOpacityRisk !== null &&
      sharpnessQuality.selectedDomainOpacityRisk <= 3,
    `selectedDomainOpacityRisk=${sharpnessQuality.selectedDomainOpacityRisk}; selected concept should be understandable without specialist context`,
  );
  gate(
    "conditionalArchetypeJustification",
    sharpnessQuality.conditionalArchetypesWithJustification === sharpnessQuality.conditionalArchetypesUsed,
    `conditionalArchetypesWithJustification=${sharpnessQuality.conditionalArchetypesWithJustification}/${sharpnessQuality.conditionalArchetypesUsed}; hidden_map/time_machine/maker_kit need justification`,
  );

  return {
    ok: issues.length === 0,
    score: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    passed,
    total,
    issues,
    warnings,
  };
};

const VALID_ARTIFACT_TIERS = ["static_mvp", "proposed_integration", "mocked_integration_mvp", "live_integration_candidate"];
const AUTO_PUBLISHABLE_EXTERNAL_MODES = ["none", "proposed", "mocked_adapter"];
// コアロジックファースト契約（2026-07-07）: 生成物の主体は source/core/** の実処理ロジック＋
// sample-trace を再生する最小ランナーページ。UI部品(components/)・styles.css は要求しない。
// gemini.ts / sample-input.ts / steps/* はプロンプト必須だがハードゲート対象外（リトライコスト抑制）。
const REQUIRED_BUILD_FILES = [
  "README.md",
  "metadata.json",
  "manifest.json",
  "source/app/page.tsx",
  "source/core/pipeline.ts",
  "source/data/sample-trace.ts",
  "validation/self-review.json",
];

const stringArrayHas = (value: unknown, expected: string) =>
  asArray(value).some((item) => str(item) === expected);

const fileEntries = (record: Record<string, unknown>) =>
  asArray(record.files)
    .map(asRecord)
    .filter((file): file is Record<string, unknown> => file !== null);

const allFileText = (files: Record<string, unknown>[]) =>
  files
    .map((file) => str(file.content))
    .filter(Boolean)
    .join("\n");

export const builderQuality = (plan: unknown): StepQuality => {
  const record = asRecord(plan);
  const issues: StepQualityIssue[] = [];
  let passed = 0;
  let total = 0;
  const gate = (check: string, ok: boolean, detail: string) => {
    total += 1;
    if (ok) passed += 1;
    else issues.push({ check, detail });
  };

  if (!record) {
    return { ok: false, score: 0, passed: 0, total: 1, issues: [{ check: "shape", detail: "non-object response" }] };
  }

  const files = fileEntries(record);
  const filePaths = files.map((file) => str(file.path));
  const sourceText = allFileText(files);
  const interactionModel = asRecord(record.interactionModel);
  const proof = asRecord(record.interactionProofPlan);
  const mvpContract = asRecord(record.mvpContract);
  const mvpContractV2 = asRecord(record.mvpContractV2);
  const runtimeBoundary = asRecord(mvpContractV2?.runtimeBoundary);
  const claimBoundary = asRecord(mvpContractV2?.claimBoundary);
  const renderVerification = asRecord(mvpContractV2?.renderVerification);

  gate("framework", str(record.framework) === "next_static_artifact", "framework must be next_static_artifact");
  gate("filesPresent", files.length > 0, "files[] is empty");
  // 公開ページ「何が面白いか」に出る訴求コピー。薄い/欠落だとフィードが弱くなるため、
  // 新規性×差別化×技術トレンドを織り込んだ実体のある本文を必須化する（>=80字）。
  gate(
    "interestingness",
    str(record.interestingness).trim().length >= 80,
    `interestingness must be substantial appeal copy weaving novelty/differentiation/tech-trend (>=80 chars); got ${str(record.interestingness).trim().length}`,
  );
  // トップフィード/詳細ページ「名前直下の一文キャッチコピー」。存在する場合のみ、決定論正規化
  // (normalizeShortTagline)が非nullを返すこと(=40字以内に収まる読める句)を検証する。
  // presence は必須化しない: response-level eval は baseline(旧プロンプト)応答も作業ツリーの
  // このメトリクスで検証するため、presence 必須だと baseline 側が必ず落ちて前後比較にならない。
  // presence の担保は builder.md の REQUIRED 節と publish 側フォールバックが担う。
  const shortTaglineRaw = str(record.shortTagline).trim();
  if (shortTaglineRaw) {
    gate(
      "shortTagline.normalizable",
      normalizeShortTagline(shortTaglineRaw) !== null,
      `shortTagline must normalize to a non-empty catch copy within ${SHORT_TAGLINE_MAX_CHARS} chars; got ${[...shortTaglineRaw].length} chars: ${shortTaglineRaw.slice(0, 60)}`,
    );
  }
  // 公開時 Project.categoryId の第1候補。存在する場合のみカタログ内 id であることを検証する
  // (shortTagline と同じ理由で presence は必須化しない。欠落時は publish 側の決定論フォールバックが解決する)。
  const categoryIdRaw = str(record.categoryId).trim();
  if (categoryIdRaw) {
    gate(
      "categoryId.catalog",
      isProductCategoryId(categoryIdRaw),
      `categoryId must be one of the product category catalog ids; got ${categoryIdRaw}`,
    );
  }
  for (const requiredFile of REQUIRED_BUILD_FILES) {
    gate(`requiredFile.${requiredFile}`, filePaths.includes(requiredFile), `${requiredFile} is missing from files[]`);
  }
  files.forEach((file, index) => {
    gate(`files[${index}].path`, str(file.path).length > 0, `files[${index}].path missing`);
    gate(`files[${index}].purpose`, str(file.purpose).length > 0, `files[${index}].purpose missing`);
    gate(`files[${index}].content`, str(file.content).length > 0, `files[${index}].content missing or empty`);
  });

  gate("interactionModel.present", interactionModel !== null, "interactionModel missing");
  if (interactionModel) {
    gate("interactionModel.states", asArray(interactionModel.states).length > 0, "interactionModel.states[] empty");
    const transitions = asArray(interactionModel.transitions).map(asRecord).filter(Boolean);
    gate("interactionModel.transitions", transitions.length > 0, "interactionModel.transitions[] empty");
    transitions.forEach((transition, index) => {
      if (!transition) return;
      gate(`interactionModel.transitions[${index}].visibleChange`, str(transition.visibleChange).length > 0, "visibleChange missing");
    });
  }

  gate("interactionProofPlan.present", proof !== null, "interactionProofPlan missing");
  if (proof) {
    gate("interactionProofPlan.primaryAction", str(proof.primaryAction).length > 0, "primaryAction missing");
    gate("interactionProofPlan.expectedState", str(proof.expectedState).length > 0, "expectedState missing");
    const evidenceList = asArray(proof.visibleEvidence).map(str).filter(Boolean);
    const proofSelectorList = asArray(proof.proofSelectors).map(str).filter(Boolean);
    gate("interactionProofPlan.visibleEvidence", evidenceList.length > 0, "visibleEvidence[] empty");
    gate("interactionProofPlan.proofSelectors", proofSelectorList.length > 0, "proofSelectors[] empty");
    gate("interactionProofPlan.requiredSourceFiles", asArray(proof.requiredSourceFiles).length > 0, "requiredSourceFiles[] empty");
    // コアロジックファースト契約: 対話証明はランナーページ＋sample-trace に固定する。
    // 「選択後にしか出ないボタン」等を primaryAction に宣言する逸脱（render proof で必ず落ちる）を
    // 生成時点で弾き、リトライで矯正する。
    const requiredSourceFileList = asArray(proof.requiredSourceFiles).map(str);
    gate(
      "interactionProofPlan.requiredSourceFiles.entry",
      requiredSourceFileList.includes("source/app/page.tsx"),
      "requiredSourceFiles[] must include source/app/page.tsx (the runner page implements the proof)",
    );
    gate(
      "interactionProofPlan.requiredSourceFiles.sampleTrace",
      requiredSourceFileList.includes("source/data/sample-trace.ts"),
      "requiredSourceFiles[] must include source/data/sample-trace.ts (the replayed trace anchors the proof)",
    );

    // 品質の芯は「検証可能な静的アンカー/証跡が最低1つ存在する」こと。builder は稀にリスト描画
    // された1行分の per-item セレクタ（例 data-proof="option-card-<id>"）を混ぜ、それだけが静的
    // リテラルにならない。以前は「宣言した全てが静的」を要求して生成全体を落としていたが、
    // 「静的に存在する data-proof/属性が1つ以上」に緩める。実アーティファクトは他の静的アンカーで
    // 十分に検証可能で、動的1件で高コストな生成を捨てる必要はない。
    const selectorIsStaticInSource = (selector: string): boolean => {
      let sawCheckable = false;
      const proofName = selector.match(/data-proof=['"]([^'"]+)['"]/)?.[1];
      if (proofName) {
        sawCheckable = true;
        if (!(sourceText.includes(`data-proof="${proofName}"`) || sourceText.includes(`data-proof='${proofName}'`))) {
          return false;
        }
      }
      for (const match of selector.matchAll(/\[([A-Za-z_:-][\w:.-]*)=['"]([^'"]+)['"]\]/g)) {
        sawCheckable = true;
        const [, attrName, attrValue] = match;
        if (!(sourceText.includes(`${attrName}="${attrValue}"`) || sourceText.includes(`${attrName}='${attrValue}'`))) {
          return false;
        }
      }
      return sawCheckable;
    };
    const evidencePresent = evidenceList.filter((evidence) => sourceText.includes(evidence));
    const staticSelectors = proofSelectorList.filter(selectorIsStaticInSource);
    gate(
      "interactionProofPlan.visibleEvidencePresent",
      evidenceList.length === 0 || evidencePresent.length >= 1,
      `no visibleEvidence string appears verbatim in generated source (declared ${evidenceList.length})`,
    );
    gate(
      "interactionProofPlan.proofSelectorStaticPresent",
      proofSelectorList.length === 0 || staticSelectors.length >= 1,
      `no proofSelector resolves to a static literal in generated source (declared ${proofSelectorList.length})`,
    );
  }

  gate("mvpContract.present", mvpContract !== null, "mvpContract missing");
  if (mvpContract) {
    for (const field of ["firstScreenValue", "coreInteraction", "stateChange", "inspectableOutput", "staticDataBoundary"]) {
      gate(`mvpContract.${field}`, str(mvpContract[field]).length > 0, `${field} missing`);
    }
    for (const field of ["requiredFiles", "nonGoals", "forbiddenDependencies"]) {
      gate(`mvpContract.${field}`, asArray(mvpContract[field]).length > 0, `${field}[] empty`);
    }
  }

  gate("mvpContractV2.present", mvpContractV2 !== null, "mvpContractV2 missing");
  if (mvpContractV2) {
    gate("mvpContractV2.contractVersion", str(mvpContractV2.contractVersion) === "mvp-contract-v2", "contractVersion must be mvp-contract-v2");
    gate("mvpContractV2.artifactTier", VALID_ARTIFACT_TIERS.includes(str(mvpContractV2.artifactTier)), "artifactTier is invalid");
    gate("mvpContractV2.externalDependencyMode", VALID_EXTERNAL_DEPENDENCY_MODES.includes(str(mvpContractV2.externalDependencyMode)), "externalDependencyMode is invalid");
    gate("mvpContractV2.autoPublishableExternalMode", AUTO_PUBLISHABLE_EXTERNAL_MODES.includes(str(mvpContractV2.externalDependencyMode)), "live_required must be held for human review, not this initial builder path");
    gate("mvpContractV2.runtimeBoundary", runtimeBoundary !== null, "runtimeBoundary missing");
    if (runtimeBoundary) {
      gate("runtimeBoundary.networkCalls", runtimeBoundary.networkCalls === "none", "networkCalls must be none");
      gate("runtimeBoundary.secrets", runtimeBoundary.secrets === "none", "secrets must be none");
      gate("runtimeBoundary.externalWrites", runtimeBoundary.externalWrites === "none" || runtimeBoundary.externalWrites === "proposed", "externalWrites must be none or proposed");
    }
    gate(
      "mvpContractV2.claimBoundary",
      claimBoundary !== null &&
        asArray(claimBoundary.publicCopyMustSay).length > 0 &&
        asArray(claimBoundary.publicCopyMustNotSay).length > 0,
      "claimBoundary.publicCopyMustSay[] and publicCopyMustNotSay[] are required",
    );
    gate("mvpContractV2.renderVerification", renderVerification?.required === true, "renderVerification.required must be true");
    gate("mvpContractV2.requiredFiles.readme", stringArrayHas(mvpContractV2.requiredFiles, "README.md"), "mvpContractV2.requiredFiles must include README.md");
  }

  // source/core/** は「文書化された実呼び出しパターン」層で、デモ(entrypoint)から一切importされない。
  // そのため fetch はcore/内のみ許可し、デモ側(core/以外)では従来どおり禁止する。
  // process.env は全ファイルで禁止（apiKeyは関数引数で受ける契約）。
  const demoText = files
    .filter((file) => !str(file.path).startsWith("source/core/"))
    .map((file) => str(file.content))
    .filter(Boolean)
    .join("\n");
  gate(
    "source.noFetch",
    !/\bfetch\s*\(/.test(demoText),
    "generated source outside source/core/ must not call fetch()",
  );
  gate("source.noProcessEnv", !sourceText.includes("process.env"), "generated source must not read process.env");
  // モデルIDの世代固定: プロンプト指示だけでは builder が学習分布に引かれて gemini-1.x を書きがち
  // （実測: 指示済みでも 1.5-flash を出力）。非推奨世代はゲートで落としてリトライで矯正する。
  gate(
    "source.currentModelId",
    !/gemini-1\.[05]/i.test(sourceText),
    "source references a deprecated gemini-1.x model id; use a current fast model such as gemini-2.5-flash",
  );
  // render_proof は entrypoint の importグラフだけを esbuild でbundleする。page.tsx が core/ を
  // importすると、core側の未解決import・実行時副作用でrender proofごと壊れるため事前に弾く。
  const entryFile = files.find((file) => str(file.path) === "source/app/page.tsx");
  gate(
    "entry.noCoreImport",
    !entryFile || !/from\s+["'][^"']*\/core\//.test(str(entryFile.content)),
    "source/app/page.tsx must not import source/core/** — not even a type-only `import type {...} from '../core/types'` (this check rejects ANY core import). If the page needs types, re-declare them locally inside page.tsx (duplicating core/types.ts is fine) or type the data structurally from the sample-trace import",
  );
  // 参照整合: 全ファイルの相対importが files[] に実在するファイルへ解決できること。
  // esbuild は型専用importを黙って除去するため render proof では検出できず、
  // 「読み物としてのソース」に存在しないモジュール参照が残る（実測: core/types.ts 欠落）。
  const emittedPaths = new Set(filePaths);
  const relativeImportResolves = (fromPath: string, spec: string): boolean => {
    const parts = fromPath.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    const resolved = parts.join("/");
    return ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].some((suffix) =>
      emittedPaths.has(`${resolved}${suffix}`),
    );
  };
  const unresolvedImports: string[] = [];
  for (const file of files) {
    const filePath = str(file.path);
    if (!/\.(tsx?|jsx?)$/.test(filePath)) continue;
    for (const match of str(file.content).matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
      if (!relativeImportResolves(filePath, match[1])) {
        unresolvedImports.push(`${filePath} -> ${match[1]}`);
      }
    }
  }
  gate(
    "source.importsResolve",
    unresolvedImports.length === 0,
    `relative imports must resolve to files emitted in files[]; unresolved: ${unresolvedImports.slice(0, 3).join(", ")}`,
  );

  return {
    ok: issues.length === 0,
    score: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    passed,
    total,
    issues,
  };
};

/**
 * 準備済みプロンプト（prompt.md）に Phase1 の配線指示が含まれるかの key-free チェック。
 * APIキー無しでも回せる「配線が効いた」直接確認。
 */
export const promptWiringChecks = (
  step: StepName,
  promptText: string,
): Record<string, boolean> => {
  const text = promptText.toLowerCase();
  const has = (needle: string) => text.includes(needle.toLowerCase());

  if (step === "concept") {
    return {
      mentionsPreferredInputs: has("sourcePreferences") || has("preferredInputs"),
      mentionsConceptSelectionRules: has("conceptSelectionRules"),
      mentionsMaterialChoiceReason: has("materialChoiceReason"),
    };
  }
  if (step === "requirements") {
    return {
      mentionsPreferredInputs: has("sourcePreferences") || has("preferredInputs"),
      mentionsExternalDependencyPlan: has("externalDependencyPlan"),
      mentionsExternalDependencyMode: has("externalDependencyMode"),
      mentionsClaimBoundary: has("claimBoundary"),
    };
  }
  if (step === "builder") {
    return {
      mentionsDefaultTemplatePatterns: has("templatePatternPreferences") || has("defaultTemplatePatterns"),
      mentionsTemplateReconciliation:
        has("templateDivergenceReason") || has("preferredScreenTypes") || has("signatureScreen"),
      mentionsMvpContractV2: has("mvpContractV2"),
      mentionsMockedAdapter: has("mocked_adapter"),
      mentionsRuntimeBoundary: has("runtimeBoundary"),
      mentionsSourceTrace: has("sourceTrace") && has("antiCloneBoundary") && has("sourceEvidenceAudit"),
    };
  }
  if (step === "reviewer") {
    return {
      mentionsReviewerPolicy: has("reviewerPolicy") || has("reviewerAgent"),
      mentionsHackathonDemoChecks: has("hackathonDemoChecks"),
      mentionsLearningExtraction: has("learningExtraction"),
      mentionsRewriteResult: has("rewriteResult"),
      mentionsSourceTrace: has("sourceTrace") || has("sourceProvenance") || has("sourcePlan"),
    };
  }
  if (step === "rewriter") {
    return {
      mentionsReviewResult: has("reviewResult"),
      mentionsIssueResolutions: has("issueResolutions"),
      mentionsAddressedIssues: has("addressedReviewIssue"),
    };
  }
  if (step === "publisher") {
    return {
      mentionsValidation: has("validation"),
      mentionsMvpContractPass: has("mvpContractPass"),
      mentionsMvpContractV2: has("mvpContractV2") || has("check-mvp-contract-v2"),
      mentionsExternalDependencyMode: has("externalDependencyMode"),
      mentionsClaimBoundary: has("claimBoundary"),
      mentionsSafetyBlockers: has("safetyBlockers"),
      mentionsSourceTrace: has("sourceTrace") || has("sourceProvenance") || has("sourcePlan"),
      mentionsRewriteResult: has("rewriteResult"),
    };
  }
  return {};
};

/** prompt 内の templatePatternId enum が product-templates.json の id 集合と同期しているか。 */
export const templateCatalogSync = (
  promptText: string,
  catalogIds: string[],
): { ok: boolean; missing: string[]; present: string[] } => {
  const present = catalogIds.filter((id) => promptText.includes(id));
  const missing = catalogIds.filter((id) => !promptText.includes(id));
  return { ok: missing.length === 0, missing, present };
};

/**
 * concept の hard regression 判定（baseline が満たしていた品質を candidate が割ったか）。
 * 計画 §5 の停止条件に対応。
 */
export const conceptHardRegressions = (
  base: { schema: SchemaShape; diversity: ConceptDiversity },
  candidate: { schema: SchemaShape; diversity: ConceptDiversity },
): string[] => {
  const regressions: string[] = [];
  if (base.schema.ok && !candidate.schema.ok) {
    regressions.push(
      `concept schema-shape regressed (candidate missing: ${candidate.schema.missing.join(", ")})`,
    );
  }
  if (
    base.diversity.distinctTemplatePatternIds >= 3 &&
    candidate.diversity.distinctTemplatePatternIds < 3
  ) {
    regressions.push(
      `concept distinct templatePatternId dropped to ${candidate.diversity.distinctTemplatePatternIds} (was ${base.diversity.distinctTemplatePatternIds}, needs >=3)`,
    );
  }
  if (
    candidate.diversity.pairwiseTitleJaccard > 0.4 &&
    candidate.diversity.pairwiseTitleJaccard > base.diversity.pairwiseTitleJaccard
  ) {
    regressions.push(
      `concept candidates too similar: pairwise title Jaccard ${candidate.diversity.pairwiseTitleJaccard} > 0.4 (base ${base.diversity.pairwiseTitleJaccard})`,
    );
  }
  return regressions;
};

/** LLM-judge の加重合計が noise band を超えて低下したか。 */
export const judgeRegression = (
  baseScore: number,
  candidateScore: number,
  noiseBand = 0.5,
): string | null =>
  baseScore - candidateScore > noiseBand
    ? `LLM-judge weightedTotal dropped ${(baseScore - candidateScore).toFixed(2)} (> noise band ${noiseBand})`
    : null;

// ---- 後段(reviewer/rewriter/publisher)の hard regression（A-1）----
// response-level の base/cand 比較。プロンプト改悪で「判定が悪化」「解決カバレッジ低下」
// 「ゲート矛盾」が出たかを検出する。status の単発フリップは LLM ノイズも含むため、
// response-level（手動・APIキー時）でのシグナルとして扱う（CI の常時ゲートは source-level）。

const REVIEW_SCORE_DIMENSIONS = [
  "novelty",
  "notObviousInsight",
  "userClarity",
  "coreInteraction",
  "visualSpecificity",
  "codeFeasibility",
  "sourceInspectability",
  "artifactCompleteness",
  "safety",
  "differenceFromRecentArtifacts",
] as const;

const statusOf = (response: unknown): string => {
  const record = asRecord(response);
  return record ? str(record.status) : "";
};

/**
 * reviewer の weightedTotal を取得。response に scores.weightedTotal があればそれを使い、
 * 無ければ reviewer.md のルーブリック（coreInteraction/userClarity/safety を二重重み、13で割る）で算出。
 * 10次元が揃わない場合は null。
 */
export const reviewerWeightedTotal = (response: unknown): number | null => {
  const scores = asRecord(asRecord(response)?.scores);
  if (!scores) return null;
  const direct = Number(scores.weightedTotal);
  if (Number.isFinite(direct)) return direct;
  let sum = 0;
  let counted = 0;
  for (const dimension of REVIEW_SCORE_DIMENSIONS) {
    const value = Number(scores[dimension]);
    if (Number.isFinite(value)) {
      sum += value;
      counted += 1;
    }
  }
  if (counted < REVIEW_SCORE_DIMENSIONS.length) return null;
  const doubled = ["coreInteraction", "userClarity", "safety"].reduce(
    (acc, dimension) => acc + Number(scores[dimension] ?? 0),
    0,
  );
  return Number(((sum + doubled) / 13).toFixed(2));
};

/** reviewer: pass→否、hackathonDemoChecks の pass→否、weightedTotal の noiseBand 超え低下。 */
export const reviewerHardRegressions = (
  base: unknown,
  candidate: unknown,
  noiseBand = 0.5,
): string[] => {
  const regressions: string[] = [];
  const candStatus = statusOf(candidate);
  if (statusOf(base) === "pass" && candStatus && candStatus !== "pass") {
    regressions.push(`reviewer status regressed: pass -> ${candStatus}`);
  }
  const baseChecks = asRecord(asRecord(base)?.hackathonDemoChecks);
  const candChecks = asRecord(asRecord(candidate)?.hackathonDemoChecks);
  if (baseChecks && candChecks) {
    for (const key of Object.keys(baseChecks)) {
      const candValue = str(candChecks[key]);
      if (str(baseChecks[key]) === "pass" && candValue && candValue !== "pass") {
        regressions.push(`reviewer hackathonDemoChecks.${key} regressed: pass -> ${candValue}`);
      }
    }
  }
  const baseScore = reviewerWeightedTotal(base);
  const candScore = reviewerWeightedTotal(candidate);
  if (baseScore !== null && candScore !== null) {
    const reason = judgeRegression(baseScore, candScore, noiseBand);
    if (reason) regressions.push(`reviewer ${reason.replace("LLM-judge ", "")}`);
  }
  return regressions;
};

/** rewriter: revised→否、解決した review issue 数の減少。 */
export const rewriterHardRegressions = (base: unknown, candidate: unknown): string[] => {
  const regressions: string[] = [];
  const candStatus = statusOf(candidate);
  if (statusOf(base) === "revised" && candStatus && candStatus !== "revised") {
    regressions.push(`rewriter status regressed: revised -> ${candStatus}`);
  }
  const baseCount = asArray(asRecord(base)?.addressedReviewIssues).length;
  const candCount = asArray(asRecord(candidate)?.addressedReviewIssues).length;
  if (baseCount > candCount) {
    regressions.push(`rewriter addressed issue count dropped: ${baseCount} -> ${candCount}`);
  }
  return regressions;
};

/** publisher: publish→否、矛盾（reviewPass=false なのに status=publish）。 */
export const publisherHardRegressions = (base: unknown, candidate: unknown): string[] => {
  const regressions: string[] = [];
  const candStatus = statusOf(candidate);
  if (statusOf(base) === "publish" && candStatus && candStatus !== "publish") {
    regressions.push(`publisher status regressed: publish -> ${candStatus}`);
  }
  const candRecord = asRecord(candidate);
  if (candRecord && candRecord.reviewPass === false && str(candRecord.status) === "publish") {
    regressions.push("publisher contradiction: reviewPass=false but status=publish");
  }
  if (candRecord && candRecord.sourceTracePass === false && str(candRecord.status) === "publish") {
    regressions.push("publisher contradiction: sourceTracePass=false but status=publish");
  }
  return regressions;
};

export type HighRiskTopicCategory =
  | "medical"
  | "legal"
  | "financial"
  | "political_persuasion"
  | "personal_data";

export type HighRiskHoldCheck = {
  id: string;
  status: "pass" | "fail";
  message: string;
};

export type HighRiskHoldResult = {
  ok: boolean;
  categories: HighRiskTopicCategory[];
  checks: HighRiskHoldCheck[];
};

export type HighRiskTopicValidationCheck = {
  key: "high_risk_topic";
  status: "pass" | "fail";
  summary: string;
  categories: HighRiskTopicCategory[];
};

const HIGH_RISK_TOPIC_PATTERNS: Record<HighRiskTopicCategory, RegExp[]> = {
  medical: [
    /\bmedical\b/i,
    /\bdiagnos(?:e|is|tic)\b/i,
    /\btreatment\b/i,
    /\bdrug dosage\b/i,
    /\bpatient\b/i,
    /医療|診断|治療|服薬|投薬|症状/,
  ],
  legal: [
    /\blegal\b/i,
    /\blawsuit\b/i,
    /\bcontract advice\b/i,
    /\bliability\b/i,
    /\bimmigration\b/i,
    /法律|訴訟|契約助言|法的責任|弁護士/,
  ],
  financial: [
    /\bfinancial\b/i,
    /\binvest(?:ment|ing)?\b/i,
    /\bstock\b/i,
    /\bportfolio\b/i,
    /\bloan\b/i,
    /\btax\b/i,
    /金融|投資|株式|融資|税務|資産運用/,
  ],
  political_persuasion: [
    /\bpolitical persuasion\b/i,
    /\bcampaign\b/i,
    /\bvoter\b/i,
    /\belection\b/i,
    /\btargeted political\b/i,
    /政治説得|選挙|有権者|投票|政治キャンペーン/,
  ],
  personal_data: [
    /\bpersonal data\b/i,
    /\bpersonally identifiable\b/i,
    /\bPII\b/,
    /\bemail addresses?\b/i,
    /\bphone numbers?\b/i,
    /\bhome addresses?\b/i,
    /個人情報|個人データ|住所|電話番号|メールアドレス/,
  ],
};

const unknownToText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

export const detectHighRiskTopicCategories = (value: unknown): HighRiskTopicCategory[] => {
  const text = unknownToText(value);
  return (Object.entries(HIGH_RISK_TOPIC_PATTERNS) as [HighRiskTopicCategory, RegExp[]][])
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([category]) => category);
};

const collectTextForKeys = (value: unknown, keyPattern: RegExp): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextForKeys(item, keyPattern));
  }
  const record = asRecord(value);
  if (!record) return [];
  const matches: string[] = [];
  for (const [key, nested] of Object.entries(record)) {
    if (keyPattern.test(key)) matches.push(unknownToText(nested));
    matches.push(...collectTextForKeys(nested, keyPattern));
  }
  return matches.filter(Boolean);
};

export const conceptRequiresHumanReviewForHighRisk = (response: unknown): boolean => {
  const reviewSignal = collectTextForKeys(
    response,
    /humanReview|reviewTrigger|riskFlag|risk|safetyBoundar|claimBoundar|nonGoal/i,
  ).join("\n");
  if (!reviewSignal.trim()) return false;
  return /human review|manual review|human approval|hold_for_review|do not publish|not publish|block|escalat/i.test(
    reviewSignal,
  );
};

export const reviewerBlocksHighRisk = (response: unknown): boolean => {
  const record = asRecord(response);
  if (!record) return false;
  const recommendation = asRecord(record.publishRecommendation);
  const problems = asArray(record.problems).map(asRecord).filter(Boolean);
  const safetyScore = Number(asRecord(record.scores)?.safety);
  return (
    str(record.status) === "block" ||
    recommendation?.readyForRepresentativeDemo === false ||
    (Number.isFinite(safetyScore) && safetyScore < 3) ||
    problems.some((problem) => ["high", "blocker"].includes(str(problem?.severity)))
  );
};

export const publisherHoldsHighRisk = (response: unknown): boolean => {
  const record = asRecord(response);
  if (!record) return false;
  const status = str(record.status);
  if (status === "publish") return false;
  const safetyBlockers = asArray(record.safetyBlockers);
  return (
    status === "hold_for_review" ||
    status === "block" ||
    record.reviewPass === false ||
    safetyBlockers.length > 0
  );
};

export const highRiskTopicHoldChecks = (input: {
  topic: unknown;
  concept: unknown;
  reviewer: unknown;
  publisher: unknown;
  expectedCategories?: HighRiskTopicCategory[];
}): HighRiskHoldResult => {
  const categories = detectHighRiskTopicCategories([input.topic, input.concept]);
  const checks: HighRiskHoldCheck[] = [];
  const push = (id: string, ok: boolean, pass: string, fail: string) => {
    checks.push({ id, status: ok ? "pass" : "fail", message: ok ? pass : fail });
  };

  const expected = input.expectedCategories ?? [];
  push(
    "topic.highRiskDetected",
    categories.length > 0 && expected.every((category) => categories.includes(category)),
    `detected high-risk categories: ${categories.join(", ")}`,
    `missing expected high-risk categories: ${expected.filter((category) => !categories.includes(category)).join(", ") || "<none detected>"}`,
  );
  push(
    "concept.humanReviewHold",
    conceptRequiresHumanReviewForHighRisk(input.concept),
    "concept carries a human-review hold signal",
    "concept does not carry a human-review hold signal",
  );
  push(
    "reviewer.block",
    reviewerBlocksHighRisk(input.reviewer),
    "reviewer blocks or requires representative-demo review",
    "reviewer does not block or require review",
  );
  push(
    "publisher.hold",
    publisherHoldsHighRisk(input.publisher),
    "publisher holds or blocks publication",
    "publisher allows publication",
  );

  return {
    ok: checks.every((check) => check.status === "pass"),
    categories,
    checks,
  };
};

export const highRiskTopicValidationCheck = (evidence: unknown): HighRiskTopicValidationCheck => {
  const categories = detectHighRiskTopicCategories(evidence);
  return {
    key: "high_risk_topic",
    status: categories.length > 0 ? "fail" : "pass",
    summary:
      categories.length > 0
        ? `High-risk topic flag detected: ${categories.join(", ")}. Human review is required before publish or feature decisions.`
        : "No high-risk topic flag detected in validation evidence.",
    categories,
  };
};
