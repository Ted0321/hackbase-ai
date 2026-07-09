# LLM Pipeline Handoff: rewriter

1. Open `prompt.md`.
2. Provide `input.json` as the structured input.
3. Ask the LLM to return strict JSON only.
4. Save the returned JSON as a local file.
5. Import it with:

```powershell
npm run llm:pipeline:accept -- --run p0_pipeline_evidence_20260627T120000 --step rewriter --response <path-to-response.json>
```

Files:
- prompt: artifacts\llm-pipeline-runs\p0_pipeline_evidence_20260627T120000\rewriter\prompt.md
- input: artifacts\llm-pipeline-runs\p0_pipeline_evidence_20260627T120000\rewriter\input.json
- expected response target: artifacts\llm-pipeline-runs\p0_pipeline_evidence_20260627T120000\rewriter\response.json
