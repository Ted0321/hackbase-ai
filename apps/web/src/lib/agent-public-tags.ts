import type { AdminAgentProfile } from "./admin-agent-registry";

export type AgentPublicTagKind = "artifact" | "specialty";

export type AgentPublicTag = {
  kind: AgentPublicTagKind;
  label: string;
  source: string;
};

export type AgentPublicTagInput = {
  profile?:
    | (Pick<AdminAgentProfile, "specialties" | "styleTraits" | "creationPolicy"> & {
        artifactStrengths?: string[];
      })
    | null;
  max?: number;
  maxArtifacts?: number;
  maxSpecialties?: number;
};

const PUBLIC_TAG_LABELS: Record<string, string> = {
  accessibility: "アクセシビリティ",
  analogy_transfer: "異分野転用",
  automation_snippet: "自動化",
  board: "ボード",
  capability_mapping: "機能整理",
  challenge_loops: "挑戦設計",
  citation: "出典整理",
  civic: "地域・公共",
  community: "コミュニティ",
  comparison: "比較",
  context_setting: "文脈",
  criteria_design: "評価基準",
  cross_domain: "分野横断",
  curriculum: "学習設計",
  data_quality: "品質管理",
  decision_board: "判断",
  decision_support: "意思決定",
  dev_utility: "開発支援",
  difference_analysis: "差分",
  evaluator: "評価ツール",
  evaluation: "評価",
  explainer: "解説",
  explanation: "説明",
  field_notes: "観察",
  framing: "見立て",
  frontier_explainer: "先端解説",
  game_design: "ゲーム設計",
  game_like_tool: "遊べる",
  hygiene: "データ衛生",
  ideation: "アイディエーション",
  incident_triage: "障害対応",
  issue_triage: "課題整理",
  learning_path: "学習",
  local_tools: "地域",
  map: "マップ",
  mapping: "構造マップ",
  narrative: "物語化",
  onboarding: "導入支援",
  onboarding_route: "導入",
  operations: "運用",
  operator_tools: "運用支援",
  permission_design: "許可",
  plain_language: "平易化",
  playable_learning: "遊べる学習",
  playful_interaction: "遊び心",
  provenance: "来歴整理",
  remix: "リミックス",
  runbook: "手順書",
  scenario_design: "シナリオ",
  scoring: "採点",
  simplification: "簡略化",
  simulation: "シミュレーション",
  simulator: "シミュレーター",
  sourcing: "情報源整理",
  structure: "構造化",
  systems_view: "全体像",
  tradeoff_clarity: "トレードオフ",
  tradeoff_modeling: "比較検討",
  transformation: "変換",
  trend_reading: "トレンド",
  trust_boundary: "信頼設計",
  usage_context: "利用文脈",
  user_research: "ユーザー調査",
  workflow: "ワークフロー",
  workspace: "作業場",
};

const INTERNAL_TAG_KEYS = new Set([
  "active",
  "admin_review_required",
  "all_projects",
  "draft",
  "human_review",
  "local_only",
  "own_projects",
  "paused",
  "requires_validation",
  "same_category",
  "system",
  "validation_warning",
]);

const normalizeKey = (value: string) => value.trim().toLowerCase();

const labelFor = (value: string) => {
  const key = normalizeKey(value);
  return PUBLIC_TAG_LABELS[key] ?? value.replace(/_/g, " ");
};

const appendTag = (
  tags: AgentPublicTag[],
  seen: Set<string>,
  kind: AgentPublicTagKind,
  value?: string | null,
) => {
  if (!value) return;
  const label = labelFor(value).trim();
  const key = normalizeKey(label);
  if (!label || INTERNAL_TAG_KEYS.has(normalizeKey(value)) || seen.has(key)) return;
  seen.add(key);
  tags.push({ kind, label, source: value });
};

export function buildAgentPublicTags(input: AgentPublicTagInput) {
  const max = input.max ?? 5;
  const maxArtifacts = input.maxArtifacts ?? 2;
  const maxSpecialties = input.maxSpecialties ?? max;
  const tags: AgentPublicTag[] = [];
  const seen = new Set<string>();
  const profile = input.profile;
  let artifactCount = 0;
  let specialtyCount = 0;

  for (const value of profile?.creationPolicy?.artifactStrengths ?? profile?.artifactStrengths ?? []) {
    if (artifactCount >= maxArtifacts) break;
    const before = tags.length;
    appendTag(tags, seen, "artifact", value);
    if (tags.length > before) artifactCount += 1;
    if (tags.length >= max) return tags;
  }

  for (const value of profile?.specialties ?? []) {
    if (specialtyCount >= maxSpecialties) break;
    const before = tags.length;
    appendTag(tags, seen, "specialty", value);
    if (tags.length > before) specialtyCount += 1;
    if (tags.length >= max) return tags;
  }

  return tags.slice(0, max);
}
