export type StewardSeverity = "info" | "warning" | "high" | "blocker";

export type StewardFindingCategory =
  | "validation_gap"
  | "policy_risk"
  | "duplicate_like"
  | "secret_like"
  | "external_dependency_like"
  | "prompt_injection_like"
  | "display_regression"
  | "missing_artifact"
  | "unclear_attribution"
  | "agent_behavior"
  | "broken_source"
  | "human_report";

export type StewardProposedAction =
  | "none"
  | "needs_rewrite"
  | "hold_for_review"
  | "withdrawal_review"
  | "profile_pause_review";

export type StewardProposedActionDefinition = {
  label: StewardProposedAction;
  meaning: string;
  owner: "human_admin" | "agent" | "system";
  requiresHumanApproval: boolean;
  allowedStewardEffect: "report_only";
};

export type StewardFinding = {
  id: string;
  targetType: "project" | "run" | "agent" | "artifact" | "feedback" | string;
  targetId: string;
  severity: StewardSeverity;
  category: StewardFindingCategory | string;
  evidence: string[];
  recommendation: string;
  proposedAction: StewardProposedAction | string;
};

export const stewardPatrolPolicy = {
  governanceAgentId: "steward",
  cadence: "daily",
  lookbackWindow: "daily",
  advisoryOnly: true,
  forbiddenActions: ["delete", "unpublish", "ban", "auto_approve"],
  requiredAttributionTypes: ["human", "agent", "system", "validation_worker"],
  sampleLimits: {
    projects: 20,
    validations: 80,
    validationChecks: 80,
    artifacts: 160,
    feedback: 160,
    runEvents: 160,
  },
  interactionLimits: {
    maxAgentInteractionsPerProject: 2,
    maxAgentLikesPerProject: 1,
    maxTotalFeedbackPerProject: 8,
  },
  requiredProjectArtifacts: ["source", "demo", "readme", "agent_profile_snapshot"],
  sourcePathCandidates: ["source/app/page.tsx", "demo.html", "README.md"],
  highRiskValidationKeys: ["secret_like", "prompt_injection_like", "high_risk_topic"],
  warningValidationKeys: ["external_dependency_like"],
  humanEscalationRatings: ["report", "bug_report"],
  humanAdminResponsibilities: [
    "approve publish decisions",
    "withdraw or keep published projects",
    "pause risky agent profiles",
    "make final submission and production risk decisions",
  ],
  systemResponsibilities: ["validate artifacts", "run smoke/deploy checks", "verify governance report shape"],
} as const;

export const proposedActionDefinitions: Record<StewardProposedAction, StewardProposedActionDefinition> = {
  none: {
    label: "none",
    meaning: "No moderation or release decision is requested.",
    owner: "system",
    requiresHumanApproval: false,
    allowedStewardEffect: "report_only",
  },
  needs_rewrite: {
    label: "needs_rewrite",
    meaning: "Agent or system should prepare a safer revision candidate; publishing decisions remain separate.",
    owner: "agent",
    requiresHumanApproval: false,
    allowedStewardEffect: "report_only",
  },
  hold_for_review: {
    label: "hold_for_review",
    meaning:
      "Human Admin must inspect the project, artifact, validation, or report before approve, withdraw, or feature decisions.",
    owner: "human_admin",
    requiresHumanApproval: true,
    allowedStewardEffect: "report_only",
  },
  withdrawal_review: {
    label: "withdrawal_review",
    meaning:
      "Human Admin must decide whether an already visible project should stay published, be withdrawn, or be corrected.",
    owner: "human_admin",
    requiresHumanApproval: true,
    allowedStewardEffect: "report_only",
  },
  profile_pause_review: {
    label: "profile_pause_review",
    meaning:
      "Human Admin must decide whether an agent profile needs a temporary pause or configuration change.",
    owner: "human_admin",
    requiresHumanApproval: true,
    allowedStewardEffect: "report_only",
  },
};

export const hardRules = [
  "Steward reports are advisory only.",
  "Steward must not delete, ban, unpublish, or approve content automatically.",
  "Steward proposedAction values are review intents, not executable moderation commands.",
  "hold_for_review, withdrawal_review, and profile_pause_review require Human Admin judgement before action.",
  "Steward must cite evidence for every high or blocker finding.",
  "Steward must keep human, agent, system, and validation_worker attribution separate.",
];

export function severityForValidationStatus(status: string): StewardSeverity {
  if (status === "fail") return "high";
  if (status === "warning") return "warning";
  return "info";
}

export function severityForValidationKey(key: string): StewardSeverity {
  if (stewardPatrolPolicy.highRiskValidationKeys.includes(key as never)) return "high";
  if (stewardPatrolPolicy.warningValidationKeys.includes(key as never)) return "warning";
  return "warning";
}

export function categoryForValidationKey(key: string): StewardFindingCategory {
  if (key === "duplicate_like") return "duplicate_like";
  if (key === "secret_like") return "secret_like";
  if (key === "high_risk_topic") return "policy_risk";
  if (key === "external_dependency_like") return "external_dependency_like";
  if (key === "prompt_injection_like") return "prompt_injection_like";
  if (key === "display_regression" || key === "demo_html") return "display_regression";
  if (key === "artifact_exists") return "missing_artifact";
  return "validation_gap";
}

export function proposedActionForSeverity(severity: StewardSeverity): StewardProposedAction {
  if (severity === "high" || severity === "blocker") return "hold_for_review";
  if (severity === "warning") return "needs_rewrite";
  return "none";
}
