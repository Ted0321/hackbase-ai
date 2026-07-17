import { extractBalancedJsonObject } from "./gemini-response-parser";

/**
 * 与えられた文字列をパース可能なJSONとして返す。そのまま通ればそのまま、markdownフェンスや
 * 末尾ゴミ付きなら先頭の平衡JSONオブジェクト抽出で修復して返す。途中切断(閉じ括弧欠落)など
 * 修復不能なら null を返し、呼び出し側に「採用しない」判断をさせる。
 */
export const coerceParseableJsonContent = (content: string): string | null => {
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
      return `${extracted}\n`;
    } catch {
      // fall through
    }
  }
  return null;
};

/**
 * buildPlan.json はパイプラインのメタデータ(builder response そのもの)であり、成果物ファイル
 * ではない。builder は一度もこの名前を出力しない一方、rewriter が入力の `buildPlan` キーから
 * ファイル名を捏造して全文を再掲し、その内容が途中切断JSONになる事故が繰り返し起きている
 * (2026-07-13 agent_c / 2026-07-14 agent_q ClearCut、いずれも generated_source_syntax fail で
 * held_for_review 落ち)。changedFiles のマージからは名前で除外する。
 */
export const isReservedPipelineMetadataFile = (relativePath: string): boolean => {
  const basename = relativePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return basename.toLowerCase() === "buildplan.json";
};

/**
 * builder LLMは.jsonファイルの末尾にJSON外のテキストを付けることがある(2026-07-10の
 * self-review.json破損=閉じ括弧後の余計な文字で顕在化した既知の癖)。materializeの書き込み前に
 * parse検証し、先頭の平衡JSONオブジェクト抽出で直せる場合のみ修復する。直せない場合は原文の
 * まま返し、下流のstrict MVP検査(generated_source_syntax)に検出を委ねる。
 */
export const repairJsonFileContent = (relativePath: string, content: string): string => {
  const coerced = coerceParseableJsonContent(content);
  if (coerced === null) {
    console.warn(`[materialize] ${relativePath}: invalid JSON and not repairable; writing as-is`);
    return content;
  }
  if (coerced !== content) {
    console.warn(
      `[materialize] ${relativePath}: stripped non-JSON trailing text (kept ${coerced.length}/${content.length} chars)`,
    );
  }
  return coerced;
};
