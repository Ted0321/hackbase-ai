export const PUBLIC_PROJECT_STATUSES = ["auto_published", "published"];
export const WITHDRAWN_PROJECT_DECISION = "withdrawn";

// 人間の公開判断を待っている publishDecision の集合。スケジューラ経路のholdは
// ops_review、手動生成経路は approval_requested。'pending' を書く経路は現存しないが
// schema既定値として残り得るため含める。値→表示ラベルは publishDecisionLabel を使う。
export const HOLD_PUBLISH_DECISIONS = ["pending", "ops_review", "approval_requested"];

const PUBLISH_DECISION_LABELS: Record<string, string> = {
  human_approved: "人間承認済",
  auto_published: "自動公開",
  ops_review: "公開判断待ち",
  approval_requested: "承認申請中",
  withdrawn: "取り下げ",
  pending: "保留",
};

/** publishDecision の日本語ラベル。未知値はそのまま返し、null/空は「未記録」。 */
export const publishDecisionLabel = (decision?: string | null): string => {
  if (!decision) return "未記録";
  return PUBLISH_DECISION_LABELS[decision] ?? decision;
};

/** status/decision がレビュー待ち(公開前hold)かどうか。 */
export const isHoldForReview = (status?: string | null, decision?: string | null): boolean =>
  status === "held_for_review" || HOLD_PUBLISH_DECISIONS.includes(decision ?? "");

export type ProjectVisibilityFields = {
  status?: string | null;
  publishDecision?: string | null;
};

export const publicProjectWhere = {
  status: {
    in: PUBLIC_PROJECT_STATUSES,
  },
  NOT: {
    publishDecision: WITHDRAWN_PROJECT_DECISION,
  },
};

export const activeProjectWhere = {
  NOT: [
    { status: WITHDRAWN_PROJECT_DECISION },
    { publishDecision: WITHDRAWN_PROJECT_DECISION },
  ],
};

export function isPublicProject(project: ProjectVisibilityFields): boolean {
  const status = project.status?.toLowerCase();
  const publishDecision = project.publishDecision?.toLowerCase();

  return Boolean(
    status &&
      (PUBLIC_PROJECT_STATUSES as readonly string[]).includes(status) &&
      publishDecision !== WITHDRAWN_PROJECT_DECISION,
  );
}

export function selectPublicRunProject<T extends ProjectVisibilityFields>(projects: T[]): T | undefined {
  return projects.find(isPublicProject);
}

export function isActiveProject(project: ProjectVisibilityFields): boolean {
  const status = project.status?.toLowerCase();
  const publishDecision = project.publishDecision?.toLowerCase();

  return status !== WITHDRAWN_PROJECT_DECISION && publishDecision !== WITHDRAWN_PROJECT_DECISION;
}
