/**
 * Visual provider orchestration + env-gated config (DOC-105 / DOC-106).
 *
 * Safety contract:
 *   - AI generation is OFF by default. With no env set, `aiPlanForKind` returns
 *     a local_svg plan and no provider is constructed or called.
 *   - AI is reached only when the per-kind master switch is `true` AND the
 *     selected provider is not `local_svg`.
 *   - Any provider error (including the PR1 not-enabled scaffold) is caught by
 *     the caller and falls back to the deterministic local SVG asset.
 */
import {
  ProductVisualImageProvider,
  ProductVisualKind,
  VisualProviderId,
  buildPromptForKind,
} from "./types";
import { createImagenProvider, aspectRatioForKind } from "./imagen";
import { createNanoBananaProvider } from "./nano-banana";

const isProviderId = (value: string): value is VisualProviderId =>
  value === "local_svg" ||
  value === "imagen" ||
  value === "openai_images" ||
  value === "nano_banana";

const readProviderId = (value: string | undefined, fallback: VisualProviderId): VisualProviderId => {
  const normalized = (value ?? "").trim();
  return isProviderId(normalized) ? normalized : fallback;
};

const truthy = (value: string | undefined): boolean => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

export type VisualAiConfig = {
  showcaseEnabled: boolean;
  iconEnabled: boolean;
  showcaseProvider: VisualProviderId;
  iconProvider: VisualProviderId;
  imagenModel: string;
  nanoBananaModel: string;
  openaiImageModel: string;
  timeoutMs: number;
  maxRetries: number;
};

export const readVisualAiConfig = (
  env: Record<string, string | undefined> = process.env,
): VisualAiConfig => ({
  showcaseEnabled: truthy(env.PRODIA_VISUAL_AI_ENABLED),
  iconEnabled: truthy(env.PRODIA_ICON_AI_ENABLED),
  showcaseProvider: readProviderId(env.PRODIA_VISUAL_PROVIDER, "local_svg"),
  iconProvider: readProviderId(env.PRODIA_ICON_PROVIDER, "local_svg"),
  imagenModel: (env.PRODIA_IMAGEN_MODEL ?? "").trim() || "imagen-3.0-generate-002",
  nanoBananaModel: (env.PRODIA_NANO_BANANA_MODEL ?? "").trim() || "gemini-3-pro-image",
  openaiImageModel: (env.OPENAI_IMAGE_MODEL ?? "").trim() || "gpt-image-1",
  timeoutMs: Number.parseInt(env.PRODIA_VISUAL_TIMEOUT_MS ?? "", 10) || 30_000,
  maxRetries: Number.parseInt(env.PRODIA_VISUAL_MAX_RETRIES ?? "", 10) || 1,
});

export type VisualPlan = {
  kind: ProductVisualKind;
  /** True when an AI provider should be attempted (local_svg fallback remains). */
  aiRequested: boolean;
  providerId: VisualProviderId;
  model?: string;
  /** Output basename the AI image would be written to, relative to mockups/. */
  aiOutputBasename: string;
};

const AI_OUTPUT_BASENAME: Record<ProductVisualKind, string> = {
  product_showcase: "product-showcase.png",
  product_icon: "product-logo.png",
};

/**
 * Decide, from config, whether a kind attempts AI generation and with which
 * provider/model. `local_svg` (or a disabled switch) yields aiRequested=false.
 */
export const aiPlanForKind = (kind: ProductVisualKind, config: VisualAiConfig): VisualPlan => {
  const enabled = kind === "product_showcase" ? config.showcaseEnabled : config.iconEnabled;
  const providerId = kind === "product_showcase" ? config.showcaseProvider : config.iconProvider;
  const aiRequested = enabled && providerId !== "local_svg";
  const model =
    providerId === "imagen"
      ? config.imagenModel
      : providerId === "nano_banana"
        ? config.nanoBananaModel
        : providerId === "openai_images"
          ? config.openaiImageModel
          : undefined;
  return {
    kind,
    aiRequested,
    providerId: aiRequested ? providerId : "local_svg",
    model: aiRequested ? model : undefined,
    aiOutputBasename: AI_OUTPUT_BASENAME[kind],
  };
};

/**
 * Construct the provider implementation for a plan. Returns null for local_svg
 * (handled deterministically by the local generator). Only called when
 * plan.aiRequested is true.
 */
export const providerForPlan = (plan: VisualPlan): ProductVisualImageProvider | null => {
  if (!plan.aiRequested) return null;
  switch (plan.providerId) {
    case "imagen":
      return createImagenProvider({ model: plan.model });
    case "nano_banana":
      return createNanoBananaProvider({ model: plan.model });
    case "openai_images":
      // PR4: OpenAI gpt-image-1 provider. Not scaffolded yet — fall back to local_svg.
      return null;
    default:
      return null;
  }
};

export { buildPromptForKind, aspectRatioForKind };
export type { ProductVisualKind, VisualProviderId };
