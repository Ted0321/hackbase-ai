/**
 * prompt-eval-metrics.ts の単体テスト。
 * リポジトリにテストランナーが無いため、assertion で exit する tsx スクリプトとして実装
 * （check-*.ts と同じ流儀）。`npm run eval:metrics:test` で実行。
 */
import assert from "node:assert/strict";
import {
  builderQuality,
  conceptQuality,
  conceptCandidates,
  conceptDiversity,
  conceptHardRegressions,
  conceptNameQuality,
  conceptSharpnessQuality,
  highRiskTopicValidationCheck,
  jaccard,
  judgeRegression,
  pairwiseMaxJaccard,
  promptWiringChecks,
  publisherHardRegressions,
  requirementsQuality,
  reviewerHardRegressions,
  reviewerWeightedTotal,
  rewriterHardRegressions,
  schemaShapeForStep,
  templateCatalogSync,
  tokenize,
  type ConceptDiversity,
  type SchemaShape,
} from "./prompt-eval-metrics";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const namedConcept = (overrides: Record<string, unknown>) => ({
  nameCandidates: [
    { name: "BrickQuest", pattern: "coined_compound", reason: "short metaphor" },
    { name: "たすかる実験台", pattern: "everyday_japanese", reason: "warm daily action" },
    { name: "声の工房", pattern: "object_metaphor", reason: "place/object metaphor" },
    { name: "PawMate", pattern: "companion_persona", reason: "helper role" },
    { name: "VoiceSketch", pattern: "visible_transformation", reason: "input becomes output" },
  ],
  namePatternUsed: "object_metaphor",
  nameScores: {
    pronounceability: 4,
    scene: 4,
    curiosity: 4,
    specificity: 4,
    aiFit: 4,
    fieldGroundedness: 4,
    visibleTransformation: 4,
    memorability: 4,
    safetyFit: 4,
  },
  nameSelectionReason: "短く読めて、最初の画面で何が起きるかを想像できるため。",
  badNameAvoided: "AI支援ツールは凡庸で、何が変わるか見えないため避けた。",
  aiVisibleTransformation: "入力した素材が比較可能な候補カードへ変わる。",
  firstScreenHook: "最初に素材を貼ると、候補カードの順位が入れ替わる。",
  curiosityHook: "名前と一行説明だけで、どんな変換が起きるか試したくなる。",
  conceptArchetype: "transformation",
  humanHook: "自分の素材が別物に変わる瞬間を見たくなる。",
  beforeAfter: "ばらばらの素材が比較できる候補カードに変わる。",
  surpriseMoment: "貼った直後に順位と理由が目の前で組み替わる。",
  firstScreenDrama: "最初の貼り付けだけで、眠っていた素材が動くカードになる。",
  shareLine: "これ、素材を貼るだけで企画カードに変わるよ。",
  boringVersionAvoided: "ただの要約ダッシュボードにはせず、変化が見える体験にした。",
  aiIntrospectionRisk: 1,
  domainOpacityRisk: 1,
  riskSelectionNote: "AI内部説明ではなく、普通の利用者に見える変化を主役にしている。",
  ...overrides,
});

check("tokenize splits and drops short tokens", () => {
  assert.deepEqual(tokenize("AI Decision Board, a tool!"), ["ai", "decision", "board", "tool"]);
  assert.deepEqual(tokenize(""), []);
});

check("jaccard basic", () => {
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccard(["a", "b"], ["c", "d"]), 0);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(["a", "b", "c", "d"], ["a", "b"]), 0.5);
});

check("pairwiseMaxJaccard finds closest pair", () => {
  const value = pairwiseMaxJaccard([
    "alpha beta gamma",
    "alpha beta gamma",
    "totally different words here",
  ]);
  assert.equal(value, 1);
});

check("conceptCandidates reads candidates[] and conceptBriefs[]", () => {
  assert.equal(conceptCandidates({ candidates: [{ title: "x" }] }).length, 1);
  assert.equal(conceptCandidates({ conceptBriefs: [{ title: "x" }, { title: "y" }] }).length, 2);
  assert.equal(conceptCandidates({}).length, 0);
  assert.equal(conceptCandidates(null).length, 0);
});

check("schemaShapeForStep concept ok and missing", () => {
  const ok = schemaShapeForStep("concept", {
    candidates: [{ title: "T", templatePatternId: "signal_map" }],
    selectedConcept: { id: "c1" },
  });
  assert.equal(ok.ok, true);
  const bad = schemaShapeForStep("concept", { candidates: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("candidates[]"));
  assert.ok(bad.missing.includes("selectedConcept"));
});

check("schemaShapeForStep combination/reviewer/builder", () => {
  assert.equal(
    schemaShapeForStep("combination", { selectedRemixes: [{}], evaluatedRemixes: [{}, {}] }).ok,
    true,
  );
  assert.equal(
    schemaShapeForStep("reviewer", {
      status: "pass",
      scores: {},
      hackathonDemoChecks: {},
      problems: [],
    }).ok,
    true,
  );
  // 厳格化: hackathonDemoChecks / problems[] が無いと ng
  assert.equal(schemaShapeForStep("reviewer", { status: "pass", scores: {} }).ok, false);
  assert.equal(
    schemaShapeForStep("builder", { files: [{}], mvpContract: {}, mvpContractV2: {}, sourceTrace: {} }).ok,
    true,
  );
  assert.equal(schemaShapeForStep("builder", { files: [{}], mvpContract: {}, mvpContractV2: {} }).ok, false);
  assert.equal(schemaShapeForStep("builder", { files: [] }).ok, false);
});

check("schemaShapeForStep research accepts real material contract", () => {
  // 実 research 出力は sourceProductCards / topicCards 等。旧 researchReports/signalCards は空でも有効。
  assert.equal(
    schemaShapeForStep("research", { sourceProductCards: [{}], researchReports: [], signalCards: [] }).ok,
    true,
  );
  assert.equal(schemaShapeForStep("research", { topicCards: [{}] }).ok, true);
  assert.equal(schemaShapeForStep("research", { researchReports: [{}] }).ok, true);
  assert.equal(schemaShapeForStep("research", { signalCards: [{}] }).ok, true);
  // 素材配列が一切無ければ ng（過剰ブロックは回避しつつ、空出力は弾く）。
  const empty = schemaShapeForStep("research", { researchRunSummary: {} });
  assert.equal(empty.ok, false);
  assert.ok(empty.missing.some((m) => m.includes("sourceProductCards")));
});

check("schemaShapeForStep rewriter/publisher", () => {
  assert.equal(
    schemaShapeForStep("rewriter", {
      status: "revised",
      changedFiles: [],
      addressedReviewIssues: [],
    }).ok,
    true,
  );
  assert.equal(schemaShapeForStep("rewriter", { status: "revised" }).ok, false);
  assert.equal(
    schemaShapeForStep("publisher", {
      status: "publish",
      requiredArtifactsPresent: true,
      reviewPass: true,
      validationPass: true,
      mvpContractPass: true,
      sourceTracePass: true,
      safetyBlockers: [],
    }).ok,
    true,
  );
  assert.equal(schemaShapeForStep("publisher", { status: "publish" }).ok, false);
});

check("requirementsQuality gates buildable contract", () => {
  const good = {
    mvpGoal: "Operator triages incidents and sees the next action.",
    screens: [{ name: "Board", primaryControl: "severity filter", stateOutput: "incident list re-ranks" }],
    dataModel: [
      {
        name: "Incident",
        fields: ["id", "severity"],
        sampleShape: "{ id: 'inc-1', severity: 'high', nextAction: 'page on-call' }",
      },
    ],
    acceptanceCriteria: ["filtering changes the visible ranking"],
    externalDependencyPlan: {
      externalDependencyMode: "none",
      externalIntegrations: [],
      integrationAssumptions: [],
      claimBoundary: {
        publicCopyMustSay: ["This MVP runs on static sample data."],
        publicCopyMustNotSay: ["live external data is guaranteed"],
      },
    },
    interactionProofPlan: {
      primaryAction: "click severity 'high'",
      initialState: "all incidents shown",
      expectedState: "only high incidents, re-ranked",
      visibleEvidence: ["High only"],
      requiredSourceFiles: ["source/app/page.tsx"],
    },
  };
  const okResult = requirementsQuality(good);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.score, 1);

  const objectSample = requirementsQuality({
    ...good,
    dataModel: [
      {
        name: "Incident",
        fields: ["id", "severity", "nextAction"],
        sampleShape: { id: "inc-1", severity: "high", nextAction: "page on-call" },
      },
    ],
  });
  assert.equal(objectSample.ok, true);

  // screen に stateOutput が無い -> ng
  const noState = requirementsQuality({
    ...good,
    screens: [{ name: "Board", primaryControl: "filter", stateOutput: "" }],
  });
  assert.equal(noState.ok, false);
  assert.ok(noState.issues.some((i) => i.check.includes("stateOutput")));

  // dataModel の sampleShape が薄い -> ng
  const thin = requirementsQuality({ ...good, dataModel: [{ name: "Incident", sampleShape: "x" }] });
  assert.equal(thin.ok, false);
  assert.ok(thin.issues.some((i) => i.check.includes("sampleShape")));

  // screens 膨張 -> scope creep
  const tooMany = requirementsQuality({
    ...good,
    screens: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, primaryControl: "c", stateOutput: "o" })),
  });
  assert.ok(tooMany.issues.some((i) => i.check === "screensWithinBound"));

  // manualFallbackReason があれば requiredSourceFiles を免除
  const manual = requirementsQuality({
    ...good,
    interactionProofPlan: {
      ...good.interactionProofPlan,
      requiredSourceFiles: [],
      manualFallbackReason: "interaction needs a human to observe",
    },
  });
  assert.equal(manual.ok, true);

  const noExternalPlan = requirementsQuality({
    ...good,
    externalDependencyPlan: undefined,
  });
  assert.equal(noExternalPlan.ok, false);
  assert.ok(noExternalPlan.issues.some((i) => i.check === "externalDependencyPlan.present"));

  const liveRequired = requirementsQuality({
    ...good,
    externalDependencyPlan: {
      ...good.externalDependencyPlan,
      externalDependencyMode: "live_required",
    },
  });
  assert.equal(liveRequired.ok, false);
  assert.ok(liveRequired.issues.some((i) => i.check === "externalDependencyPlan.autoPublishableMode"));
});

check("conceptDiversity counts distinct patterns and similarity", () => {
  const diversity = conceptDiversity({
    candidates: [
      { title: "A board", oneLiner: "x", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" },
      { title: "B map", oneLiner: "y", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" },
      { title: "C studio", oneLiner: "z", templatePatternId: "transformation_studio", surfacePattern: "creative_assistant", aiMechanismPattern: "simulation" },
    ],
  });
  assert.equal(diversity.candidateCount, 3);
  assert.equal(diversity.distinctTemplatePatternIds, 3);
  assert.equal(diversity.distinctSurfacePatterns, 3);
  assert.ok(diversity.pairwiseTitleJaccard < 0.4);
});

check("conceptQuality gates diversity targets", () => {
  const good = conceptQuality({
    selectedConcept: { id: "alpha" },
    candidates: [
      namedConcept({ id: "alpha", title: "Alpha route", oneLiner: "sort field evidence", namePatternUsed: "coined_compound", templatePatternId: "source_to_mission", surfacePattern: "daily_utility", aiMechanismPattern: "workflow_generation" }),
      namedConcept({ id: "beta", title: "Beta score", oneLiner: "rank lab samples", namePatternUsed: "visible_transformation", conceptArchetype: "judgment_arena", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" }),
      namedConcept({ id: "gamma", title: "旅メモ試写室", oneLiner: "inspect sensor zones", namePatternUsed: "object_metaphor", conceptArchetype: "field_compass", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" }),
    ],
  });
  assert.equal(good.ok, true);

  const bad = conceptQuality({
    candidates: [
      { title: "Same board", oneLiner: "same output", templatePatternId: "signal_map", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" },
      { title: "Same board", oneLiner: "same output", templatePatternId: "signal_map", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" },
    ],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((issue) => issue.check === "candidateCount"));
  assert.ok(bad.issues.some((issue) => issue.check === "pairwiseTitleJaccard"));
});

check("conceptQuality treats candidate spread misses as warnings", () => {
  const quality = conceptQuality({
    selectedConcept: { id: "toon" },
    candidates: [
      namedConcept({ id: "xray", title: "X-Ray Spec", oneLiner: "compare model answers", conceptArchetype: "hidden_map", conditionalArchetypeJustification: "the hidden comparison layer is the central user-visible value", templatePatternId: "source_to_mission", surfacePattern: "learning_explainer", aiMechanismPattern: "workflow_generation" }),
      namedConcept({ id: "arena", title: "Feature Arena", oneLiner: "debate product ideas", conceptArchetype: "judgment_arena", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" }),
      namedConcept({ id: "toon", title: "Civic Toon", oneLiner: "turn city hall PDFs into comics", conceptArchetype: "transformation", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" }),
    ],
  });

  assert.equal(quality.ok, true);
  assert.equal(quality.issues.length, 0);
  assert.ok(quality.warnings?.some((issue) => issue.check === "distinctSurfacePatterns"));
  assert.ok(quality.warnings?.some((issue) => issue.check === "distinctNamePatternsUsed"));
});

check("conceptNameQuality gates naming contract and generic titles", () => {
  const quality = conceptNameQuality({
    candidates: [
      namedConcept({ title: "VoiceSketch", oneLiner: "voice turns into storyboard cards" }),
      namedConcept({
        title: "AI旅行支援ツール",
        oneLiner: "generic support",
        nameCandidates: [],
        namePatternUsed: "unknown",
        nameScores: { pronounceability: 4 },
        badNameAvoided: "",
      }),
    ],
  });

  assert.equal(quality.candidatesWithEnoughNameCandidates, 1);
  assert.equal(quality.candidatesWithNamePattern, 1);
  assert.equal(quality.candidatesWithCompleteNameScores, 1);
  assert.equal(quality.genericTitleCount, 1);
  assert.equal(quality.englishOrMixedTitleCount, 1);
  assert.equal(quality.distinctNamePatternsUsed, 2);

  const gated = conceptQuality({
    candidates: [
      namedConcept({ title: "声の工房", oneLiner: "voice turns into storyboard cards", namePatternUsed: "object_metaphor", templatePatternId: "source_to_mission", surfacePattern: "daily_utility", aiMechanismPattern: "workflow_generation" }),
      namedConcept({ title: "AI旅行支援ツール", oneLiner: "generic support", namePatternUsed: "plain_utility", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" }),
      namedConcept({ title: "旅メモ試写室", oneLiner: "plans become preview cards", namePatternUsed: "scene_phrase", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" }),
    ],
  });

  assert.equal(gated.ok, false);
  assert.ok(gated.issues.some((issue) => issue.check === "noGenericTitles"));
  assert.ok(gated.issues.some((issue) => issue.check === "englishOrMixedTitle"));
});

check("conceptSharpnessQuality gates archetypes and human-interest fields", () => {
  const quality = conceptSharpnessQuality({
    selectedConcept: { id: "ok" },
    candidates: [
      namedConcept({ id: "ok", conceptArchetype: "transformation" }),
      namedConcept({ conceptArchetype: "hidden_map", conditionalArchetypeJustification: "隠れた偏りが触って分かるため主力型より強い。" }),
      namedConcept({ conceptArchetype: "unknown", humanHook: "", beforeAfter: "", riskSelectionNote: "" }),
    ],
  });

  assert.equal(quality.candidatesWithValidArchetype, 2);
  assert.equal(quality.distinctConceptArchetypes, 3);
  assert.equal(quality.candidatesWithHumanHook, 2);
  assert.equal(quality.candidatesWithBeforeAfter, 2);
  assert.equal(quality.candidatesWithRiskScores, 3);
  assert.equal(quality.candidatesWithRiskSelectionNote, 2);
  assert.equal(quality.conditionalArchetypesUsed, 1);
  assert.equal(quality.conditionalArchetypesWithJustification, 1);
  assert.equal(quality.selectedAiIntrospectionRisk, 1);
  assert.equal(quality.selectedDomainOpacityRisk, 1);

  const sameArchetype = conceptQuality({
    selectedConcept: { id: "a" },
    candidates: [
      namedConcept({ id: "a", title: "Alpha route", oneLiner: "sort field evidence", namePatternUsed: "coined_compound", conceptArchetype: "transformation", templatePatternId: "source_to_mission", surfacePattern: "daily_utility", aiMechanismPattern: "workflow_generation" }),
      namedConcept({ id: "b", title: "Beta score", oneLiner: "rank lab samples", namePatternUsed: "visible_transformation", conceptArchetype: "transformation", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" }),
      namedConcept({ id: "c", title: "旅メモ試写室", oneLiner: "inspect sensor zones", namePatternUsed: "object_metaphor", conceptArchetype: "transformation", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" }),
    ],
  });

  assert.equal(sameArchetype.ok, false);
  assert.ok(sameArchetype.issues.some((issue) => issue.check === "distinctConceptArchetypes"));

  const selectedRisk = conceptQuality({
    selectedConcept: { id: "risky" },
    candidates: [
      namedConcept({ id: "safe", title: "Alpha route", oneLiner: "sort field evidence", namePatternUsed: "coined_compound", conceptArchetype: "transformation", templatePatternId: "source_to_mission", surfacePattern: "daily_utility", aiMechanismPattern: "workflow_generation" }),
      namedConcept({ id: "risky", title: "Beta score", oneLiner: "rank lab samples", namePatternUsed: "visible_transformation", conceptArchetype: "hidden_map", aiIntrospectionRisk: 5, domainOpacityRisk: 4, conditionalArchetypeJustification: "ログ閲覧ではなく診断体験として成立する場合だけ使う。", templatePatternId: "evidence_decision_board", surfacePattern: "decision_helper", aiMechanismPattern: "evaluation_scoring" }),
      namedConcept({ id: "other", title: "旅メモ試写室", oneLiner: "inspect sensor zones", namePatternUsed: "object_metaphor", conceptArchetype: "field_compass", templatePatternId: "signal_map", surfacePattern: "learning_explainer", aiMechanismPattern: "multi_source_synthesis" }),
    ],
  });

  assert.equal(selectedRisk.ok, false);
  assert.ok(selectedRisk.issues.some((issue) => issue.check === "selectedAiIntrospectionRisk"));
  assert.ok(selectedRisk.issues.some((issue) => issue.check === "selectedDomainOpacityRisk"));
});

check("builderQuality gates MVP Contract V2 and interaction proof", () => {
  // コアロジックファースト契約: ランナーページはcore/をimportせず、sample-traceを再生する。
  const runnerSource = [
    "import { sampleTrace } from '../data/sample-trace';",
    "export default function Page() {",
    "  return <button data-proof=\"primary-action\">トレースを再生</button>;",
    "}",
  ].join("\n");
  // core/gemini.ts には実呼び出しパターンとして fetch( を含める（core/内は許可される仕様の証明）。
  const geminiSource = [
    "export async function callGemini(apiKey: string, prompt: string) {",
    "  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {",
    "    method: 'POST',",
    "    headers: { 'x-goog-api-key': apiKey },",
    "    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),",
    "  });",
    "  return res.json();",
    "}",
  ].join("\n");
  const good = {
    requirementSpecId: "req-1",
    framework: "next_static_artifact",
    interestingness:
      "既存のスコア比較ツールと違い、ブランドルールを自分で定義してAI下書きを即採点できる点が新しく、逸脱箇所を具体的に直せるのが強みです。LLM評価をリアルタイムに反映する最近の潮流を、静的サンプルだけで安全に体験できます。",
    files: [
      { path: "README.md", purpose: "explain", content: "Uses sample data." },
      { path: "metadata.json", purpose: "metadata", content: "{}" },
      { path: "manifest.json", purpose: "manifest", content: "{}" },
      { path: "source/app/page.tsx", purpose: "entry", content: runnerSource },
      { path: "source/core/pipeline.ts", purpose: "core orchestration", content: "export const steps = ['extract'];" },
      { path: "source/core/gemini.ts", purpose: "documented call pattern", content: geminiSource },
      { path: "source/core/steps/extract.ts", purpose: "step", content: "export const extract = (input: string) => input;" },
      { path: "source/data/sample-input.ts", purpose: "sample input", content: "export const sampleInput = 'raw text';" },
      { path: "source/data/sample-trace.ts", purpose: "recorded trace", content: "export const sampleTrace = ['Score updated'];" },
      { path: "validation/self-review.json", purpose: "review", content: "{}" },
    ],
    interactionModel: {
      states: ["initial", "updated"],
      transitions: [{ from: "initial", event: "click", to: "updated", visibleChange: "Score updated appears" }],
    },
    interactionProofPlan: {
      primaryAction: "トレースを再生",
      initialState: "Initial trace",
      expectedState: "Replayed trace",
      visibleEvidence: ["Score updated"],
      proofSelectors: ["button[data-proof='primary-action']"],
      requiredSourceFiles: ["source/app/page.tsx", "source/data/sample-trace.ts"],
    },
    implementationNotes: ["Translated the agent's practical preference into a score tuning surface."],
    knownRisks: [],
    submissionReadiness: {
      firstScreenValue: "Score can be tuned.",
      coreInteraction: "Click a tuning control.",
      stateChange: "Score changes.",
      inspectableOutput: "Updated score is shown.",
      staticDataBoundary: "Sample data only.",
      remainingWeakness: "Small sample.",
    },
    mvpContract: {
      firstScreenValue: "Score can be tuned.",
      coreInteraction: "Click a tuning control.",
      stateChange: "Score changes.",
      inspectableOutput: "Updated score is shown.",
      staticDataBoundary: "Sample data only.",
      requiredFiles: ["README.md"],
      nonGoals: ["No live external API integration"],
      forbiddenDependencies: ["external API"],
    },
    mvpContractV2: {
      contractVersion: "mvp-contract-v2",
      artifactTier: "proposed_integration",
      externalDependencyMode: "proposed",
      requiredFiles: ["README.md"],
      runtimeBoundary: { networkCalls: "none", secrets: "none", externalWrites: "none" },
      claimBoundary: {
        publicCopyMustSay: ["This uses sample data."],
        publicCopyMustNotSay: ["This is live."],
      },
      renderVerification: { required: true, checks: ["render"] },
    },
    sourceTrace: {
      sourceProductUsed: "source_a",
      sourceProductUse: "primary_source_core",
      sourceEvidenceAudit: {
        evidenceLevel: "A",
        observedFields: ["name"],
        inferredFields: ["mechanism"],
        missingFields: ["codeUrl"],
        usePolicy: "primary_source_core",
      },
      antiCloneBoundary: "Do not copy the source UI.",
      sourceBoundary: "Use only the observed mechanism.",
      missingSourceEvidence: ["codeUrl"],
    },
  };

  const result = builderQuality(good);
  assert.equal(result.ok, true);

  const bad = builderQuality({
    ...good,
    files: good.files.filter((file) => file.path !== "source/data/sample-trace.ts"),
    interactionProofPlan: {
      ...good.interactionProofPlan,
      visibleEvidence: ["Missing evidence"],
    },
    mvpContractV2: {
      ...good.mvpContractV2,
      externalDependencyMode: "live_required",
      runtimeBoundary: { networkCalls: "live_required", secrets: "required", externalWrites: "live_required" },
    },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((issue) => issue.check === "requiredFile.source/data/sample-trace.ts"));
  assert.ok(bad.issues.some((issue) => issue.check === "mvpContractV2.autoPublishableExternalMode"));
  assert.ok(bad.issues.some((issue) => issue.check === "runtimeBoundary.networkCalls"));
  assert.ok(bad.issues.some((issue) => issue.check === "interactionProofPlan.visibleEvidencePresent"));

  // fetch はデモ側(core/以外)では引き続き禁止。ランナーページに fetch を書いたら fail。
  const fetchInDemo = builderQuality({
    ...good,
    files: good.files.map((file) =>
      file.path === "source/app/page.tsx"
        ? { ...file, content: `${file.content}\nfetch('https://example.com');` }
        : file,
    ),
  });
  assert.equal(fetchInDemo.ok, false);
  assert.ok(fetchInDemo.issues.some((issue) => issue.check === "source.noFetch"));

  // ランナーページが core/ をimportしたら fail（render proofのbundleを守る）。
  const coreImportInEntry = builderQuality({
    ...good,
    files: good.files.map((file) =>
      file.path === "source/app/page.tsx"
        ? { ...file, content: `import { steps } from '../core/pipeline';\n${file.content}` }
        : file,
    ),
  });
  assert.equal(coreImportInEntry.ok, false);
  assert.ok(coreImportInEntry.issues.some((issue) => issue.check === "entry.noCoreImport"));

  // process.env は core/ 含む全ファイルで禁止（apiKeyは関数引数契約）。
  const envInCore = builderQuality({
    ...good,
    files: good.files.map((file) =>
      file.path === "source/core/gemini.ts"
        ? { ...file, content: `${file.content}\nconst key = process.env.GEMINI_API_KEY;` }
        : file,
    ),
  });
  assert.equal(envInCore.ok, false);
  assert.ok(envInCore.issues.some((issue) => issue.check === "source.noProcessEnv"));

  // 相対importは files[] に実在するファイルへ解決できなければならない（types.ts 欠落等を検出）。
  const unresolvedImport = builderQuality({
    ...good,
    files: good.files.map((file) =>
      file.path === "source/core/pipeline.ts"
        ? { ...file, content: `import { Foo } from './types';\n${file.content}` }
        : file,
    ),
  });
  assert.equal(unresolvedImport.ok, false);
  assert.ok(unresolvedImport.issues.some((issue) => issue.check === "source.importsResolve"));

  // 非推奨の gemini-1.x モデルIDは全ファイルで禁止（現行の高速モデルを参照させる）。
  const staleModelId = builderQuality({
    ...good,
    files: good.files.map((file) =>
      file.path === "source/core/gemini.ts"
        ? { ...file, content: file.content.replace("gemini-2.5-flash", "gemini-1.5-flash") }
        : file,
    ),
  });
  assert.equal(staleModelId.ok, false);
  assert.ok(staleModelId.issues.some((issue) => issue.check === "source.currentModelId"));

  // 宣言した proofSelector が全て非静的（=検証可能な静的アンカーが1つも無い）ときは失敗。
  const dynamicSelector = builderQuality({
    ...good,
    interactionProofPlan: {
      ...good.interactionProofPlan,
      proofSelectors: ["[data-proof='primary-action'][data-node-id='node-2']"],
    },
  });
  assert.equal(dynamicSelector.ok, false);
  assert.ok(dynamicSelector.issues.some((issue) => issue.check === "interactionProofPlan.proofSelectorStaticPresent"));

  // 静的アンカーが1つ以上あれば、リスト由来の動的セレクタが混ざっていても通す（緩和後の挙動）。
  const mixedSelectors = builderQuality({
    ...good,
    interactionProofPlan: {
      ...good.interactionProofPlan,
      proofSelectors: [
        "button[data-proof='primary-action']",
        "div[data-proof='option-card-hotfix']",
      ],
    },
  });
  assert.equal(mixedSelectors.ok, true);

  // shortTagline / categoryId は lenient ゲート: 欠落は pass（baseline eval 保護）、存在時のみ内容を検証。
  // good フィクスチャは両フィールド欠落 = 上の assert(result.ok) で「欠落 pass」を担保済み。
  const validCopyFields = builderQuality({
    ...good,
    shortTagline: "長い議事録を3行の決定メモに変える",
    categoryId: "cat_summary",
  });
  assert.equal(validCopyFields.ok, true);

  // 40字超の shortTagline は正規化不能として fail（生成時リトライで矯正させる）。
  const overlongTagline = builderQuality({
    ...good,
    shortTagline: "こ".repeat(41),
  });
  assert.ok(overlongTagline.issues.some((issue) => issue.check === "shortTagline.normalizable"));

  // カタログ外の categoryId は fail（publish 側フォールバックに頼らず生成時に矯正させる）。
  const unknownCategory = builderQuality({
    ...good,
    categoryId: "cat_made_up",
  });
  assert.ok(unknownCategory.issues.some((issue) => issue.check === "categoryId.catalog"));

  // usageGuide も lenient ゲート: 欠落は pass（good フィクスチャは欠落 = 上の assert(result.ok) で担保済み）、
  // 存在時のみ「正規化して2〜4ステップ残る」ことを検証する。
  const validUsageGuide = builderQuality({
    ...good,
    usageGuide: {
      intro: "サンプルデータで分析の流れを試せます。",
      steps: [
        { action: "「サンプル実行トレースを再生」ボタンを押す", result: "結果エリアに各ステップの出力が順に表示される。" },
        { action: "ステップごとの出力カードを読む", result: "各処理が何を受け取り何を返したかが確認できる。" },
      ],
      checkPoint: "指摘が具体的な修正案まで踏み込んでいるか。",
    },
  });
  assert.equal(validUsageGuide.ok, true);

  // 操作と結果が同一文の1ステップだけ → 正規化で全滅 = 構造欠陥として fail（生成時リトライで矯正させる）。
  const brokenUsageGuide = builderQuality({
    ...good,
    usageGuide: { steps: [{ action: "同じ文。", result: "同じ文。" }] },
  });
  assert.ok(brokenUsageGuide.issues.some((issue) => issue.check === "usageGuide.normalizable"));

  // オブジェクトでない usageGuide も fail。
  const stringUsageGuide = builderQuality({ ...good, usageGuide: "テキスト" });
  assert.ok(stringUsageGuide.issues.some((issue) => issue.check === "usageGuide.normalizable"));
});

check("promptWiringChecks detects wiring instructions", () => {
  const concept = promptWiringChecks("concept", "use conceptProjection.sourcePreferences and conceptSelectionRules in materialChoiceReason");
  assert.equal(concept.mentionsPreferredInputs, true);
  assert.equal(concept.mentionsConceptSelectionRules, true);
  const requirements = promptWiringChecks(
    "requirements",
    "use sourcePreferences and define externalDependencyPlan with externalDependencyMode and claimBoundary",
  );
  assert.equal(requirements.mentionsExternalDependencyPlan, true);
  assert.equal(requirements.mentionsClaimBoundary, true);
  const builder = promptWiringChecks(
    "builder",
    "pick a templatePatternId in templatePatternPreferences or set templateDivergenceReason; emit mvpContractV2 with mocked_adapter and runtimeBoundary; include sourceTrace with sourceEvidenceAudit and antiCloneBoundary",
  );
  assert.equal(builder.mentionsDefaultTemplatePatterns, true);
  assert.equal(builder.mentionsTemplateReconciliation, true);
  assert.equal(builder.mentionsMvpContractV2, true);
  assert.equal(builder.mentionsRuntimeBoundary, true);
  assert.equal(builder.mentionsSourceTrace, true);
  const none = promptWiringChecks("concept", "no wiring here");
  assert.equal(none.mentionsPreferredInputs, false);
});

check("templateCatalogSync flags missing ids", () => {
  const sync = templateCatalogSync("uses signal_map and evidence_decision_board", [
    "signal_map",
    "evidence_decision_board",
    "remix_roulette",
  ]);
  assert.equal(sync.ok, false);
  assert.deepEqual(sync.missing, ["remix_roulette"]);
});

check("conceptHardRegressions detects schema and diversity drops", () => {
  const baseSchema: SchemaShape = { ok: true, missing: [] };
  const candSchemaBad: SchemaShape = { ok: false, missing: ["candidates[]"] };
  const div = (n: number, j: number): ConceptDiversity => ({
    candidateCount: 3,
    distinctTemplatePatternIds: n,
    distinctSurfacePatterns: n,
    distinctAiMechanismPatterns: n,
    pairwiseTitleJaccard: j,
  });
  // schema regression
  assert.equal(
    conceptHardRegressions(
      { schema: baseSchema, diversity: div(3, 0.2) },
      { schema: candSchemaBad, diversity: div(3, 0.2) },
    ).length,
    1,
  );
  // diversity collapse: template ids drop below 3
  assert.equal(
    conceptHardRegressions(
      { schema: baseSchema, diversity: div(3, 0.2) },
      { schema: baseSchema, diversity: div(2, 0.2) },
    ).length,
    1,
  );
  // similarity rises above 0.4 and worse than base
  assert.equal(
    conceptHardRegressions(
      { schema: baseSchema, diversity: div(3, 0.2) },
      { schema: baseSchema, diversity: div(3, 0.55) },
    ).length,
    1,
  );
  // no regression
  assert.equal(
    conceptHardRegressions(
      { schema: baseSchema, diversity: div(3, 0.3) },
      { schema: baseSchema, diversity: div(3, 0.25) },
    ).length,
    0,
  );
});

check("judgeRegression respects noise band", () => {
  assert.equal(judgeRegression(4.0, 3.0), "LLM-judge weightedTotal dropped 1.00 (> noise band 0.5)");
  assert.equal(judgeRegression(4.0, 3.7), null);
});

check("promptWiringChecks covers late stages", () => {
  assert.equal(
    promptWiringChecks(
      "reviewer",
      "use reviewerPolicy and hackathonDemoChecks and learningExtraction and check sourceTrace sourcePlan",
    ).mentionsHackathonDemoChecks,
    true,
  );
  assert.equal(
    promptWiringChecks("reviewer", "check sourceTrace sourcePlan").mentionsSourceTrace,
    true,
  );
  assert.equal(
    promptWiringChecks(
      "rewriter",
      "revise using ReviewResult, issueResolutions, and addressedReviewIssues",
    ).mentionsReviewResult,
    true,
  );
  assert.equal(
    promptWiringChecks("publisher", "check validation, mvpContractPass, check-mvp-contract-v2, externalDependencyMode, claimBoundary, sourceTrace, rewriteResult, and safetyBlockers")
      .mentionsSafetyBlockers,
    true,
  );
  assert.equal(
    promptWiringChecks("publisher", "check validation, mvpContractPass, check-mvp-contract-v2, externalDependencyMode, claimBoundary, sourceTrace, rewriteResult, and safetyBlockers")
      .mentionsMvpContractV2,
    true,
  );
  assert.equal(
    promptWiringChecks("publisher", "check sourceTrace sourcePlan").mentionsSourceTrace,
    true,
  );
  assert.equal(
    promptWiringChecks("publisher", "check rewriteResult after review").mentionsRewriteResult,
    true,
  );
  assert.equal(promptWiringChecks("reviewer", "no wiring here").mentionsHackathonDemoChecks, false);
});

check("reviewerWeightedTotal reads direct or computes from dimensions", () => {
  assert.equal(reviewerWeightedTotal({ scores: { weightedTotal: 4.2 } }), 4.2);
  const allFour = Object.fromEntries(
    [
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
    ].map((dimension) => [dimension, 4]),
  );
  assert.equal(reviewerWeightedTotal({ scores: allFour }), 4.0);
  assert.equal(reviewerWeightedTotal({ scores: { novelty: 4 } }), null);
  assert.equal(reviewerWeightedTotal(null), null);
});

check("reviewerHardRegressions detects verdict/score drops", () => {
  const base = {
    status: "pass",
    scores: { weightedTotal: 4.5 },
    hackathonDemoChecks: { touchability: "pass" },
  };
  assert.ok(
    reviewerHardRegressions(base, {
      status: "needs_revision",
      scores: { weightedTotal: 4.5 },
      hackathonDemoChecks: { touchability: "pass" },
    }).some((reason) => reason.includes("status regressed")),
  );
  assert.ok(
    reviewerHardRegressions(base, {
      status: "pass",
      scores: { weightedTotal: 4.5 },
      hackathonDemoChecks: { touchability: "block" },
    }).some((reason) => reason.includes("touchability")),
  );
  assert.ok(
    reviewerHardRegressions(base, {
      status: "pass",
      scores: { weightedTotal: 3.5 },
      hackathonDemoChecks: { touchability: "pass" },
    }).some((reason) => reason.includes("weightedTotal")),
  );
  assert.equal(reviewerHardRegressions(base, base).length, 0);
});

check("rewriterHardRegressions detects status/coverage drops", () => {
  const base = { status: "revised", addressedReviewIssues: ["rev-001", "rev-002"] };
  assert.ok(
    rewriterHardRegressions(base, {
      status: "blocked",
      addressedReviewIssues: ["rev-001", "rev-002"],
    }).some((reason) => reason.includes("status regressed")),
  );
  assert.ok(
    rewriterHardRegressions(base, {
      status: "revised",
      addressedReviewIssues: ["rev-001"],
    }).some((reason) => reason.includes("issue count dropped")),
  );
  assert.equal(rewriterHardRegressions(base, base).length, 0);
});

check("publisherHardRegressions detects verdict drop and contradiction", () => {
  const base = { status: "publish", reviewPass: true };
  assert.ok(
    publisherHardRegressions(base, { status: "block", reviewPass: true }).some((reason) =>
      reason.includes("status regressed"),
    ),
  );
  assert.ok(
    publisherHardRegressions(base, { status: "publish", reviewPass: false }).some((reason) =>
      reason.includes("contradiction"),
    ),
  );
  assert.ok(
    publisherHardRegressions(base, { status: "publish", sourceTracePass: false }).some((reason) =>
      reason.includes("sourceTracePass=false"),
    ),
  );
  assert.equal(publisherHardRegressions(base, base).length, 0);
});

check("highRiskTopicValidationCheck ignores forbidden dependency labels alone", () => {
  const result = highRiskTopicValidationCheck({
    title: "AIエージェント判断検証ボード",
    oneLiner: "AIエージェントの判断根拠、リスク、代替案を確認する。",
    metadata: {
      knownRisks: ["AIの判断を過度に信頼しないよう、人間のレビュー点を表示する。"],
      sourceProvenance: {
        sourceProductUsed: "Quad",
        sourceProductUse: "primary_source_core",
      },
    },
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.categories, []);
});

console.log(`\nAll ${passed} prompt-eval-metrics checks passed.`);
