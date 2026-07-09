/**
 * interactionPolicy.targetPreference を対象プロジェクト選定へ反映する純関数群。
 *
 * agent の targetPreference トークン（例: "education", "validation_warned_projects",
 * "workflow_tools"）と、各プロジェクトから安全に取れる signal（categoryId / publishDecision）を
 * 突き合わせ、一致が多い順へ安定再ランクする。signal が無ければスコア0で元順を保つ（加算的・無害）。
 *
 * 純関数なので target-preference.test.ts で単体検証する。
 */

export type ProjectPreferenceFields = {
  categoryId?: string | null;
  publishDecision?: string | null;
};

export type ProjectVisibilityFields = {
  status?: string | null;
  publishDecision?: string | null;
};

const visibleProjectStatuses = new Set(["auto_published", "published"]);
const withdrawnDecisions = new Set(["withdrawn"]);

export const isPublicInteractionTarget = (project: ProjectVisibilityFields): boolean => {
  const status = project.status?.toLowerCase();
  const decision = project.publishDecision?.toLowerCase();
  return Boolean(status && visibleProjectStatuses.has(status) && !withdrawnDecisions.has(decision ?? ""));
};

/** プロジェクトから targetPreference 照合用のトークン集合を作る。 */
export const projectPreferenceSignals = (project: ProjectPreferenceFields): string[] => {
  const tokens: string[] = [];
  if (project.categoryId) tokens.push(project.categoryId.toLowerCase());
  const decision = project.publishDecision?.toLowerCase();
  if (decision) {
    tokens.push(decision);
    if (decision === "hold_for_review") {
      tokens.push("validation_warned_projects", "held_for_review");
    }
  }
  return tokens;
};

/** preference トークンが signal にいくつ一致したか（部分一致を含む）。 */
export const preferenceScore = (preferences: string[], signals: string[]): number => {
  let score = 0;
  for (const preference of preferences) {
    const p = preference.toLowerCase();
    if (signals.some((s) => s === p || s.includes(p) || p.includes(s))) score += 1;
  }
  return score;
};

/**
 * preference 一致が多い順へ安定再ランク（同点は元順を維持）。
 * preferences 未指定なら元配列をそのまま返す。
 */
export const rankByTargetPreference = <T>(
  preferences: string[] | undefined,
  projects: T[],
  signalsOf: (project: T) => string[],
): T[] => {
  if (!preferences || preferences.length === 0) return projects;
  return projects
    .map((project, index) => ({
      project,
      index,
      score: preferenceScore(preferences, signalsOf(project)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.project);
};
