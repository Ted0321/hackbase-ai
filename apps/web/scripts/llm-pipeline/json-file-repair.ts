import { extractBalancedJsonObject } from "./gemini-response-parser";

/**
 * builder LLMは.jsonファイルの末尾にJSON外のテキストを付けることがある(2026-07-10の
 * self-review.json破損=閉じ括弧後の余計な文字で顕在化した既知の癖)。materializeの書き込み前に
 * parse検証し、先頭の平衡JSONオブジェクト抽出で直せる場合のみ修復する。直せない場合は原文の
 * まま返し、下流のstrict MVP検査(generated_source_syntax)に検出を委ねる。
 */
export const repairJsonFileContent = (relativePath: string, content: string): string => {
  try {
    JSON.parse(content);
    return content;
  } catch {
    // fall through to repair
  }
  const extracted = extractBalancedJsonObject(content);
  if (extracted) {
    try {
      JSON.parse(extracted);
      console.warn(
        `[materialize] ${relativePath}: stripped non-JSON trailing text (kept ${extracted.length}/${content.length} chars)`,
      );
      return `${extracted}\n`;
    } catch {
      // fall through
    }
  }
  console.warn(`[materialize] ${relativePath}: invalid JSON and not repairable; writing as-is`);
  return content;
};
