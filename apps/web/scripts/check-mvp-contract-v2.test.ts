import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), "artifacts", "mvp-contract-v2-tests");
const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");

const run = (artifactPath: string) =>
  spawnSync(process.execPath, [tsxCli, "scripts/check-mvp-contract-v2.ts", "--path", artifactPath, "--json-only"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
    },
  });

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const baseContract = {
  contractVersion: "mvp-contract-v2",
  artifactTier: "mocked_integration_mvp",
  firstScreenValue: "Shows a trend summary workspace",
  coreInteraction: "Clicking Analyze updates the summary",
  stateChange: "The summary changes from idle to analyzed",
  inspectableOutput: "README and source files show the mock integration",
  staticDataBoundary: "Uses static sample data and mock adapters only",
  requiredFiles: ["source/app/page.tsx", "source/integrations/xApiMock.ts", "source/data/x-posts.sample.ts"],
  nonGoals: ["No live external API integration"],
  forbiddenDependencies: ["external API", "secret", "external publishing"],
  externalDependencyMode: "mocked_adapter",
  externalIntegrations: [
    {
      service: "X API",
      intendedUse: "Collect recent topic signals after MVP validation",
      dataFlow: "query -> mock posts -> summary -> UI",
      authRequirement: "oauth",
      currentImplementation: "mock_adapter",
      adapterPath: "source/integrations/xApiMock.ts",
      sampleDataPath: "source/data/x-posts.sample.ts",
      riskNotes: ["MVP does not call the real service"],
    },
  ],
  runtimeBoundary: {
    networkCalls: "none",
    secrets: "none",
    externalWrites: "none",
  },
  mvpComplexityBudget: {
    maxScreens: 1,
    maxPrimaryActions: 1,
    maxSourceFiles: 12,
    maxNewDependencies: 0,
    allowDatabase: false,
  },
  integrationAssumptions: [
    {
      service: "X API",
      verificationStatus: "unverified",
      unavailableOrUnknown: ["Official docs are not checked in this fixture"],
      rateLimitRisk: "unknown",
      costRisk: "unknown",
      termsRisk: "unknown",
    },
  ],
  mockFidelity: {
    simulatedBehaviors: ["Static search response"],
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
  humanReviewTriggers: [],
};

const createArtifact = async (name: string, metadata: unknown) => {
  const artifactDir = path.join(root, name);
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(path.join(artifactDir, "source", "app"), { recursive: true });
  await mkdir(path.join(artifactDir, "source", "integrations"), { recursive: true });
  await mkdir(path.join(artifactDir, "source", "data"), { recursive: true });

  await writeFile(
    path.join(artifactDir, "README.md"),
    [
      "# MVP Contract V2 Fixture",
      "",
      "This MVP does not connect to the external service at runtime.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeJson(path.join(artifactDir, "metadata.json"), metadata);
  await writeJson(path.join(artifactDir, "source", "metadata.json"), {
    note: "Internal artifact metadata may repeat forbidden claim examples such as live external data is guaranteed.",
  });
  await writeFile(
    path.join(artifactDir, "source", "app", "page.tsx"),
    "export default function Page() { return <main><button>Analyze</button><p>analyzed</p></main>; }\n",
    "utf8",
  );
  await writeFile(
    path.join(artifactDir, "source", "integrations", "xApiMock.ts"),
    "export const fetchMockPosts = () => [{ id: 'p1', text: 'sample' }];\n",
    "utf8",
  );
  await writeFile(
    path.join(artifactDir, "source", "data", "x-posts.sample.ts"),
    "export const samplePosts = [{ id: 'p1', text: 'sample' }];\n",
    "utf8",
  );

  return {
    dir: artifactDir,
    rel: path.relative(process.cwd(), artifactDir).replace(/\\/g, "/"),
  };
};

const parseResult = (stdout: string) => JSON.parse(stdout) as { result: string; source: string; autoPublishable: boolean };

const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

async function main() {
  const mocked = await createArtifact("mocked", {
    version: 1,
    artifactId: "mocked",
    mvpContractV2: baseContract,
  });
  const mockedRun = run(mocked.rel);
  expect(mockedRun.status === 0, `mocked fixture should exit 0, got ${mockedRun.status}\n${mockedRun.stdout}\n${mockedRun.stderr}`);
  const mockedResult = parseResult(mockedRun.stdout);
  expect(mockedResult.result === "warn", `mocked fixture should warn only for render report, got ${mockedResult.result}`);
  expect(mockedResult.autoPublishable === true, "mocked fixture should be autoPublishable");

  const proposed = await createArtifact("proposed", {
    version: 1,
    artifactId: "proposed",
    mvpContractV2: {
      ...baseContract,
      artifactTier: "proposed_integration",
      externalDependencyMode: "proposed",
      externalIntegrations: [
        {
          service: "X API",
          intendedUse: "Collect recent topic signals after MVP validation",
          dataFlow: "query -> future adapter -> UI",
          authRequirement: "oauth",
          currentImplementation: "not_connected",
          riskNotes: ["MVP describes the integration but does not connect to it"],
        },
      ],
      runtimeBoundary: {
        networkCalls: "none",
        secrets: "none",
        externalWrites: "none",
      },
      mockFidelity: {
        simulatedBehaviors: ["Static sample response for the proposed service"],
        omittedBehaviors: ["OAuth", "rate limits", "live network calls"],
        failureCasesIncluded: ["empty result"],
      },
    },
  });
  const proposedRun = run(proposed.rel);
  expect(
    proposedRun.status === 0,
    `proposed fixture should exit 0, got ${proposedRun.status}\n${proposedRun.stdout}\n${proposedRun.stderr}`,
  );
  const proposedResult = parseResult(proposedRun.stdout);
  expect(proposedResult.result === "warn", `proposed fixture should warn only for render report, got ${proposedResult.result}`);
  expect(proposedResult.autoPublishable === true, "proposed fixture should be autoPublishable");

  const legacy = await createArtifact("legacy", {
    version: 1,
    artifactId: "legacy",
    mvpContract: {
      firstScreenValue: "Shows a useful first screen",
      coreInteraction: "Clicking Analyze updates the summary",
      stateChange: "The summary changes from idle to analyzed",
      inspectableOutput: "README and source files",
      staticDataBoundary: "Static sample data only",
      requiredFiles: ["source/app/page.tsx"],
      nonGoals: ["No live API"],
      forbiddenDependencies: ["secret"],
    },
  });
  const legacyRun = run(legacy.rel);
  expect(legacyRun.status === 0, `legacy fixture should exit 0, got ${legacyRun.status}\n${legacyRun.stdout}\n${legacyRun.stderr}`);
  const legacyResult = parseResult(legacyRun.stdout);
  expect(legacyResult.source === "v1_fallback", `legacy fixture should use v1_fallback, got ${legacyResult.source}`);
  expect(legacyResult.result === "warn", `legacy fixture should warn, got ${legacyResult.result}`);

  // コアロジックファースト: source/core/** 内の fetch は文書化呼び出しパターンとして許可され、
  // proposed モードで autoPublishable のまま。同じ fetch がデモ側(page.tsx)にあると fail する。
  const coreFetch = await createArtifact("core-fetch", {
    version: 1,
    artifactId: "core-fetch",
    mvpContractV2: {
      ...baseContract,
      artifactTier: "proposed_integration",
      externalDependencyMode: "proposed",
      externalIntegrations: [
        {
          service: "Gemini API",
          intendedUse: "Summarize input via gemini-2.5-flash",
          dataFlow: "input -> core pipeline -> UI",
          authRequirement: "api_key",
          currentImplementation: "not_connected",
          riskNotes: ["Documented call pattern only; the demo replays a sample trace"],
        },
      ],
      mockFidelity: {
        simulatedBehaviors: ["Recorded sample trace replay"],
        omittedBehaviors: ["OAuth", "rate limits", "live network calls"],
        failureCasesIncluded: ["empty result"],
      },
    },
  });
  await mkdir(path.join(coreFetch.dir, "source", "core"), { recursive: true });
  await writeFile(
    path.join(coreFetch.dir, "source", "core", "gemini.ts"),
    "export const callGemini = (apiKey: string) => fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', { headers: { 'x-goog-api-key': apiKey } });\n",
    "utf8",
  );
  const coreFetchRun = run(coreFetch.rel);
  expect(
    coreFetchRun.status === 0,
    `core-fetch fixture should exit 0 (fetch under source/core/ is allowed), got ${coreFetchRun.status}\n${coreFetchRun.stdout}\n${coreFetchRun.stderr}`,
  );
  const coreFetchResult = parseResult(coreFetchRun.stdout);
  expect(coreFetchResult.autoPublishable === true, "core-fetch fixture should be autoPublishable");

  const demoFetch = await createArtifact("demo-fetch", {
    version: 1,
    artifactId: "demo-fetch",
    mvpContractV2: {
      ...baseContract,
      artifactTier: "proposed_integration",
      externalDependencyMode: "proposed",
      externalIntegrations: [
        {
          service: "Gemini API",
          intendedUse: "Summarize input via gemini-2.5-flash",
          dataFlow: "input -> core pipeline -> UI",
          authRequirement: "api_key",
          currentImplementation: "not_connected",
          riskNotes: ["Documented call pattern only"],
        },
      ],
      mockFidelity: {
        simulatedBehaviors: ["Recorded sample trace replay"],
        omittedBehaviors: ["OAuth", "rate limits", "live network calls"],
        failureCasesIncluded: ["empty result"],
      },
    },
  });
  await writeFile(
    path.join(demoFetch.dir, "source", "app", "page.tsx"),
    "export default function Page() { fetch('https://example.com'); return <main><button>Analyze</button><p>analyzed</p></main>; }\n",
    "utf8",
  );
  const demoFetchRun = run(demoFetch.rel);
  expect(demoFetchRun.status === 1, `demo-fetch fixture should exit 1 (fetch outside core/ is forbidden), got ${demoFetchRun.status}`);
  const demoFetchResult = parseResult(demoFetchRun.stdout);
  expect(demoFetchResult.result === "fail", `demo-fetch fixture should fail, got ${demoFetchResult.result}`);

  const live = await createArtifact("live", {
    version: 1,
    artifactId: "live",
    mvpContractV2: {
      ...baseContract,
      artifactTier: "live_integration_candidate",
      externalDependencyMode: "live_required",
      runtimeBoundary: {
        networkCalls: "live_required",
        secrets: "required",
        externalWrites: "live_required",
      },
    },
  });
  const liveRun = run(live.rel);
  expect(liveRun.status === 1, `live fixture should exit 1, got ${liveRun.status}`);
  const liveResult = parseResult(liveRun.stdout);
  expect(liveResult.result === "fail", `live fixture should fail, got ${liveResult.result}`);
  expect(liveResult.autoPublishable === false, "live fixture should not be autoPublishable");

  await rm(root, { recursive: true, force: true });
  console.log("mvp contract v2 tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
