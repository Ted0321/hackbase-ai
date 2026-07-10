// run-agent-interactions-scheduler.ts (Lane3) の「日次プラン＋毎時キュー消化」のうち、副作用のない
// 純粋関数だけを独立させたモジュール。スケジューラー本体はimport時にmain()を即実行するため、
// テストからは直接importできない — この分離により状態遷移を単体テストできる。
//
// 2026-07-10 Stage 2(時間分散): 従来は24h due-gateが開いた1回のtickで全ユニットを一括バースト
// 実行していた(全反応が同時刻に固まって見える)。本モジュールで「日初にその日のユニットへ
// ランダムな実行予定時刻を割り当ててSchedulerStateに保存し、毎時tickで期限到来分のみ実行する」
// due-queue方式に変える。Cloud Schedulerの毎時トリガーは既存のため、インフラ変更は不要。

import type { PlannedUnit, UnitPattern } from "./interaction-slot-planner";

// 1ユニットの実行失敗(子プロセス非0)を何回まで再試行するか。scheduledAtは過ぎているので
// 失敗ユニットは次のtickで自然に再実行され、上限到達で failed 確定する。
export const MAX_UNIT_ATTEMPTS = 2;

// 実行予定時刻を散らす幅(時間)。毎時tickの周期(24h)より少し短くして、日末のユニットが
// 次のプラン更新前に確実に消化されるようにする。
export const DEFAULT_UNIT_SPREAD_HOURS = 22;

export type QueuedUnitStatus = "pending" | "completed" | "skipped" | "failed" | "expired";

export type QueuedUnit = {
  id: string;
  agentId: string;
  pattern: UnitPattern;
  scheduledAt: string;
  status: QueuedUnitStatus;
  attempts: number;
  // 実際に作成されたFeedback行数(runner出力の created)。②の降格=1、対象なし=0 の観測用。
  rows?: number;
  executedAt?: string;
  lastError?: string;
};

export type DayPlan = {
  plannedAt: string;
  units: QueuedUnit[];
};

/**
 * planDailyUnits の結果に実行予定時刻を割り当てて当日プランを作る。
 * scheduledAt は plannedAt + U(0, spreadHours) の一様散布。immediate(=--force や spreadHours=0)
 * なら全件 now 即時(従来の一括バースト互換)。
 */
export function buildDayPlan(args: {
  units: readonly PlannedUnit[];
  now: Date;
  spreadHours?: number;
  immediate?: boolean;
  idSuffixes?: readonly string[];
  random?: () => number;
}): DayPlan {
  const random = args.random ?? Math.random;
  const spreadMs = Math.max(0, args.spreadHours ?? DEFAULT_UNIT_SPREAD_HOURS) * 60 * 60 * 1000;
  const immediate = args.immediate || spreadMs === 0;
  return {
    plannedAt: args.now.toISOString(),
    units: args.units.map((unit, index) => ({
      // idはスケジューラ側から注入可能(テストの決定論用)。既定はindexベースで十分一意
      // (プランはstate内で完結し、日毎に作り直されるため)。
      id: `unit_${args.idSuffixes?.[index] ?? `${args.now.getTime().toString(36)}_${index}`}`,
      agentId: unit.agentId,
      pattern: unit.pattern,
      scheduledAt: immediate
        ? args.now.toISOString()
        : new Date(args.now.getTime() + random() * spreadMs).toISOString(),
      status: "pending",
      attempts: 0,
    })),
  };
}

/** このtickで実行すべきユニット(期限到来のpending)。scheduledAt昇順で返す。 */
export function dueUnits(plan: DayPlan | undefined, now: Date): QueuedUnit[] {
  if (!plan) return [];
  return plan.units
    .filter(
      (unit) =>
        unit.status === "pending" &&
        unit.attempts < MAX_UNIT_ATTEMPTS &&
        Date.parse(unit.scheduledAt) <= now.getTime(),
    )
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}

export type UnitExecutionResult =
  | { outcome: "completed"; rows: number }
  | { outcome: "failed"; error: string };

/**
 * ユニットの実行結果をプランへ反映する(unitsは破壊せず新しいDayPlanを返す)。
 * - completed: rows>0 なら completed、rows=0 は skipped(対象作品なし等。無害)
 * - failed: attempts+1。MAX_UNIT_ATTEMPTS 到達で failed 確定、未満なら pending のまま
 *   (scheduledAtは過ぎているため次tickで自然に再試行される)
 */
export function markUnitResult(
  plan: DayPlan,
  unitId: string,
  result: UnitExecutionResult,
  now: Date,
): DayPlan {
  return {
    ...plan,
    units: plan.units.map((unit) => {
      if (unit.id !== unitId) return unit;
      if (result.outcome === "completed") {
        return {
          ...unit,
          status: result.rows > 0 ? ("completed" as const) : ("skipped" as const),
          rows: result.rows,
          executedAt: now.toISOString(),
        };
      }
      const attempts = unit.attempts + 1;
      return {
        ...unit,
        attempts,
        status: attempts >= MAX_UNIT_ATTEMPTS ? ("failed" as const) : ("pending" as const),
        lastError: result.error.slice(0, 500),
      };
    }),
  };
}

/**
 * プラン更新(24h経過)時に、残っているpendingを expired にする。日跨ぎの持ち越しはしない —
 * 持ち越すと当日分と合算されて日次量が上振れするし、状態機械も複雑になる。
 */
export function expireLeftoverUnits(plan: DayPlan, now: Date): { plan: DayPlan; expired: number } {
  let expired = 0;
  const units = plan.units.map((unit) => {
    if (unit.status !== "pending") return unit;
    expired += 1;
    return { ...unit, status: "expired" as const, executedAt: now.toISOString() };
  });
  return { plan: { ...plan, units }, expired };
}

export type DayPlanSummary = {
  total: number;
  pending: number;
  completed: number;
  skipped: number;
  failed: number;
  expired: number;
  rows: number;
  // 次に期限が来るpendingユニットの時刻(ISO)。pendingが無ければnull。
  nextUnitAt: string | null;
};

export function planSummary(plan: DayPlan | undefined): DayPlanSummary {
  const units = plan?.units ?? [];
  const pendingTimes = units
    .filter((unit) => unit.status === "pending")
    .map((unit) => unit.scheduledAt)
    .sort();
  return {
    total: units.length,
    pending: pendingTimes.length,
    completed: units.filter((unit) => unit.status === "completed").length,
    skipped: units.filter((unit) => unit.status === "skipped").length,
    failed: units.filter((unit) => unit.status === "failed").length,
    expired: units.filter((unit) => unit.status === "expired").length,
    rows: units.reduce((sum, unit) => sum + (unit.rows ?? 0), 0),
    nextUnitAt: pendingTimes[0] ?? null,
  };
}
