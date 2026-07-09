import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * P1-A reader: data/agents/agent-learnings.json を読み、指定agentの
 * 「一人称の学びブロック」を整形する。concept/requirements プロンプトへ注入する。
 */

export type AgentLearning = {
  agentId: string;
  displayName: string;
  voice: string | null;
  specialties: string[];
  critiqueFocus: string[];
  preferences: { resonantCategories: Array<{ category: string; likeCount: number }> };
  constraints: { requirementConstraints: string[]; avoid: string[] };
  remixCandidates: string[];
  learningSignals?: {
    critiques: string[];
    risks: string[];
    remixes: string[];
  };
  feedbackSummary: {
    posts: number;
    humanFeedback: number;
    agentFeedback: number;
    likes: number;
    comments: number;
    agentSignals?: {
      critiques: number;
      risks: number;
      remixes: number;
      compares: number;
    };
    validationPassRate: number | null;
  };
  nextStepGuidance: string;
};

export type AgentLearningsFile = {
  version: number;
  generatedAt: string;
  source: string;
  registryVersion: number;
  learnings: AgentLearning[];
};

export const agentLearningsPath = () =>
  path.join(process.cwd(), "data", "agents", "agent-learnings.json");

export const readAgentLearnings = async (): Promise<AgentLearningsFile | null> => {
  try {
    return JSON.parse(await readFile(agentLearningsPath(), "utf8")) as AgentLearningsFile;
  } catch {
    return null;
  }
};

export const getAgentLearning = (
  file: AgentLearningsFile | null,
  agentId: string,
): AgentLearning | null => file?.learnings.find((entry) => entry.agentId === agentId) ?? null;

/**
 * 指定agentの学びを、一人称の企画プロンプトに差し込めるテキストブロックへ整形する。
 * トピックではなく「どう作るか（好み/要件制約/禁止/展開候補）」を渡すのが要点。
 */
export const formatAgentLearningForPrompt = (learning: AgentLearning | null): string => {
  if (!learning) return "";
  const lines: string[] = [];

  if (learning.preferences.resonantCategories.length > 0) {
    const top = learning.preferences.resonantCategories
      .slice(0, 3)
      .map((entry) => `${entry.category}(like ${entry.likeCount})`)
      .join(", ");
    lines.push(`- 過去に響いた方向: ${top}（同系統の"価値・操作の型"は活かす。ただしトピックは今日のsignalから新規に）`);
  }
  for (const constraint of learning.constraints.requirementConstraints.slice(0, 4)) {
    lines.push(`- 次の要件で必ず反映する指摘: ${constraint}`);
  }
  for (const avoid of learning.constraints.avoid.slice(0, 3)) {
    lines.push(`- 避ける: ${avoid}`);
  }
  for (const remix of learning.remixCandidates.slice(0, 2)) {
    lines.push(`- 展開候補(任意): ${remix}`);
  }
  if (learning.nextStepGuidance) {
    lines.push(`- 方針: ${learning.nextStepGuidance}`);
  }

  if (lines.length === 0) return "";
  return [
    `## ${learning.displayName} としての学び（過去の反応から / 集計のみ・生データは渡さない）`,
    ...lines,
  ].join("\n");
};
