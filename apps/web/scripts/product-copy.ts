/**
 * shortTagline(プロダクト名直下に出す一文キャッチコピー)の決定論正規化。
 *
 * 役割: builder / backfill が生成した shortTagline を、表示に安全な形へ決定論的に整える。
 * LLM出力のブレ(囲み記号・複数文・末尾句点・空白)はここで吸収し、上限超過は途中切断せずに
 * null で棄却する(切断された文は壊れたコピーになるため、表示側の oneLiner フォールバックに委ねる)。
 * research出力の決定論クランプ(PR#93)と同じ思想の、文フィールド版。
 */

export const SHORT_TAGLINE_MAX_CHARS = 40;

// 全体を囲んでいる場合にだけ剥がす囲み記号のペア。LLMが例示の「」表記を真似て出すケースを吸収する。
const ENCLOSURE_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ['"', '"'],
  ["'", "'"],
];

export const normalizeShortTagline = (raw: string | null | undefined): string | null => {
  if (typeof raw !== "string") return null;
  let value = raw.replace(/\s+/g, " ").trim();
  for (const [open, close] of ENCLOSURE_PAIRS) {
    if (
      value.startsWith(open) &&
      value.endsWith(close) &&
      value.length > open.length + close.length
    ) {
      value = value.slice(open.length, value.length - close.length).trim();
    }
  }
  // 複数文が来たら第1文のみ採用する。ASCIIピリオドは「Node.js」「2.0」等の固有名詞を
  // 誤分割するため文区切りに含めない(末尾に残った場合のみ下で除去される)。
  const [head] = value.split(/(?<=[。！？!?])\s*/);
  value = (head ?? value).trim();
  // キャッチコピーは句点で終わらせない。
  value = value.replace(/[。.]+$/u, "").trim();
  if (!value) return null;
  if ([...value].length > SHORT_TAGLINE_MAX_CHARS) return null;
  return value;
};
