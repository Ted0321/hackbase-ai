/**
 * Unit checks for integrated pipeline step quality validation.
 *
 * Run:
 *   npx tsx scripts/check-pipeline-step-quality.test.ts
 */
import assert from "node:assert/strict";
import { checkPipelineStepQuality } from "./check-pipeline-step-quality";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const input = {
  agentRuntimeContext: {
    agentId: "agent_a",
    phase: "concept",
  },
};

const reflection = {
  agentId: "agent_a",
  phase: "concept",
  triggerUsed: "A human requested a focused creation run.",
  personaInfluence: ["Used the maker's operator-tool preference."],
  memoryInfluence: [],
  skillApplied: ["Turned source signals into a decision surface."],
  toolBoundary: ["Used read-only source material and generated a local plan."],
  outputContractApplied: ["Returned strict JSON with three distinct candidates."],
  governanceBoundary: ["Kept human request and agent selection separate."],
};

const goodConceptResponse = {
  candidates: [
    {
      id: "c1",
      title: "Alpha route",
      oneLiner: "Sort field evidence into an action route.",
      templatePatternId: "source_to_mission",
      surfacePattern: "daily_utility",
      aiMechanismPattern: "workflow_generation",
      agentRuntimeReflection: reflection,
    },
    {
      id: "c2",
      title: "Beta score",
      oneLiner: "Rank lab samples by uncertainty and next step.",
      templatePatternId: "evidence_decision_board",
      surfacePattern: "decision_helper",
      aiMechanismPattern: "evaluation_scoring",
      agentRuntimeReflection: reflection,
    },
    {
      id: "c3",
      title: "Gamma map",
      oneLiner: "Inspect sensor zones through a comparison map.",
      templatePatternId: "signal_map",
      surfacePattern: "learning_explainer",
      aiMechanismPattern: "multi_source_synthesis",
      agentRuntimeReflection: reflection,
    },
  ],
  selectedConcept: { id: "c1" },
};

check("passes integrated concept checks", () => {
  const result = checkPipelineStepQuality({
    step: "concept",
    response: goodConceptResponse,
    input,
    responsePath: "response.json",
    inputPath: "input.json",
  });

  assert.equal(result.result, "pass");
  assert.equal(result.checks.every((item) => item.status === "pass"), true);
});

check("fails when runtime input is missing for a run artifact", () => {
  const result = checkPipelineStepQuality({
    step: "concept",
    response: goodConceptResponse,
    responsePath: "response.json",
    inputPath: "input.json",
  });

  assert.equal(result.result, "fail");
  assert.ok(
    result.checks.some((item) => item.id === "agent_runtime_reflection" && item.status === "fail"),
  );
});

check("fails raw runtime identifier leakage", () => {
  const result = checkPipelineStepQuality({
    step: "concept",
    response: {
      ...goodConceptResponse,
      candidates: [
        {
          ...goodConceptResponse.candidates[0],
          agentRuntimeReflection: {
            ...reflection,
            toolBoundary: ["read_signal and compose_prompt were copied into the answer."],
          },
        },
        goodConceptResponse.candidates[1],
        goodConceptResponse.candidates[2],
      ],
    },
    input: {
      agentRuntimeContext: {
        agentId: "agent_a",
        phase: "concept",
        allowedTools: [{ toolId: "read_signal" }, { toolId: "compose_prompt" }],
      },
    },
    responsePath: "response.json",
    inputPath: "input.json",
  });

  assert.equal(result.result, "fail");
  assert.ok(
    result.checks.some((item) => item.id === "agent_runtime_reflection" && item.status === "fail"),
  );
});

check("fails mojibake-like response text", () => {
  const result = checkPipelineStepQuality({
    step: "concept",
    response: {
      ...goodConceptResponse,
      candidates: [
        {
          ...goodConceptResponse.candidates[0],
          oneLiner: "郢晢ｽｫ郢ｧ・｢郢晄㈱繝ｻ should never pass as readable copy.",
        },
        goodConceptResponse.candidates[1],
        goodConceptResponse.candidates[2],
      ],
    },
    input,
    responsePath: "response.json",
    inputPath: "input.json",
  });

  assert.equal(result.result, "fail");
  assert.ok(result.checks.some((item) => item.id === "text_quality" && item.status === "fail"));
});

console.log(`\nAll ${passed} pipeline step quality checks passed.`);
