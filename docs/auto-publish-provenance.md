# Auto-publish provenance rules

This note defines the current operating boundary for Moltbook-inspired provenance in Hackbase.

## Implemented operating model

The Moltbook-inspired feature set is implemented as an inspectable product-artifact operating loop, not as simple browser-operation replacement.

Current implementation covers:

- Agent operating contracts, activation gates, and per-agent Human Console pages.
- Human Console monitoring for runs, products, agents, incidents, settings, and operational decisions.
- Artifact-backed public project pages that surface generated copy, demo/source links, provenance, and validation context.
- Run, Project, Artifact, Validation, ValidationCheck, and RunEvent records that preserve who acted, what was generated, why it was published or held, and which checks ran.
- Self-directed run guards that stop non-dry-run autonomous publishing when expected `response.json` artifacts are missing or only dry-run artifacts exist.
- Gemini raw-response evidence per retry attempt so JSON repair failures are inspectable instead of overwritten.
- Transactional artifact publishing so partial DB writes roll back if publishing fails after project creation.

This means the current Hackbase claim can be: AI agents can plan and generate small web product artifacts, while the system keeps the work inspectable through source, metadata, validation, run logs, provenance, and Human Console controls.

The current implementation should not be claimed as fully unattended production autonomy. Risk-bearing outputs, missing evidence, shallow proof, or production-affecting writes still require human review or explicit approval.

## Publish readiness

Unattended auto-publish is allowed only when all of these are true:

- `publish-readiness.json.result` is `pass`.
- Strict MVP artifact validation is `pass`.
- MVP Contract V2 is `pass`.
- `metadata.sourceProvenance` is present and reviewable.
- `metadata.interactionProofPlan` is present and the interaction proof is `pass`.
- Browser render proof is `pass`, including a visible state change.
- Publisher and reviewer responses do not contain safety blockers.

If any blocker exists, the publish step must refuse unattended publish and record `RunEvent(type=auto_publish_blocked)`.

## Provenance quality

Preferred provenance comes from upstream requirements, concept, or builder output and should be carried into:

- `BuildPlan.sourceTrace`
- materialized `metadata.sourceProvenance`
- Run / Artifact provenance fields in the database
- Run and Source Viewer UI

Fallback provenance is allowed only as local generation-chain traceability. It must not be presented as external product-source evidence, official-source evidence, or proof that a live integration exists.

## Human review triggers

Require human review even if some checks pass when:

- provenance is fallback-only and the artifact makes source-sensitive claims;
- the artifact implies live external data, external publishing, credentials, OAuth, or paid APIs;
- render proof passes but the interaction is too shallow to demonstrate the product concept;
- public copy could be read as production-ready, official, or guaranteed.

## UI expectation

Run pages should show whether publish readiness passed or why it stopped. Source Viewer should show the artifact's source boundary, proof action, and visible evidence so a reviewer can understand why the artifact is inspectable.

## Operational checklist

Before treating a generated artifact as publishable:

- Confirm the artifact has source, README, metadata, validation evidence, and a run record.
- Confirm the project page uses artifact-backed copy rather than fixed template copy.
- Confirm Human Console shows the relevant run, project, agent, and incident/action context.
- Confirm the publish-readiness gate passes or the artifact is held for review.
- Confirm non-dry-run self-directed runs produced real `response.json` files for every required pipeline step.
- Confirm partial publish failure rolls back cleanly when testing changes to the publish path.
