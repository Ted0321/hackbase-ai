export type ModelUsageCostInput = {
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd?: number | null;
};

// concept/builder は既定で gemini-2.5-pro を使うため pro を明示（未登録だと
// DEFAULT=flash に落ち、出力単価を 1/4 に過小計上する）。pro を先頭に置き
// includes 一致で flash より先に拾う。画像モデルは estimatedCostUsd 経由で計上。
const PRICING: Array<{ match: string; inputPerM: number; outputPerM: number }> = [
  { match: "gemini-2.5-pro", inputPerM: 1.25, outputPerM: 10 },
  { match: "gemini-2.5-flash", inputPerM: 0.3, outputPerM: 2.5 },
  { match: "gemini-2.0-flash", inputPerM: 0.1, outputPerM: 0.4 },
  { match: "gemini-1.5-flash", inputPerM: 0.075, outputPerM: 0.3 },
];

const DEFAULT_PRICING = { inputPerM: 0.3, outputPerM: 2.5 };

const pricingFor = (model: string | null) => {
  const name = (model ?? "").toLowerCase();
  return PRICING.find((entry) => name.includes(entry.match)) ?? DEFAULT_PRICING;
};

export const estimateModelUsageCostUsd = (row: ModelUsageCostInput): number => {
  if (typeof row.estimatedCostUsd === "number" && Number.isFinite(row.estimatedCostUsd)) {
    return row.estimatedCostUsd;
  }

  const price = pricingFor(row.model);
  const input = row.promptTokens ?? 0;
  // thinkingトークンはtotalTokensにのみ含まれ出力単価で課金されるため、totalTokensが
  // あれば total - prompt を出力側として使う(completionTokens優先だと系統的過少計上)。
  const derivedOutput =
    row.totalTokens != null ? Math.max(0, row.totalTokens - input) : row.completionTokens ?? 0;
  const output = derivedOutput > 0 ? derivedOutput : 0;

  return (input / 1_000_000) * price.inputPerM + (output / 1_000_000) * price.outputPerM;
};
