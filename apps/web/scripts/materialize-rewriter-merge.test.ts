/**
 * materialize-llm-plan.ts の rewriter マージ (R1) の結合テスト。
 * builder の plan.files に rewriter の changedFiles を path 一致で差替/append し、
 * content 無しは builder 本文を維持、不正/非ソース path は skip することを実体化結果で検証する。
 * spawn 流儀は check-publish-readiness.test.ts に倣う。`npm run eval:materialize-merge:test` で実行。
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

const root = path.join(process.cwd(), "artifacts", "llm-pipeline-runs");
const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = async () => {
  const runId = "eval_materialize_merge_test";
  const runRoot = path.join(root, runId);
  const artifactId = "artifact";
  await rm(runRoot, { recursive: true, force: true });

  // builder: 2 つの code-like ファイル。
  await writeJson(path.join(runRoot, "builder", "response.json"), {
    requirementSpecId: "req_merge_test",
    framework: "next",
    files: [
      {
        path: "app/page.tsx",
        purpose: "Primary UI",
        content: "export default function Page(){ return <div>BUILDER_A</div>; }",
      },
      {
        path: "app/keep.tsx",
        purpose: "Untouched helper",
        content: "export const Keep = () => <div>BUILDER_KEEP</div>;",
      },
      {
        path: "source/components/SourcePrefixed.tsx",
        purpose: "Already source-prefixed component",
        content: "export const SourcePrefixed = () => <div>SOURCE_PREFIXED</div>;",
      },
      {
        path: "source/integrations/xApiMock.ts",
        purpose: "Mock adapter",
        content: "export const fetchMock = () => [{ id: 'p1' }];",
      },
      {
        path: "source/data/x-posts.sample.ts",
        purpose: "Mock sample data",
        content: "export const samplePosts = [{ id: 'p1' }];",
      },
      {
        path: "source/core/steps/prompt-step.ts",
        purpose: "Prompt template step kept when rewriter output is broken",
        content: "export const promptStep = `builder prompt BUILDER_PROMPT`;",
      },
    ],
    implementationNotes: [],
    knownRisks: [],
    submissionReadiness: {
      firstScreenValue: "first",
      coreInteraction: "click",
      inspectableOutput: "text",
      staticDataBoundary: "local fixture",
      remainingWeakness: "none",
    },
    mvpContractV2: {
      artifactTier: "mocked_integration_mvp",
      externalDependencyMode: "mocked_adapter",
      requiredFiles: [
        "source/app/page.tsx",
        "source/components/SourcePrefixed.tsx",
        "source/integrations/xApiMock.ts",
        "source/data/x-posts.sample.ts",
      ],
      externalIntegrations: [
        {
          service: "X API",
          intendedUse: "Fixture mock adapter",
          dataFlow: "fixture -> mock adapter -> UI",
          authRequirement: "oauth",
          currentImplementation: "mock_adapter",
          adapterPath: "source/integrations/xApiMock.ts",
          sampleDataPath: "source/data/x-posts.sample.ts",
          riskNotes: ["No live service in fixture"],
        },
      ],
      runtimeBoundary: {
        networkCalls: "none",
        secrets: "none",
        externalWrites: "none",
      },
      integrationAssumptions: [
        {
          service: "X API",
          verificationStatus: "unverified",
          unavailableOrUnknown: ["Fixture only"],
          rateLimitRisk: "unknown",
          costRisk: "unknown",
          termsRisk: "unknown",
        },
      ],
      mockFidelity: {
        samplePayloadPath: "source/data/x-posts.sample.ts",
        simulatedBehaviors: ["Static fixture payload"],
        omittedBehaviors: ["OAuth", "rate limits", "live network calls"],
        failureCasesIncluded: ["empty result"],
      },
      claimBoundary: {
        publicCopyMustSay: ["This MVP does not connect to the external service at runtime."],
        publicCopyMustNotSay: ["live external data is guaranteed"],
      },
      renderVerification: {
        required: true,
        checks: ["render", "click", "state_change", "screenshot"],
      },
    },
  });

  // rewriter: page を差替 / keep は content 無し / extra を追加 / 不正 path は skip。
  await writeJson(path.join(runRoot, "rewriter", "response.json"), {
    status: "revised",
    changedFiles: [
      {
        path: "app/page.tsx",
        changeSummary: "fix first screen",
        content:
          "export default function Page(){ return <main><button data-proof=\"primary-action\">Apply</button><section data-proof=\"result\"><h2>REWRITER_A</h2><strong>Ready result</strong></section></main>; }",
      },
      { path: "app/keep.tsx", changeSummary: "no content provided" },
      {
        path: "app/extra.tsx",
        changeSummary: "added by rewriter",
        content: "export const Extra = () => <div>REWRITER_EXTRA</div>;",
      },
      { path: "../evil.tsx", content: "export const Evil = 1;" },
      {
        // 修復不能な構文破壊(未終端テンプレートリテラル)は変更を捨てて builder 原本を維持する。
        path: "source/core/steps/prompt-step.ts",
        changeSummary: "broken rewrite must be dropped",
        content: "export const promptStep = { unterminated: `REWRITER_BROKEN\n",
      },
      {
        // テンプレートリテラル内の生```フェンス(2026-07-14 HeatShield形)は自動エスケープで採用される。
        path: "source/core/steps/fence-step.ts",
        changeSummary: "added prompt step with raw fence",
        content:
          "export const fencePrompt = `出力は必ずJSONのみ。説明文や```jsonマークは不要です。\nREWRITER_FENCE\n`;",
      },
    ],
    addressedReviewIssues: ["rev-001"],
  });

  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      "scripts/materialize-llm-plan.ts",
      "--input",
      `artifacts/llm-pipeline-runs/${runId}/builder/response.json`,
      "--run",
      runId,
      "--artifact",
      artifactId,
      "--write",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" },
    },
  );

  assert.equal(result.status, 0, `materialize exited ${result.status}: ${result.stderr}`);

  const artifactDir = path.join(runRoot, "materialized", artifactId);
  const read = (rel: string) => readFile(path.join(artifactDir, rel), "utf8");

  const pageContent = await read("source/app/page.tsx");
  assert.ok(pageContent.includes("REWRITER_A"), "page.tsx should use rewriter content");
  assert.ok(!pageContent.includes("BUILDER_A"), "page.tsx should not keep builder content");

  const keepContent = await read("source/app/keep.tsx");
  assert.ok(
    keepContent.includes("BUILDER_KEEP"),
    "keep.tsx should retain builder content when rewriter had no content",
  );

  const extraContent = await read("source/app/extra.tsx");
  assert.ok(extraContent.includes("REWRITER_EXTRA"), "extra.tsx should be appended from rewriter");

  const sourcePrefixedContent = await read("source/components/SourcePrefixed.tsx");
  assert.ok(sourcePrefixedContent.includes("SOURCE_PREFIXED"), "source-prefixed paths should not be nested");

  const promptStepContent = await read("source/core/steps/prompt-step.ts");
  assert.ok(
    promptStepContent.includes("BUILDER_PROMPT"),
    "prompt-step.ts should keep builder content when rewriter output has unrepairable syntax",
  );
  assert.ok(!promptStepContent.includes("REWRITER_BROKEN"), "broken rewriter content must not be materialized");

  const fenceStepContent = await read("source/core/steps/fence-step.ts");
  assert.ok(fenceStepContent.includes("REWRITER_FENCE"), "repairable rewriter file should be appended");
  assert.ok(
    fenceStepContent.includes("\\`\\`\\`json"),
    "raw ``` fence inside a template literal should be escaped on materialize",
  );

  const metadata = JSON.parse(await read("metadata.json")) as {
    rewriteApplied?: { changedFilePaths: string[]; appendedFilePaths: string[] };
    interactionProofPlan?: {
      primaryAction?: string;
      expectedState?: string;
      requiredSourceFiles?: string[];
      manualFallbackReason?: string;
    };
    sourceProvenance?: {
      sourceProductUsed?: string;
      sourceProductUse?: string;
      sourceEvidenceAudit?: {
        evidenceLevel?: string;
        observedFields?: string[];
        missingFields?: string[];
        usePolicy?: string;
      };
      sourceBoundary?: string;
      antiCloneBoundary?: string;
    };
    sourceFiles: Array<{ relativePath: string }>;
    mvpContractV2: {
      requiredFiles: string[];
      externalIntegrations: Array<{ adapterPath?: string; sampleDataPath?: string }>;
      mockFidelity?: { samplePayloadPath?: string };
    };
  };
  assert.ok(metadata.rewriteApplied, "metadata.rewriteApplied should be present");
  assert.deepEqual(metadata.rewriteApplied?.changedFilePaths, ["app/page.tsx"]);
  assert.deepEqual(metadata.rewriteApplied?.appendedFilePaths, ["app/extra.tsx", "source/core/steps/fence-step.ts"]);

  const evilMaterialized = metadata.sourceFiles.some((file) => file.relativePath.includes("evil"));
  assert.ok(!evilMaterialized, "unsafe ../evil.tsx path must be skipped");
  assert.ok(
    metadata.sourceFiles.every((file) => !file.relativePath.includes("source/source/")),
    "materialized source paths must not contain source/source",
  );
  assert.ok(
    metadata.mvpContractV2.requiredFiles.every((file) => !file.includes("source/source/")),
    "mvpContractV2.requiredFiles must not contain source/source",
  );
  assert.equal(metadata.mvpContractV2.externalIntegrations[0]?.adapterPath, "source/integrations/xApiMock.ts");
  assert.equal(metadata.mvpContractV2.externalIntegrations[0]?.sampleDataPath, "source/data/x-posts.sample.ts");
  assert.equal(metadata.mvpContractV2.mockFidelity?.samplePayloadPath, "source/data/x-posts.sample.ts");
  assert.ok(metadata.interactionProofPlan, "metadata.interactionProofPlan fallback should be present");
  assert.equal(metadata.interactionProofPlan?.primaryAction, "Apply");
  assert.equal(metadata.interactionProofPlan?.requiredSourceFiles?.[0], "source/app/page.tsx");
  assert.ok(
    metadata.interactionProofPlan?.manualFallbackReason?.includes("Generated fallback proof plan"),
    "fallback proof plan should explain why it was generated",
  );
  assert.ok(metadata.sourceProvenance, "metadata.sourceProvenance fallback should be present");
  assert.equal(metadata.sourceProvenance?.sourceProductUsed, "req_merge_test");
  assert.equal(metadata.sourceProvenance?.sourceProductUse, "direct");
  assert.equal(metadata.sourceProvenance?.sourceEvidenceAudit?.evidenceLevel, "generated_artifact_metadata");
  assert.ok(
    metadata.sourceProvenance?.antiCloneBoundary?.includes("must not be presented as external product-source evidence"),
    "fallback provenance should not over-claim external source evidence",
  );

  await rm(runRoot, { recursive: true, force: true });
  console.log("PASS materialize rewriter merge (R1): replace / keep / append / skip-unsafe");
  console.log("\nAll materialize-rewriter-merge checks passed.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
