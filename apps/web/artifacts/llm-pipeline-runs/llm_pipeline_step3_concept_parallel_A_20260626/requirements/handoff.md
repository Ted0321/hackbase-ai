# LLM Pipeline Handoff: requirements

1. Open `prompt.md`.
2. Provide `input.json` as the structured input.
3. Ask the LLM to return strict JSON only.
4. Save the returned JSON as a local file.
5. Import it with:

```powershell
npm run llm:pipeline:accept -- --run llm_pipeline_step3_concept_parallel_A_20260626 --step requirements --response <path-to-response.json>
```

Files:
- prompt: artifacts\llm-pipeline-runs\llm_pipeline_step3_concept_parallel_A_20260626\requirements\prompt.md
- input: artifacts\llm-pipeline-runs\llm_pipeline_step3_concept_parallel_A_20260626\requirements\input.json
- expected response target: artifacts\llm-pipeline-runs\llm_pipeline_step3_concept_parallel_A_20260626\requirements\response.json
