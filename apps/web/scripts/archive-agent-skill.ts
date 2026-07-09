import path from "node:path";
import { readFile } from "node:fs/promises";
import "./load-local-env";
import { createPrismaClient } from "./prisma-client";
import {
  type ArchivedSkill,
  agentSkillTableMissing,
  upsertAgentSkill,
} from "./agent-skills";

/**
 * 成功Run（MVPバリデーション pass）の materialized metadata.json を distill し、
 * AgentSkill テーブルに「事例型の記憶（スキル）」としてアーカイブする。
 *
 * Hermes Agent の「タスク完了ごとにスキルを蓄積する」発想を、Hackbase.aiの要約型学習に足す。
 * 保存先はDB（唯一の正）。本番Cloud Runの揮発FSでも消えず、1スキル=1行で競合もない。
 *
 * - distillは「型」のみ（コード本体は持たない＝軽量）。
 * - ベストエフォート: 失敗しても例外を投げず null を返し、公開フローを止めない。
 *
 * Usage:
 *   tsx scripts/archive-agent-skill.ts --path <materializedDir> --agent <agentId> --run <runId>
 */

// materialize-llm-plan.ts の MaterializedMetadata のうち、distillに必要な分だけを読む。
type MetadataShape = {
  artifactId?: string;
  generatedAt?: string;
  title?: string;
  oneLiner?: string;
  agentId?: string;
  mvpContract?: {
    firstScreenValue?: string;
    coreInteraction?: string;
    stateChange?: string;
    inspectableOutput?: string;
    staticDataBoundary?: string;
    forbiddenDependencies?: string[];
  };
  implementationNotes?: string[];
  knownRisks?: string[];
  sourceFiles?: Array<{ relativePath?: string; purpose?: string }>;
  selfDirectedPlan?: {
    agentId?: string;
    planningIntent?: string;
    templatePatternId?: string;
  } & Record<string, unknown>;
};

const slugTail = (value: string): string => {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  return parts.slice(-3).join("-") || "artifact";
};

const stampFrom = (iso: string | undefined): string => {
  const source = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : new Date();
  return source.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/**
 * metadata.json を distill して ArchivedSkill を作る（DB保存とは独立に純粋関数）。
 */
const distillSkill = (
  metadata: MetadataShape,
  agentId: string,
  runId: string,
): ArchivedSkill => {
  const stamp = stampFrom(metadata.generatedAt);
  const tail = slugTail(metadata.artifactId ?? runId);
  // agentId を含めて別エージェント間のPK衝突を防ぐ（同一agent×同一成果物の再実行はupsertで冪等）。
  const skillId = `skill_${slugTail(agentId)}_${stamp}_${tail}`;

  const mvp = metadata.mvpContract ?? {};
  const templatePatternId =
    typeof metadata.selfDirectedPlan?.templatePatternId === "string"
      ? metadata.selfDirectedPlan.templatePatternId
      : null;

  return {
    version: 1,
    skillId,
    agentId,
    runId,
    archivedAt: new Date().toISOString(),
    title: metadata.title ?? null,
    oneLiner: metadata.oneLiner ?? null,
    templatePatternId,
    planningIntent:
      typeof metadata.selfDirectedPlan?.planningIntent === "string"
        ? metadata.selfDirectedPlan.planningIntent
        : null,
    mvpContract: {
      firstScreenValue: mvp.firstScreenValue ?? null,
      coreInteraction: mvp.coreInteraction ?? null,
      stateChange: mvp.stateChange ?? null,
      inspectableOutput: mvp.inspectableOutput ?? null,
      staticDataBoundary: mvp.staticDataBoundary ?? null,
      forbiddenDependencies: Array.isArray(mvp.forbiddenDependencies)
        ? mvp.forbiddenDependencies.filter((v): v is string => typeof v === "string")
        : [],
    },
    implementationNotes: Array.isArray(metadata.implementationNotes)
      ? metadata.implementationNotes.filter((v): v is string => typeof v === "string")
      : [],
    knownRisks: Array.isArray(metadata.knownRisks)
      ? metadata.knownRisks.filter((v): v is string => typeof v === "string")
      : [],
    sourceFileShapes: Array.isArray(metadata.sourceFiles)
      ? metadata.sourceFiles
          .map((f) => ({
            relativePath: typeof f.relativePath === "string" ? f.relativePath : "",
            purpose: typeof f.purpose === "string" ? f.purpose : "",
          }))
          .filter((f) => f.relativePath)
      : [],
    promoted: false,
    receivedFeedback: null,
  };
};

/**
 * 成功RunをスキルとしてDBへ保存。成功時は skillId を、失敗時は null を返す（ベストエフォート）。
 */
export const archiveAgentSkill = async (params: {
  materializedDir: string;
  agentId: string;
  runId: string;
}): Promise<string | null> => {
  const { materializedDir, agentId, runId } = params;
  if (!materializedDir || !agentId || !runId) return null;

  const metadataPath = path.isAbsolute(materializedDir)
    ? path.join(materializedDir, "metadata.json")
    : path.join(process.cwd(), materializedDir, "metadata.json");

  const metadata = await readJson<MetadataShape>(metadataPath);
  if (!metadata) return null;

  const skill = distillSkill(metadata, agentId, runId);

  const prisma = createPrismaClient();
  try {
    if (await agentSkillTableMissing(prisma)) {
      console.warn("[archive-agent-skill] AgentSkill table missing; run `npm run db:push`. skipped.");
      return null;
    }
    await upsertAgentSkill(prisma, skill);
    return skill.skillId;
  } finally {
    await prisma.$disconnect();
  }
};

const parseArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isMain = (): boolean => {
  const entry = process.argv[1] ?? "";
  return entry.includes("archive-agent-skill");
};

if (isMain()) {
  const materializedDir = parseArg("--path");
  const agentId = parseArg("--agent");
  const runId = parseArg("--run");

  if (!materializedDir || !agentId || !runId) {
    console.error(
      "Usage: tsx scripts/archive-agent-skill.ts --path <materializedDir> --agent <agentId> --run <runId>",
    );
    process.exit(1);
  }

  archiveAgentSkill({ materializedDir, agentId, runId })
    .then((skillId) => {
      if (skillId) {
        console.log(`[archive-agent-skill] archived -> AgentSkill ${skillId}`);
      } else {
        console.log(`[archive-agent-skill] skipped (no metadata.json or table missing)`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(`[archive-agent-skill] failed: ${String(error)}`);
      process.exit(1);
    });
}
