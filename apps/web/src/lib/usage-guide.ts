/**
 * usageGuide(使い方タブの番号付き手順)の型と決定論正規化。
 *
 * 役割: builder / backfill が生成した usageGuide を、表示に安全な形へ決定論的に整える。
 * LLM出力のブレ(囲み記号・複数文・末尾句点・重複文・過剰ステップ)はここで吸収し、
 * 「使えるステップが2件未満」という構造欠陥のときだけ null で棄却する
 * (researchQuality の決定論クランプ(PR#93)/shortTagline 正規化(product-copy.ts)と同じ思想。
 *  ゲートで生成を絞め殺さず、正規化で救える出力は救う)。
 *
 * 表示契約: Project.usageGuide カラムには serializeUsageGuide の JSON 文字列を保存し、
 * ページ側は必ず parseStoredUsageGuide 経由で読む(不正JSONは null → 表示側の決定論導出へ
 * フォールバック)。
 */

export type UsageGuideStep = {
  // ユーザーが行う操作。命令形の日本語1文(実UI要素名を含むことを builder.md が要求)。
  action: string;
  // その操作で画面に起きること1文。
  result: string;
};

export type UsageGuide = {
  // 任意の導入1文(どんな場面で使うか)。
  intro?: string;
  // 2〜4件の番号付き手順。
  steps: UsageGuideStep[];
  // 画面のどこを見ればこの作品の価値を判断できるか(任意1文)。
  checkPoint?: string;
};

export const USAGE_GUIDE_MIN_STEPS = 2;
export const USAGE_GUIDE_MAX_STEPS = 4;
// builder.md は action ≦約50字 / result ≦約100字を指示する。正規化側は少し緩い上限で
// 受け、超過は途中切断せず棄却する(切断された文は壊れたコピーになるため)。
export const USAGE_ACTION_MAX_CHARS = 60;
export const USAGE_RESULT_MAX_CHARS = 120;
export const USAGE_NOTE_MAX_CHARS = 160;

// 全体を囲んでいる場合にだけ剥がす囲み記号のペア(normalizeShortTagline と同じ吸収)。
const ENCLOSURE_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ['"', '"'],
  ["'", "'"],
];

// 重複判定キー: 空白ゆれと末尾句読点の差だけで別文扱いにならないよう正規化する。
export const usageSentenceKey = (value: string): string =>
  value.replace(/\s+/g, " ").trim().replace(/[。．.!?！？]+$/u, "");

const stripEnclosures = (value: string): string => {
  let result = value;
  for (const [open, close] of ENCLOSURE_PAIRS) {
    if (
      result.startsWith(open) &&
      result.endsWith(close) &&
      result.length > open.length + close.length
    ) {
      result = result.slice(open.length, result.length - close.length).trim();
    }
  }
  return result;
};

// 複数文が来たら第1文のみ採用する。ASCIIピリオドは「Node.js」「2.5」等を誤分割するため
// 文区切りに含めない(shortTagline 正規化と同じ判断)。
const firstSentenceOnly = (value: string): string => {
  const [head] = value.split(/(?<=[。！？!?])\s*/);
  return (head ?? value).trim();
};

const normalizeLine = (raw: unknown, maxChars: number): string | null => {
  if (typeof raw !== "string") return null;
  const value = firstSentenceOnly(stripEnclosures(raw.replace(/\s+/g, " ").trim()));
  if (!value) return null;
  if ([...value].length > maxChars) return null;
  return value;
};

export const normalizeUsageGuide = (raw: unknown): UsageGuide | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];

  const seen = new Set<string>();
  const steps: UsageGuideStep[] = [];
  for (const rawStep of rawSteps) {
    if (steps.length >= USAGE_GUIDE_MAX_STEPS) break;
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
    const stepRecord = rawStep as Record<string, unknown>;
    const action = normalizeLine(stepRecord.action, USAGE_ACTION_MAX_CHARS)
      // 操作見出しは句点で終わらせない。
      ?.replace(/[。．.]+$/u, "")
      .trim();
    const result = normalizeLine(stepRecord.result, USAGE_RESULT_MAX_CHARS);
    if (!action || !result) continue;
    const actionKey = usageSentenceKey(action);
    const resultKey = usageSentenceKey(result);
    // 操作と結果が同一文、または既出文と重複するステップは落とす(使い方タブの重複表示の再発防止)。
    if (!actionKey || !resultKey || actionKey === resultKey) continue;
    if (seen.has(actionKey) || seen.has(resultKey)) continue;
    seen.add(actionKey);
    seen.add(resultKey);
    steps.push({ action, result });
  }

  // 構造欠陥(使える手順が2件未満)のときだけ棄却する。intro/checkPoint の不備は
  // フィールド単位で落とし、ガイド全体は生かす。
  if (steps.length < USAGE_GUIDE_MIN_STEPS) return null;

  const intro = normalizeLine(record.intro, USAGE_NOTE_MAX_CHARS);
  const introKey = intro ? usageSentenceKey(intro) : null;
  const checkPoint = normalizeLine(record.checkPoint, USAGE_NOTE_MAX_CHARS);
  const checkPointKey = checkPoint ? usageSentenceKey(checkPoint) : null;

  return {
    ...(intro && introKey && !seen.has(introKey) ? { intro } : {}),
    steps,
    ...(checkPoint && checkPointKey && !seen.has(checkPointKey) && checkPointKey !== introKey
      ? { checkPoint }
      : {}),
  };
};

// Project.usageGuide(JSON文字列カラム)の防御的読み取り。不正JSON/不正形は null。
export const parseStoredUsageGuide = (raw: string | null | undefined): UsageGuide | null => {
  if (!raw) return null;
  try {
    return normalizeUsageGuide(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const serializeUsageGuide = (guide: UsageGuide): string => JSON.stringify(guide);
