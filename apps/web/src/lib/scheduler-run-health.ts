/**
 * 失敗した SchedulerRun の「今も対応が必要か」の分類。
 *
 * 背景(2026-07-10): 一過性のレーン失敗が派生incident(P0)として7日間残り続け、
 * 手動のDB操作(neutralize-failed-scheduler-runs.ts)でしか消せなかった。失敗行そのものは
 * 監査のため書き換えず、読む側で「もう対応不要な失敗」を判定して除外する。
 * sync-console-observability.ts(incident化)と console-summary.ts(失敗Schedulerバッジ)の
 * 両方からこのモジュールを使い、判定を一致させる。
 *
 * 分類ポリシー:
 *  - recovered:    失敗より後に同じ scheduleName の成功(completed)がある = レーンは自己回復済み。
 *                  スケジューラは失敗agentを数時間後に再試行する設計なので、後続の成功は
 *                  「一過性だった」ことの十分な証拠として扱う。恒常的な問題なら新しい失敗行が
 *                  生まれ続け、scheduler_repeated_failure(閾値3)がP0で拾う。
 *  - budgetCapped: 予算上限(rate-guard)による想定内の遮断。UTC日替わりで自動再開する。
 *  - active:       上記以外 = まだ回復が確認できていない実際の失敗。
 */

export type FailedSchedulerRunLike = {
  scheduleName: string;
  startedAt: Date;
  errorMessage: string | null;
};

export type CompletedSchedulerRunMarker = {
  scheduleName: string;
  startedAt: Date;
};

// 失敗SchedulerRunを遡って評価する共通窓(日)。syncの派生incident窓(DERIVED_INCIDENT_LOOKBACK_DAYS)
// とバッジ集計で同じ値を使う。
export const SCHEDULER_FAILURE_LOOKBACK_DAYS = 7;

// rate-guard.ts(enforceGeminiBudget)が投げる文言に一致させる。メッセージは
// SchedulerRun.errorMessage に「agentId: ...」形式で埋め込まれるため部分一致で判定する。
const BUDGET_CAP_PATTERN = /Gemini daily (request|cost) cap reached/i;

export const isBudgetCapFailure = (errorMessage: string | null | undefined): boolean =>
  BUDGET_CAP_PATTERN.test(errorMessage ?? "");

const latestCompletedAtBySchedule = (completed: CompletedSchedulerRunMarker[]): Map<string, number> => {
  const latest = new Map<string, number>();
  for (const run of completed) {
    const at = run.startedAt.getTime();
    if (Number.isNaN(at)) continue;
    const current = latest.get(run.scheduleName);
    if (current === undefined || at > current) latest.set(run.scheduleName, at);
  }
  return latest;
};

export type ClassifiedSchedulerFailures<T> = {
  active: T[];
  budgetCapped: T[];
  recovered: T[];
};

export const classifySchedulerFailures = <T extends FailedSchedulerRunLike>(
  failed: T[],
  completed: CompletedSchedulerRunMarker[],
): ClassifiedSchedulerFailures<T> => {
  const latestCompleted = latestCompletedAtBySchedule(completed);
  const result: ClassifiedSchedulerFailures<T> = { active: [], budgetCapped: [], recovered: [] };
  for (const run of failed) {
    const recoveredAt = latestCompleted.get(run.scheduleName);
    if (recoveredAt !== undefined && recoveredAt > run.startedAt.getTime()) {
      result.recovered.push(run);
    } else if (isBudgetCapFailure(run.errorMessage)) {
      result.budgetCapped.push(run);
    } else {
      result.active.push(run);
    }
  }
  return result;
};
