# artifact_otayori_route_p0

This directory is a materialized LLM BuildPlan artifact candidate.

## Readiness

- First screen value: The intended first screen shows the notice, extracted actions, and uncertainty queue together.
- Core interaction: A user filters action cards, selects one to inspect evidence, and marks review status.
- State change: The selected evidence panel and review status update from user input.
- Inspectable output: README, metadata, sample data, source placeholder, and self-review are all declared.
- Static data boundary: No external API, login, upload, school system, or paid service is required.
- Public boundary: This MVP runs on static sample data.
- Remaining weakness: Needs materialization into a concrete artifact directory and UI smoke verification.

## MVP Contract

- Required files: `source/README.md`, `source/metadata.json`, `source/source/app/page.tsx`, `source/source/data/sample-notice.json`, `source/validation/self-review.json`
- Non-goals: arbitrary PDF parsing; school messaging integration; official notice interpretation; external publishing
- Forbidden dependencies: external API; secret; login-only flow; paid API; external publishing

## Files

- `source/README.md`: Explain the Otayori Route artifact, intended user, static data boundary, and human-review limits.
- `source/metadata.json`: Describe the concept, selected agents, template pattern, and MVP Contract for validation.
- `source/source/app/page.tsx`: Render the one-screen workspace with source notice, action cards, filters, and review state.
- `source/source/data/sample-notice.json`: Hold static sample notice text and extracted action candidates.
- `source/validation/self-review.json`: Record initial self-review against the P0 MVP criteria.

## Demo Placeholder

- `demo-placeholder.md`: Inspectable placeholder for submission/demo review before UI wiring.

## DB Write

skipped: BuildPlan materialization is artifact-only for this session. Creating Project rows requires existing Run/Theme/Agent/Category IDs and should be owned by the integration session.
