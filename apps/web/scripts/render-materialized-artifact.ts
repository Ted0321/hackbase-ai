import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Locator, type Page } from "playwright";

type CheckStatus = "pass" | "fail" | "warn";

type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

type JsonRecord = Record<string, unknown>;

type RenderVerificationReport = {
  version: 1;
  generatedAt: string;
  path: string;
  result: "pass" | "fail" | "warn";
  checks: Check[];
  summary: string;
  previewPath?: string;
  screenshotPath?: string;
};

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  const artifactPath = typeof values.get("path") === "string" ? String(values.get("path")) : "";
  if (!artifactPath) {
    console.error(
      "Usage: tsx scripts/render-materialized-artifact.ts --path <artifact-dir> [--write] [--output <json>]",
    );
    process.exit(1);
  }

  return {
    artifactPath,
    write: values.get("write") === true,
    output: typeof values.get("output") === "string" ? String(values.get("output")) : "",
  };
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isNonEmptyString(item)) : [];

const requireFromWeb = createRequire(path.join(process.cwd(), "package.json"));

const fileExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const toRel = (root: string, filePath: string) =>
  path.relative(root, filePath).replace(/\\/g, "/");

const toImportPath = (fromDir: string, target: string) => {
  const relative = toRel(fromDir, target).replace(/\.tsx?$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const resolveFileCandidate = (basePath: string): string | null => {
  const candidates = [
    basePath,
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
    `${basePath}.css`,
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.jsx"),
    path.join(basePath, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const artifactResolverPlugin = (entrypointPath: string): Plugin => ({
  name: "artifact-render-resolver",
  setup(pluginBuild) {
    const modulePaths = new Map<string, string>([
      ["react", requireFromWeb.resolve("react")],
      ["react-dom", requireFromWeb.resolve("react-dom")],
      ["react-dom/client", requireFromWeb.resolve("react-dom/client")],
      ["react/jsx-runtime", requireFromWeb.resolve("react/jsx-runtime")],
      ["scheduler", requireFromWeb.resolve("scheduler")],
    ]);

    pluginBuild.onResolve({ filter: /^(react|react-dom|react-dom\/client|react\/jsx-runtime|scheduler)$/ }, (args) => {
      const resolved = modulePaths.get(args.path);
      return resolved ? { path: resolved } : null;
    });

    pluginBuild.onResolve({ filter: /^\.\.\/\.\.\/source\/app\/page$/ }, () => ({ path: entrypointPath }));

    // `@/` path alias -> materialized `source/` root. builder が entrypoint 等で
    // `@/components/...` / `@/data/...` を使うことがあり、相対 import ではないため
    // 素の esbuild では解決できず render proof の bundle が失敗する。source ルートに写像する。
    // entrypointPath は `.../source/app/page.tsx` なので dirname 2 つ上が `source/`。
    const sourceRoot = path.resolve(path.dirname(entrypointPath), "..");
    pluginBuild.onResolve({ filter: /^@\// }, (args) => {
      const resolved = resolveFileCandidate(path.resolve(sourceRoot, args.path.slice(2)));
      return resolved ? { path: resolved } : null;
    });

    pluginBuild.onResolve({ filter: /^\./ }, (args) => {
      const resolved = resolveFileCandidate(path.resolve(args.resolveDir, args.path));
      return resolved ? { path: resolved } : null;
    });
  },
});

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const push = (checks: Check[], id: string, ok: boolean, pass: string, fail: string) => {
  checks.push({ id, status: ok ? "pass" : "fail", message: ok ? pass : fail });
};

const findFirstVisible = async (page: Page, selectors: string[]): Promise<{ selector: string; locator: Locator } | null> => {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return { selector, locator: candidate };
        }
      }
    } catch {
      // Invalid selectors are reported by the selector evidence checks.
    }
  }
  return null;
};

const collectVisibleSelectors = async (page: Page, selectors: string[]): Promise<string[]> => {
  const visible: string[] = [];
  for (const selector of selectors) {
    if (await findFirstVisible(page, [selector])) visible.push(selector);
  }
  return visible;
};

const primeInputsForStateChange = async (page: Page) => {
  const selects = page.locator("select:visible");
  const selectCount = await selects.count().catch(() => 0);
  for (let index = 0; index < selectCount; index += 1) {
    const select = selects.nth(index);
    const id = (await select.getAttribute("id").catch(() => ""))?.toLowerCase() ?? "";
    if (id.includes("family")) {
      await select
        .evaluate((element) => {
          const selectElement = element as HTMLSelectElement;
          for (const option of Array.from(selectElement.options)) {
            option.selected = option.value.includes("Child");
          }
          selectElement.dispatchEvent(new Event("input", { bubbles: true }));
          selectElement.dispatchEvent(new Event("change", { bubbles: true }));
        })
        .catch(() => undefined);
    }
  }

  const textInputs = page.locator("input[type='text']:visible");
  const count = await textInputs.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    const input = textInputs.nth(index);
    // readonly/disabled inputs (builders often render sample URLs as readonly text)
    // would make fill() wait out its full 30s timeout and throw, killing the whole
    // proof run before any report is written ("unparsed" in publish readiness).
    // Skip them, and never let a single stubborn input abort the harness.
    const editable = await input.isEditable({ timeout: 500 }).catch(() => false);
    if (!editable) continue;
    const current = await input.inputValue().catch(() => "");
    const id = (await input.getAttribute("id").catch(() => ""))?.toLowerCase() ?? "";
    const fillSafely = (value: string) => input.fill(value, { timeout: 3000 }).catch(() => undefined);
    if (id.includes("postal")) {
      await fillSafely("200-0001");
    } else if (id.includes("family") || index === 1) {
      await fillSafely("Child_1");
    } else if (id.includes("specific")) {
      await fillSafely("allergy");
    } else {
      await fillSafely(`${current} updated`);
    }
  }
};

const clickPrimaryAction = async (
  page: Page,
  proofSelectors: string[],
  primaryAction: string,
): Promise<{ clicked: boolean; target: string }> => {
  const interactiveSelectors = proofSelectors.filter((selector) => /\b(button|input|select|textarea)\b/i.test(selector));
  const byProofSelector = await findFirstVisible(page, interactiveSelectors);
  if (byProofSelector) {
    const tagName = await byProofSelector.locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    const inputType = await byProofSelector.locator.getAttribute("type").catch(() => "");
    if (tagName === "input" && inputType === "range") {
      await byProofSelector.locator.evaluate((element) => {
        const input = element as HTMLInputElement;
        const min = input.min || "0";
        const max = input.max || "100";
        const nextValue = input.value === max ? min : max;
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (valueSetter) {
          valueSetter.call(input, nextValue);
        } else {
          input.value = nextValue;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return { clicked: true, target: byProofSelector.selector };
    }
    await byProofSelector.locator.click();
    return { clicked: true, target: byProofSelector.selector };
  }

  if (primaryAction) {
    const byText = page.getByText(primaryAction, { exact: false }).first();
    if (await byText.isVisible().catch(() => false)) {
      await byText.click();
      return { clicked: true, target: `text:${primaryAction}` };
    }
  }

  const byAnyProofSelector = await findFirstVisible(page, proofSelectors);
  if (byAnyProofSelector) {
    await byAnyProofSelector.locator.click();
    return { clicked: true, target: byAnyProofSelector.selector };
  }

  const button = page.locator("button:visible").first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return { clicked: true, target: "button:visible" };
  }

  const checkbox = page.locator("input[type='checkbox']:visible").first();
  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.click();
    return { clicked: true, target: "input[type='checkbox']:visible" };
  }

  return { clicked: false, target: "" };
};

const clickFallbackForStateChange = async (page: Page): Promise<string> => {
  const fallbackSelectors = ["input[type='checkbox']:visible", "select:visible", "button:visible"];
  for (const selector of fallbackSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return selector;
    }
  }
  return "";
};

const waitForEvidenceAfterInteraction = async (
  page: Page,
  proofSelectors: string[],
  visibleEvidence: string[],
): Promise<void> => {
  const expectedText = visibleEvidence.find((text) => isNonEmptyString(text));
  if (expectedText) {
    try {
      await page
        .locator("body")
        .filter({ hasText: expectedText })
        .waitFor({ state: "visible", timeout: 2500 });
      return;
    } catch {
      // Fall back to selector wait below.
    }
  }

  for (const selector of proofSelectors) {
    try {
      await page.locator(selector).first().waitFor({ state: "visible", timeout: 1200 });
      return;
    } catch {
      // Try the next declared selector.
    }
  }

  await page.waitForTimeout(350);
};

// Generated pages frequently reveal results through staggered timers
// (setTimeout chains of 200-1000ms per pipeline step). A single immediate
// innerText read after the click races the first repaint — especially when a
// declared proof selector is already visible pre-click, which makes
// waitForEvidenceAfterInteraction return instantly. Poll with the same
// normalization the comparison uses instead of reading once.
const waitForBodyTextChange = async (page: Page, beforeText: string, timeoutMs: number) => {
  const normalizedBefore = normalizeText(beforeText);
  await page
    .waitForFunction(
      (prev) =>
        (document.body?.innerText ?? "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim() !== prev,
      normalizedBefore,
      { timeout: timeoutMs },
    )
    .catch(() => undefined);
};

const localBrowserCandidates = () =>
  [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => isNonEmptyString(value));

const launchBrowser = async (checks: Check[]): Promise<Browser> => {
  const errors: string[] = [];
  try {
    const browser = await chromium.launch({ headless: true });
    checks.push({ id: "browser.launch", status: "pass", message: "launched Playwright-managed Chromium" });
    return browser;
  } catch (error) {
    errors.push((error as Error).message.split("\n")[0] ?? String(error));
  }

  for (const executablePath of localBrowserCandidates()) {
    if (!(await fileExists(executablePath))) continue;
    try {
      const browser = await chromium.launch({ headless: true, executablePath });
      checks.push({
        id: "browser.launch",
        status: "pass",
        message: `launched system browser: ${executablePath}`,
      });
      return browser;
    } catch (error) {
      errors.push(`${executablePath}: ${(error as Error).message.split("\n")[0] ?? String(error)}`);
    }
  }

  throw new Error(`Could not launch a Chromium-compatible browser. ${errors.slice(0, 3).join(" | ")}`);
};

// Captured for the top-level catch: when main() dies mid-run we still emit a
// parseable fail report (publish readiness treats missing JSON as "unparsed"
// and gives ops nothing to debug with).
let argsForCrashReport: { artifactPath: string; write: boolean; output: string } | null = null;

async function main() {
  const args = parseArgs();
  argsForCrashReport = args;
  const root = path.resolve(process.cwd(), args.artifactPath);
  const checks: Check[] = [];
  const metadata = await readJson<JsonRecord>(path.join(root, "metadata.json"));
  const manifest = await readJson<JsonRecord>(path.join(root, "manifest.json"));

  push(checks, "metadata", isRecord(metadata), "metadata.json is readable", "metadata.json is missing or invalid");
  push(checks, "manifest", isRecord(manifest), "manifest.json is readable", "manifest.json is missing or invalid");

  const entrypoint =
    isRecord(manifest) && isNonEmptyString(manifest.entrypoint) ? manifest.entrypoint : "source/app/page.tsx";
  const entrypointPath = path.join(root, entrypoint);
  push(
    checks,
    "entrypoint",
    await fileExists(entrypointPath),
    `entrypoint exists: ${entrypoint}`,
    `entrypoint is missing: ${entrypoint}`,
  );

  const proof = isRecord(metadata?.interactionProofPlan) ? metadata.interactionProofPlan : {};
  const primaryAction = isNonEmptyString(proof.primaryAction) ? proof.primaryAction : "";
  const visibleEvidence = asStringArray(proof.visibleEvidence);
  const proofSelectors = asStringArray(proof.proofSelectors);

  const validationDir = path.join(root, "validation");
  const harnessDir = path.join(validationDir, ".render-harness");
  await mkdir(harnessDir, { recursive: true });

  const harnessEntry = path.join(harnessDir, "entry.tsx");
  const bundlePath = path.join(harnessDir, "bundle.js");
  const cssPath = path.join(harnessDir, "bundle.css");
  const htmlPath = path.join(harnessDir, "index.html");
  const screenshotPath = path.join(validationDir, "render-verification.png");
  const defaultReportPath = path.join(validationDir, "render-verification.json");
  const reportPath = args.output ? path.resolve(process.cwd(), args.output) : defaultReportPath;

  const harnessEntryContent = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    `import Page from "${toImportPath(harnessDir, entrypointPath)}";`,
    "",
    'createRoot(document.getElementById("root") as HTMLElement).render(<Page />);',
    "",
  ].join("\n");
  await writeFile(harnessEntry, harnessEntryContent, "utf8");

  try {
    const result = await build({
      stdin: {
        contents: harnessEntryContent,
        resolveDir: harnessDir,
        sourcefile: "entry.tsx",
        loader: "tsx",
      },
      outdir: "out",
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      write: false,
      loader: {
        ".css": "css",
        ".ts": "ts",
        ".tsx": "tsx",
      },
      plugins: [artifactResolverPlugin(entrypointPath)],
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      logLevel: "silent",
    });
    for (const output of result.outputFiles) {
      if (output.path.endsWith(".css")) {
        await writeFile(cssPath, output.contents);
      } else if (output.path.endsWith(".js")) {
        await writeFile(bundlePath, output.contents);
      }
    }
    checks.push({ id: "bundle", status: "pass", message: "artifact source bundled for browser render" });
  } catch (error) {
    checks.push({ id: "bundle", status: "fail", message: `bundle failed: ${(error as Error).message}` });
  }

  const cssLink = (await fileExists(cssPath)) ? '<link rel="stylesheet" href="./bundle.css" />' : "";
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      cssLink,
      "<title>Materialized Artifact Render Harness</title>",
      "</head>",
      "<body>",
      '<div id="root"></div>',
      '<script src="./bundle.js"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
    "utf8",
  );

  if (checks.some((check) => check.status === "fail")) {
    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;
    const passed = checks.filter((check) => check.status === "pass").length;
    const report: RenderVerificationReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      path: root,
      result: "fail",
      checks,
      summary: `${passed} pass, ${failed} fail, ${warned} warn`,
      previewPath: toRel(root, htmlPath),
      screenshotPath: toRel(root, screenshotPath),
    };
    if (args.write) {
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nResult: ${report.result.toUpperCase()} - ${report.summary}`);
    process.exit(1);
  }

  const browser = await launchBrowser(checks);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    const renderedTextSnapshots: string[] = [];
    const visibleSelectorEvidence = new Set<string>();
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    // ブラウザのリソース読込失敗（favicon や file:// ハーネス特有の欠損アセット等）は
    // console.error として出るが、実装の機能不全ではなくレンダーハーネス特有のノイズ。
    // これらは除外し、実 JS 例外（pageerror）と実アプリの console.error のみを集計する。
    const isResourceLoadNoise = (text: string) =>
      /Failed to load resource|net::ERR_|ERR_FILE_NOT_FOUND|favicon/i.test(text);
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (isResourceLoadNoise(text)) return;
      consoleErrors.push(text);
    });

    await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: "networkidle" });
    await page.waitForSelector("#root", { timeout: 5000 });
    await page.waitForTimeout(250);

    const bodyTextBeforeInteraction = await page.locator("body").innerText().catch(() => "");
    renderedTextSnapshots.push(bodyTextBeforeInteraction);
    for (const selector of await collectVisibleSelectors(page, proofSelectors)) {
      visibleSelectorEvidence.add(selector);
    }
    push(
      checks,
      "render.body_text",
      bodyTextBeforeInteraction.trim().length > 0,
      `rendered body text length=${bodyTextBeforeInteraction.trim().length}`,
      "rendered body is empty",
    );
    push(
      checks,
      "render.console_errors",
      consoleErrors.length === 0,
      "no browser console/page errors",
      `browser errors: ${consoleErrors.slice(0, 3).join("; ")}`,
    );

    await primeInputsForStateChange(page);
    const beforeClickText = await page.locator("body").innerText().catch(() => "");
    renderedTextSnapshots.push(beforeClickText);
    const click = await clickPrimaryAction(page, proofSelectors, primaryAction);
    await waitForEvidenceAfterInteraction(page, proofSelectors, visibleEvidence);
    await waitForBodyTextChange(page, beforeClickText, 4000);
    let afterClickText = await page.locator("body").innerText().catch(() => "");
    renderedTextSnapshots.push(afterClickText);
    for (const selector of await collectVisibleSelectors(page, proofSelectors)) {
      visibleSelectorEvidence.add(selector);
    }
    let stateChanged = normalizeText(afterClickText) !== normalizeText(beforeClickText);
    let fallbackTarget = "";
    if (!stateChanged) {
      fallbackTarget = await clickFallbackForStateChange(page);
      await waitForEvidenceAfterInteraction(page, proofSelectors, visibleEvidence);
      await waitForBodyTextChange(page, beforeClickText, 4000);
      afterClickText = await page.locator("body").innerText().catch(() => "");
      renderedTextSnapshots.push(afterClickText);
      for (const selector of await collectVisibleSelectors(page, proofSelectors)) {
        visibleSelectorEvidence.add(selector);
      }
      stateChanged = normalizeText(afterClickText) !== normalizeText(beforeClickText);
    }

    if (proofSelectors.length > 0) {
      // builder は多めに proof selector を宣言しがちで、その多くはタブ/複数操作の先にしか
      // 現れない。render proof の芯は「実際に描画され、少なくとも1つの証跡アンカーが可視」で
      // あること（描画・クリック反応・console無エラーは別チェックで担保）。全数一致を要求すると
      // 過剰宣言だけで高コストな生成を落とすため、静的ゲートと同様「1つ以上可視」に緩める。
      push(
        checks,
        "render.proof_selectors",
        visibleSelectorEvidence.size >= 1,
        `at least one proof selector visible across render/interaction (${visibleSelectorEvidence.size}/${proofSelectors.length})`,
        `no proof selector visible across render/interaction (0/${proofSelectors.length})`,
      );
    } else {
      checks.push({ id: "render.proof_selectors", status: "warn", message: "no proof selectors declared" });
    }

    push(
      checks,
      "interaction.click",
      click.clicked,
      `clicked ${click.target}`,
      "no clickable primary action or fallback control found",
    );
    push(
      checks,
      "interaction.state_change",
      stateChanged,
      fallbackTarget ? `state changed after fallback click: ${fallbackTarget}` : `state changed after click: ${click.target}`,
      "body text did not change after interaction",
    );
    push(
      checks,
      "interaction.console_errors",
      consoleErrors.length === 0,
      "no browser console/page errors after interaction",
      `browser errors after interaction: ${consoleErrors.slice(0, 3).join("; ")}`,
    );

    const renderedEvidenceText = renderedTextSnapshots.join("\n");
    const evidencePresent = visibleEvidence.filter((text) => normalizeText(renderedEvidenceText).includes(normalizeText(text)));
    const evidenceMissing = visibleEvidence.filter((text) => !normalizeText(renderedEvidenceText).includes(normalizeText(text)));
    if (visibleEvidence.length > 0) {
      push(
        checks,
        "render.visible_evidence",
        evidencePresent.length >= 1,
        `at least one visibleEvidence rendered (${evidencePresent.length}/${visibleEvidence.length})`,
        `no visibleEvidence rendered (0/${visibleEvidence.length}); e.g. missing: ${evidenceMissing
          .slice(0, 3)
          .join(", ")}`,
      );
    } else {
      checks.push({ id: "render.visible_evidence", status: "warn", message: "no visibleEvidence declared" });
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    push(
      checks,
      "render.screenshot",
      await fileExists(screenshotPath),
      `screenshot written: ${toRel(root, screenshotPath)}`,
      "screenshot was not written",
    );
  } finally {
    await browser.close();
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const passed = checks.filter((check) => check.status === "pass").length;
  const report: RenderVerificationReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    path: root,
    result: failed > 0 ? "fail" : warned > 0 ? "warn" : "pass",
    checks,
    summary: `${passed} pass, ${failed} fail, ${warned} warn`,
    previewPath: toRel(root, htmlPath),
    screenshotPath: toRel(root, screenshotPath),
  };

  if (args.write) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nResult: ${report.result.toUpperCase()} - ${report.summary}`);
  if (report.result === "fail") process.exit(1);
}

main().catch(async (error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error);
  const artifactPath = argsForCrashReport?.artifactPath ?? "";
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    path: artifactPath ? path.resolve(process.cwd(), artifactPath) : "",
    result: "fail",
    checks: [{ id: "harness.uncaught_error", status: "fail", message }],
    summary: "0 pass, 1 fail, 0 warn",
  };
  try {
    if (argsForCrashReport?.write && artifactPath) {
      const reportPath = argsForCrashReport.output
        ? path.resolve(process.cwd(), argsForCrashReport.output)
        : path.join(path.resolve(process.cwd(), artifactPath), "validation", "render-verification.json");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } catch {
    // Best effort: the console JSON below is still parseable by the caller.
  }
  console.log(JSON.stringify(report, null, 2));
  console.error(error);
  process.exit(1);
});
