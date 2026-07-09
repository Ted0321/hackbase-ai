import Link from "next/link";
import { notFound } from "next/navigation";
import { AGENT_CADENCES, AGENT_STATUSES, activationChecklist } from "@/lib/admin-agent-registry";
import { adminWriteKeyConfigured, adminWriteRequiresKey, consoleReadOnly } from "@/lib/admin-auth";
import { ConsoleReadOnlyNotice } from "../../console-readonly-note";
import { buildAgentPublicTags } from "@/lib/agent-public-tags";
import { readAdminAgentWithContract } from "@/lib/agent-operating-contract-store";
import { decideAgentDue, runStamp } from "@/lib/agent-due-decision";
import { prisma } from "@/lib/db";
import { formatDateTimeJst, formatShortDateTimeJst } from "@/lib/format-datetime";
import { activeProjectWhere } from "@/lib/project-visibility";
import { readSchedulerStateRecord } from "@/lib/scheduler-state";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import { activateAgentAction, syncAgentToDbAction, updateAgentSettingsAction } from "../actions";
import styles from "../admin-agents.module.css";
import { AgentConsoleTabs } from "./agent-console-tabs";
import { SettingsPreview } from "./settings/settings-preview";
import { readAgentMemoryDigestFromDb } from "../../../../../scripts/agent-memory-digest";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    tab?: string;
    saved?: string;
    created?: string;
    synced?: string;
    activated?: string;
  }>;
};

type AgentRunState = {
  lastCompletedAt?: string | null;
  lastStartedAt?: string | null;
  lastSkippedAt?: string | null;
  nextDueAt?: string | null;
  runsToday?: number;
  lastRunId?: string | null;
  lastStatus?: "completed" | "failed" | "skipped" | null;
  lastError?: string | null;
  lastSkipReason?: string | null;
};

type AgentDueSchedulerState = {
  version?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  lastCompletedAt?: string | null;
  nextDueAt?: string | null;
  agents?: Record<string, AgentRunState>;
};

const TABS = ["overview", "settings", "generation", "reactions", "audit"] as const;

type AgentTab = (typeof TABS)[number];

const tabLabels: Record<AgentTab, string> = {
  overview: "概要",
  settings: "設定",
  generation: "生成ログ",
  reactions: "反応ログ",
  audit: "監査ログ",
};

const categoryLabels: Record<string, string> = {
  cat_research: "Research",
  cat_automation: "Automation",
  cat_learning: "Learning",
  cat_ideation: "Ideation",
  cat_operations: "Operations",
  cat_decision: "Decision",
  cat_scoring: "Scoring",
  cat_summary: "Summary",
  cat_writing: "Writing",
  cat_creative: "Creative",
  cat_utility: "Utility",
};

const isTab = (value?: string): value is AgentTab => TABS.includes(value as AgentTab);

const displayValue = (value?: string | null) => (value?.trim() ? value : "未設定");

const displayList = (items?: string[]) => (items && items.length > 0 ? items.join(" / ") : "未設定");

const hoursValue = (hours?: number[]) => (hours ?? []).join(", ");

const statusClass = (status?: string | null) => {
  if (status === "completed" || status === "success" || status === "pass" || status === "active") return styles.enabled;
  if (status === "failed" || status === "error" || status === "blocked") return styles.disabled;
  if (status === "draft") return styles.draft;
  return styles.badge;
};

type GenerationProjectForSort = {
  createdAt: Date;
  publishedAt?: Date | null;
  publishDecision?: string | null;
  status: string;
  validationStatus?: string | null;
  validations: Array<{
    buildStatus?: string | null;
    riskStatus?: string | null;
    runStatus?: string | null;
    status?: string | null;
  }>;
};

const generationPriority = (project: GenerationProjectForSort) => {
  const values = [
    project.status,
    project.validationStatus,
    project.publishDecision,
    project.validations[0]?.status,
    project.validations[0]?.riskStatus,
    project.validations[0]?.buildStatus,
    project.validations[0]?.runStatus,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (values.some((value) => ["failed", "error", "blocked", "fail"].includes(value))) return 0;
  if (values.some((value) => value.includes("hold") || value.includes("review") || value.includes("warn"))) return 1;
  if (!project.publishedAt || values.some((value) => value.includes("draft") || value.includes("pending"))) return 2;
  return 3;
};

const generationPriorityLabel = (priority: number) => {
  if (priority === 0) return "要確認";
  if (priority === 1) return "レビュー";
  if (priority === 2) return "未公開";
  return "正常";
};

const isLowValueReaction = (type?: string | null) => Boolean(type?.includes("like") || type === "want_to_grow");

const reactionPriority = (type?: string | null) => {
  if (!type) return 99;
  if (type.includes("risk")) return 0;
  if (type.includes("critique")) return 1;
  if (type.includes("remix")) return 2;
  if (type.includes("compare")) return 3;
  if (isLowValueReaction(type)) return 4;
  return 5;
};

const reactionStatusClass = (type?: string | null) => {
  if (type?.includes("risk")) return styles.disabled;
  if (type?.includes("critique")) return styles.draft;
  if (isLowValueReaction(type)) return styles.subtleBadge;
  return styles.badge;
};

const feedbackLabel = (rating: string, actorType: string) => {
  if (rating === "agent_like") return "Agent Like";
  if (rating === "like") return actorType === "agent" ? "Agent Like" : "Like";
  if (rating === "want_to_grow") return "Want to grow";
  if (rating === "agent_critique") return "Agent Critique";
  if (rating === "agent_remix_suggestion") return "Remix";
  if (rating === "agent_compare_note") return "Compare";
  if (rating === "agent_risk_flag") return "Risk";
  return rating.replaceAll("_", " ");
};

const eventLabel = (type: string) => {
  if (type === "agent_like") return "Agent Like";
  if (type === "agent_critique") return "Agent Critique";
  if (type === "agent_remix_suggestion") return "Remix";
  if (type === "agent_compare_note") return "Compare";
  if (type === "agent_risk_flag") return "Risk";
  return type.replaceAll("_", " ");
};

const readAuditTrail = async (agentId: string) => {
  try {
    const [decisions, activities] = await Promise.all([
      prisma.adminDecision.findMany({
        where: { agentId },
        orderBy: { decidedAt: "desc" },
        take: 10,
      }),
      prisma.userActivityLog.findMany({
        where: { targetType: "agent", targetId: agentId },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
    return { decisions, activities };
  } catch {
    return { decisions: [], activities: [] };
  }
};

const AdminWriteFields = () => (
  <>
    <label className={styles.label}>
      adminName
      <input name="adminName" defaultValue="Local Admin" />
    </label>
    <label className={styles.label}>
      adminWriteKey
      <input
        name="adminWriteKey"
        type="password"
        placeholder={adminWriteKeyConfigured() ? "required" : adminWriteRequiresKey() ? "required in this env" : "local dev bypass"}
      />
    </label>
    <p className={`${styles.help} ${styles.adminGuardNote}`}>
      本番ではPRODIA_ADMIN_WRITE_KEYが必要です。ローカルでは未設定時のみ空欄で保存できます。
    </p>
  </>
);

const Empty = ({ children }: { children: React.ReactNode }) => <p className={styles.help}>{children}</p>;

export default async function AdminAgentConsole({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query: Awaited<NonNullable<PageProps["searchParams"]>> = searchParams ? await searchParams : {};
  const activeTab: AgentTab = isTab(query.tab) ? query.tab : "overview";

  const [contractAgent, schedulerState, dbAgent, auditTrail] = await Promise.all([
    readAdminAgentWithContract(prisma, id),
    readSchedulerStateRecord<AgentDueSchedulerState>(prisma, "agent-creation-daily"),
    prisma.agent.findUnique({
      where: { id },
      include: {
        primaryCategory: true,
        secondaryCategory: true,
        _count: { select: { projects: { where: activeProjectWhere } } },
        projects: {
          where: activeProjectWhere,
          include: {
            category: true,
            theme: true,
            run: true,
            validations: { orderBy: { checkedAt: "desc" }, take: 1 },
            artifacts: { orderBy: { createdAt: "desc" }, take: 4 },
            validationChecks: { orderBy: { createdAt: "desc" }, take: 4 },
          },
          orderBy: { createdAt: "desc" },
          take: 12,
        },
      },
    }),
    readAuditTrail(id),
  ]);

  if (!contractAgent && !dbAgent) {
    notFound();
  }

  const displayName = contractAgent?.displayName ?? dbAgent?.name ?? id;
  const agentId = contractAgent?.agentId ?? dbAgent?.id ?? id;
  const publicTags = buildAgentPublicTags({
    profile: contractAgent,
    max: 6,
    maxArtifacts: 3,
    maxSpecialties: 3,
  });
  const oneLiner = contractAgent?.oneLiner ?? dbAgent?.oneLiner ?? "説明は未設定です。";
  const policy = contractAgent?.schedulingPolicy ?? {};
  const interactionPolicy = contractAgent?.interactionPolicy ?? {};
  const dueState = schedulerState?.agents?.[agentId];
  const contractSource =
    contractAgent && "contractSource" in contractAgent && typeof contractAgent.contractSource === "string"
      ? contractAgent.contractSource
      : contractAgent
        ? "registry"
        : "missing";
  const memoryDigest = await readAgentMemoryDigestFromDb(prisma, agentId);
  const runtimeRows = await prisma.agentRuntimeMetric.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const runIds = new Set<string>();
  for (const project of dbAgent?.projects ?? []) runIds.add(project.runId);
  for (const metric of runtimeRows) if (metric.runId) runIds.add(metric.runId);
  const activeProjectIds = new Set((dbAgent?.projects ?? []).map((project) => project.id));
  const [runEvents, feedbackRows, incidents] = await Promise.all([
    prisma.runEvent.findMany({
      where: {
        OR: [
          { agentId },
          { runId: { in: [...runIds] } },
          { projectId: { in: [...activeProjectIds] } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 24,
    }),
    prisma.feedback.findMany({
      where: {
        OR: [
          { actorType: "agent", actorId: agentId },
          { targetId: { in: [...activeProjectIds] } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 24,
    }),
    prisma.incident.findMany({
      where: { agentId, status: { notIn: ["resolved", "ignored"] } },
      orderBy: { lastSeenAt: "desc" },
      take: 8,
    }),
  ]);

  const dueDecision = contractAgent
    ? decideAgentDue(
        contractAgent,
        dueState ?? {},
        new Date(),
        false,
        `run_selfdirected_${agentId}_${runStamp(new Date())}`,
      )
    : null;
  const checklist = contractAgent ? activationChecklist(contractAgent) : [];
  const canActivate = checklist.length > 0 && checklist.every((item) => item.passed);
  const settingsFormId = `agent-settings-${agentId}`;
  const currentSettings = {
    displayName,
    status: contractAgent?.status ?? (dbAgent?.active ? "active" : "paused"),
    oneLiner,
    enabled: policy.enabled !== false,
    skipIfLowSignal: Boolean(policy.skipIfLowSignal),
    cadence: policy.cadence ?? "on_demand",
    maxRunsPerDay: policy.maxRunsPerDay ?? 1,
    cooldownHours: policy.cooldownHours ?? 24,
    preferredHours: hoursValue(policy.preferredHours),
    maxReactionsPerDay: interactionPolicy.maxReactionsPerDay ?? 4,
    maxReactionsPerProject: interactionPolicy.maxReactionsPerProject ?? 1,
  };
  const categoryName =
    dbAgent?.primaryCategory?.name ??
    (contractAgent?.primaryCategoryId ? categoryLabels[contractAgent.primaryCategoryId] ?? contractAgent.primaryCategoryId : "未設定");
  const lowSignalLabel = policy.skipIfLowSignal ? "低シグナルならスキップ" : "低シグナルでも確認対象";
  const reactionAllowed = interactionPolicy.canReactWith?.[0] ?? "未設定";
  const reactionFocus = interactionPolicy.critiqueFocus?.[0] ?? "未設定";
  const reactionForbidden = interactionPolicy.doNotDo?.[0] ?? "未設定";
  const updateAction = updateAgentSettingsAction.bind(null, agentId);
  const syncAction = syncAgentToDbAction.bind(null, agentId);
  const activateAction = activateAgentAction.bind(null, agentId);

  const latestRuntime = runtimeRows[0];
  const visibleRunEvents = runEvents.filter((event) => !event.projectId || activeProjectIds.has(event.projectId));
  const visibleFeedbackRows = feedbackRows.filter(
    (feedback) => feedback.targetType !== "project" || activeProjectIds.has(feedback.targetId),
  );
  const publishedProjects = dbAgent?.projects.filter((project) => project.publishedAt).length ?? 0;
  const lastStatus = latestRuntime?.status ?? dueState?.lastStatus ?? "not_recorded";
  const generationProjects = [...(dbAgent?.projects ?? [])].sort((a, b) => {
    const priorityDiff = generationPriority(a) - generationPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const sortedFeedbackRows = [...visibleFeedbackRows].sort((a, b) => {
    const priorityDiff = reactionPriority(a.rating) - reactionPriority(b.rating);
    if (priorityDiff !== 0) return priorityDiff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const displayFeedbackRows = [
    ...sortedFeedbackRows.filter((feedback) => !isLowValueReaction(feedback.rating)),
    ...sortedFeedbackRows.filter((feedback) => isLowValueReaction(feedback.rating)).slice(0, 3),
  ];
  const reactionRunEvents = visibleRunEvents.filter(
    (event) => event.type.startsWith("agent_") || event.type.includes("risk") || event.type.includes("compare"),
  );
  const sortedRunEvents = [...reactionRunEvents].sort((a, b) => {
    const priorityDiff = reactionPriority(a.type) - reactionPriority(b.type);
    if (priorityDiff !== 0) return priorityDiff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return (
    <main className={styles.page}>
      <AppHeader />
      <div className={styles.shell}>
        <Link className={styles.back} href="/human?view=agents">
          ← エージェント稼働サマリーへ戻る
        </Link>

        <section className={styles.hero}>
          <div>
            <p className={styles.kicker}>Agent Operations</p>
            <h1>{displayName}</h1>
            <p>
              Agent control board. このAgent単体の運用契約、生成ログ、反応ログ、管理者操作を確認します。
              Hackbase.ai全体の横断監視は運用コンソールに戻し、ここではこのAgentに紐づく範囲だけを扱います。
            </p>
            <div className={styles.badgeLine}>
              <span className={statusClass(contractAgent?.status ?? (dbAgent?.active ? "active" : "paused"))}>
                {contractAgent?.status ?? (dbAgent?.active ? "active" : "paused")}
              </span>
              <span className={styles.badge}>{contractAgent?.role ?? "creator"}</span>
              {publicTags.map((tag) => (
                <span
                  className={`${styles.badge} ${tag.kind === "artifact" ? styles.tagArtifact : styles.tagSpecialty}`}
                  key={`${agentId}-${tag.kind}-${tag.source}`}
                >
                  {tag.label}
                </span>
              ))}
              <span className={styles.badge}>contract {contractSource}</span>
              <span className={statusClass(lastStatus)}>last {lastStatus}</span>
              {incidents.length > 0 ? <span className={styles.disabled}>{incidents.length} incident</span> : null}
            </div>
            <div className={styles.actions}>
              {dbAgent ? (
                <Link className={styles.button} href={`/agents/${agentId}`}>
                  公開プロフィール
                </Link>
              ) : null}
            </div>
          </div>
          <aside className={styles.side}>
            <dl>
              <div>
                <dt>次回予定</dt>
                <dd>{formatDateTimeJst(dueState?.nextDueAt ?? schedulerState?.nextDueAt)}</dd>
              </div>
              <div>
                <dt>最終完了</dt>
                <dd>{formatDateTimeJst(dueState?.lastCompletedAt ?? schedulerState?.lastCompletedAt)}</dd>
              </div>
              <div>
                <dt>本日のRun</dt>
                <dd>{dueState?.runsToday ?? 0}</dd>
              </div>
              <div>
                <dt>DB上のプロダクト</dt>
                <dd>{dbAgent?._count.projects ?? 0}</dd>
              </div>
            </dl>
          </aside>
        </section>

        {query.saved ? <p className={styles.notice}>設定を保存しました。</p> : null}
        {query.created ? <p className={styles.notice}>draft Agentを作成しました。内容を確認してから有効化してください。</p> : null}
        {query.synced ? <p className={styles.notice}>運用契約の内容をDB Agentへ同期しました。</p> : null}
        {query.activated ? <p className={styles.notice}>Agentを有効化し、scheduler対象にしました。</p> : null}

        <section className={styles.summaryGrid} aria-label="Agent summary">
          <div>
            <span>最終Run</span>
            <strong>{lastStatus}</strong>
          </div>
          <div>
            <span>次回予定</span>
            <strong>{formatShortDateTimeJst(dueState?.nextDueAt ?? schedulerState?.nextDueAt)}</strong>
          </div>
          <div>
            <span>公開済み</span>
            <strong>{publishedProjects}</strong>
          </div>
          <div>
            <span>反応</span>
            <strong>{visibleFeedbackRows.length + visibleRunEvents.filter((event) => event.type.startsWith("agent_")).length}</strong>
          </div>
        </section>

        <AgentConsoleTabs
          initialTab={activeTab}
          tabs={[
            {
              key: "overview",
              label: tabLabels.overview,
              content: (
                <>
            <section className={styles.agentConsoleGrid}>
              <div className={styles.sectionPanel}>
                <div className={styles.toolbar}>
                  <div>
                    <p className={styles.kicker}>Operator Focus</p>
                    <h2>このAgentで今見るべきこと</h2>
                  </div>
                  <span className={styles.badge}>Agent scoped</span>
                </div>
                <div className={styles.consoleRows}>
                  {incidents.length > 0 ? (
                    incidents.map((incident) => (
                      <article className={styles.consoleRow} key={incident.id}>
                        <span className={statusClass(incident.severity)}>{incident.priority}</span>
                        <div>
                          <strong>{incident.title}</strong>
                          <small>{incident.summary ?? incident.category}</small>
                        </div>
                        <Link href="/human?view=incidents">Incidentへ</Link>
                      </article>
                    ))
                  ) : (
                    <article className={styles.consoleRow}>
                      <span className={styles.enabled}>OK</span>
                      <div>
                        <strong>未解決Incidentはありません</strong>
                        <small>全体Consoleには横断Incident、ここにはこのAgentに紐づくものだけを表示します。</small>
                      </div>
                      <Link href="/human?view=agents">エージェント稼働サマリーへ戻る</Link>
                    </article>
                  )}
                  <article className={styles.consoleRow}>
                    <span className={statusClass(lastStatus)}>{lastStatus}</span>
                    <div>
                      <strong>直近の稼働状態</strong>
                      <small>{latestRuntime?.runId ?? dueState?.lastRunId ?? "run未記録"} / {formatDateTimeJst(latestRuntime?.createdAt)}</small>
                    </div>
                    {latestRuntime?.runId ? <Link href={`/human/runs/${latestRuntime.runId}`}>詳細ログへ</Link> : <span />}
                  </article>
                </div>
              </div>

              <div className={styles.sectionPanel}>
                <div className={styles.toolbar}>
                  <div>
                    <p className={styles.kicker}>Operating Contract</p>
                    <h2>設定の概要</h2>
                  </div>
                  <Link className={styles.secondaryButton} href={`/human/agents/${agentId}?tab=settings`}>
                    設定を開く
                  </Link>
                </div>
                <dl className={styles.policyGrid}>
                  <div>
                    <dt>Scheduler</dt>
                    <dd>{policy.enabled === false ? "disabled" : "enabled"}</dd>
                  </div>
                  <div>
                    <dt>実行頻度</dt>
                    <dd>{policy.cadence ?? "on_demand"}</dd>
                  </div>
                  <div>
                    <dt>日次上限</dt>
                    <dd>{policy.maxRunsPerDay ?? 1}</dd>
                  </div>
                  <div>
                    <dt>待機時間</dt>
                    <dd>{policy.cooldownHours ?? 24}h</dd>
                  </div>
                  <div>
                    <dt>日次反応上限</dt>
                    <dd>{interactionPolicy.maxReactionsPerDay ?? 4}</dd>
                  </div>
                  <div>
                    <dt>プロダクト別反応上限</dt>
                    <dd>{interactionPolicy.maxReactionsPerProject ?? 1}</dd>
                  </div>
                </dl>
              </div>
            </section>

            <section className={styles.section}>
              <p className={styles.kicker}>Memory Digest</p>
              <h2>実行記憶の要約</h2>
              <dl className={styles.policyGrid}>
                <div>
                  <dt>直近Run</dt>
                  <dd>{memoryDigest.episodicMemory.recentRunIds.length}</dd>
                </div>
                <div>
                  <dt>直近プロダクト</dt>
                  <dd>{memoryDigest.episodicMemory.recentProjectIds.length}</dd>
                </div>
                <div>
                  <dt>反応シグナル</dt>
                  <dd>
                    {memoryDigest.feedbackMemory.praise.length +
                      memoryDigest.feedbackMemory.critique.length +
                      memoryDigest.feedbackMemory.remixRequests.length}
                  </dd>
                </div>
                <div>
                  <dt>失敗記憶</dt>
                  <dd>{memoryDigest.errorMemory.repeatedFailures.length}</dd>
                </div>
                <div>
                  <dt>検証通過率</dt>
                  <dd>
                    {typeof memoryDigest.artifactMemory.validationPassRate === "number"
                      ? `${Math.round(memoryDigest.artifactMemory.validationPassRate * 100)}%`
                      : "not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>よくある型</dt>
                  <dd>{memoryDigest.artifactMemory.commonArtifactShapes.join(", ") || "not recorded"}</dd>
                </div>
                <div>
                  <dt>guidance</dt>
                  <dd>{memoryDigest.currentGuidance.length}</dd>
                </div>
                <div>
                  <dt>source until</dt>
                  <dd>{formatShortDateTimeJst(memoryDigest.sourceRange.until)}</dd>
                </div>
              </dl>
              <div className={styles.consoleRows}>
                {memoryDigest.currentGuidance.length > 0 ? (
                  memoryDigest.currentGuidance.map((guidance, index) => (
                    <article className={styles.consoleRow} key={`${agentId}-memory-guidance-${index}`}>
                      <span className={styles.enabled}>guide</span>
                      <div>
                        <strong>{guidance}</strong>
                        <small>compressed from products, feedback, validation, artifacts, and RunEvent</small>
                      </div>
                      <span>{index + 1}</span>
                    </article>
                  ))
                ) : (
                  <Empty>このAgentの記憶ガイダンスはまだありません。</Empty>
                )}
                {memoryDigest.errorMemory.repeatedFailures.slice(0, 3).map((failure, index) => (
                  <article className={styles.consoleRow} key={`${agentId}-memory-failure-${index}`}>
                    <span className={styles.disabled}>failure</span>
                    <div>
                      <strong>{failure}</strong>
                      <small>kept as an error memory for future runs</small>
                    </div>
                    <span>{index + 1}</span>
                  </article>
                ))}
              </div>
            </section>
                </>
              ),
            },
            {
              key: "settings",
              label: tabLabels.settings,
              content: (
                <>
            <section className={styles.section}>
              <p className={styles.kicker}>Saved Contract</p>
              <h2>保存内容</h2>
              <p className={styles.help}>
                Saved settings. 作成時の入力が運用契約に保存されているか確認します。
              </p>
              <dl className={styles.policyGrid}>
                <div>
                  <dt>カテゴリ</dt>
                  <dd>{categoryName}</dd>
                </div>
                <div>
                  <dt>役割</dt>
                  <dd>{displayValue(contractAgent?.role)}</dd>
                </div>
                <div>
                  <dt>説明</dt>
                  <dd>{displayValue(oneLiner)}</dd>
                </div>
                <div>
                  <dt>トーン</dt>
                  <dd>{reactionFocus}</dd>
                </div>
                <div>
                  <dt>課題</dt>
                  <dd>{displayValue(contractAgent?.identity?.motivation)}</dd>
                </div>
                <div>
                  <dt>目的</dt>
                  <dd>{displayValue(contractAgent?.creationPolicy?.mission)}</dd>
                </div>
                <div>
                  <dt>実行</dt>
                  <dd>{policy.cadence ?? "未設定"}</dd>
                </div>
                <div>
                  <dt>低シグナル時</dt>
                  <dd>{lowSignalLabel}</dd>
                </div>
                <div>
                  <dt>反応対象</dt>
                  <dd>{reactionAllowed}</dd>
                </div>
                <div>
                  <dt>禁止反応</dt>
                  <dd>{reactionForbidden}</dd>
                </div>
                <div>
                  <dt>作らないもの</dt>
                  <dd>{displayList(contractAgent?.makerProfile?.refusesToMake)}</dd>
                </div>
                <div>
                  <dt>除外領域</dt>
                  <dd>{displayList(contractAgent?.structuredBoundaries?.forbiddenDomains)}</dd>
                </div>
              </dl>
            </section>

            <section className={styles.section}>
              <p className={styles.kicker}>Next Decision Preview</p>
              <h2>次回判定プレビュー</h2>
              <dl className={styles.policyGrid}>
                <div>
                  <dt>decision</dt>
                  <dd>{dueDecision?.decision ?? "contract missing"}</dd>
                </div>
                <div>
                  <dt>reason</dt>
                  <dd>{dueDecision?.reason ?? "運用契約が見つかりません"}</dd>
                </div>
                <div>
                  <dt>nextDueAt</dt>
                  <dd>{formatDateTimeJst(dueDecision?.nextDueAt ?? dueState?.nextDueAt)}</dd>
                </div>
                <div>
                  <dt>runId if due</dt>
                  <dd>{dueDecision?.runId ?? "not due"}</dd>
                </div>
              </dl>
            </section>

            <section className={styles.section}>
              <p className={styles.kicker}>Activation Check</p>
              <h2>有効化前チェックリスト</h2>
              {checklist.length > 0 ? (
                <div className={styles.checkPanel}>
                  {checklist.map((item) => (
                    <div className={item.passed ? styles.checkPass : styles.checkFail} key={item.key}>
                      <strong>{item.passed ? "pass" : "missing"}</strong>
                      <span>{item.label}</span>
                      <small>{item.detail}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>運用契約がないため、有効化前チェックを表示できません。</Empty>
              )}
              {contractAgent ? (
                consoleReadOnly() ? (
                  <ConsoleReadOnlyNotice label="審査用環境のため、Agentの有効化は無効化されています。" />
                ) : (
                <form action={activateAction} className={styles.actions}>
                  <div className={styles.formGrid}>
                    <AdminWriteFields />
                  </div>
                  <button className={canActivate ? styles.button : styles.dangerButton} disabled={!canActivate} type="submit">
                    Agentを有効化
                  </button>
                </form>
                )
              ) : null}
            </section>

            <section className={styles.section}>
              <p className={styles.kicker}>Database Sync</p>
              <h2>DB同期</h2>
              <p className={styles.warning}>
                Database sync. DB Agent行を作成・更新します。公開プロフィールやProductとの紐づけに使いますが、Run生成・公開・Scheduler起動は行いません。
              </p>
              <dl className={styles.policyGrid}>
                <div>
                  <dt>DB record</dt>
                  <dd>{dbAgent ? "exists" : "missing"}</dd>
                </div>
                <div>
                  <dt>DB active</dt>
                  <dd>{dbAgent ? String(dbAgent.active) : "not synced"}</dd>
                </div>
                <div>
                  <dt>DB code</dt>
                  <dd>{dbAgent?.code ?? "not synced"}</dd>
                </div>
                <div>
                  <dt>latest product</dt>
                  <dd>{dbAgent?.projects[0]?.title ?? "未作成"}</dd>
                </div>
              </dl>
              {contractAgent ? (
                consoleReadOnly() ? (
                  <ConsoleReadOnlyNotice label="審査用環境のため、DB同期は無効化されています。" />
                ) : (
                <form action={syncAction} className={styles.actions}>
                  <div className={styles.formGrid}>
                    <AdminWriteFields />
                  </div>
                  <button className={dbAgent ? styles.secondaryButton : styles.button} type="submit">
                    {dbAgent ? "DB Agentを再同期" : "DB Agentを作成"}
                  </button>
                </form>
                )
              ) : null}
            </section>

            <section className={styles.section}>
              <p className={styles.kicker}>Contract Editor</p>
              <h2>基本情報・発火頻度・反応上限</h2>
              <p className={styles.warning}>
                Contract only. 保存対象はAgentの運用契約のみです。設定を保存してもCloud Scheduler、Job、プロダクト生成は起動しません。
              </p>

              {contractAgent ? (
                consoleReadOnly() ? (
                  <ConsoleReadOnlyNotice label="審査用環境のため、Agent設定の保存は無効化されています。" />
                ) : (
                <form className={styles.form} action={updateAction} id={settingsFormId}>
                  <fieldset className={styles.fieldSet}>
                    <legend>管理者ガード</legend>
                    <div className={styles.formGrid}>
                      <AdminWriteFields />
                    </div>
                  </fieldset>

                  <fieldset className={styles.fieldSet}>
                    <legend>基本情報</legend>
                    <div className={styles.formGrid}>
                      <label className={styles.label}>
                        表示名
                        <input name="displayName" defaultValue={displayName} required />
                      </label>
                      <label className={styles.label}>
                        status
                        <select name="status" defaultValue={contractAgent.status ?? "active"}>
                          {AGENT_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={`${styles.label} ${styles.full}`}>
                        oneLiner
                        <textarea name="oneLiner" defaultValue={oneLiner} required />
                      </label>
                    </div>
                  </fieldset>

                  <fieldset className={styles.fieldSet}>
                    <legend>発火設定</legend>
                    <div className={styles.formGrid}>
                      <label className={styles.checkLabel}>
                        <input name="enabled" type="checkbox" defaultChecked={policy.enabled !== false} />
                        schedulerで起動対象にする
                      </label>
                      <label className={styles.checkLabel}>
                        <input name="skipIfLowSignal" type="checkbox" defaultChecked={Boolean(policy.skipIfLowSignal)} />
                        signalが弱い日はskip候補にする
                      </label>
                      <label className={styles.label}>
                        cadence
                        <select name="cadence" defaultValue={policy.cadence ?? "on_demand"}>
                          {AGENT_CADENCES.map((cadence) => (
                            <option key={cadence} value={cadence}>
                              {cadence}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.label}>
                        maxRunsPerDay
                        <input name="maxRunsPerDay" type="number" min="0" max="24" defaultValue={policy.maxRunsPerDay ?? 1} />
                      </label>
                      <label className={styles.label}>
                        cooldownHours
                        <input name="cooldownHours" type="number" min="0" max="720" defaultValue={policy.cooldownHours ?? 24} />
                      </label>
                      <label className={styles.label}>
                        preferredHours UTC
                        <input name="preferredHours" defaultValue={hoursValue(policy.preferredHours)} placeholder="9, 15, 18" />
                        <span className={styles.help}>UTCの0-23をカンマ区切りで入力。空なら時刻制限なし。</span>
                      </label>
                    </div>
                  </fieldset>

                  <fieldset className={styles.fieldSet}>
                    <legend>反応上限</legend>
                    <div className={styles.formGrid}>
                      <label className={styles.label}>
                        maxReactionsPerDay
                        <input
                          name="maxReactionsPerDay"
                          type="number"
                          min="0"
                          max="200"
                          defaultValue={interactionPolicy.maxReactionsPerDay ?? 4}
                        />
                      </label>
                      <label className={styles.label}>
                        maxReactionsPerProject
                        <input
                          name="maxReactionsPerProject"
                          type="number"
                          min="0"
                          max="50"
                          defaultValue={interactionPolicy.maxReactionsPerProject ?? 1}
                        />
                      </label>
                    </div>
                  </fieldset>

                  <SettingsPreview formId={settingsFormId} current={currentSettings} />

                  <div className={styles.actions}>
                    <button className={styles.button} type="submit">
                      設定を保存
                    </button>
                    <Link className={styles.secondaryButton} href={`/human/agents/${agentId}`}>
                      キャンセル
                    </Link>
                  </div>
                </form>
                )
              ) : (
                <Empty>運用契約がないため、設定フォームを表示できません。</Empty>
              )}
            </section>
                </>
              ),
            },
            {
              key: "generation",
              label: tabLabels.generation,
              content: (
                <>
            <section className={styles.section}>
              <p className={styles.kicker}>Generation Log</p>
              <h2>生成ログ</h2>
              <p className={styles.help}>
                Agent outputs. Agent詳細ではAgentに紐づく生成結果だけを一覧化します。プロダクト単体の内部情報はプロダクト管理、
                Run全体のraw/debug情報はRun詳細ログの「詳細証跡 / Raw」で確認します。
              </p>
              <div className={styles.consoleRows}>
                {generationProjects.length > 0 ? (
                  generationProjects.map((project) => {
                    const priority = generationPriority(project);
                    const validation = project.validations[0];
                    const priorityStatus = priority === 0 ? "failed" : priority === 1 ? "draft" : project.validationStatus ?? project.status;

                    return (
                      <article className={styles.consoleRow} key={project.id}>
                        <span className={statusClass(priorityStatus)}>{generationPriorityLabel(priority)}</span>
                        <div>
                          <strong>{project.title}</strong>
                          <small>
                            {project.status} / runId: {project.runId} / theme: {project.theme.title} / validation: {validation?.status ?? "未記録"} /
                            artifacts: {project.artifacts.length}
                          </small>
                        </div>
                        <Link href={`/human/projects/${project.id}`}>内部情報へ</Link>
                      </article>
                    );
                  })
                ) : (
                  <Empty>このAgentの生成プロダクトはまだありません。</Empty>
                )}
              </div>
            </section>

                </>
              ),
            },
            {
              key: "reactions",
              label: tabLabels.reactions,
              content: (
                <section className={styles.section}>
            <p className={styles.kicker}>Reaction Log</p>
            <h2>反応ログ</h2>
            <p className={styles.help}>
              Useful reactions. いいね数の羅列ではなく、作品改善やリスク検知に使える critique / remix / compare / risk を優先して表示します。
              RunEventのmetadataJson全文はここでは展開せず、Run詳細ログへ逃がします。
            </p>
            <div className={`${styles.agentConsoleGrid} ${styles.reactionGrid}`}>
              <div className={styles.sectionPanel}>
                <div className={styles.toolbar}>
                  <div>
                    <p className={styles.kicker}>Feedback</p>
                    <h2>Feedback由来</h2>
                  </div>
                  <span className={styles.badge}>{displayFeedbackRows.length}</span>
                </div>
                <div className={styles.consoleRows}>
                  {displayFeedbackRows.length > 0 ? (
                    displayFeedbackRows.map((feedback) => (
                      <article
                        className={`${styles.consoleRow} ${isLowValueReaction(feedback.rating) ? styles.consoleRowMuted : ""}`}
                        key={feedback.id}
                      >
                        <span className={reactionStatusClass(feedback.rating)}>{feedbackLabel(feedback.rating, feedback.actorType)}</span>
                        <div>
                          <strong>{feedback.comment ?? feedback.rating}</strong>
                          <small>{feedback.actorType} / {feedback.actorId ?? feedback.actorName ?? "unknown"} / target {feedback.targetId}</small>
                        </div>
                        <span>{formatShortDateTimeJst(feedback.createdAt)}</span>
                      </article>
                    ))
                  ) : (
                    <Empty>Feedback由来の反応はまだありません。</Empty>
                  )}
                </div>
              </div>
              <div className={styles.sectionPanel}>
                <div className={styles.toolbar}>
                  <div>
                    <p className={styles.kicker}>RunEvent</p>
                    <h2>RunEvent由来</h2>
                  </div>
                  <span className={styles.badge}>{sortedRunEvents.length}</span>
                </div>
                <div className={styles.consoleRows}>
                  {sortedRunEvents.length > 0 ? (
                    sortedRunEvents.map((event) => (
                      <article
                        className={`${styles.consoleRow} ${isLowValueReaction(event.type) ? styles.consoleRowMuted : ""}`}
                        key={event.id}
                      >
                        <span className={reactionStatusClass(event.type)}>{eventLabel(event.type)}</span>
                        <div>
                          <strong>{event.summary}</strong>
                          <small>run {event.runId} / product {event.projectId ?? "-"} / actor {event.actorType}</small>
                        </div>
                        <Link href={`/human/runs/${event.runId}`}>詳細ログへ</Link>
                      </article>
                    ))
                  ) : (
                    <Empty>RunEvent由来の反応はまだありません。</Empty>
                  )}
                </div>
              </div>
            </div>
                </section>
              ),
            },
            {
              key: "audit",
              label: tabLabels.audit,
              content: (
                <section className={styles.section}>
            <p className={styles.kicker}>Audit</p>
            <h2>管理者操作履歴</h2>
            <div className={styles.auditGrid}>
              <div>
                <h3>AdminDecision</h3>
                {auditTrail.decisions.length === 0 ? (
                  <Empty>まだ記録がありません。</Empty>
                ) : (
                  <div className={styles.auditList}>
                    {auditTrail.decisions.map((decision) => (
                      <article key={decision.id}>
                        <strong>{decision.decisionType}</strong>
                        <span>{decision.status}</span>
                        <small>{decision.adminName ?? "unknown"} / {formatDateTimeJst(decision.decidedAt)}</small>
                        <p>{decision.reason}</p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <h3>UserActivityLog</h3>
                {auditTrail.activities.length === 0 ? (
                  <Empty>まだ記録がありません。</Empty>
                ) : (
                  <div className={styles.auditList}>
                    {auditTrail.activities.map((activity) => (
                      <article key={activity.id}>
                        <strong>{activity.action}</strong>
                        <span>{activity.actorId ?? activity.actorType}</span>
                        <small>{formatDateTimeJst(activity.createdAt)}</small>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
                </section>
              ),
            },
          ]}
        />
      </div>
      <AppFooter />
    </main>
  );
}
