import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RequirementSpec } from "./llm-pipeline/types";

/**
 * 公開作品の「ソースだけ」を最新コアロジック形式へ差し替えるための前段スクリプト。
 *
 * 本番で消えてしまった RequirementSpec（builder の入力）を、GCS に残っている
 *   - materialized の `metadata.json`（MaterializedMetadata: title/oneLiner/readiness/
 *     mvpContract/mvpContractV2/interactionProofPlan/sourceProvenance/knownRisks 等）
 *   - `source/metadata.json`（builder が source 内に置く企画メモ: targetUser/userMoment/
 *     process/architecture 等。任意）
 * から復元し、`requirements/response.json` として書き出す。
 *
 * builder は requirements をスキーマ検証しない（出力のみ検証）ので、コンセプトが伝わる
 * 妥当な JSON であれば十分。旧UIベースの requirements でも新 builder はコアロジック形式の
 * ソースを出すことは実証済み。persona context は目的（First Response Compass との形式統一）に
 * 対して低優先のため省略する。
 *
 * Usage:
 *   tsx scripts/reconstruct-requirement-spec.ts \
 *     --metadata <existing metadata.json> \
 *     --source-metadata <existing source/metadata.json> \
 *     --agent agent_r \
 *     --out artifacts/llm-pipeline-runs/<run>/requirements/response.json
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = raw[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(key, next);
        index += 1;
      } else {
        values.set(key, "true");
      }
    }
  }
  return {
    metadata: values.get("metadata"),
    sourceMetadata: values.get("source-metadata"),
    agent: values.get("agent"),
    out: values.get("out"),
  };
};

const readJson = async (filePath: string): Promise<JsonRecord> => {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return parsed;
};

const readJsonOptional = async (filePath: string | undefined): Promise<JsonRecord> => {
  if (!filePath) return {};
  try {
    return await readJson(filePath);
  } catch {
    return {};
  }
};

async function main() {
  const args = parseArgs();

  if (!args.metadata || !args.out) {
    console.error(
      'Usage: tsx scripts/reconstruct-requirement-spec.ts --metadata <metadata.json> [--source-metadata <source/metadata.json>] --agent <agentId> --out <requirements/response.json>',
    );
    process.exit(1);
  }

  const metadata = await readJson(args.metadata);
  const sourceMetadata = await readJsonOptional(args.sourceMetadata);

  // --- 基本ID -------------------------------------------------------------
  const generatedFrom = isRecord(metadata.generatedFrom) ? metadata.generatedFrom : {};
  const ownerAgentId =
    asString(metadata.agentId) ?? asString(args.agent) ?? "agent_unknown";
  const requirementSpecId =
    asString(generatedFrom.requirementSpecId) ??
    asString(metadata.requirementSpecId) ??
    `req_${asString(metadata.artifactId) ?? ownerAgentId}`;
  const conceptId =
    asString(metadata.conceptId) ??
    requirementSpecId.replace(/^req_/, "concept_");

  // --- 参照ブロック -------------------------------------------------------
  const mvpContract = isRecord(metadata.mvpContract) ? metadata.mvpContract : {};
  const mvpContractV2 = isRecord(metadata.mvpContractV2) ? metadata.mvpContractV2 : {};
  const readiness = isRecord(metadata.readiness) ? metadata.readiness : {};
  const sourceProvenance = isRecord(metadata.sourceProvenance) ? metadata.sourceProvenance : {};
  const interactionProofPlan = isRecord(metadata.interactionProofPlan)
    ? metadata.interactionProofPlan
    : undefined;

  const title = asString(metadata.title) ?? asString(sourceMetadata.title) ?? requirementSpecId;
  const oneLiner = asString(metadata.oneLiner) ?? asString(metadata.interestingness) ?? "";

  // source/metadata.json（任意）の企画メモ
  const targetUser = asString(sourceMetadata.targetUser);
  const userMoment = asString(sourceMetadata.userMoment);
  const processDesc = asString(sourceMetadata.process);
  const architecture = asString(sourceMetadata.architecture);

  // --- mvpGoal: 「何をAI処理するか」を builder に伝えるため厚めに合成 --------
  const mvpGoalParts = [
    title,
    oneLiner,
    asString(readiness.firstScreenValue) ?? asString(mvpContract.firstScreenValue),
    targetUser ? `対象ユーザー: ${targetUser}` : undefined,
    userMoment ? `利用シーン: ${userMoment}` : undefined,
    processDesc ? `処理の流れ: ${processDesc}` : undefined,
    architecture ? `構成: ${architecture}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const mvpGoal = mvpGoalParts.join(" / ");

  // --- screens: mvpContract から 1 画面を合成 -----------------------------
  const coreInteraction = asString(mvpContract.coreInteraction) ?? "主要入力を1つ受け取り実行する";
  const stateChange = asString(mvpContract.stateChange) ?? "実行後に結果状態を表示する";
  const inspectableOutput = asString(mvpContract.inspectableOutput);
  const screens: RequirementSpec["screens"] = [
    {
      name: "Main",
      purpose:
        asString(readiness.firstScreenValue) ??
        asString(mvpContract.firstScreenValue) ??
        `${title} の中心的価値を1画面で提供する`,
      primaryControl: coreInteraction,
      stateOutput: stateChange,
      components: ["input", "runAction", "resultView"],
      interactions: [coreInteraction, stateChange].filter(Boolean),
    },
  ];

  // --- dataModel: 最小合成（緩くてよい） ----------------------------------
  const dataModel: RequirementSpec["dataModel"] = [
    {
      name: "Result",
      fields: ["input", "output", "createdAt"],
      ...(inspectableOutput ? { sampleShape: { output: inspectableOutput } } : {}),
    },
  ];

  // --- acceptanceCriteria -------------------------------------------------
  const acceptanceCriteria = [
    asString(readiness.coreInteraction) ?? `ユーザーは ${coreInteraction} を実行できる`,
    asString(readiness.stateChange) ?? `実行すると ${stateChange}`,
    asString(readiness.inspectableOutput) ?? "出力は画面上で確認できる",
  ].filter((item): item is string => Boolean(item));

  // --- nonGoals / safetyConstraints ---------------------------------------
  const nonGoals = asStringArray(mvpContract.nonGoals);
  const claimBoundary = isRecord(mvpContractV2.claimBoundary) ? mvpContractV2.claimBoundary : {};
  const safetyConstraints = asStringArray(claimBoundary.publicCopyMustNotSay);

  // --- externalDependencyPlan: mvpContractV2 から --------------------------
  const externalDependencyMode = asString(mvpContractV2.externalDependencyMode);
  const externalDependencyPlan: RequirementSpec["externalDependencyPlan"] | undefined =
    externalDependencyMode
      ? {
          externalDependencyMode: externalDependencyMode as never,
          externalIntegrations: (Array.isArray(mvpContractV2.externalIntegrations)
            ? mvpContractV2.externalIntegrations
            : []) as never,
          integrationAssumptions: (Array.isArray(mvpContractV2.integrationAssumptions)
            ? mvpContractV2.integrationAssumptions
            : []) as never,
          claimBoundary: {
            publicCopyMustSay: asStringArray(claimBoundary.publicCopyMustSay),
            publicCopyMustNotSay: safetyConstraints,
          },
        }
      : undefined;

  // --- 組み立て -----------------------------------------------------------
  const spec: RequirementSpec = {
    id: requirementSpecId,
    conceptId,
    ownerAgentId,
    ...(asString(sourceProvenance.sourceBoundary)
      ? { sourceBoundary: asString(sourceProvenance.sourceBoundary) }
      : {}),
    ...(asString(sourceProvenance.antiCloneBoundary)
      ? { antiCloneBoundary: asString(sourceProvenance.antiCloneBoundary) }
      : {}),
    mvpGoal,
    screens,
    dataModel,
    acceptanceCriteria,
    nonGoals,
    safetyConstraints,
    ...(externalDependencyPlan ? { externalDependencyPlan } : {}),
    ...(interactionProofPlan ? { interactionProofPlan: interactionProofPlan as never } : {}),
  };

  const outPath = path.resolve(process.cwd(), args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  console.log("=== reconstruct-requirement-spec ===");
  console.log(`  metadata:        ${args.metadata}`);
  console.log(`  source-metadata: ${args.sourceMetadata ?? "(none)"}`);
  console.log(`  ownerAgentId:    ${ownerAgentId}`);
  console.log(`  requirementSpec: ${requirementSpecId}`);
  console.log(`  conceptId:       ${conceptId}`);
  console.log(`  mvpGoal (${mvpGoal.length} chars): ${mvpGoal.slice(0, 120)}${mvpGoal.length > 120 ? "…" : ""}`);
  console.log(`  screens:         ${spec.screens.length}`);
  console.log(`  acceptance:      ${spec.acceptanceCriteria.length}`);
  console.log(`  nonGoals:        ${spec.nonGoals.length}`);
  console.log(`  safety:          ${spec.safetyConstraints.length}`);
  console.log(`  extDepMode:      ${externalDependencyMode ?? "(none)"}`);
  console.log(`  interactionProof:${interactionProofPlan ? " present" : " (none)"}`);
  console.log(`  → wrote ${path.relative(process.cwd(), outPath).replaceAll("\\", "/")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
