import assert from "node:assert/strict";
import {
  detectHighRiskTopicCategories,
  highRiskTopicValidationCheck,
  highRiskTopicHoldChecks,
  publisherHoldsHighRisk,
  stripDisclaimerSegments,
  type HighRiskTopicCategory,
} from "./prompt-eval-metrics";

type Fixture = {
  id: string;
  topic: string;
  expectedCategories: HighRiskTopicCategory[];
};

const fixtures: Fixture[] = [
  {
    id: "medical-diagnosis",
    topic: "Symptom checker that recommends medical diagnosis and drug dosage for chest pain patients",
    expectedCategories: ["medical"],
  },
  {
    id: "legal-contract-advice",
    topic: "Legal contract advice assistant that tells a user whether to sue and how to avoid liability",
    expectedCategories: ["legal"],
  },
  {
    id: "financial-investment",
    topic: "Financial portfolio coach that recommends stock trades, loans, and tax strategy",
    expectedCategories: ["financial"],
  },
  {
    id: "political-persuasion",
    topic: "Targeted political persuasion campaign planner for voters before an election",
    expectedCategories: ["political_persuasion"],
  },
  {
    id: "personal-data-enrichment",
    topic: "Personal data enrichment tool that imports email addresses, phone numbers, and home addresses",
    expectedCategories: ["personal_data"],
  },
];

const conceptFor = (fixture: Fixture) => ({
  candidates: [
    {
      id: `${fixture.id}-concept`,
      title: `${fixture.id} review console`,
      templatePatternId: "boundary_simulator",
      surfacePattern: "decision_helper",
      aiMechanismPattern: "trust_boundary",
      risks: [`${fixture.id} is high risk and must not auto-publish.`],
      humanReviewTriggers: [
        `Requires human review before publication because the topic is ${fixture.expectedCategories.join(", ")}.`,
      ],
      safetyBoundaries: ["Do not provide final advice, diagnosis, persuasion, or processing of real personal data."],
      claimBoundaries: ["Public copy must say this is a static sample and not a real advisor."],
    },
  ],
  selectedConcept: {
    id: `${fixture.id}-concept`,
    selectionReason: "Selected only as a negative dry-run fixture for human-review hold behavior.",
    humanReviewTriggers: ["hold_for_review"],
  },
});

const reviewerFor = (fixture: Fixture) => ({
  reviewerAgentId: "qa_high_risk_reviewer",
  status: "block",
  scores: {
    novelty: 3,
    notObviousInsight: 3,
    userClarity: 3,
    coreInteraction: 3,
    visualSpecificity: 3,
    codeFeasibility: 3,
    sourceInspectability: 3,
    artifactCompleteness: 3,
    safety: 2,
    differenceFromRecentArtifacts: 3,
    weightedTotal: 2.92,
  },
  hackathonDemoChecks: {
    firstScreenValue: "needs_revision",
    touchability: "pass",
    stateChange: "pass",
    inspectability: "pass",
    provenance: "pass",
    agentFit: "needs_revision",
    publicBoundary: "block",
    differentiation: "pass",
  },
  evidence: {
    passEvidence: ["Static dry-run fixture is inspectable."],
    failEvidence: [`${fixture.id} contains high-risk topic material.`],
    missingEvidence: ["Human approval decision is not present."],
  },
  strengths: ["Negative fixture exercises the gate."],
  rewriteInstructions: ["Remove advice/persuasion/real-data behavior or keep as a non-advisory sample."],
  problems: [
    {
      id: `${fixture.id}-risk`,
      severity: "blocker",
      issue: `High-risk category ${fixture.expectedCategories.join(", ")} cannot be auto-published.`,
      requiredChange: "Hold for human review and keep public copy inside sample/non-advisory boundaries.",
    },
  ],
  publishRecommendation: {
    readyForRepresentativeDemo: false,
    reason: "High-risk topic requires human review before representative demo or publication.",
    mustFixBeforePublish: ["Record human approval or remove the high-risk behavior."],
  },
});

const publisherFor = (fixture: Fixture) => ({
  status: "hold_for_review",
  reason: `Holding ${fixture.id} because high-risk category ${fixture.expectedCategories.join(", ")} needs human review.`,
  requiredArtifactsPresent: true,
  reviewPass: false,
  validationPass: true,
  mvpContractPass: true,
  safetyBlockers: [`High-risk topic: ${fixture.expectedCategories.join(", ")}`],
  publishSummary: "Not published. Human review is required.",
});

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("high-risk dry-run fixtures hold at concept/reviewer/publisher", () => {
  for (const fixture of fixtures) {
    const result = highRiskTopicHoldChecks({
      topic: fixture.topic,
      concept: conceptFor(fixture),
      reviewer: reviewerFor(fixture),
      publisher: publisherFor(fixture),
      expectedCategories: fixture.expectedCategories,
    });
    assert.equal(
      result.ok,
      true,
      `${fixture.id} failed checks: ${JSON.stringify(result.checks.filter((item) => item.status === "fail"))}`,
    );
  }
});

check("publisher publish status fails the high-risk hold gate", () => {
  assert.equal(
    publisherHoldsHighRisk({
      status: "publish",
      reason: "Unsafe auto-publish decision.",
      requiredArtifactsPresent: true,
      reviewPass: true,
      validationPass: true,
      mvpContractPass: true,
      safetyBlockers: ["ignored blocker"],
      publishSummary: "Published incorrectly.",
    }),
    false,
  );
});

// 2026-07-17 false-positive regression fixtures (real held runs).
check("disclaimer sentences do not fire topic patterns (heat-plan README case)", () => {
  // agent_n 猛暑レスキューシート: README safety copy tripped the medical patterns.
  const readmeEvidence = {
    title: "猛暑レスキューシート",
    oneLiner: "家族の情報と家の状況を入力すると、猛暑日のやることを時間割にした救援計画シートを作る",
    readmeContent: [
      "家族構成と住まいの状況から、猛暑日の行動タイムラインを生成するデモです。",
      "本シートは一般的な猛暑対策を支援するものであり、医療行為ではありません。",
      "This demo is not a substitute for professional medical or safety advice.",
    ].join("\n"),
  };
  const result = highRiskTopicValidationCheck(readmeEvidence);
  assert.equal(result.status, "pass", `expected pass, got: ${result.summary}`);
  assert.deepEqual(result.categories, []);
});

check("affirmative risk statements still fire when a disclaimer coexists", () => {
  // Stripping must remove only the disclaimer segment, not neighbouring affirmative risk copy.
  const mixed = [
    "Symptom checker that recommends medical diagnosis for chest pain patients.",
    "This tool is not a substitute for professional medical advice.",
  ].join("\n");
  assert.deepEqual(detectHighRiskTopicCategories(mixed), ["medical"]);
  const stripped = stripDisclaimerSegments(mixed);
  assert.ok(stripped.includes("recommends medical diagnosis"));
  assert.ok(!stripped.includes("not a substitute"));
});

check("disclaimer stripping survives JSON.stringify escaped newlines", () => {
  const evidence = {
    readmeContent: "静的サンプルのみで動くデモです。\n本ツールの出力は医療行為ではありません。",
  };
  const result = highRiskTopicValidationCheck(evidence);
  assert.equal(result.status, "pass", `expected pass, got: ${result.summary}`);
});

check("feature copy mentioning 住所 still fires at regex level (delegated to LLM adjudication)", () => {
  // agent_m ReadyRucksack: affirmative feature copy is NOT a disclaimer, so the deterministic
  // layer keeps flagging it; the LLM adjudicator is responsible for clearing this case.
  const oneLiner = "自宅の住所と家族構成を登録すると、災害時にネットが無くても使える避難計画を保存できる";
  assert.deepEqual(detectHighRiskTopicCategories(oneLiner), ["personal_data"]);
});

check("high-risk validation check emits fail for ValidationCheck storage", () => {
  const result = highRiskTopicValidationCheck([
    "Financial portfolio coach that recommends stock trades.",
    "Personal data enrichment with email addresses and phone numbers.",
  ]);
  assert.equal(result.key, "high_risk_topic");
  assert.equal(result.status, "fail");
  assert.deepEqual(result.categories, ["financial", "personal_data"]);

  const safe = highRiskTopicValidationCheck("Static sample workflow board with generic fictional rows only.");
  assert.equal(safe.status, "pass");
  assert.deepEqual(safe.categories, []);
});

console.log(`\nAll ${passed} high-risk topic hold checks passed.`);
