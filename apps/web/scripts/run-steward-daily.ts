import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient, missingTables as listMissingTables } from "./prisma-client";
import { readSchedulerStateRecord, writeSchedulerStateRecord } from "../src/lib/scheduler-state";
import {
  buildGovernanceDiversitySummary,
  disconnectGovernanceReportDb,
  generateGovernanceReport,
  type GovernanceReportOptions,
} from "./generate-governance-report";
import {
  checkGovernanceReportObject,
  hasGovernanceReportFailures,
  printGovernanceReportCheck,
} from "./check-governance-report";
import { hardRules, proposedActionDefinitions, stewardPatrolPolicy } from "./steward-policy";
import "./load-local-env";

type StewardDailyOptions = GovernanceReportOptions & {
  printJson?: boolean;
  selfTest?: boolean;
};

type StewardDailyResult = Awaited<ReturnType<typeof generateGovernanceReport>>;
type StewardSchedulerState = {
  version: "steward-daily-gate.v1";
  lastCompletedAt?: string;
  nextDueAt?: string;
  lastStatus?: "completed" | "skipped";
  history?: Array<{ at: string; status: "completed" | "skipped"; nextDueAt: string; reportId?: string }>;
};

const SCHEDULER_STATE_KEY = "steward-daily";
const SCHEDULER_STATE_SCOPE = "governance";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const addDailyInterval = (iso: string) => new Date(Date.parse(iso) + ONE_DAY_MS).toISOString();

function stewardDueDecision(state: StewardSchedulerState | null, now: Date, force?: boolean) {
  if (force) return { due: true, reason: "forced", nextDueAt: now.toISOString() };
  if (!state?.nextDueAt) return { due: true, reason: "no previous Steward state", nextDueAt: now.toISOString() };
  const nextDueAt = new Date(state.nextDueAt);
  if (Number.isNaN(nextDueAt.getTime())) {
    return { due: true, reason: "invalid previous nextDueAt", nextDueAt: now.toISOString() };
  }
  if (now >= nextDueAt) return { due: true, reason: "daily interval elapsed", nextDueAt: now.toISOString() };
  return { due: false, reason: `not due until ${state.nextDueAt}`, nextDueAt: state.nextDueAt };
}

async function readStewardState() {
  const prisma = createPrismaClient();
  try {
    return await readSchedulerStateRecord<StewardSchedulerState>(prisma, SCHEDULER_STATE_KEY);
  } finally {
    await prisma.$disconnect();
  }
}

async function writeStewardState(state: StewardSchedulerState) {
  const prisma = createPrismaClient();
  try {
    await writeSchedulerStateRecord(prisma, SCHEDULER_STATE_KEY, SCHEDULER_STATE_SCOPE, state);
  } finally {
    await prisma.$disconnect();
  }
}

// Lane1(run-research-cache-scheduler.ts)と同じ流儀でSchedulerRun行を残す(dry-runでは書かない)。
// このファイルの他ヘルパー同様、書き込みごとにclientを開閉する。
async function createStewardSchedulerRun(data: {
  id: string;
  status: "running" | "skipped";
  forced: boolean;
  reason?: string;
  startedAt: Date;
  completedAt?: Date;
  nextDueAt?: Date;
}) {
  const prisma = createPrismaClient();
  try {
    await prisma.schedulerRun.create({
      data: {
        id: data.id,
        scheduleName: SCHEDULER_STATE_KEY,
        status: data.status,
        source: "governance",
        planner: "steward-daily-patrol",
        limit: 0,
        intervalHours: 24,
        forced: data.forced,
        dryRun: false,
        reason: data.reason,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        nextDueAt: data.nextDueAt,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function finishStewardSchedulerRun(
  id: string,
  data: { status: "completed" | "failed"; errorMessage?: string; nextDueAt?: Date },
) {
  const prisma = createPrismaClient();
  try {
    await prisma.schedulerRun.update({
      where: { id },
      data: {
        status: data.status,
        errorMessage: data.errorMessage,
        completedAt: new Date(),
        nextDueAt: data.nextDueAt,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function missingTables(requiredTables: string[]) {
  const prisma = createPrismaClient();
  try {
    return await listMissingTables(prisma, requiredTables);
  } finally {
    await prisma.$disconnect();
  }
}

async function buildNoDataDryRunReport(args: StewardDailyOptions, reportId: string, missingRequiredTables: string[]): Promise<StewardDailyResult> {
  const outPath = path.resolve("artifacts", "governance-reports", `${reportId}.json`);
  const agentDiversitySummary = await buildGovernanceDiversitySummary();
  const zeroActorCounts = {
    human: 0,
    agent: 0,
    system: 0,
    validation_worker: 0,
  };

  return {
    report: {
      version: 2,
      id: reportId,
      generatedAt: new Date().toISOString(),
      governanceAgentId: stewardPatrolPolicy.governanceAgentId,
      scope: {
        runIds: [],
        projectIds: [],
        lookbackWindow: args.lookbackWindow ?? "daily",
      },
      summary: `Dry-run only: local database schema is not initialized. Missing table(s): ${missingRequiredTables.join(", ")}.`,
      overallStatus: "needs_review",
      findings: [],
      cleanupCandidates: [],
      operationalResponsibility: {
        model: "AI detects, Human Admin decides, system verifies.",
        steward: "Detect risks and produce advisory-only evidence. No automatic delete, unpublish, ban, or approve.",
        humanAdmin: stewardPatrolPolicy.humanAdminResponsibilities,
        system: stewardPatrolPolicy.systemResponsibilities,
      },
      proposedActionDefinitions,
      dailyOpsChecklist: [
        "Human Admin reviews the latest available Steward evidence before approve, withdraw, feature, or submission decisions.",
        "System initializes or points DATABASE_URL at the prepared local database before DB-backed submission verification.",
        "System runs governance report check, validation, smoke, deploy check, and submission gate after the human decision.",
      ],
      devOpsCandidates: [
        {
          runner: "Cloud Scheduler",
          fit: "Trigger daily Steward patrol or readiness checks after production release.",
          guardrail: "Must invoke report/check only; no delete, unpublish, ban, or auto_approve endpoint.",
        },
        {
          runner: "Cloud Run Jobs",
          fit: "Run heavier governance or smoke verification with isolated logs.",
          guardrail: "Job output should be artifacts/logs for Human Admin review; no delete, unpublish, ban, or auto_approve.",
        },
        {
          runner: "GitHub Actions",
          fit: "Verify report schema, hard rules, and submission gates during integration.",
          guardrail: "CI may fail builds, but must not delete, unpublish, ban, auto_approve, or mutate production content.",
        },
      ],
      interactionSummary: {
        feedbackByActorType: zeroActorCounts,
        eventsByActorType: zeroActorCounts,
        agentFeedback: 0,
        humanReports: 0,
        eventTypes: [],
      },
      agentDiversitySummary,
      patrolPolicy: {
        cadence: stewardPatrolPolicy.cadence,
        advisoryOnly: stewardPatrolPolicy.advisoryOnly,
        forbiddenActions: stewardPatrolPolicy.forbiddenActions,
        humanApprovalRequiredActions: Object.values(proposedActionDefinitions)
          .filter((definition) => definition.requiresHumanApproval)
          .map((definition) => definition.label),
        interactionLimits: stewardPatrolPolicy.interactionLimits,
        requiredProjectArtifacts: stewardPatrolPolicy.requiredProjectArtifacts,
      },
      runEventRecordingDecision: {
        priority: "P1",
        decision: "Defer automatic RunEvent writes for this patrol.",
        rationale: "Daily check remains advisory and dry-run safe; DB writes require an explicit non-dry-run command.",
        suggestedEventType: "steward_daily_patrol_reported",
      },
      coverageGaps: [
        "Local database schema is not initialized, so DB-backed project, validation, artifact, feedback, and RunEvent rows were not sampled.",
        "This dry-run did not inspect rendered screenshots or remote production state.",
        "It did not execute destructive cleanup or write RunEvent records.",
        ...(agentDiversitySummary.status === "available"
          ? []
          : ["Agent diversity summary could not be loaded from local registry/data snapshots."]),
      ],
      hardRules,
      nextReviewHint: "Initialize the local DB or point DATABASE_URL at the prepared submission database, then rerun the Steward daily check.",
    },
    outPath,
    wroteFile: false,
    skippedExisting: false,
  };
}

const parseArgs = (): StewardDailyOptions => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    dryRun: values.has("dry-run") || values.has("dryRun"),
    force: values.has("force"),
    printJson: values.has("json"),
    selfTest: values.has("self-test"),
  };
};

function runSelfTest() {
  const now = new Date("2026-07-03T18:00:00.000Z");
  const assertions: Array<[string, boolean]> = [
    ["first run is due", stewardDueDecision(null, now).due],
    [
      "future nextDueAt skips",
      !stewardDueDecision(
        { version: "steward-daily-gate.v1", nextDueAt: "2026-07-04T18:00:00.000Z" },
        now,
      ).due,
    ],
    [
      "elapsed nextDueAt is due",
      stewardDueDecision(
        { version: "steward-daily-gate.v1", nextDueAt: "2026-07-03T17:59:59.000Z" },
        now,
      ).due,
    ],
    [
      "force bypasses future gate",
      stewardDueDecision(
        { version: "steward-daily-gate.v1", nextDueAt: "2026-07-04T18:00:00.000Z" },
        now,
        true,
      ).due,
    ],
    ["daily interval adds 24h", addDailyInterval("2026-07-03T18:00:00.000Z") === "2026-07-04T18:00:00.000Z"],
  ];

  for (const [label, ok] of assertions) {
    console.log(`${ok ? "PASS" : "FAIL"} self-test ${label}`);
  }
  if (assertions.some(([, ok]) => !ok)) process.exit(1);
}

async function main() {
  const args = parseArgs();
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const now = new Date();
  const state = await readStewardState();
  const due = stewardDueDecision(state, now, args.force);
  const schedulerRunId = `sched_steward_${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  if (!due.due) {
    console.log(`[steward-daily] skipped: ${due.reason}`);
    console.log(`Next due at ${due.nextDueAt}`);
    if (!args.dryRun) {
      await createStewardSchedulerRun({
        id: schedulerRunId,
        status: "skipped",
        forced: false,
        reason: due.reason,
        startedAt: now,
        completedAt: now,
        nextDueAt: new Date(due.nextDueAt),
      });
      await writeStewardState({
        version: "steward-daily-gate.v1",
        ...state,
        lastStatus: "skipped",
        nextDueAt: due.nextDueAt,
        history: [
          { at: now.toISOString(), status: "skipped", nextDueAt: due.nextDueAt },
          ...((state?.history ?? []).slice(0, 29)),
        ],
      });
    }
    return;
  }

  if (!args.dryRun) {
    await createStewardSchedulerRun({
      id: schedulerRunId,
      status: "running",
      forced: Boolean(args.force),
      reason: due.reason,
      startedAt: now,
    });
  }

  const patrolDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const reportId = `steward_daily_${patrolDate}`;
  try {
    const missingRequiredTables = args.dryRun
      ? await missingTables(["Project", "Validation", "ValidationCheck", "Artifact", "Feedback", "RunEvent"])
      : [];
    const result =
      missingRequiredTables.length > 0
        ? await buildNoDataDryRunReport({ ...args, lookbackWindow: "daily" }, reportId, missingRequiredTables)
        : await generateGovernanceReport({
            ...args,
            lookbackWindow: "daily",
            reportId,
          });
    const relativePath = path.relative(process.cwd(), result.outPath);

    if (result.wroteFile) {
      console.log(`Steward daily patrol report written: ${relativePath}`);
    } else if (result.skippedExisting) {
      console.log(`Steward daily patrol already exists: ${relativePath}`);
      console.log("Use --force only after human review if the same day must be regenerated.");
    } else {
      console.log(`Dry run: steward daily patrol report was not written. Candidate path: ${relativePath}`);
    }

    console.log(`Status: ${String(result.report.overallStatus)}`);
    console.log(`Findings: ${Array.isArray(result.report.findings) ? result.report.findings.length : 0}`);

    const checkResult = await checkGovernanceReportObject(result.report, result.outPath);
    console.log("");
    printGovernanceReportCheck(checkResult);

    if (!result.wroteFile && args.printJson) {
      console.log("");
      console.log("Dry-run report JSON:");
      console.log(JSON.stringify(result.report, null, 2));
    }

    if (hasGovernanceReportFailures(checkResult)) {
      if (!args.dryRun) {
        await finishStewardSchedulerRun(schedulerRunId, {
          status: "failed",
          errorMessage: "governance report check failed",
        });
      }
      process.exit(1);
    }

    if (!args.dryRun) {
      const completedAt = new Date().toISOString();
      const nextDueAt = addDailyInterval(completedAt);
      await writeStewardState({
        version: "steward-daily-gate.v1",
        lastCompletedAt: completedAt,
        nextDueAt,
        lastStatus: "completed",
        history: [
          { at: completedAt, status: "completed", nextDueAt, reportId },
          ...((state?.history ?? []).slice(0, 29)),
        ],
      });
      await finishStewardSchedulerRun(schedulerRunId, {
        status: "completed",
        nextDueAt: new Date(nextDueAt),
      });
      console.log(`Next due at ${nextDueAt}`);
    }
  } catch (error) {
    if (!args.dryRun) {
      await finishStewardSchedulerRun(schedulerRunId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    throw error;
  }
}

main()
  .then(async () => {
    await disconnectGovernanceReportDb();
  })
  .catch(async (error) => {
    console.error(error);
    await disconnectGovernanceReportDb();
    process.exit(1);
  });
