import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type GovernanceReport = {
  id?: string;
  generatedAt?: string;
  governanceAgentId?: string;
  summary?: string;
  overallStatus?: string;
  findings?: Array<{
    severity?: string;
    category?: string;
    targetId?: string;
    proposedAction?: string;
  }>;
  dailyOpsChecklist?: string[];
  operationalResponsibility?: {
    model?: string;
    steward?: string;
    humanAdmin?: string[];
    system?: string[];
  };
  proposedActionDefinitions?: Record<
    string,
    {
      meaning?: string;
      owner?: string;
      requiresHumanApproval?: boolean;
    }
  >;
  scope?: {
    runIds?: string[];
    projectIds?: string[];
    lookbackWindow?: string;
  };
  patrolPolicy?: {
    cadence?: string;
    advisoryOnly?: boolean;
  };
};

/**
 * artifacts/governance-reports/ から最新の steward ガバナンス所見を読み込む。
 * steward パイプライン（generate-governance-report.ts / run-steward-daily.ts）が
 * 書き出した advisory レポートを、人間コンソールで確認するために使う。
 */
export const readLatestGovernanceReport = async (): Promise<GovernanceReport | null> => {
  const reportDir = path.join(process.cwd(), "artifacts", "governance-reports");

  try {
    const entries = await readdir(reportDir, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(reportDir, entry.name);
          return {
            filePath,
            updatedAt: (await stat(filePath)).mtimeMs,
          };
        }),
    );
    const latest = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return null;

    return JSON.parse(await readFile(latest.filePath, "utf8")) as GovernanceReport;
  } catch {
    return null;
  }
};
