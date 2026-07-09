import Link from "next/link";
import { notFound } from "next/navigation";
import { readStoredArtifactPath } from "@/lib/artifact-store";
import { prisma } from "@/lib/db";
import { formatDateTimeJst } from "@/lib/format-datetime";
import { activeProjectWhere } from "@/lib/project-visibility";
import { ProductConsoleTabs } from "../../projects/[id]/product-console-tabs";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import styles from "../../agents/admin-agents.module.css";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

const PIPELINE_STEPS = [
  "requirements",
  "builder",
  "reviewer",
  "rewriter",
  "publisher",
  "research",
  "concept",
  "combination",
  "agent-router",
] as const;

const stepDirFromResponsePath = (responsePath: string): string | null => {
  const match = responsePath.replace(/\\/g, "/").match(/^(.*)\/response\.json$/);
  return match ? match[1] : null;
};

const formatJson = (raw: string | null): string => {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const formatMetadata = (raw: string | null): string => {
  if (!raw) return "(metadataなし)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const parseJsonRecord = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const formatListValue = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join(", ")
    : typeof value === "string"
      ? value
      : "";

const formatToolPolicySummary = (value: string | null) => {
  const policy = parseJsonRecord(value);
  if (!policy) return "未記録";

  const allowed = formatListValue(policy.allowedTools);
  const blocked = formatListValue(policy.blockedTools);
  const publishGate =
    typeof policy.publishGate === "string" ? policy.publishGate : undefined;

  return [
    typeof policy.input === "string" ? `入力: ${policy.input}` : null,
    typeof policy.network === "string" ? `ネットワーク: ${policy.network}` : null,
    typeof policy.write === "string" ? `書き込み: ${policy.write}` : null,
    typeof policy.publish === "string" ? `公開: ${policy.publish}` : null,
    allowed ? `tools: ${allowed}` : null,
    blocked ? `blocked: ${blocked}` : null,
    publishGate ? `gate: ${publishGate}` : null,
  ]
    .filter(Boolean)
    .join(" / ") || "記録あり";
};

const formatCostSummary = (value: string | null) => {
  const cost = parseJsonRecord(value);
  if (!cost) return "未記録";

  return [
    typeof cost.model === "string" ? `model: ${cost.model}` : null,
    typeof cost.planner === "string" ? `planner: ${cost.planner}` : null,
    cost.modelCalls === undefined ? null : `呼び出し: ${String(cost.modelCalls)}`,
    cost.estimatedTokens === undefined ? null : `推定tokens: ${String(cost.estimatedTokens)}`,
    cost.estimatedUsd === undefined ? null : `推定USD: ${String(cost.estimatedUsd)}`,
    cost.estimatedCostUsd === undefined
      ? null
      : `推定コストUSD: ${String(cost.estimatedCostUsd)}`,
  ]
    .filter(Boolean)
    .join(" / ") || "記録あり";
};

const runStatusLabel = (value: string) => {
  switch (value) {
    case "completed":
      return "完了";
    case "running":
      return "実行中";
    case "failed":
      return "失敗";
    default:
      return value;
  }
};

const runStatusClass = (value: string) => {
  if (value === "completed") return styles.opsChipOk;
  if (value === "running") return styles.opsChipWarning;
  if (value === "failed") return styles.opsChipCritical;
  return styles.opsChipNeutral;
};

type PublisherDecisionResponse = {
  status?: string;
  reason?: string;
  requiredArtifactsPresent?: boolean;
  reviewPass?: boolean;
  validationPass?: boolean;
  mvpContractPass?: boolean;
  safetyBlockers?: string[];
  publishSummary?: string;
};

type PublishReadinessReport = {
  result?: string;
  blockers?: string[];
  warnings?: string[];
  validationStatus?: string;
  mvpResult?: string;
  mvpContractV2Result?: string;
  interactionProofResult?: string;
  renderProofResult?: string;
  evidencePaths?: Record<string, string>;
};

const parsePublisherDecisionResponse = (value: string | null): PublisherDecisionResponse | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as PublisherDecisionResponse;
  } catch {
    return null;
  }
};

const parsePublishReadinessReport = (value: string | null): PublishReadinessReport | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as PublishReadinessReport;
  } catch {
    return null;
  }
};

const labelForDecision = (value: string | null | undefined) => {
  switch (value) {
    case "publish":
    case "published":
    case "auto_published":
      return "公開";
    case "revise":
    case "draft":
      return "要修正";
    case "block":
    case "failed":
      return "ブロック";
    default:
      return value ?? "未記録";
  }
};

const decisionClass = (value: string | null | undefined) => {
  switch (value) {
    case "publish":
    case "published":
    case "auto_published":
      return styles.opsChipOk;
    case "revise":
    case "draft":
    case "pending":
      return styles.opsChipWarning;
    case "block":
    case "failed":
      return styles.opsChipCritical;
    default:
      return styles.opsChipNeutral;
  }
};

const labelForBoolean = (value: boolean | undefined) => {
  if (value === true) return "通過";
  if (value === false) return "未通過";
  return "未記録";
};

const labelForValidation = (value: string | null | undefined) => {
  switch (value) {
    case "pass":
      return "通過";
    case "fail":
      return "未通過";
    case "not_recorded":
      return "未記録";
    default:
      return value ?? "未記録";
  }
};

const checkStatusClass = (value: string | null | undefined) => {
  switch (value) {
    case "pass":
    case "passed":
    case "success":
    case "ok":
      return styles.opsChipOk;
    case "fail":
    case "failed":
    case "error":
    case "blocked":
      return styles.opsChipCritical;
    case "warn":
    case "warning":
    case "pending":
    case "not_recorded":
      return styles.opsChipWarning;
    default:
      return styles.opsChipNeutral;
  }
};

const readinessCheckKeywords = [
  "mvp_contract_v2",
  "mvp-contract-v2",
  "mvp contract v2",
  "interaction_proof",
  "interaction-proof",
  "render_verification",
  "render-verification",
  "publish_readiness",
  "publish-readiness",
  "publisher",
];

const isReadinessCheckKey = (key: string) => {
  const normalized = key.toLowerCase();
  return readinessCheckKeywords.some((keyword) => normalized.includes(keyword));
};

export default async function AdminRunDetail({ params }: PageProps) {
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      artifacts: { orderBy: [{ type: "asc" }, { path: "asc" }] },
      projects: {
        where: activeProjectWhere,
        include: {
          agent: true,
          category: true,
          validations: {
            include: { checks: { orderBy: { key: "asc" } } },
            orderBy: { checkedAt: "desc" },
            take: 1,
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!run) {
    notFound();
  }

  const ownerLabel =
    run.humanOwnerName ?? run.humanOwnerId ?? run.humanOwnerType ?? "未記録";
  const sourceInteractionLabel = run.sourceInteractionType ?? "未記録";
  const sandboxLabel = run.sandboxMode ?? "未記録";
  const toolPolicySummary = formatToolPolicySummary(run.toolPolicyJson);
  const costSummary = formatCostSummary(run.costSummaryJson);
  const activeProjectIds = new Set(run.projects.map((project) => project.id));
  const visibleRunEvents = run.events.filter((event) => !event.projectId || activeProjectIds.has(event.projectId));
  const visibleRunArtifacts = run.artifacts.filter((artifact) => !artifact.projectId || activeProjectIds.has(artifact.projectId));
  const primaryProject = run.projects[0];
  const publicProject = run.projects.find((project) =>
    ["published", "auto_published"].includes(project.status),
  );
  const latestEvent = visibleRunEvents.at(-1);
  const failedChecks = run.projects.flatMap((project) =>
    (project.validations[0]?.checks ?? [])
      .filter((check) => check.status === "fail")
      .map((check) => ({ ...check, projectTitle: project.title })),
  );

  const responseArtifacts = visibleRunArtifacts.filter(
    (artifact) =>
      (artifact.type === "llm_response" || artifact.type === "llm_prompt") &&
      stepDirFromResponsePath(artifact.path),
  );
  const stepDirs = Array.from(
    new Set(
      responseArtifacts
        .map((artifact) => stepDirFromResponsePath(artifact.path))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const orderedStepDirs = stepDirs.sort((a, b) => {
    const ai = PIPELINE_STEPS.findIndex((step) => a.endsWith(`/${step}`));
    const bi = PIPELINE_STEPS.findIndex((step) => b.endsWith(`/${step}`));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const pipelineSteps = await Promise.all(
    orderedStepDirs.map(async (dir) => {
      const stepName = dir.split("/").pop() ?? dir;
      const [prompt, input, response, handoff] = await Promise.all([
        readStoredArtifactPath(`${dir}/prompt.md`),
        readStoredArtifactPath(`${dir}/input.json`),
        readStoredArtifactPath(`${dir}/response.json`),
        readStoredArtifactPath(`${dir}/handoff.md`),
      ]);
      return { stepName, dir, prompt, input, response, handoff };
    }),
  );
  const publisherResponses = pipelineSteps
    .filter((step) => step.stepName === "publisher")
    .map((step) => ({
      dir: step.dir,
      response: parsePublisherDecisionResponse(step.response),
      raw: step.response,
    }));
  const publishReadinessArtifacts = visibleRunArtifacts.filter((artifact) =>
    artifact.path.replaceAll("\\", "/").endsWith("/publish-readiness.json"),
  );
  const publishReadinessReports = await Promise.all(
    publishReadinessArtifacts.map(async (artifact) => {
      const raw = await readStoredArtifactPath(artifact.path);
      return {
        id: artifact.id,
        path: artifact.path,
        projectId: artifact.projectId,
        report: parsePublishReadinessReport(raw),
        raw,
      };
    }),
  );
  const autoPublishBlockedEvents = visibleRunEvents
    .filter((event) => event.type === "auto_publish_blocked")
    .map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      summary: event.summary,
      metadata: parseJsonRecord(event.metadataJson),
    }));

  const validationChecks = run.projects.flatMap((project) =>
    (project.validations[0]?.checks ?? []).map((check) => ({
      ...check,
      projectTitle: project.title,
    })),
  );
  const readinessChecks = validationChecks.filter((check) => isReadinessCheckKey(check.key));
  const hiddenReadinessCheckCount = Math.max(readinessChecks.length - 12, 0);
  const publisherDecisionRows = run.projects.map((project) => {
    const validation = project.validations[0];
    return {
      id: project.id,
      title: project.title,
      decision: project.publishDecision,
      reason: project.publishDecisionReason ?? "公開判断の理由はまだ記録されていません。",
      validationStatus: project.validationStatus ?? validation?.status ?? "not_recorded",
    };
  });

  return (
    <main className={styles.page}>
      <AppHeader />
      <div className={styles.shell}>
        <div className={styles.returnLinks} aria-label="戻る">
          <Link className={styles.back} href="/human?view=runs">
            ← Run一覧へ戻る
          </Link>
          {primaryProject ? (
            <Link className={styles.back} href={`/human/projects/${primaryProject.id}`}>
              ← プロダクト管理へ戻る
            </Link>
          ) : null}
        </div>

        <section className={styles.hero}>
          <div>
            <p className={styles.kicker}>Run Detail Log</p>
            <h1>{run.summary ?? run.id}</h1>
            <p>
              Run evidence board. 1つの生成Runについて、公開判断に必要な内部情報と調査用の詳細証跡を確認します。
              通常確認では要約と公開判断を見て、prompt、input、response、metadataJsonは必要なときだけ展開します。
            </p>
            <div className={styles.badgeLine}>
              <span className={`${styles.opsChip} ${runStatusClass(run.status)}`}>{runStatusLabel(run.status)}</span>
              <span className={styles.badge}>{run.triggerType}</span>
              <span className={styles.badge}>{run.autonomyLevel}</span>
              {run.errorMessage || failedChecks.length > 0 ? (
                <span className={styles.disabled}>要確認 {failedChecks.length}</span>
              ) : (
                <span className={styles.enabled}>重大なblockerなし</span>
              )}
            </div>
          </div>
          <aside className={styles.side}>
            <dl>
              <div>
                <dt>Run ID</dt>
                <dd>{run.id}</dd>
              </div>
              <div>
                <dt>実行者</dt>
                <dd>
                  {run.actorType} / {run.actorName ?? run.actorId ?? "未記録"}
                </dd>
              </div>
              <div>
                <dt>開始</dt>
                <dd>{formatDateTimeJst(run.startedAt)}</dd>
              </div>
              <div>
                <dt>完了</dt>
                <dd>{formatDateTimeJst(run.completedAt)}</dd>
              </div>
            </dl>
          </aside>
        </section>

        <nav className={styles.relatedLinkBar} aria-label="Run関連ページ">
          {publicProject ? (
            <Link href={`/projects/${publicProject.id}?tab=production-memo`}>公開投稿ログ</Link>
          ) : (
            <span className={styles.rowMeta}>公開ページなし</span>
          )}
          {primaryProject ? <Link href={`/human/projects/${primaryProject.id}`}>プロダクト管理</Link> : null}
          <Link href="/human?view=runs">Run一覧</Link>
          <Link href="/human">運用コンソール</Link>
        </nav>

        <section className={styles.summaryGrid} aria-label="Runサマリー">
          <div>
            <span>生成</span>
            <strong>{run.projects.length}</strong>
          </div>
          <div>
            <span>公開</span>
            <strong>{run.publishedProjectCount}</strong>
          </div>
          <div>
            <span>失敗</span>
            <strong>{run.failedProjectCount}</strong>
          </div>
          <div>
            <span>証跡</span>
            <strong>
              {visibleRunEvents.length} / {visibleRunArtifacts.length}
            </strong>
          </div>
        </section>

        <div className={styles.productConsoleGrid}>
          <div className={styles.productConsoleMain}>
            <ProductConsoleTabs
              tabs={[
                {
                  key: "summary",
                  label: "要約",
                  content: (
                    <div className={styles.productTabContent}>
                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Run Summary</p>
                            <h2>このRunの現在地</h2>
                          </div>
                          <span className={`${styles.opsChip} ${runStatusClass(run.status)}`}>{runStatusLabel(run.status)}</span>
                        </div>
                        <p className={styles.productLead}>
                          Current run state. 現在のstatusは <strong>{runStatusLabel(run.status)}</strong>、生成されたプロダクトは{" "}
                          <strong>{run.generatedProjectCount}</strong> 件、公開済みは{" "}
                          <strong>{run.publishedProjectCount}</strong> 件です。
                          {run.errorMessage ? ` エラー: ${run.errorMessage}` : " 公開判断に必要な要約だけを優先して表示しています。"}
                        </p>
                      </section>

                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Publish Decisions</p>
                            <h2>生成プロダクトと公開状態</h2>
                          </div>
                          <span className={styles.badge}>{publisherDecisionRows.length}件</span>
                        </div>
                        <div className={styles.consoleRows}>
                          {publisherDecisionRows.length === 0 ? (
                            <p className={styles.help}>このRunには公開判断がまだ記録されていません。</p>
                          ) : (
                            publisherDecisionRows.map((row) => (
                              <article className={styles.consoleRow} key={row.id}>
                                <span className={`${styles.opsChip} ${decisionClass(row.decision)}`}>
                                  {labelForDecision(row.decision)}
                                </span>
                                <div>
                                  <strong>
                                    <Link href={`/human/projects/${row.id}`}>{row.title}</Link>
                                  </strong>
                                  <small>{row.reason}</small>
                                </div>
                                <span className={styles.rowMeta}>{labelForValidation(row.validationStatus)}</span>
                              </article>
                            ))
                          )}
                        </div>
                      </section>

                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Quality Evidence</p>
                            <h2>公開前チェック</h2>
                          </div>
                          <span className={styles.badge}>{readinessChecks.length}件</span>
                        </div>
                        <p className={styles.help}>
                          Readiness checks. 細かいValidationCheckをすべて読むのではなく、公開可否に関係するreadiness系の項目を優先して表示します。
                        </p>
                        <div className={styles.consoleRows}>
                          {readinessChecks.length === 0 ? (
                            <p className={styles.help}>
                              MVP Contract、render、publisher系のValidationCheckはまだ記録されていません。
                            </p>
                          ) : (
                            readinessChecks.slice(0, 12).map((check) => (
                              <article className={styles.consoleRow} key={check.id}>
                                <span className={`${styles.opsChip} ${checkStatusClass(check.status)}`}>{check.status}</span>
                                <div>
                                  <strong>
                                    <Link href={`/human/projects/${check.projectId}`}>{check.projectTitle}</Link>
                                  </strong>
                                  <small>{check.key}</small>
                                  <small>{check.summary ?? "summaryなし"}</small>
                                </div>
                                <span className={styles.rowMeta}>{check.actorName ?? check.actorType}</span>
                              </article>
                            ))
                          )}
                        </div>
                        {hiddenReadinessCheckCount > 0 ? (
                          <p className={styles.help}>追加の{hiddenReadinessCheckCount}件は「詳細証跡」タブで確認できます。</p>
                        ) : null}
                      </section>

                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Publish Readiness</p>
                            <h2>自動公開ゲートの最終判定</h2>
                          </div>
                          <span className={styles.badge}>{publishReadinessReports.length}件</span>
                        </div>
                        <p className={styles.help}>
                          Gate result. publish-readiness.json と auto_publish_blocked をもとに、自動公開を通した理由または止めた理由を表示します。
                        </p>
                        <div className={styles.consoleRows}>
                          {publishReadinessReports.length === 0 && autoPublishBlockedEvents.length === 0 ? (
                            <p className={styles.help}>publish readiness の記録はまだありません。</p>
                          ) : (
                            <>
                              {publishReadinessReports.map((item) => {
                                const report = item.report;
                                const blockers = report?.blockers ?? [];
                                const warnings = report?.warnings ?? [];
                                return (
                                  <article className={styles.consoleRow} key={item.id}>
                                    <span className={`${styles.opsChip} ${checkStatusClass(report?.result)}`}>
                                      {report?.result ?? "未記録"}
                                    </span>
                                    <div>
                                      <strong>
                                        validation {report?.validationStatus ?? "未記録"} / interaction{" "}
                                        {report?.interactionProofResult ?? "未記録"} / render{" "}
                                        {report?.renderProofResult ?? "未記録"}
                                      </strong>
                                      <small>{item.path}</small>
                                      {blockers.length > 0 ? <small>blocker: {blockers.slice(0, 4).join(" / ")}</small> : null}
                                      {warnings.length > 0 ? <small>warning: {warnings.slice(0, 4).join(" / ")}</small> : null}
                                    </div>
                                    <span className={styles.rowMeta}>{blockers.length === 0 ? "公開可" : "停止"}</span>
                                  </article>
                                );
                              })}
                              {autoPublishBlockedEvents.map((event) => {
                                const blockers = Array.isArray(event.metadata?.blockers)
                                  ? event.metadata.blockers.filter((item): item is string => typeof item === "string")
                                  : [];
                                return (
                                  <article className={styles.consoleRow} key={event.id}>
                                    <span className={`${styles.opsChip} ${styles.opsChipCritical}`}>blocked</span>
                                    <div>
                                      <strong>{event.summary ?? "自動公開が停止されました"}</strong>
                                      <small>{formatDateTimeJst(event.createdAt)}</small>
                                      {blockers.length > 0 ? <small>blocker: {blockers.slice(0, 4).join(" / ")}</small> : null}
                                    </div>
                                    <span className={styles.rowMeta}>RunEvent</span>
                                  </article>
                                );
                              })}
                            </>
                          )}
                        </div>
                      </section>
                    </div>
                  ),
                },
                {
                  key: "evidence",
                  label: "詳細証跡 / Raw",
                  content: (
                    <div className={styles.productTabContent}>
                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Debug Boundary</p>
                            <h2>raw情報はこのタブで必要時だけ確認します</h2>
                          </div>
                          <span className={styles.badge}>調査用</span>
                        </div>
                        <p className={styles.help}>
                          Raw details. 通常運用では「要約」タブの公開判断、品質証跡、readinessだけを確認します。
                          prompt、input、response、metadataJson、artifact pathは原因調査や再現確認が必要な場合だけ開きます。
                        </p>
                      </section>
                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Publisher Response</p>
                            <h2>保存された公開判断</h2>
                          </div>
                          <span className={styles.badge}>{publisherResponses.length}件</span>
                        </div>
                        <div className={styles.consoleRows}>
                          {publisherResponses.length === 0 ? (
                            <p className={styles.help}>publisher/response.jsonはこのRunに保存されていません。</p>
                          ) : (
                            publisherResponses.map((item) => (
                              <article className={styles.consoleRow} key={item.dir}>
                                <span className={`${styles.opsChip} ${decisionClass(item.response?.status)}`}>
                                  {labelForDecision(item.response?.status)}
                                </span>
                                <div>
                                  <strong>{item.response?.publishSummary ?? "公開判断"}</strong>
                                  <small>{item.response?.reason ?? "理由フィールドがありません。"}</small>
                                  <small>{item.dir}/response.json</small>
                                </div>
                                <span className={styles.rowMeta}>{labelForBoolean(item.response?.validationPass)}</span>
                              </article>
                            ))
                          )}
                        </div>
                        {publisherResponses.map((item) => (
                          <details className={styles.detailBlock} key={`${item.dir}-json`}>
                            <summary>{item.dir}/response.jsonを表示</summary>
                            <pre className={styles.codeBlock}>
                              <code>{formatMetadata(item.raw)}</code>
                            </pre>
                          </details>
                        ))}
                      </section>

                      <section className={styles.sectionPanel} id="events">
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Run Events</p>
                            <h2>イベント履歴</h2>
                          </div>
                          <span className={styles.badge}>{visibleRunEvents.length}件</span>
                        </div>
                        <div className={styles.consoleRows}>
                          {visibleRunEvents.length === 0 ? (
                            <p className={styles.help}>RunEventは記録されていません。</p>
                          ) : (
                            visibleRunEvents.map((event) => (
                              <article className={styles.consoleRow} key={event.id}>
                                <span className={styles.badge}>{event.type}</span>
                                <div>
                                  <strong>{event.summary}</strong>
                                  <small>
                                    {event.actorType}
                                    {event.actorName ? ` / ${event.actorName}` : ""} / {formatDateTimeJst(event.createdAt)}
                                  </small>
                                </div>
                                <span className={styles.rowMeta}>{event.projectId ?? "run"}</span>
                              </article>
                            ))
                          )}
                        </div>
                        {visibleRunEvents.length > 0 ? (
                          <details className={styles.detailBlock}>
                            <summary>metadataJson全件を表示</summary>
                            <pre className={styles.codeBlock}>
                              <code>
                                {visibleRunEvents
                                  .map((event) => `${event.type} / ${formatDateTimeJst(event.createdAt)}\n${formatMetadata(event.metadataJson)}`)
                                  .join("\n\n---\n\n")}
                              </code>
                            </pre>
                          </details>
                        ) : null}
                      </section>

                      <section className={styles.sectionPanel} id="pipeline">
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>LLM Pipeline</p>
                            <h2>prompt / input / response</h2>
                          </div>
                          <span className={styles.badge}>{pipelineSteps.length} steps</span>
                        </div>
                        <p className={styles.help}>
                          Pipeline evidence. prompt、input、response、handoffは調査用の証跡です。通常確認では閉じたままで問題ありません。
                        </p>
                        {pipelineSteps.length === 0 ? (
                          <p className={styles.help}>このRunにはstep単位の証跡が保存されていません。</p>
                        ) : (
                          pipelineSteps.map((step) => (
                            <details className={styles.detailBlock} key={step.dir}>
                              <summary>
                                {step.stepName} / {step.dir}
                              </summary>
                              <div className={styles.previewStack}>
                                {step.prompt ? (
                                  <div>
                                    <strong>prompt.md</strong>
                                    <pre className={styles.codeBlock}>
                                      <code>{step.prompt}</code>
                                    </pre>
                                  </div>
                                ) : null}
                                {step.input ? (
                                  <div>
                                    <strong>input.json</strong>
                                    <pre className={styles.codeBlock}>
                                      <code>{formatJson(step.input)}</code>
                                    </pre>
                                  </div>
                                ) : null}
                                {step.response ? (
                                  <div>
                                    <strong>response.json</strong>
                                    <pre className={styles.codeBlock}>
                                      <code>{formatJson(step.response)}</code>
                                    </pre>
                                  </div>
                                ) : null}
                                {step.handoff ? (
                                  <div>
                                    <strong>handoff.md</strong>
                                    <pre className={styles.codeBlock}>
                                      <code>{step.handoff}</code>
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            </details>
                          ))
                        )}
                      </section>
                    </div>
                  ),
                },
              ]}
            />
          </div>

          <aside className={styles.productConsoleAside}>
            <section className={styles.sectionPanel}>
              <div className={styles.toolbar}>
                <div>
                  <p className={styles.kicker}>Run Metadata</p>
                  <h2>実行条件</h2>
                </div>
                <span className={`${styles.opsChip} ${runStatusClass(run.status)}`}>{runStatusLabel(run.status)}</span>
              </div>
              <dl className={styles.productMetaList}>
                <div>
                  <dt>起動種別</dt>
                  <dd>{run.triggerType}</dd>
                </div>
                <div>
                  <dt>自律度</dt>
                  <dd>{run.autonomyLevel}</dd>
                </div>
                <div>
                  <dt>入口</dt>
                  <dd>{sourceInteractionLabel}</dd>
                </div>
                <div>
                  <dt>責任者</dt>
                  <dd>{ownerLabel}</dd>
                </div>
                <div>
                  <dt>実行環境</dt>
                  <dd>{sandboxLabel}</dd>
                </div>
                <div>
                  <dt>ツール方針</dt>
                  <dd>{toolPolicySummary}</dd>
                </div>
                <div>
                  <dt>コスト</dt>
                  <dd>{costSummary}</dd>
                </div>
                <div>
                  <dt>選定Theme</dt>
                  <dd>{run.selectedThemeId ?? "未選定"}</dd>
                </div>
                <div>
                  <dt>最新イベント</dt>
                  <dd>{latestEvent ? `${latestEvent.type}: ${latestEvent.summary}` : "未記録"}</dd>
                </div>
              </dl>
            </section>

            <section className={styles.sectionPanel}>
              <p className={styles.kicker}>Related Evidence</p>
              <h2>詳細確認への導線</h2>
              <div className={styles.consoleRows}>
                <article className={styles.consoleRow}>
                  <span className={styles.badge}>Public</span>
                  <div>
                    <strong>{publicProject ? "公開投稿ログ" : "公開投稿ログなし"}</strong>
                    <small>
                      {publicProject
                        ? "ユーザーに見える投稿ログと制作証跡を確認します。"
                        : "このRunには現在公開中の代表プロダクトがないため、公開ページへのリンクは出していません。"}
                    </small>
                  </div>
                  {publicProject ? (
                    <Link href={`/projects/${publicProject.id}?tab=production-memo`}>開く</Link>
                  ) : (
                    <span className={styles.rowMeta}>非公開</span>
                  )}
                </article>
                {primaryProject ? (
                  <article className={styles.consoleRow}>
                    <span className={styles.badge}>Product</span>
                    <div>
                      <strong>プロダクト管理</strong>
                      <small>このRunで生成された代表プロダクトの内部情報を確認します。</small>
                    </div>
                    <Link href={`/human/projects/${primaryProject.id}`}>開く</Link>
                  </article>
                ) : null}
                <article className={styles.consoleRow}>
                  <span className={styles.badge}>Artifacts</span>
                  <div>
                    <strong>保存物</strong>
                    <small>Artifact storeに残っているpathと種類を確認します。</small>
                  </div>
                  <span className={styles.rowMeta}>{visibleRunArtifacts.length}件</span>
                </article>
              </div>
              <details className={styles.detailBlock}>
                <summary>Artifact path一覧を表示</summary>
                <pre className={styles.codeBlock}>
                  <code>
                    {visibleRunArtifacts.length > 0
                      ? visibleRunArtifacts
                          .map((artifact) => `${artifact.type} / ${artifact.projectId ?? "run direct"}\n${artifact.path}`)
                          .join("\n\n")
                      : "Artifactはまだ記録されていません。"}
                  </code>
                </pre>
              </details>
            </section>
          </aside>
        </div>
      </div>
      <AppFooter />
    </main>
  );
}
