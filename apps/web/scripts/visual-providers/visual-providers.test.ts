/**
 * Unit checks for the visual provider scaffold (DOC-105/DOC-106).
 * Run with `npm run visuals:providers:test`.
 *
 * These assert the SAFETY contract: with no env set, AI is never requested, and
 * the PR1 imagen scaffold never performs a network call.
 */
import assert from "node:assert/strict";
import {
  aiPlanForKind,
  buildPromptForKind,
  providerForPlan,
  readVisualAiConfig,
} from "./index";
import { buildImagenRequest, createImagenProvider } from "./imagen";
import { VisualProviderNotEnabledError } from "./types";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};
const checkAsync = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

async function main() {
check("default env keeps both kinds on local_svg (no AI requested)", () => {
  const config = readVisualAiConfig({});
  const showcase = aiPlanForKind("product_showcase", config);
  const icon = aiPlanForKind("product_icon", config);
  assert.equal(showcase.aiRequested, false);
  assert.equal(showcase.providerId, "local_svg");
  assert.equal(icon.aiRequested, false);
  assert.equal(providerForPlan(showcase), null);
  assert.equal(providerForPlan(icon), null);
});

check("enabling the switch WITHOUT changing provider stays local_svg", () => {
  const config = readVisualAiConfig({ PRODIA_VISUAL_AI_ENABLED: "true" });
  const plan = aiPlanForKind("product_showcase", config);
  assert.equal(plan.aiRequested, false);
  assert.equal(plan.providerId, "local_svg");
});

check("provider set WITHOUT the master switch stays local_svg", () => {
  const config = readVisualAiConfig({ PRODIA_VISUAL_PROVIDER: "imagen" });
  const plan = aiPlanForKind("product_showcase", config);
  assert.equal(plan.aiRequested, false);
  assert.equal(providerForPlan(plan), null);
});

check("switch + imagen provider requests AI with the configured model", () => {
  const config = readVisualAiConfig({
    PRODIA_VISUAL_AI_ENABLED: "true",
    PRODIA_VISUAL_PROVIDER: "imagen",
    PRODIA_IMAGEN_MODEL: "imagen-4.0-generate-001",
  });
  const plan = aiPlanForKind("product_showcase", config);
  assert.equal(plan.aiRequested, true);
  assert.equal(plan.providerId, "imagen");
  assert.equal(plan.model, "imagen-4.0-generate-001");
  assert.equal(plan.aiOutputBasename, "product-showcase.png");
  assert.notEqual(providerForPlan(plan), null);
});

check("icon and showcase switches are independent", () => {
  const config = readVisualAiConfig({
    PRODIA_ICON_AI_ENABLED: "true",
    PRODIA_ICON_PROVIDER: "imagen",
  });
  assert.equal(aiPlanForKind("product_showcase", config).aiRequested, false);
  assert.equal(aiPlanForKind("product_icon", config).aiRequested, true);
  assert.equal(aiPlanForKind("product_icon", config).aiOutputBasename, "product-logo.png");
});

check("prompt builders embed product fields and forbid readable UI text", () => {
  const fields = { title: "Signal Sifter", oneLiner: "Turn noise into leads", category: "Research" };
  const showcase = buildPromptForKind("product_showcase", fields);
  assert.match(showcase, /Signal Sifter/);
  assert.match(showcase, /Turn noise into leads/);
  assert.match(showcase, /placeholder bars/);
  assert.match(showcase, /Do NOT write any words/);
  assert.match(showcase, /not even the product name/);
  const icon = buildPromptForKind("product_icon", fields);
  assert.match(icon, /no text, no emoji, no mascot/);
  assert.match(icon, /48x48/);
});

check("buildImagenRequest targets the Gemini Developer API predict endpoint", () => {
  const req = buildImagenRequest({
    apiKey: "test-key",
    model: "imagen-3.0-generate-002",
    prompt: "hello",
    aspectRatio: "16:9",
  });
  assert.match(req.endpoint, /generativelanguage\.googleapis\.com\/v1beta\/models\/imagen-3\.0-generate-002:predict/);
  assert.equal(req.body.instances[0].prompt, "hello");
  assert.equal(req.body.parameters.aspectRatio, "16:9");
});

await checkAsync("imagen provider makes NO network call without an API key (throws NotEnabled)", async () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const provider = createImagenProvider({ model: "imagen-3.0-generate-002" });
    await assert.rejects(
      () =>
        provider.generate({
          kind: "product_showcase",
          title: "X",
          oneLiner: "Y",
          category: "Z",
          prompt: "p",
          outputPath: "/tmp/should-not-be-written.png",
        }),
      (error: unknown) => error instanceof VisualProviderNotEnabledError,
    );
  } finally {
    if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
    if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
  }
});
}

main()
  .then(() => {
    console.log(`\n${passed} checks passed.`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
