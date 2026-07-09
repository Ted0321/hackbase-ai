export type LlmResponseTextIssue = {
  path: string;
  term: string;
  sample: string;
};

// Mojibake markers observed in generated prompt responses. Keep these as
// Unicode escapes so the detector itself cannot be re-corrupted by encoding.
const mojibakeLeadPattern =
  /[\u90e2\u90b5\u965e\u96b4\u9677\u9aeb\u95d5\u9b2f\u96cb\u96b9\u95d6\u965d\u967c\u968b\u95d4\u7e67\u7e3a\u87c6\u8b5b\u8c4e\u87b3\u83a8\u90a8\u8811][\uff61-\uff9f\u30fb\ufffd]?/g;

const replacementCharacterPattern = /\ufffd/g;

// Lone (unpaired) UTF-16 surrogate halves and C1 control characters. Some Gemini
// Japanese responses corrupt into `\udcXX` / `\x80` fragments that the CJK-lead
// pattern above does not catch; valid surrogate PAIRS (emoji etc.) are excluded
// via the pairing lookahead/behind, so this only flags genuinely broken text.
const corruptedCharacterPattern =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\u0080-\u009f]/g;

const sampleAround = (text: string, index: number) =>
  text.slice(Math.max(0, index - 24), Math.min(text.length, index + 48)).replace(/\s+/g, " ");

const collectMatches = (
  text: string,
  currentPath: string,
  pattern: RegExp,
  issues: LlmResponseTextIssue[],
  maxIssues: number,
) => {
  pattern.lastIndex = 0;
  for (;;) {
    if (issues.length >= maxIssues) break;
    const match = pattern.exec(text);
    if (!match) break;
    issues.push({
      path: currentPath,
      term: match[0],
      sample: sampleAround(text, match.index),
    });
  }
};

export function findMojibakeLikeTextIssues(
  value: unknown,
  opts: { maxIssues?: number; path?: string } = {},
): LlmResponseTextIssue[] {
  const maxIssues = opts.maxIssues ?? 20;
  const issues: LlmResponseTextIssue[] = [];

  const visit = (item: unknown, currentPath: string) => {
    if (issues.length >= maxIssues) return;

    if (typeof item === "string") {
      collectMatches(item, currentPath, mojibakeLeadPattern, issues, maxIssues);
      collectMatches(item, currentPath, replacementCharacterPattern, issues, maxIssues);
      collectMatches(item, currentPath, corruptedCharacterPattern, issues, maxIssues);
      return;
    }

    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
      return;
    }

    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        visit(child, currentPath ? `${currentPath}.${key}` : key);
        if (issues.length >= maxIssues) return;
      }
    }
  };

  visit(value, opts.path ?? "$");
  return issues;
}
