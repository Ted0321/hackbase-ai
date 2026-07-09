/**
 * Unit checks for agentRuntimeReflection response contract validation.
 *
 * Run:
 *   npx tsx scripts/check-agent-runtime-reflection.test.ts
 */
import assert from "node:assert/strict";
import { checkAgentRuntimeReflection } from "./check-agent-runtime-reflection";

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
  triggerUsed: "Manual creation run requested by a human.",
  personaInfluence: ["Selected a decision surface because this maker prefers operator tools."],
  memoryInfluence: [],
  skillApplied: ["Translated signal reading into a visible user decision moment."],
  toolBoundary: ["Used read-only signal and artifact context only."],
  outputContractApplied: ["Returned strict JSON with three candidates."],
  governanceBoundary: ["Kept human and agent roles visible."],
};

check("concept candidates pass when reflection matches input runtime context", () => {
  const result = checkAgentRuntimeReflection({
    step: "concept",
    input,
    response: {
      candidates: [
        {
          id: "c1",
          agentRuntimeReflection: reflection,
        },
      ],
    },
  });

  assert.equal(result.result, "pass");
  assert.equal(result.checks.every((item) => item.status === "pass"), true);
});

check("requirements response fails without reflection", () => {
  const result = checkAgentRuntimeReflection({
    step: "requirements",
    input: {
      agentRuntimeContext: {
        agentId: "agent_a",
        phase: "requirements",
      },
    },
    response: {
      id: "req-1",
    },
  });

  assert.equal(result.result, "fail");
  assert.ok(result.checks.some((item) => item.id === "agentRuntimeReflection" && item.status === "fail"));
});

check("raw runtime context leakage fails", () => {
  const result = checkAgentRuntimeReflection({
    step: "builder",
    input: {
      agentRuntimeContext: {
        agentId: "agent_a",
        phase: "builder",
      },
    },
    response: {
      agentRuntimeReflection: {
        ...reflection,
        phase: "builder",
        toolBoundary: ["Copied input.agentRuntimeContext.allowedTools directly."],
      },
    },
  });

  assert.equal(result.result, "fail");
  assert.ok(result.checks.some((item) => item.id.endsWith(".raw_context_leak") && item.status === "fail"));
});

check("memory guidance requires memoryInfluence", () => {
  const result = checkAgentRuntimeReflection({
    step: "concept",
    input: {
      agentRuntimeContext: {
        agentId: "agent_a",
        phase: "concept",
        memoryDigest: {
          currentGuidance: ["Address the most recent critique in the next requirements."],
        },
      },
    },
    response: {
      candidates: [
        {
          id: "c1",
          agentRuntimeReflection: reflection,
        },
      ],
    },
  });

  assert.equal(result.result, "fail");
  assert.ok(
    result.checks.some((item) => item.id.endsWith(".memoryInfluenceFromDigest") && item.status === "fail"),
  );
});

check("raw skill, tool, and trigger identifiers fail", () => {
  const result = checkAgentRuntimeReflection({
    step: "builder",
    input: {
      agentRuntimeContext: {
        agentId: "agent_a",
        phase: "builder",
        trigger: { triggerId: "manual_creation" },
        allowedTools: [{ toolId: "compose_prompt" }],
        skillRefs: [{ skillId: "concept_signal_to_decision_surface" }],
      },
    },
    response: {
      agentRuntimeReflection: {
        ...reflection,
        phase: "builder",
        memoryInfluence: [],
        triggerUsed: "manual_creation",
        skillApplied: ["Used concept_signal_to_decision_surface directly."],
        toolBoundary: ["compose_prompt was allowed."],
      },
    },
  });

  assert.equal(result.result, "fail");
  assert.ok(result.checks.some((item) => item.id.endsWith(".raw_context_leak") && item.status === "fail"));
});

console.log(`\nAll ${passed} agentRuntimeReflection checks passed.`);
