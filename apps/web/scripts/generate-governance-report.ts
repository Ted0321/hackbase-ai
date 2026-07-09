import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readStoredArtifactPath } from "../src/lib/artifact-store";
import { readAgentRegistry } from "./agent-registry";
import { buildAgentDiversityReport } from "./agent-diversity-report";
import { readAgentQualityStats, readGeneratedOutputMetadata } from "./agent-similarity";
import { createPrismaClient } from "./prisma-client";
import {
  categoryForValidationKey,
  hardRules,
  proposedActionDefinitions,
  proposedActionForSeverity,
  severityForValidationKey,
  severityForValidationStatus,
  stewardPatrolPolicy,
  type StewardFinding,
} from "./steward-policy";
import "./load-local-env";

export type GovernanceReportOptions = {
  dryRun?: boolean;
  force?: boolean;
  lookbackWindow?: "manual" | "daily" | "weekly" | "custom" | string;
  reportId?: string;
  outDir?: string;
};

type GovernanceReportResult = {
  report: Record<string, unknown>;
  outPath: string;
  wroteFile: boolean;
  skippedExisting: boolean;
};

const prisma = createPrismaClient();

export async function disconnectGovernanceReportDb() {
  await prisma.$disconnect();
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

const parseArgs = (): GovernanceReportOptions => {
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
    lookbackWindow: String(values.get("lookback-window") ?? values.get("lookbackWindow") ?? "manual"),
    reportId: typeof values.get("report-id") === "string" ? String(values.get("report-id")) : undefined,
    outDir: typeof values.get("out-dir") === "string" ? String(values.get("out-dir")) : undefined,
  };
};

const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

const safeEvidence = (items: Array<string | null | undefined>) =>
  items.filter((item): item is string => Boolean(item && item.trim().length > 0));

const textLooksEmpty = (body: string) => body.replace(/\s/g, "").length < 80;

export async function buildGovernanceDiversitySummary() {
  try {
    const [registry, qualityStats, generatedOutputMetadata] = await Promise.all([
      readAgentRegistry(),
      readAgentQualityStats(),
      readGeneratedOutputMetadata(),
    ]);
    const report = await buildAgentDiversityReport({
      registryVersion: registry.version,
      agents: registry.agents,
      qualityStats,
      generatedOutputMetadata,
      nearestPairLimit: 5,
    });

    return {
      status: "available",
      activeCreatorCount: report.activeCreatorCount,
      averagePairwiseSimilarity: report.averagePairwiseSimilarity,
      maxPairwiseSimilarity: report.maxPairwiseSimilarity,
      nearestNeighborPairs: report.nearestNeighborPairs.slice(0, 5),
      overlapHotspots: report.overlapHotspots.slice(0, 8),
      coverageGaps: report.coverageGaps,
      generatedOutputCoverage: {
        latestProjectCount: report.generatedOutputCoverage.latestProjectCount,
        metadataProjectCount: report.generatedOutputCoverage.metadataProjectCount,
        templatePatternUniqueCount: report.generatedOutputCoverage.templatePatternCoverage.uniqueCount,
        surfacePatternUniqueCount: report.generatedOutputCoverage.surfacePatternCoverage.uniqueCount,
        aiMechanismPatternUniqueCount: report.generatedOutputCoverage.aiMechanismPatternCoverage.uniqueCount,
      },
      advisoryUse:
        "Diversity signals are for Steward/Human Admin observation only; they must not trigger automatic delete, unpublish, ban, approve, or profile pause actions.",
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: String(error),
      advisoryUse:
        "Diversity signals were not available for this report; this absence must not trigger automatic action.",
    };
  }
}

// artifact本体はFS優先→GCSフォールバックで解決する（web読み手と同じ artifact-store 経由）。
// 本番の日次Jobは揮発FSで、source実体はGCSにしか無いため、旧実装のFS existsSyncだけでは
// 全 source を broken_source と誤検知していた（2026-07-08修正）。
const readArtifactBody = (artifactPath: string) => readStoredArtifactPath(artifactPath);

const firstMissingRequiredArtifacts = (
  projectId: string,
  artifactTypes: string[],
): StewardFinding[] => {
  return stewardPatrolPolicy.requiredProjectArtifacts
    .filter((requiredType) => !artifactTypes.includes(requiredType))
    .map((requiredType) => ({
      id: `finding_missing_${requiredType}_${projectId}`,
      targetType: "project",
      targetId: projectId,
      severity: requiredType === "source" ? "high" : "warning",
      category: "missing_artifact",
      evidence: [`No artifact with type=${requiredType} was found for project:${projectId}.`],
      recommendation:
        requiredType === "source"
          ? "Project source artifactが生成・保存されているか人間管理者が確認する。"
          : "生成runのartifact保存経路を確認する。",
      proposedAction: requiredType === "source" ? "hold_for_review" : "needs_rewrite",
    }));
};

const dailyOpsChecklist = [
  "Open the latest Steward governance report and start with high/blocker findings.",
  "Human Admin reviews hold_for_review items before approve, withdraw, feature, or submission decisions.",
  "Human Admin reviews withdrawal_review items against the visible project page and recent feedback before changing publication state.",
  "Human Admin reviews profile_pause_review items against the agent profile and recent behavior before pausing any profile.",
  "System runs governance report check, validation, smoke, deploy check, and submission gate after the human decision.",
  "Record the final human decision separately from Steward evidence; Steward report remains advisory-only.",
];

export async function generateGovernanceReport(
  options: GovernanceReportOptions = {},
): Promise<GovernanceReportResult> {
  const agentDiversitySummary = await buildGovernanceDiversitySummary();
  const projects = await prisma.project.findMany({
    include: { agent: true },
    orderBy: { createdAt: "desc" },
    take: stewardPatrolPolicy.sampleLimits.projects,
  });
  const projectIds = projects.map((project) => project.id);
  const runIds = unique(projects.map((project) => project.runId));

  const [validations, checks, artifacts, feedback, events] = await Promise.all([
    prisma.validation.findMany({
      orderBy: { checkedAt: "desc" },
      take: stewardPatrolPolicy.sampleLimits.validations,
    }),
    prisma.validationCheck.findMany({
      where: {
        status: { not: "pass" },
      },
      orderBy: { createdAt: "desc" },
      take: stewardPatrolPolicy.sampleLimits.validationChecks,
    }),
    prisma.artifact.findMany({
      where: {
        projectId: { in: projectIds },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.feedback.findMany({
      orderBy: { createdAt: "desc" },
      take: stewardPatrolPolicy.sampleLimits.feedback,
    }),
    prisma.runEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: stewardPatrolPolicy.sampleLimits.runEvents,
    }),
  ]);

  const findings: StewardFinding[] = [];

  const artifactsByProject = new Map<string, typeof artifacts>();
  for (const artifact of artifacts) {
    if (!artifact.projectId) continue;
    artifactsByProject.set(artifact.projectId, [...(artifactsByProject.get(artifact.projectId) ?? []), artifact]);
  }

  const feedbackByProject = new Map<string, typeof feedback>();
  for (const item of feedback.filter((item) => item.targetType === "project")) {
    feedbackByProject.set(item.targetId, [...(feedbackByProject.get(item.targetId) ?? []), item]);
  }

  findings.push(
    ...validations
      .filter((validation) => validation.status !== "pass")
      .slice(0, 12)
      .map((validation) => {
        const severity = severityForValidationStatus(validation.status);
        return {
          id: `finding_validation_${validation.id}`,
          targetType: "project",
          targetId: validation.projectId,
          severity,
          category: "validation_gap",
          evidence: safeEvidence([
            `validation:${validation.id}`,
            `actorType:${validation.actorType}`,
            validation.summary,
            validation.errorMessage,
            `status:${validation.status}`,
          ]),
          recommendation: "人間管理者がvalidation summaryとartifactを確認する。",
          proposedAction: proposedActionForSeverity(severity),
        };
      }),
  );

  findings.push(
    ...checks.slice(0, 12).map((check) => {
      const severity = severityForValidationKey(check.key);
      return {
        id: `finding_check_${check.id}`,
        targetType: "project",
        targetId: check.projectId,
        severity,
        category: categoryForValidationKey(check.key),
        evidence: safeEvidence([
          `validation_check:${check.id}`,
          `actorType:${check.actorType}`,
          check.summary,
          `status:${check.status}`,
        ]),
        recommendation: "該当checkの根拠を確認し、rewriteまたはholdの要否を人間が判断する。",
        proposedAction: proposedActionForSeverity(severity),
      };
    }),
  );

  for (const project of projects) {
    const projectArtifacts = artifactsByProject.get(project.id) ?? [];
    const projectArtifactTypes = projectArtifacts.map((artifact) => artifact.type);
    findings.push(...firstMissingRequiredArtifacts(project.id, projectArtifactTypes));

    const sourceArtifact = projectArtifacts.find((artifact) => artifact.type === "source");
    if (sourceArtifact) {
      const sourceBody = await readArtifactBody(sourceArtifact.path);
      if (sourceBody === null) {
        findings.push({
          id: `finding_broken_source_path_${sourceArtifact.id}`,
          targetType: "artifact",
          targetId: sourceArtifact.id,
          severity: "high",
          category: "broken_source",
          evidence: [`artifact:${sourceArtifact.id}`, `path:${sourceArtifact.path}`, "source file is missing on disk"],
          recommendation: "Project sourceの実体ファイルがartifact pathに存在するか確認する。",
          proposedAction: "hold_for_review",
        });
      } else if (textLooksEmpty(sourceBody)) {
        findings.push({
          id: `finding_empty_source_${sourceArtifact.id}`,
          targetType: "artifact",
          targetId: sourceArtifact.id,
          severity: "high",
          category: "broken_source",
          evidence: [`artifact:${sourceArtifact.id}`, `path:${sourceArtifact.path}`, "source file is nearly empty"],
          recommendation: "生成されたsourceが空または壊れていないか確認する。",
          proposedAction: "hold_for_review",
        });
      }
    }

    const projectFeedback = feedbackByProject.get(project.id) ?? [];
    const agentFeedback = projectFeedback.filter((item) => item.actorType === "agent");
    const agentLikes = agentFeedback.filter((item) => item.rating === "agent_like");
    const humanReports = projectFeedback.filter(
      (item) =>
        item.actorType === "human" &&
        (stewardPatrolPolicy.humanEscalationRatings as readonly string[]).includes(item.rating),
    );

    if (agentFeedback.length > stewardPatrolPolicy.interactionLimits.maxAgentInteractionsPerProject) {
      findings.push({
        id: `finding_agent_interaction_overflow_${project.id}`,
        targetType: "project",
        targetId: project.id,
        severity: "warning",
        category: "agent_behavior",
        evidence: [
          `agentFeedback:${agentFeedback.length}`,
          `limit:${stewardPatrolPolicy.interactionLimits.maxAgentInteractionsPerProject}`,
          `ratings:${agentFeedback.map((item) => item.rating).join(",")}`,
        ],
        recommendation: "agent同士の反応が主役artifactを圧迫していないか確認する。",
        proposedAction: "needs_rewrite",
      });
    }

    if (agentLikes.length > stewardPatrolPolicy.interactionLimits.maxAgentLikesPerProject) {
      findings.push({
        id: `finding_duplicate_agent_like_${project.id}`,
        targetType: "project",
        targetId: project.id,
        severity: "warning",
        category: "duplicate_like",
        evidence: [`agent_like:${agentLikes.length}`, `limit:${stewardPatrolPolicy.interactionLimits.maxAgentLikesPerProject}`],
        recommendation: "agent_likeの連発を避け、critique/remix/risk flagへ寄せる。",
        proposedAction: "needs_rewrite",
      });
    }

    for (const report of humanReports.slice(0, 4)) {
      findings.push({
        id: `finding_human_report_${report.id}`,
        targetType: "feedback",
        targetId: report.id,
        severity: report.rating === "bug_report" ? "high" : "warning",
        category: "human_report",
        evidence: safeEvidence([
          `feedback:${report.id}`,
          `rating:${report.rating}`,
          `actorType:${report.actorType}`,
          report.comment,
        ]),
        recommendation: "人間からのreport/bug_reportを確認し、artifact修正または説明追記が必要か判断する。",
        proposedAction: report.rating === "bug_report" ? "hold_for_review" : "needs_rewrite",
      });
    }
  }

  const feedbackByActorType = stewardPatrolPolicy.requiredAttributionTypes.reduce<Record<string, number>>((acc, actorType) => {
    acc[actorType] = feedback.filter((item) => item.actorType === actorType).length;
    return acc;
  }, {});

  const eventsByActorType = stewardPatrolPolicy.requiredAttributionTypes.reduce<Record<string, number>>((acc, actorType) => {
    acc[actorType] = events.filter((event) => event.actorType === actorType).length;
    return acc;
  }, {});

  const reportId = options.reportId ?? `steward_report_${stamp()}`;
  const outDir = path.resolve(options.outDir ?? path.join(process.cwd(), "artifacts", "governance-reports"));
  const outPath = path.join(outDir, `${reportId}.json`);
  const existing = existsSync(outPath);
  const shouldWrite = !options.dryRun && (!existing || Boolean(options.force));

  const report = {
    version: 2,
    id: reportId,
    generatedAt: new Date().toISOString(),
    governanceAgentId: stewardPatrolPolicy.governanceAgentId,
    scope: {
      runIds,
      projectIds,
      lookbackWindow: options.lookbackWindow ?? "manual",
    },
    summary: `Reviewed ${projects.length} project(s), ${validations.length} validation(s), ${checks.length} non-pass validation check(s), ${artifacts.length} artifact(s), ${feedback.length} feedback item(s), and ${events.length} event(s).`,
    overallStatus:
      findings.some((finding) => finding.severity === "blocker")
        ? "blocked"
        : findings.some((finding) => finding.severity === "high")
          ? "hold_recommended"
          : findings.length > 0
            ? "needs_review"
            : "clear",
    findings,
    cleanupCandidates: [],
    operationalResponsibility: {
      model: "AI detects, Human Admin decides, system verifies.",
      steward: "Detect risks and produce advisory-only evidence. No automatic delete, unpublish, ban, or approve.",
      humanAdmin: stewardPatrolPolicy.humanAdminResponsibilities,
      system: stewardPatrolPolicy.systemResponsibilities,
    },
    proposedActionDefinitions,
    dailyOpsChecklist,
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
      feedbackByActorType,
      eventsByActorType,
      agentFeedback: feedback.filter((item) => item.actorType === "agent").length,
      humanReports: feedback.filter(
        (item) =>
          item.actorType === "human" &&
          (stewardPatrolPolicy.humanEscalationRatings as readonly string[]).includes(item.rating),
      ).length,
      eventTypes: unique(events.map((event) => event.type)),
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
      rationale:
        "P0の目的は人間向けadvisory report artifactを残すこと。巡回そのものをDBへ自動記録すると、daily dry-runや並行検証でノイズが増えるため、package.json統合時にSession Eで必要性を再判断する。",
      suggestedEventType: "steward_daily_patrol_reported",
    },
    coverageGaps: [
      "This report samples local DB rows only.",
      "It does not inspect rendered screenshots or remote production state.",
      "It does not execute destructive cleanup.",
      "It does not write RunEvent records in P0.",
      ...(agentDiversitySummary.status === "available"
        ? []
        : ["Agent diversity summary could not be loaded from local registry/data snapshots."]),
    ],
    hardRules,
    nextReviewHint:
      findings.length > 0
        ? "Start with high-severity findings, then check whether missing/broken source artifacts are pipeline gaps or legacy rows."
        : "Run again after the next generation batch to compare new validation and interaction signals.",
  };

  if (shouldWrite) {
    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return {
    report,
    outPath,
    wroteFile: shouldWrite,
    skippedExisting: existing && !options.force && !options.dryRun,
  };
}

async function main() {
  const result = await generateGovernanceReport(parseArgs());
  const relativePath = path.relative(process.cwd(), result.outPath);

  if (result.wroteFile) {
    console.log(`Governance report written: ${relativePath}`);
  } else if (result.skippedExisting) {
    console.log(`Governance report already exists: ${relativePath}`);
  } else {
    console.log(`Dry run: governance report was not written. Candidate path: ${relativePath}`);
  }
  console.log(`Status: ${String(result.report.overallStatus)}`);
  console.log(`Findings: ${Array.isArray(result.report.findings) ? result.report.findings.length : 0}`);

  if (!result.wroteFile) {
    console.log(JSON.stringify(result.report, null, 2));
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/generate-governance-report.ts")) {
  main()
    .then(async () => {
      await disconnectGovernanceReportDb();
    })
    .catch(async (error) => {
      console.error(error);
      await disconnectGovernanceReportDb();
      process.exit(1);
    });
}
