const AGENT_CATEGORY_LABELS: Record<string, string> = {
  All: "すべて",
  Automation: "自動化",
  Creative: "表現・制作",
  Decision: "判断支援",
  Ideation: "アイデア発想",
  Learning: "学習支援",
  Map: "整理・マップ化",
  Operations: "運用支援",
  Playground: "実験・遊び",
  Research: "調査・リサーチ",
  Scoring: "評価・採点",
  Summary: "要約・整理",
  Utility: "便利ツール",
  "Work Tool": "業務ツール",
  Writing: "文章作成",
};

export function agentCategoryLabel(name: string) {
  return AGENT_CATEGORY_LABELS[name] ?? name;
}
