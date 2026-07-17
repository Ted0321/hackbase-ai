import ts from "typescript";

/**
 * 生成ソース(.ts/.tsx/.js/.jsx)の構文修復。
 *
 * builderはプロンプト全文をテンプレートリテラルとして source/core/** に埋め込む契約のため、
 * プロンプト本文に生のバッククォートが混入するとリテラルが途中終了して構文エラーになる。
 * 実事故(2026-07-14 HeatShield Route / run_selfdirected_agent_j_20260714T170022)では、
 * プロンプト本文の「説明文や```jsonマークは不要です」の```で 2-generate-plan.ts が壊れ、
 * generated_source_syntax fail → held_for_review 落ちした。
 *
 * 方針: check-mvp-artifact と同じ parse 診断(ts.createSourceFile の parseDiagnostics)を
 * 修復の判定器に使い、候補修復(バッククォートのエスケープ等)を順に試して「構文エラーが
 * ゼロになった場合のみ」採用する。直せない場合は原文のまま返し、検出側ゲートに委ねる。
 * 判定器と検出器が同一なので、採用された修復は必ずゲートを通る。
 */

const scriptKindFor = (filePath: string) => {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

export const isTsLikeSourcePath = (filePath: string): boolean => /\.(tsx?|jsx?)$/i.test(filePath);

/** check-mvp-artifact の generated_source_syntax と同じ基準の parse 診断(最大3件)。 */
export const tsParseIssues = (filePath: string, content: string): string[] => {
  const parsed = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const diagnostics =
    (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diagnostics.slice(0, 3).map((diagnostic) => {
    const pos =
      typeof diagnostic.start === "number" ? parsed.getLineAndCharacterOfPosition(diagnostic.start) : null;
    const location = pos ? `${pos.line + 1}:${pos.character + 1}` : "?";
    return `${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
};

// markdownコードフェンス(```json 等)のバッククォート連をエスケープする。テンプレートリテラル
// 内の生フェンスは最初の1本でリテラルを閉じてしまうため、これが実事故の主形。
const escapeFenceBackticks = (content: string): string =>
  content.replace(/(?<!\\)`{3,}/g, (run) => run.replace(/`/g, "\\`"));

const firstParseErrorOffset = (filePath: string, content: string): number | null => {
  const parsed = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const diagnostics =
    (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (diagnostics.length === 0) return null;
  return typeof diagnostics[0].start === "number" ? diagnostics[0].start : 0;
};

// パーサー誘導のバッククォート修復: markdownインラインコード(`json` 等)の生バッククォートは
// 左→右の機械的ペアリングでは正当なテンプレート開始と区別できない。そこで parse 診断の
// 「最初のエラー位置」直前にある未エスケープのバッククォートを1本ずつエスケープし、エラー位置が
// 厳密に前進した場合だけ採用して繰り返す。正当な区切りを誤エスケープするとエラーが前進しない
// ため、その時点で打ち切って原文を返す(採用可否は呼び出し側の「エラーゼロ」判定が最終ゲート)。
const escapeBackticksParserGuided = (filePath: string, content: string): string => {
  let current = content;
  let errorOffset = firstParseErrorOffset(filePath, current);
  for (let step = 0; step < 32 && errorOffset !== null; step += 1) {
    let backtickIndex = -1;
    for (let index = Math.min(errorOffset, current.length - 1); index >= 0; index -= 1) {
      if (current[index] === "`" && current[index - 1] !== "\\") {
        backtickIndex = index;
        break;
      }
    }
    if (backtickIndex < 0) break;
    const next = `${current.slice(0, backtickIndex)}\\\`${current.slice(backtickIndex + 1)}`;
    const nextErrorOffset = firstParseErrorOffset(filePath, next);
    if (nextErrorOffset === null) return next;
    if (nextErrorOffset <= errorOffset + 1) break; // +1 = 挿入した \ の分。前進しない書き換えは誤修復。
    current = next;
    errorOffset = nextErrorOffset;
  }
  return content;
};

// テンプレートリテラル内の未エスケープ ${ を literal 化する。正当な補間も literal 化される
// 破壊的候補なので、デモが実行しない documentation-grade の source/core/** に限って試す
// (page.tsx 等の実行コードで補間を literal 化すると表示が変わってしまう)。
const escapeTemplateExpressionStarts = (content: string): string =>
  content.replace(/(?<!\\)\$\{/g, "\\${");

const isCoreDocumentationPath = (relativePath: string): boolean =>
  /(^|\/)core\//.test(relativePath.replace(/\\/g, "/"));

export type TsSourceRepair =
  | { status: "clean" }
  | { status: "repaired"; content: string; appliedFix: string; issues: string[] }
  | { status: "unrepairable"; issues: string[] };

/**
 * 生成された TS/JS ソースの構文を検証し、既知の LLM 癖(テンプレートリテラル内の生バック
 * クォート/${)由来なら自動エスケープで修復する。修復は「適用後に parse 診断がゼロ」の
 * 候補だけを採用するため、意味の怪しい書き換えが構文エラーのまま通ることはない。
 */
export const repairGeneratedTsSource = (relativePath: string, content: string): TsSourceRepair => {
  if (!isTsLikeSourcePath(relativePath)) return { status: "clean" };
  const issues = tsParseIssues(relativePath, content);
  if (issues.length === 0) return { status: "clean" };

  const candidates: Array<{ label: string; apply: (value: string) => string }> = [
    { label: "escaped code-fence backticks (```)", apply: escapeFenceBackticks },
    {
      label: "escaped stray template-literal backticks (parser-guided)",
      apply: (value) => escapeBackticksParserGuided(relativePath, escapeFenceBackticks(value)),
    },
  ];
  if (isCoreDocumentationPath(relativePath)) {
    candidates.push({
      label: "escaped backticks and template expression starts (${)",
      apply: (value) =>
        escapeTemplateExpressionStarts(
          escapeBackticksParserGuided(relativePath, escapeFenceBackticks(value)),
        ),
    });
  }

  for (const candidate of candidates) {
    const repaired = candidate.apply(content);
    if (repaired === content) continue;
    if (tsParseIssues(relativePath, repaired).length === 0) {
      return { status: "repaired", content: repaired, appliedFix: candidate.label, issues };
    }
  }
  return { status: "unrepairable", issues };
};

/**
 * materialize の書き込み経路用ヘルパ(repairJsonFileContent の TS 版)。修復できれば修復後を、
 * できなければ原文を返し、下流の strict MVP 検査(generated_source_syntax)に検出を委ねる。
 */
export const repairTsSourceFileContent = (relativePath: string, content: string): string => {
  const repair = repairGeneratedTsSource(relativePath, content);
  if (repair.status === "repaired") {
    console.warn(
      `[materialize] ${relativePath}: repaired generated source syntax (${repair.appliedFix}); original issue(s): ${repair.issues.join("; ")}`,
    );
    return repair.content;
  }
  if (repair.status === "unrepairable") {
    console.warn(
      `[materialize] ${relativePath}: syntax issue(s) not auto-repairable; writing as-is for the strict gate: ${repair.issues.join("; ")}`,
    );
  }
  return content;
};
