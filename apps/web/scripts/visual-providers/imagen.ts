/**
 * Imagen provider (Gemini Developer API).
 *
 * Reuses the existing Gemini auth (`GEMINI_API_KEY`), daily budget guard
 * (`enforceGeminiBudget`), and usage log (`logModelUsage`) so image spend is
 * capped and observed exactly like text generation — no new vendor, no new
 * billing surface (DOC-106 provider recommendation).
 *
 * Safety: this only runs when an AI provider was explicitly requested (the
 * orchestrator gates on PRODIA_VISUAL_AI_ENABLED / PRODIA_ICON_AI_ENABLED) AND a
 * key is present. Without a key it throws VisualProviderNotEnabledError, which
 * the orchestrator treats as a soft failure and falls back to local_svg — so a
 * misconfiguration never blocks generation and never silently spends.
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

export type ImagenRequest = {
  endpoint: string;
  body: {
    instances: Array<{ prompt: string }>;
    parameters: { sampleCount: number; aspectRatio: string };
  };
};

/**
 * Build the Imagen `:predict` request for the Gemini Developer API. Pure: the
 * API key is passed in (not read from the environment) so this stays testable
 * and never leaks a key into logs.
 */
export const buildImagenRequest = (args: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
}): ImagenRequest => {
  const modelPath = args.model.startsWith("models/") ? args.model : `models/${args.model}`;
  return {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/${modelPath}:predict?key=${args.apiKey}`,
    body: {
      instances: [{ prompt: args.prompt }],
      parameters: { sampleCount: 1, aspectRatio: args.aspectRatio },
    },
  };
};

export const aspectRatioForKind = (kind: ProductVisualGenerateArgs["kind"]): string =>
  kind === "product_showcase" ? "16:9" : "1:1";

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const numFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

type ImagenPredictResponse = {
  predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
};

export const createImagenProvider = (options?: { model?: string }): ProductVisualImageProvider => ({
  id: "imagen",
  async generate(args: ProductVisualGenerateArgs): Promise<ProductVisualGenerateResult> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      // No key → never call a paid API. Soft failure → orchestrator uses local_svg.
      throw new VisualProviderNotEnabledError("imagen", "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
    }

    const model = options?.model ?? process.env.PRODIA_IMAGEN_MODEL ?? "imagen-4.0-generate-001";
    const timeoutMs = intFromEnv("PRODIA_VISUAL_TIMEOUT_MS", 30_000);
    const maxRetries = intFromEnv("PRODIA_VISUAL_MAX_RETRIES", 1);
    const estimatedCostUsd = numFromEnv("PRODIA_IMAGEN_COST_USD", 0.03);

    // Count image spend against the same daily cap as text Gemini (halts runaway).
    await enforceGeminiBudget({ operation: "imagen-image" });

    const request = buildImagenRequest({
      apiKey,
      model,
      prompt: args.prompt,
      aspectRatio: aspectRatioForKind(args.kind),
    });

    const startedAt = Date.now();
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
          throw new Error(`Imagen predict failed: ${response.status} ${await response.text()}`);
        }
        const json = (await response.json()) as ImagenPredictResponse;
        const prediction = json.predictions?.[0];
        const base64 = prediction?.bytesBase64Encoded;
        if (!base64) {
          throw new Error("Imagen response did not contain image bytes.");
        }

        await mkdir(path.dirname(args.outputPath), { recursive: true });
        await writeFile(args.outputPath, Buffer.from(base64, "base64"));

        await logModelUsage({
          provider: "google-imagen",
          model,
          operation: "imagen-image",
          status: "success",
          latencyMs: Date.now() - startedAt,
          estimatedCostUsd,
        });

        const mimeType = prediction?.mimeType === "image/webp" ? "image/webp" : "image/png";
        return { path: args.outputPath, mimeType, model };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    await logModelUsage({
      provider: "google-imagen",
      model,
      operation: "imagen-image",
      status: "error",
      latencyMs: Date.now() - startedAt,
      errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  },
});
