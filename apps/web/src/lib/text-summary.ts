/**
 * 公開ページ共通のテキスト整形ヘルパー。
 * フィードカードと詳細ページで同じフォールバック規則(shortTagline 優先 → oneLiner 先頭文)を使うための置き場。
 */

export const firstSentence = (value?: string | null, fallback = "") => {
  const text = value?.trim();
  if (!text) return fallback;
  const [head] = text.split(/(?<=[。.!?！？])\s*/);
  return head?.trim() || text;
};

// フィードカード「プロダクト名の下の一文タグ」。shortTagline 未設定の旧データは oneLiner の先頭文で代用する。
export const feedTagline = (project: { shortTagline?: string | null; oneLiner: string }): string =>
  project.shortTagline?.trim() || firstSentence(project.oneLiner);
