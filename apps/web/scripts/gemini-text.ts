import "./load-local-env";
import { extractGeminiTokenUsage, logModelUsage } from "./observability";
import { enforceGeminiBudget } from "./llm-pipeline/rate-guard";

/**
 * 軽量な Gemini テキスト生成ヘルパー。
 * run-gemini.ts と同じ generateContent エンドポイントを使うが、単一テキスト応答用に最小化したもの。
 * AI反応のLLM生成（FL-5）など、構造化JSONを要さない短文生成で再利用する。
 */
export const generateGeminiText = async (
  prompt: string,
  options?: { model?: string; temperature?: number },
): Promise<string> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.");
  }
  const model = options?.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;

  // B-1: 実コール前に当日のGemini使用量上限を確認（暴走防止）。AI反応(FL-5)等の短文生成もカウント対象。
  await enforceGeminiBudget({ operation: "gemini-text" });

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini generateContent failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: unknown;
  };
  const text = (json.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  // B-1: 当日コスト/リクエスト集計（ModelUsageLog）に載せ、ガードが両Gemini経路を見られるようにする。
  await logModelUsage({
    provider: "google-gemini",
    model,
    operation: "gemini-text",
    status: text ? "success" : "empty",
    latencyMs: Date.now() - startedAt,
    ...extractGeminiTokenUsage(json),
  });

  if (!text) {
    throw new Error("Gemini response did not contain output text.");
  }
  return text;
};
