# Product Source Index Tables

This folder is the human-editable source of truth for product source material.

- `source-products.tsv`: one row per small rising product, hackathon project, GitHub project, or product-gallery launch.
- `source-evidence.tsv`: source URLs and stored evidence for each product row.
- `value-knowledge.tsv`: reusable value patterns extracted from source products.
- `excluded-products.tsv`: major or established products that should not become source-product cards.

Run `npm run research:index:build` from `apps/web` after editing these TSV files.

`source-product-index.json` is generated for the LLM pipeline. Do not hand-edit it directly.

List-valued cells use ` | ` as the delimiter.

`npm run research:index:update` validates `sourceProductCards` before writing TSV rows. The gate fails on major-product markers, missing product names, missing URLs, duplicate canonical keys, thin `coreMechanism` / `transferableStructure` / `whyItGotAttention`, missing `antiCloneBoundary`, missing provenance metadata, C/D evidence marked as `primary_source_core`, inferred critical fact fields, and missing evidence refs/attention proof for primary source cores.

P0 evidence policy:

- `observed_fields`: facts directly visible in sources.
- `inferred_fields`: AI/script-derived value structure such as transferability or anti-clone analysis.
- `missing_fields`: unavailable facts; do not fabricate them.
- `evidence_level`: `A`, `B`, `C`, or `D`.
- `use_policy`: `primary_source_core`, `weak_context`, `candidate_only`, or `exclude`.

Only `primary_source_core` rows are written into the main index by `research:index:update`. Automated refresh drafts default to `candidate_only` and must be promoted after review.

P1 source refresh policy:

- `npm run research:product-index:prepare` collects candidates from GitHub Search, Devpost, Hugging Face Spaces, Show HN, and NASA Space Apps winner pages when those sources are enabled.
- `npm run research:product-index:review -- --exploration-dir <dir>` summarizes which generated candidates are promotable after human review.
- Keep weak or metadata-only projects as `candidate_only`; promote only A/B evidence cards with observed facts, evidence refs, and no missing source-core fields.
- Hackathon and Show HN items may be useful even without code, but UI/code/award/reaction facts must stay in `missing_fields` unless directly observed.

Fixture checks:

- Valid: `npm run research:index:update -- --dry-run --exploration-dir scripts/fixtures/research-index-gate-valid`
- Invalid: `npm run research:index:update -- --dry-run --exploration-dir scripts/fixtures/research-index-gate-invalid`
