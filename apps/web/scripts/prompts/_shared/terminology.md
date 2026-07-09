# Hackbase.ai pipeline terminology & enum catalog (reference)

This file is a **reference for prompt authors**, not an auto-injected prompt. Keep step
prompts (`scripts/prompts/*.md`) consistent with the canonical values below so handoffs
between steps line up. `eval:prompt:check` asserts the `templatePatternId` list here stays
in sync with `scripts/templates/product-templates.json`.

## Casing convention
- Handoff JSON keys are **camelCase** (e.g. `templatePatternId`, `materialChoiceReason`,
  `selectionReason`). Do not introduce snake_case keys.
- Enum **values** are lower_snake_case tokens (e.g. `evidence_decision_board`,
  `daily_utility`). This matches the existing fixtures and types.

## Output language policy
- Public-facing natural language should be Japanese by default. This includes visible UI
  copy, artifact README prose, metadata descriptions, review reasons, publish summaries,
  and human-readable agent output.
- Keep structural terms in English when they are part of the contract: JSON keys, enum
  values, file paths, code identifiers, npm scripts, database fields, schema/type names,
  package names, and external product/API names.
- Do not translate canonical enum values such as `templatePatternId`, `surfacePattern`,
  `aiMechanismPattern`, `artifactTier`, `externalDependencyMode`, or validation statuses.
- When public copy needs an English technical term, use it as a term inside Japanese prose
  instead of replacing the surrounding explanation with English.
- Generated source comments may be Japanese when they explain product behavior, but avoid
  long Japanese prose inside compact JSON file contents. Prefer concise JSON values and put
  richer Japanese explanation in BuildPlan fields or README prose.
- Do not expose raw prompt text, internal policy names, runtime field names, tool IDs,
  skill IDs, trigger IDs, secrets, or production-only details in public UI, README, or
  metadata copy. Translate internal context into public-safe Japanese such as "入力準備",
  "ローカル生成", "人が確認する境界", or "サンプルデータ".
- If a generated artifact is for Japanese users or the Hackbase.ai public demo, leaving
  the main explanation in English should be treated as a copy-quality issue unless the
  English phrase is a proper noun, code identifier, or explicit technical label.

## templatePatternId (8 — source of truth: product-templates.json `templatePatterns[].id`)
- `source_to_mission`
- `evidence_decision_board`
- `signal_map`
- `transformation_studio`
- `boundary_simulator`
- `guided_explainer_path`
- `remix_roulette`
- `ops_steward_console`

Do not invent new ids. Adding/removing a pattern is a cross-file change:
`product-templates.json` + concept-strategist.md + builder.md must move together, and
`templates:diversity:check` must still pass (exactly 8 unique, all executable).

## surfacePattern (what a normal user understands)
`daily_utility` · `learning_explainer` · `playful_game` · `decision_helper` ·
`social_civic_tool` · `event_companion` · `creative_assistant` · `work_simplifier`

## aiMechanismPattern (what an AI-aware user appreciates)
`personalized_reasoning` · `multi_source_synthesis` · `agentic_workflow` · `simulation` ·
`evaluation_scoring` · `trust_boundary` · `adaptive_explainer` · `workflow_generation`

## artifactShape (concept)
`board` · `simulator` · `evaluator` · `map` · `workspace` · `game_like_tool` ·
`explainer` · `other`

## Synonym consolidation ("best*" sprawl)
The research/source types historically used several overlapping "best*" fields. When
writing or revising prompts, prefer the single canonical term and treat the others as
deprecated compatibility:
- **`bestRemixTargets`** — canonical: which themes/domains a source core can be remixed into.
  Deprecated near-synonyms: `remixableThemes`, `bestFitSourceMechanisms`.
- **`transferableStructure`** — canonical: the reusable core a source product transfers.
  Deprecated near-synonyms: `ideaKernel`, `noveltyKernel`, `originalCoreTransferred`
  (the last is the concept-side restatement and may stay).
- **`antiCloneBoundary`** — canonical: what must NOT be copied. Keep this one term everywhere.

## Diversity numeric targets (concept candidates)
A concept response returns 3 candidates. Target, and report in `diversityReport`:
- `distinctSurfacePatterns >= 3`
- `distinctTemplatePatternIds >= 3` (unless source material makes it impossible)
- `pairwiseTitleJaccard < 0.4` between any two candidates (title+oneLiner token Jaccard)
