/**
 * target-preference.ts の単体テスト（assertion で exit する tsx スクリプト）。
 * `npm run eval:target-pref:test` で実行。
 */
import assert from "node:assert/strict";
import {
  isPublicInteractionTarget,
  preferenceScore,
  projectPreferenceSignals,
  rankByTargetPreference,
} from "./target-preference";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("projectPreferenceSignals maps category and validation state", () => {
  assert.deepEqual(projectPreferenceSignals({ categoryId: "Education" }), ["education"]);
  assert.deepEqual(
    projectPreferenceSignals({ categoryId: "work", publishDecision: "hold_for_review" }),
    ["work", "hold_for_review", "validation_warned_projects", "held_for_review"],
  );
  assert.deepEqual(projectPreferenceSignals({}), []);
});

check("isPublicInteractionTarget excludes withdrawn and non-public projects", () => {
  assert.equal(isPublicInteractionTarget({ status: "published", publishDecision: "human_approved" }), true);
  assert.equal(isPublicInteractionTarget({ status: "auto_published", publishDecision: "auto_published" }), true);
  assert.equal(isPublicInteractionTarget({ status: "withdrawn", publishDecision: "withdrawn" }), false);
  assert.equal(isPublicInteractionTarget({ status: "published", publishDecision: "withdrawn" }), false);
  assert.equal(isPublicInteractionTarget({ status: "pending", publishDecision: "pending" }), false);
});

check("preferenceScore counts matches with partial overlap", () => {
  assert.equal(preferenceScore(["education", "mapping"], ["education"]), 1);
  assert.equal(
    preferenceScore(["validation_warned_projects"], ["validation_warned_projects"]),
    1,
  );
  assert.equal(preferenceScore(["workflow_tools"], ["workflow"]), 1); // partial
  assert.equal(preferenceScore(["finance"], ["education"]), 0);
});

check("rankByTargetPreference sorts matches first, stable on ties", () => {
  const projects = [
    { id: "p1", categoryId: "life" },
    { id: "p2", categoryId: "education" },
    { id: "p3", categoryId: "life" },
    { id: "p4", categoryId: "education" },
  ];
  const ranked = rankByTargetPreference(["education"], projects, (p) =>
    projectPreferenceSignals(p),
  );
  assert.deepEqual(
    ranked.map((p) => p.id),
    ["p2", "p4", "p1", "p3"], // matches first, original order preserved within each group
  );
});

check("rankByTargetPreference returns input when preferences empty/undefined", () => {
  const projects = [{ id: "a", categoryId: "x" }, { id: "b", categoryId: "y" }];
  assert.deepEqual(rankByTargetPreference(undefined, projects, () => []), projects);
  assert.deepEqual(rankByTargetPreference([], projects, () => []), projects);
});

console.log(`\nAll ${passed} target-preference checks passed.`);
