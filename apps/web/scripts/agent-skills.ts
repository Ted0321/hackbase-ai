import type { PrismaClient } from "@prisma/client";
import { missingTables } from "./prisma-client";

/**
 * 「成功事例スキル」の正準型＋DB入出力＋プロンプト整形。
 *
 * 保存先は AgentSkill テーブル（DBが唯一の正）。distillした「型（mvpContract /
 * templatePattern / implementationNotes / knownRisks）」を、concept/requirements の
 * learning ブロックへ "どう作るか" のヒントとして注入する。トピックは渡さない。
 *
 * 旧FS版（data/agents/skills/）は廃止。1スキル=1行になりindex.jsonの競合も解消。
 */

export type SkillFeedbackComment = {
  text: string;
  actorName: string | null;
  rating: string;
};

export type ReceivedFeedback = {
  refreshedAt: string;
  likeCount: number;
  wantToGrowCount: number;
  humanComments: SkillFeedbackComment[];
  aiComments: SkillFeedbackComment[];
};

export type SkillMvpContract = {
  firstScreenValue: string | null;
  coreInteraction: string | null;
  stateChange: string | null;
  inspectableOutput: string | null;
  staticDataBoundary: string | null;
  forbiddenDependencies: string[];
};

export type ArchivedSkill = {
  version: number;
  skillId: string;
  agentId: string;
  runId: string;
  archivedAt: string;
  title: string | null;
  oneLiner: string | null;
  templatePatternId: string | null;
  planningIntent: string | null;
  mvpContract: SkillMvpContract;
  implementationNotes: string[];
  knownRisks: string[];
  sourceFileShapes: Array<{ relativePath: string; purpose: string }>;
  promoted: boolean;
  receivedFeedback: ReceivedFeedback | null;
};

const SKILL_TOP_N = 3;

export const AGENT_SKILL_TABLE = "AgentSkill";

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

// Prisma行 → ArchivedSkill。JSON列を復元する。
type AgentSkillRow = {
  id: string;
  agentId: string;
  runId: string;
  version: number;
  title: string | null;
  oneLiner: string | null;
  templatePatternId: string | null;
  planningIntent: string | null;
  archivedAt: Date;
  promoted: boolean;
  mvpContractJson: string;
  implementationNotes: string;
  knownRisks: string;
  sourceFileShapes: string;
  receivedFeedbackJson: string | null;
};

export const rowToSkill = (row: AgentSkillRow): ArchivedSkill => ({
  version: row.version,
  skillId: row.id,
  agentId: row.agentId,
  runId: row.runId,
  archivedAt: row.archivedAt.toISOString(),
  title: row.title,
  oneLiner: row.oneLiner,
  templatePatternId: row.templatePatternId,
  planningIntent: row.planningIntent,
  mvpContract: parseJson<SkillMvpContract>(row.mvpContractJson, {
    firstScreenValue: null,
    coreInteraction: null,
    stateChange: null,
    inspectableOutput: null,
    staticDataBoundary: null,
    forbiddenDependencies: [],
  }),
  implementationNotes: parseJson<string[]>(row.implementationNotes, []),
  knownRisks: parseJson<string[]>(row.knownRisks, []),
  sourceFileShapes: parseJson<Array<{ relativePath: string; purpose: string }>>(
    row.sourceFileShapes,
    [],
  ),
  promoted: row.promoted,
  receivedFeedback: parseJson<ReceivedFeedback | null>(row.receivedFeedbackJson, null),
});

// ArchivedSkill → Prisma upsert data（JSON列へ直列化）。
const skillToData = (skill: ArchivedSkill) => ({
  agentId: skill.agentId,
  runId: skill.runId,
  version: skill.version,
  title: skill.title,
  oneLiner: skill.oneLiner,
  templatePatternId: skill.templatePatternId,
  planningIntent: skill.planningIntent,
  archivedAt: new Date(skill.archivedAt),
  promoted: skill.promoted,
  mvpContractJson: JSON.stringify(skill.mvpContract),
  implementationNotes: JSON.stringify(skill.implementationNotes),
  knownRisks: JSON.stringify(skill.knownRisks),
  sourceFileShapes: JSON.stringify(skill.sourceFileShapes),
  receivedFeedbackJson: skill.receivedFeedback ? JSON.stringify(skill.receivedFeedback) : null,
});

// AgentSkill テーブルが無い環境（未push）では true。各呼び出しのガードに使う。
export const agentSkillTableMissing = async (prisma: PrismaClient): Promise<boolean> => {
  try {
    const missing = await missingTables(prisma, [AGENT_SKILL_TABLE]);
    return missing.length > 0;
  } catch {
    return true;
  }
};

/**
 * スキルを冪等に保存（skillId一致でupsert）。
 */
export const upsertAgentSkill = async (
  prisma: PrismaClient,
  skill: ArchivedSkill,
): Promise<void> => {
  const data = skillToData(skill);
  await prisma.agentSkill.upsert({
    where: { id: skill.skillId },
    create: { id: skill.skillId, ...data },
    update: data,
  });
};

/**
 * 指定agentのスキルを最大 SKILL_TOP_N 件読む。promoted（人/AIに反応された型）を優先し、
 * 同格内では新しい順。テーブル未作成・該当なしは空。
 */
export const readAgentSkillsFromDb = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<ArchivedSkill[]> => {
  if (!agentId) return [];
  if (await agentSkillTableMissing(prisma)) return [];
  const rows = (await prisma.agentSkill.findMany({
    where: { agentId },
    orderBy: [{ promoted: "desc" }, { archivedAt: "desc" }],
    take: SKILL_TOP_N,
  })) as AgentSkillRow[];
  return rows.map(rowToSkill);
};

/**
 * 全スキルを取得（refresh 用）。テーブル未作成は空。
 */
export const readAllAgentSkills = async (prisma: PrismaClient): Promise<ArchivedSkill[]> => {
  if (await agentSkillTableMissing(prisma)) return [];
  const rows = (await prisma.agentSkill.findMany({
    orderBy: [{ archivedAt: "desc" }],
  })) as AgentSkillRow[];
  return rows.map(rowToSkill);
};

/**
 * promoted / receivedFeedback だけを更新（refresh の書き戻し）。
 */
export const updateSkillFeedback = async (
  prisma: PrismaClient,
  skillId: string,
  promoted: boolean,
  receivedFeedback: ReceivedFeedback | null,
): Promise<void> => {
  await prisma.agentSkill.update({
    where: { id: skillId },
    data: {
      promoted,
      receivedFeedbackJson: receivedFeedback ? JSON.stringify(receivedFeedback) : null,
    },
  });
};

/**
 * スキル群を learning ブロックへ追記するテキストへ整形する。
 * 「型（pattern / coreInteraction）」と「避けるべき既知リスク」を簡潔に渡す。
 */
export const formatAgentSkillsForPrompt = (skills: ArchivedSkill[]): string => {
  if (!skills || skills.length === 0) return "";
  const lines: string[] = [];
  let hasAiComment = false;

  for (const skill of skills) {
    const label = skill.title ?? skill.skillId;
    const parts: string[] = [];
    if (skill.templatePatternId) parts.push(`型=${skill.templatePatternId}`);
    if (skill.mvpContract.coreInteraction) parts.push(`核操作=${skill.mvpContract.coreInteraction}`);
    const head = parts.length > 0 ? `（${parts.join(" / ")}）` : "";
    const badge = skill.promoted ? "[人/AIが反応] " : "";
    lines.push(`- ${badge}過去に通った成功事例: ${label}${head}`);

    const note = skill.implementationNotes.find((n) => n && n.trim().length > 0);
    if (note) lines.push(`  - 効いた作り方: ${note}`);
    const risk = skill.knownRisks.find((r) => r && r.trim().length > 0);
    if (risk) lines.push(`  - 当時の弱点(次は改善): ${risk}`);

    const fb = skill.receivedFeedback;
    if (fb) {
      if (fb.likeCount > 0) lines.push(`  - 反応: いいね${fb.likeCount}件`);
      // 人のコメント＝主役。最大2件。
      for (const c of fb.humanComments.slice(0, 2)) {
        lines.push(`  - 人のコメント(重視): ${c.text}`);
      }
      // AIコメント＝補助。鵜呑み禁止（妥当性は吟味）。最大1件。
      for (const c of fb.aiComments.slice(0, 1)) {
        hasAiComment = true;
        lines.push(`  - AI講評(妥当性を吟味して参照): ${c.text}`);
      }
    }
  }

  if (lines.length === 0) return "";
  const footer = hasAiComment
    ? ["", "※AI講評は鵜呑みにせず、妥当なものだけ採用する。人のコメントを優先する。"]
    : [];
  return [
    "### 過去の成功事例から（型のみ・トピックは今日のsignalから新規に / [人/AIが反応]付きを優先）",
    ...lines,
    ...footer,
  ].join("\n");
};
