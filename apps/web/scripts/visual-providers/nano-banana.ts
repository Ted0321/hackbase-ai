/**
 * Nano Banana Pro provider (Gemini `gemini-3-pro-image`, Developer API).
 *
 * Unlike Imagen (imagen.ts), which uses the `:predict` REST shape and cannot
 * render text reliably, Nano Banana is called via `generateContent` with
 * responseModalities=[TEXT, IMAGE] and returns the image as an inlineData part.
 * It renders exact Japanese title/tagline text in-image, so the showcase prompt
 * (thumbnail-variants.ts) asks for the text directly and no post-compositing is
 * needed.
 *
 * Reuses the existing Gemini auth (GEMINI_API_KEY), the shared daily budget
 * guard (enforceGeminiBudget), and the usage log (logModelUsage) so image spend
 * is capped and observed exactly like text/Imagen generation.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { enforceGeminiBudget } from "../llm-pipeline/rate-guard";
import { logModelUsage } from "../observability";
import {
  ProductVisualImageProvider,
  ProductVisualGenerateArgs,
  ProductVisualGenerateResult,
  VisualProviderNotEnabledError,
} from "./types";

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const numFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const aspectRatioForKind = (kind: ProductVisualGenerateArgs["kind"]): string =>
  kind === "product_showcase" ? "16:9" : "1:1";

export type NanoBananaRequest = {
  endpoint: string;
  body: {
    contents: Array<{ parts: Array<{ text: string }> }>;
    generationConfig: {
      responseModalities: string[];
      imageConfig: { aspectRatio: string; imageSize?: string };
    };
  };
};

/**
 * Build the `generateContent` request. Pure: the API key is passed in (not read
 * from the environment) so this stays testable and never leaks a key into logs.
 * `imageSize` is only sent for gemini-3* image models (older models reject it).
 */
export const buildNanoBananaRequest = (args: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  size: string;
}): NanoBananaRequest => ({
  endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${args.apiKey}`,
  body: {
    contents: [{ parts: [{ text: args.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: args.aspectRatio,
        ...(args.model.startsWith("gemini-3") ? { imageSize: args.size } : {}),
      },
    },
  },
});

type GenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
    finishReason?: string;
  }>;
};

/**
 * Perform the generateContent call and return the decoded image bytes. Shared by
 * the pipeline provider and the standalone thumbnail-lab harness.
 */
export const generateNanoBananaImage = async (args: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  size: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/webp" }> => {
  const request = buildNanoBananaRequest(args);
  const timeoutMs = args.timeoutMs ?? 60_000;
  const maxRetries = args.maxRetries ?? 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`generateContent failed: ${response.status} ${await response.text()}`);
      }
      const json = (await response.json()) as GenerateContentResponse;
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        const finishReason = json.candidates?.[0]?.finishReason ?? "unknown";
        throw new Error(`Nano Banana response had no image (finishReason=${finishReason}).`);
      }
      const mimeType = imagePart.inlineData.mimeType === "image/webp" ? "image/webp" : "image/png";
      return { bytes: Buffer.from(imagePart.inlineData.data, "base64"), mimeType };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const createNanoBananaProvider = (options?: { model?: string }): ProductVisualImageProvider => ({
  id: "nano_banana",
  async generate(args: ProductVisualGenerateArgs): Promise<ProductVisualGenerateResult> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      // No key → never call a paid API. Soft failure → orchestrator uses local_svg.
      throw new VisualProviderNotEnabledError("nano_banana", "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
    }

    const model = options?.model ?? process.env.PRODIA_NANO_BANANA_MODEL ?? "gemini-3-pro-image";
    const size = process.env.PRODIA_NANO_BANANA_SIZE ?? "2K";
    const timeoutMs = intFromEnv("PRODIA_VISUAL_TIMEOUT_MS", 60_000);
    const maxRetries = intFromEnv("PRODIA_VISUAL_MAX_RETRIES", 1);
    const estimatedCostUsd = numFromEnv("PRODIA_NANO_BANANA_COST_USD", 0.15);

    // Count image spend against the same daily cap as text Gemini (halts runaway).
    await enforceGeminiBudget({ operation: "nano-banana-image" });

    const startedAt = Date.now();
    try {
      const result = await generateNanoBananaImage({
        apiKey,
        model,
        prompt: args.prompt,
        aspectRatio: aspectRatioForKind(args.kind),
        size,
        timeoutMs,
        maxRetries,
      });
      await mkdir(path.dirname(args.outputPath), { recursive: true });
      await writeFile(args.outputPath, result.bytes);
      await logModelUsage({
        provider: "google-nano-banana",
        model,
        operation: "nano-banana-image",
        status: "success",
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd,
      });
      return { path: args.outputPath, mimeType: result.mimeType, model };
    } catch (error) {
      await logModelUsage({
        provider: "google-nano-banana",
        model,
        operation: "nano-banana-image",
        status: "error",
        latencyMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
