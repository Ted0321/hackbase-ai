export type GeminiResponse = Record<string, unknown>;

const repairEscapedNestedJsonSeparators = (text: string): string =>
  text.replace(/\\,(\s*)"/g, (_match, spaces: string) => `,\\n${spaces}\\"`);

const normalizeLineContinuationBackslashes = (text: string): string =>
  text
    .replace(/\\\r?\n([ \t]*)/g, "\\n$1")
    .replace(/\\([ \t]+)(?=[A-Za-z_$])/g, "\\n$1");

const sanitizeJsonEscapes = (text: string): string =>
  repairEscapedNestedJsonSeparators(normalizeLineContinuationBackslashes(text)).replace(
    /\\(?!["\\/bfnrtu])/g,
    "\\\\",
  );

const sanitizeTrailingCommas = (text: string): string =>
  text.replace(/,\s*([}\]])/g, "$1");

const sanitizeQuotedMarkersInStrings = (text: string): string =>
  text
    .replace(/rather\s+"_OR_"\s+generic/g, "rather than generic")
    .replace(/(?<=\w\s)"_OR_"(?=\s\w)/g, "or");

const stripCodeFence = (text: string): string =>
  text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

const tryParse = (candidate: string): unknown | null => {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
};

const extractJsonFenceBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (;;) {
    const match = fencePattern.exec(text);
    if (!match) break;
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
};

// materialize-llm-plan の .json 修復(末尾ゴミ除去)でも再利用するため export する。
export const extractBalancedJsonObject = (text: string): string | undefined => {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return undefined;
};

const repairCandidate = (candidate: string): string[] => {
  const normalized = normalizeLineContinuationBackslashes(candidate);
  const quoted = sanitizeQuotedMarkersInStrings(candidate);
  return [
    candidate,
    normalized,
    sanitizeJsonEscapes(candidate),
    quoted,
    sanitizeJsonEscapes(quoted),
    sanitizeTrailingCommas(candidate),
    sanitizeTrailingCommas(normalized),
    sanitizeTrailingCommas(sanitizeJsonEscapes(candidate)),
    sanitizeTrailingCommas(sanitizeJsonEscapes(quoted)),
  ];
};

export const extractResponseText = (response: unknown): string => {
  if (typeof response === "string") {
    return response;
  }

  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const parts: string[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== "object") continue;
    const contentParts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(contentParts)) continue;

    for (const part of contentParts) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
};

export const extractFinishReason = (response: unknown): string | null => {
  if (!response || typeof response !== "object") return null;
  const candidates = (response as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!first || typeof first !== "object") return null;
  const reason = (first as Record<string, unknown>).finishReason;
  return typeof reason === "string" ? reason : null;
};

export const parseGeminiResponseJson = (response: unknown) => {
  const text = extractResponseText(response);
  if (!text) {
    const reason = extractFinishReason(response);
    throw new Error(
      `Gemini response did not contain output text${reason ? ` (finishReason=${reason})` : ""}.`,
    );
  }

  const stripped = stripCodeFence(text);
  const fenceBlocks = extractJsonFenceBlocks(text);
  const greedyMatch = stripped.match(/\{[\s\S]*\}/);
  const balanced = extractBalancedJsonObject(stripped);
  const baseCandidates = [
    stripped,
    ...fenceBlocks,
    balanced,
    greedyMatch?.[0],
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  const candidates = Array.from(new Set(baseCandidates.flatMap(repairCandidate)));
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  const reason = extractFinishReason(response);
  const hint =
    reason === "MAX_TOKENS"
      ? " Output may have been truncated by maxOutputTokens, leaving incomplete JSON."
      : "";
  throw new Error(
    `Gemini output was not parseable as JSON (even after escape sanitization).` +
      `${reason ? ` finishReason=${reason}.` : ""}${hint}`,
  );
};
