/**
 * Unit checks for public project visibility boundaries.
 * Run with `npm run eval:project-visibility:test`.
 */
import assert from "node:assert/strict";
import {
  activeProjectWhere,
  isActiveProject,
  isPublicProject,
  publicProjectWhere,
  selectPublicRunProject,
} from "../src/lib/project-visibility";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("isPublicProject allows only visible published states", () => {
  assert.equal(isPublicProject({ status: "published", publishDecision: "human_approved" }), true);
  assert.equal(isPublicProject({ status: "auto_published", publishDecision: "auto_published" }), true);
});

check("isPublicProject excludes review, archived, and withdrawn states", () => {
  assert.equal(isPublicProject({ status: "held_for_review", publishDecision: "ops_review" }), false);
  assert.equal(isPublicProject({ status: "archived", publishDecision: "withdrawn" }), false);
  assert.equal(isPublicProject({ status: "withdrawn", publishDecision: "withdrawn" }), false);
  assert.equal(isPublicProject({ status: "published", publishDecision: "withdrawn" }), false);
});

check("publicProjectWhere matches the route/action visibility policy", () => {
  assert.deepEqual(publicProjectWhere, {
    status: {
      in: ["auto_published", "published"],
    },
    NOT: {
      publishDecision: "withdrawn",
    },
  });
});

check("isActiveProject excludes withdrawn projects from admin default views", () => {
  assert.equal(isActiveProject({ status: "published", publishDecision: "human_approved" }), true);
  assert.equal(isActiveProject({ status: "auto_published", publishDecision: "auto_published" }), true);
  assert.equal(isActiveProject({ status: "withdrawn", publishDecision: "withdrawn" }), false);
  assert.equal(isActiveProject({ status: "published", publishDecision: "withdrawn" }), false);
});

check("activeProjectWhere matches the admin default visibility policy", () => {
  assert.deepEqual(activeProjectWhere, {
    NOT: [
      { status: "withdrawn" },
      { publishDecision: "withdrawn" },
    ],
  });
});

check("selectPublicRunProject ignores withdrawn projects even when publishedAt remains", () => {
  const selected = selectPublicRunProject([
    {
      id: "withdrawn_with_timestamp",
      status: "published",
      publishDecision: "withdrawn",
      publishedAt: new Date("2026-07-05T01:00:00.000Z"),
    },
    {
      id: "visible_project",
      status: "auto_published",
      publishDecision: "auto_published",
      publishedAt: new Date("2026-07-05T00:00:00.000Z"),
    },
  ]);

  assert.equal(selected?.id, "visible_project");
});

check("selectPublicRunProject returns undefined when a run has no public project", () => {
  const selected = selectPublicRunProject([
    {
      id: "held",
      status: "held_for_review",
      publishDecision: "ops_review",
      publishedAt: null,
    },
    {
      id: "withdrawn",
      status: "published",
      publishDecision: "withdrawn",
      publishedAt: new Date("2026-07-05T01:00:00.000Z"),
    },
  ]);

  assert.equal(selected, undefined);
});

console.log(`\nAll ${passed} project-visibility checks passed.`);
