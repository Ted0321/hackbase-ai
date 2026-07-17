import assert from "node:assert/strict";
import {
  isTsLikeSourcePath,
  repairGeneratedTsSource,
  repairTsSourceFileContent,
  tsParseIssues,
} from "./ts-source-repair";

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

// 実事故の形(2026-07-14 HeatShield Route / run_selfdirected_agent_j_20260714T170022):
// プロンプト本文の「説明文や```jsonマークは不要です」の生フェンスでテンプレートリテラルが
// 途中終了し、2-generate-plan.ts が generated_source_syntax fail で held 落ちした。
const heatShieldShape = [
  "import { callGemini } from '../gemini';",
  "",
  "const promptTemplate = (profile: { housingType: string; familyMembers: string[] }) => `あなたは防災の専門家です。",
  "- 家族構成: ${profile.familyMembers.join(', ')}",
  "- 住居タイプ: ${profile.housingType}",
  "- 出力は必ず以下のJSON形式に従ってください。説明文や```jsonマークは不要です。",
  "",
  "# 出力形式 (JSON)",
  '{ "summary": "string" }',
  "`;",
  "",
  "export async function generatePlan(apiKey: string): Promise<unknown> {",
  "  return callGemini(apiKey, promptTemplate({ housingType: 'apartment', familyMembers: ['a'] }));",
  "}",
  "",
].join("\n");

run("isTsLikeSourcePath matches ts/tsx/js/jsx only", () => {
  assert.equal(isTsLikeSourcePath("source/core/steps/2-generate-plan.ts"), true);
  assert.equal(isTsLikeSourcePath("source/app/page.tsx"), true);
  assert.equal(isTsLikeSourcePath("source/data/sample.js"), true);
  assert.equal(isTsLikeSourcePath("metadata.json"), false);
  assert.equal(isTsLikeSourcePath("README.md"), false);
});

run("valid source is untouched", () => {
  const content = "export const ok = `template with ${1 + 1} interpolation`;\n";
  assert.deepEqual(repairGeneratedTsSource("source/core/gemini.ts", content), { status: "clean" });
  assert.equal(repairTsSourceFileContent("source/core/gemini.ts", content), content);
});

run("raw ```json fence inside a template literal is escaped (2026-07-14 HeatShield shape)", () => {
  assert.ok(tsParseIssues("source/core/steps/2-generate-plan.ts", heatShieldShape).length > 0);
  const repair = repairGeneratedTsSource("source/core/steps/2-generate-plan.ts", heatShieldShape);
  assert.equal(repair.status, "repaired");
  if (repair.status !== "repaired") return;
  assert.equal(tsParseIssues("source/core/steps/2-generate-plan.ts", repair.content).length, 0);
  // フェンスはエスケープされ、正当な補間はそのまま残る。
  assert.ok(repair.content.includes("\\`\\`\\`json"));
  assert.ok(repair.content.includes("${profile.housingType}"));
});

run("markdown inline-code backticks inside a template literal are escaped", () => {
  const content = [
    "const prompt = `出力は `json` 形式のみで返してください。",
    "説明文は不要です。",
    "`;",
    "export { prompt };",
    "",
  ].join("\n");
  assert.ok(tsParseIssues("source/core/steps/format.ts", content).length > 0);
  const repair = repairGeneratedTsSource("source/core/steps/format.ts", content);
  assert.equal(repair.status, "repaired");
  if (repair.status !== "repaired") return;
  assert.equal(tsParseIssues("source/core/steps/format.ts", repair.content).length, 0);
  assert.ok(repair.content.includes("\\`json\\`"));
});

run("unescaped ${ with non-expression text is literalized under source/core/ only", () => {
  const broken = [
    "const prompt = `回答は ${回答をここに 挿入} の形式で返してください。",
    "`;",
    "export { prompt };",
    "",
  ].join("\n");
  assert.ok(tsParseIssues("source/core/steps/answer.ts", broken).length > 0);
  const coreRepair = repairGeneratedTsSource("source/core/steps/answer.ts", broken);
  assert.equal(coreRepair.status, "repaired");
  if (coreRepair.status === "repaired") {
    assert.equal(tsParseIssues("source/core/steps/answer.ts", coreRepair.content).length, 0);
    assert.ok(coreRepair.content.includes("\\${"));
  }
  // 実行される page.tsx 側では ${ の literal 化は行わない(表示が変わるため)。
  const appRepair = repairGeneratedTsSource("source/app/broken.ts", broken);
  assert.equal(appRepair.status, "unrepairable");
});

run("unrepairable syntax is reported and original content is kept", () => {
  const broken = "export const x = { unterminated: `no closing\n";
  const repair = repairGeneratedTsSource("source/core/steps/x.ts", broken);
  assert.equal(repair.status, "unrepairable");
  assert.equal(repairTsSourceFileContent("source/core/steps/x.ts", broken), broken);
});

run("non-ts paths are never touched", () => {
  const content = "```json\n{}\n```\n";
  assert.deepEqual(repairGeneratedTsSource("source/data/sample.md", content), { status: "clean" });
});

console.log("All ts-source-repair checks passed.");
