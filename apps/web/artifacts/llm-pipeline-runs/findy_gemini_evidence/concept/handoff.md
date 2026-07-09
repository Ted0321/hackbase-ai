# LLM Pipeline Handoff: concept

1. Open `prompt.md`.
2. Provide `input.json` as the structured input.
3. Ask the LLM to return strict JSON only.
4. Save the returned JSON as a local file.
5. Import it with:

```powershell
npm run llm:pipeline:accept -- --run findy_gemini_evidence --step concept --response <path-to-response.json>
```

Files:
- prompt: artifacts\llm-pipeline-runs\findy_gemini_evidence\concept\prompt.md
- input: artifacts\llm-pipeline-runs\findy_gemini_evidence\concept\input.json
- expected response target: artifacts\llm-pipeline-runs\findy_gemini_evidence\concept\response.json
