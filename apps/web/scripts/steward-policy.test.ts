import assert from "node:assert/strict";
import {
  categoryForValidationKey,
  proposedActionForSeverity,
  severityForValidationKey,
  stewardPatrolPolicy,
} from "./steward-policy";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("high-risk validation keys map to high severity and human review", () => {
  assert.ok(stewardPatrolPolicy.highRiskValidationKeys.includes("high_risk_topic"));
  assert.equal(severityForValidationKey("high_risk_topic"), "high");
  assert.equal(categoryForValidationKey("high_risk_topic"), "policy_risk");
  assert.equal(proposedActionForSeverity(severityForValidationKey("high_risk_topic")), "hold_for_review");
});

check("existing validation key mappings are preserved", () => {
  assert.equal(severityForValidationKey("secret_like"), "high");
  assert.equal(categoryForValidationKey("secret_like"), "secret_like");
  assert.equal(severityForValidationKey("external_dependency_like"), "warning");
  assert.equal(categoryForValidationKey("external_dependency_like"), "external_dependency_like");
});

console.log(`\nAll ${passed} steward-policy checks passed.`);
