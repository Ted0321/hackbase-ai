import Link from "next/link";
import { notFound } from "next/navigation";
import { consoleReadOnly } from "@/lib/admin-auth";
import { readStoredArtifactFile, readStoredArtifactPath } from "@/lib/artifact-store";
import { prisma } from "@/lib/db";
import { formatDateTimeJst } from "@/lib/format-datetime";
import { isHoldForReview } from "@/lib/project-visibility";
import { projectHasSource } from "@/lib/project-source";
import { approveProject, withdrawProject } from "../../../actions";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import styles from "../../agents/admin-agents.module.css";
import { ProductConsoleTabs } from "./product-console-tabs";
import { ConsoleReadOnlyNotice } from "../../console-readonly-note";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

type JsonRecord = Record<string, unknown>;

type EvidenceArtifactSpec = {
  label: string;
  path: string;
  root: "artifact" | "run";
};

type EvidenceArtifactSummary = EvidenceArtifactSpec & {
  storedPath: string;
  status: string;
  summary: string;
  details: string[];
};

type QualityRow = {
  label: string;
  status: string;
  detail: string;
};

const evidenceArtifactSpecs: EvidenceArtifactSpec[] = [
  { label: "MVP Contract V2", path: "validation/mvp-contract-v2.json", root: "artifact" },
  { label: "Interaction proof", path: "validation/interaction-proof.json", root: "artifact" },
  { label: "Render verification", path: "validation/render-verification.json", root: "artifact" },
  { label: "公開準備", path: "publish-readiness.json", root: "run" },
  { label: "Validation summary", path: "validation-summary.json", root: "run" },
  { label: "Publisher decision", path: "publisher/response.json", root: "run" },
];

const formatJson = (raw: string | null): string => {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonRecord = (raw: string | null): JsonRecord | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const stringField = (record: JsonRecord | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const fieldLabel = (record: JsonRecord | null, key: string, label = key): string | null => {
  const value = record?.[key];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  return `${label}: ${String(value)}`;
};

const arrayCountLabel = (record: JsonRecord | null, key: string, label = key): string | null => {
  const value = record?.[key];
  return Array.isArray(value) ? `${label}: ${value.length}` : null;
};

const summaryForEvidenceArtifact = (record: JsonRecord | null) => {
  if (!record) return "保存済みですが、JSONの要約は読み取れませんでした。";

  const blockers = record.blockers;
  const warnings = record.warnings;
  const checks = record.checks ?? record.gateResults;
  const firstSummary =
    stringField(record, "summary") ??
    stringField(record, "publishSummary") ??
    stringField(record, "reason");

  if (firstSummary) return firstSummary;
  if (Array.isArray(blockers) && blockers.length > 0) return `${blockers.length}件のblockerを記録`;
  if (Array.isArray(warnings) && warnings.length > 0) return `${warnings.length}件のwarningを記録`;
  if (Array.isArray(checks)) return `${checks.length}件のcheckを記録`;
  return "JSONを保存済み";
};

const evidenceStatus = (record: JsonRecord | null) =>
  stringField(record, "result") ??
  stringField(record, "status") ??
  stringField(record, "publisherStatus") ??
  "saved";

const evidenceDetails = (record: JsonRecord | null) =>
  [
    fieldLabel(record, "mvpContractV2Result", "mvpContractV2"),
    fieldLabel(record, "interactionProofResult", "interactionProof"),
    fieldLabel(record, "publisherStatus", "publisher"),
    fieldLabel(record, "reviewerStatus", "reviewer"),
    fieldLabel(record, "validationStatus", "validation"),
    fieldLabel(record, "requiredArtifactsPresent"),
    fieldLabel(record, "reviewPass"),
    fieldLabel(record, "validationPass"),
    fieldLabel(record, "mvpContractPass"),
    arrayCountLabel(record, "blockers"),
    arrayCountLabel(record, "warnings"),
    arrayCountLabel(record, "checks"),
    arrayCountLabel(record, "gateResults", "gates"),
  ].filter((value): value is string => Boolean(value));

const readFirstStoredArtifactFile = async (artifactRoot: string, fileNames: string[]) => {
  for (const fileName of fileNames) {
    const value = await readStoredArtifactFile(artifactRoot, fileName);
    if (value) return value;
  }
  return null;
};

const readEvidenceArtifactSummary = async (
  artifactRoot: string,
  runRoot: string,
  spec: EvidenceArtifactSpec,
): Promise<EvidenceArtifactSummary | null> => {
  const storedPath = spec.root === "run" ? `${runRoot}/${spec.path}` : `${artifactRoot}/${spec.path}`;
  const raw =
    spec.root === "run"
      ? await readStoredArtifactPath(storedPath)
      : await readStoredArtifactFile(artifactRoot, spec.path);
  if (!raw) return null;
  const parsed = parseJsonRecord(raw);
  return {
    ...spec,
    storedPath,
    status: evidenceStatus(parsed),
    summary: summaryForEvidenceArtifact(parsed),
    details: evidenceDetails(parsed),
  };
};

const statusLabel = (value?: string | null) => {
  switch (value) {
    case "auto_published":
      return "自動公開";
    case "published":
      return "公開中";
    case "held_for_review":
      return "確認待ち";
    case "archived":
      return "非公開";
    case "draft":
      return "下書き";
    case "pending":
      return "判定待ち";
    case "pass":
    case "passed":
    case "success":
    case "completed":
      return "通過";
    case "fail":
    case "failed":
    case "error":
      return "要確認";
    case "saved":
      return "保存済み";
    case "not_recorded":
    case null:
    case undefined:
      return "未記録";
    default:
      return value;
  }
};

const publishStateDescription = (status?: string | null, decision?: string | null) => {
  if (decision === "withdrawn" || status === "withdrawn" || status === "archived") {
    return "公開面からは非表示です。artifactとrun証跡は残り、内部確認は続けられます。";
  }
  if (isHoldForReview(status, decision)) {
    return "確認待ちです。公開feed/detail/demo/sourceには出さず、人間確認後に公開できます。";
  }
  if (status === "auto_published") {
    return "品質ゲート通過により自動公開されています。問題があればこの画面から取り下げます。";
  }
  if (status === "published") {
    return "人間承認済みで公開中です。問題があればこの画面から取り下げます。";
  }
  return "公開状態を確認してください。必要に応じて承認または取り下げを行います。";
};

const toneClass = (value?: string | null) => {
  const normalized = String(value ?? "").toLowerCase();
  if (
    ["pass", "passed", "success", "completed", "saved", "ok", "ready", "published", "auto_published"].includes(
      normalized,
    )
  ) {
    return styles.enabled;
  }
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("block") ||
    normalized.includes("missing") ||
    normalized === "archived" ||
    normalized === "withdrawn"
  ) {
    return styles.disabled;
  }
  if (
    normalized.includes("warn") ||
    normalized.includes("review") ||
    normalized.includes("pending") ||
    normalized.includes("draft") ||
    normalized === "not_recorded"
  ) {
    return styles.draft;
  }
  return styles.badge;
};

const isFailStatus = (value?: string | null) => {
  const normalized = String(value ?? "").toLowerCase();
  return (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("block") ||
    normalized.includes("missing")
  );
};

const artifactSizeLabel = (sizeBytes?: number | null) => {
  if (!sizeBytes) return "size未記録";
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
  if (sizeBytes >= 1024) return `${(sizeBytes / 1024).toFixed(1)}KB`;
  return `${sizeBytes}B`;
};

export default async function AdminProjectDetail({ params }: PageProps) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      agent: true,
      category: true,
      theme: true,
      run: {
        include: {
          _count: {
            select: {
              artifacts: true,
              events: true,
              projects: true,
              validationChecks: true,
            },
          },
        },
      },
      artifacts: { orderBy: [{ type: "asc" }, { path: "asc" }] },
      validations: {
        include: { checks: { orderBy: { key: "asc" } } },
        orderBy: { checkedAt: "desc" },
      },
    },
  });

  if (!project) {
    notFound();
  }

  const latestValidation = project.validations[0];
  const hasSource = projectHasSource(project.id, project.artifacts.length);
  const isPublic = project.status === "published" || project.status === "auto_published";
  const canApprove = project.status !== "published";
  const canWithdraw = isPublic || project.status === "held_for_review";
  const runRoot = `artifacts/llm-pipeline-runs/${project.runId}`;

  const [readme, metadata, selfReview, source] = await Promise.all([
    readStoredArtifactFile(project.artifactRoot, "README.md"),
    readStoredArtifactFile(project.artifactRoot, "metadata.json"),
    readStoredArtifactFile(project.artifactRoot, "validation/self-review.json"),
    readFirstStoredArtifactFile(project.artifactRoot, [
      "source/app/page.tsx",
      "source/source/app/page.tsx",
      "source.tsx",
    ]),
  ]);
  const evidenceArtifacts = (
    await Promise.all(
      evidenceArtifactSpecs.map((spec) =>
        readEvidenceArtifactSummary(project.artifactRoot, runRoot, spec),
      ),
    )
  ).filter((item): item is EvidenceArtifactSummary => Boolean(item));
  const recentRunEvents = await prisma.runEvent.findMany({
    where: { runId: project.runId },
    orderBy: { createdAt: "desc" },
    take: 4,
  });

  const validationRows: QualityRow[] = [
    {
      label: "総合Validation",
      status: latestValidation?.status ?? project.validationStatus ?? "not_recorded",
      detail: latestValidation?.summary ?? "公開判断に使う総合判定です。",
    },
    {
      label: "ビルド確認",
      status: latestValidation?.buildStatus ?? "not_recorded",
      detail: "生成物がビルド可能かを確認します。",
    },
    {
      label: "実行確認",
      status: latestValidation?.runStatus ?? "not_recorded",
      detail: "生成物が実行できるかを確認します。",
    },
    {
      label: "スクリーンショット",
      status: latestValidation?.screenshotStatus ?? "not_recorded",
      detail: "表示確認の証跡です。",
    },
    {
      label: "メタデータ",
      status: latestValidation?.metadataStatus ?? "not_recorded",
      detail: "公開に必要なメタ情報の有無です。",
    },
    {
      label: "リスク確認",
      status: latestValidation?.riskStatus ?? "not_recorded",
      detail: "公開を止めるリスクがないかを確認します。",
    },
    {
      label: "秘密情報",
      status: latestValidation?.secretStatus ?? "not_recorded",
      detail: "秘密情報の混入確認です。",
    },
    {
      label: "外部依存",
      status: latestValidation?.externalDependencyStatus ?? "not_recorded",
      detail: "公開方法に影響する外部依存の確認です。",
    },
    {
      label: "プロンプト注入",
      status: latestValidation?.promptInjectionStatus ?? "not_recorded",
      detail: "公開上問題になる指示混入の確認です。",
    },
    {
      label: "README",
      status: latestValidation?.readmeStatus ?? "not_recorded",
      detail: "公開説明の根拠が保存されているかを確認します。",
    },
    {
      label: "表示確認",
      status: latestValidation?.displayStatus ?? "not_recorded",
      detail: "公開画面で破綻がないかを確認します。",
    },
  ];

  const failedCheckCount = [
    ...validationRows.map((row) => row.status),
    ...(latestValidation?.checks.map((check) => check.status) ?? []),
    ...evidenceArtifacts.map((artifact) => artifact.status),
  ].filter(isFailStatus).length;
  const qualityStatus = latestValidation?.status ?? project.validationStatus ?? "not_recorded";
  const artifactBodyPreviews = [
    { label: "README.md", body: readme },
    { label: "metadata.json", body: metadata ? formatJson(metadata) : null },
    { label: "validation/self-review.json", body: selfReview ? formatJson(selfReview) : null },
    { label: "source", body: source },
  ].filter((item): item is { label: string; body: string } => Boolean(item.body));

  return (
    <main className={styles.page}>
      <AppHeader />
      <div className={styles.shell}>
        <div className={styles.returnLinks} aria-label="戻り先">
          <Link className={styles.back} href="/human?view=products">
            ← プロダクト一覧に戻る
          </Link>
        </div>

        <section className={styles.hero}>
          <div>
            <p className={styles.kicker}>Internal Product Info</p>
            <h1>{project.title}</h1>
            <p>
              Product review board. 公開中または審査中の1つのプロダクトについて、公開判断に必要な内部情報とRun要約をこのページで確認します。
              生成ログの全文は詳細ログに分け、通常確認では要約と公開判断に関係する証跡だけを見ます。
            </p>
            <div className={styles.badgeLine}>
              <span className={toneClass(project.status)}>{statusLabel(project.status)}</span>
              <span className={toneClass(project.publishDecision)}>{statusLabel(project.publishDecision)}</span>
              <span className={toneClass(qualityStatus)}>品質 {statusLabel(qualityStatus)}</span>
              {failedCheckCount > 0 ? (
                <span className={styles.disabled}>要確認 {failedCheckCount}</span>
              ) : (
                <span className={styles.enabled}>重大なblockerなし</span>
              )}
            </div>
          </div>
          <aside className={styles.side}>
            <dl>
              <div>
                <dt>Project ID</dt>
                <dd>{project.id}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>
                  {project.agent.code} / {project.agent.name}
                </dd>
              </div>
              <div>
                <dt>Run</dt>
                <dd>{project.runId}</dd>
              </div>
              <div>
                <dt>カテゴリ</dt>
                <dd>{project.category.name}</dd>
              </div>
            </dl>
          </aside>
        </section>

        <nav className={styles.relatedLinkBar} aria-label="プロダクト関連ページ">
          <Link href={`/projects/${project.id}`}>公開ページを見る</Link>
          {hasSource ? <Link href={`/projects/${project.id}/source`}>ソースビューアー</Link> : null}
          <Link href={`/human/runs/${project.runId}`}>Run詳細ログ</Link>
          <Link href={`/human/agents/${project.agentId}`}>制作エージェントの管理</Link>
        </nav>

        <section className={styles.summaryGrid} aria-label="公開判断サマリー">
          <div>
            <span>公開状態</span>
            <strong>{statusLabel(project.status)}</strong>
          </div>
          <div>
            <span>公開判断</span>
            <strong>{statusLabel(project.publishDecision)}</strong>
          </div>
          <div>
            <span>品質判定</span>
            <strong>{statusLabel(qualityStatus)}</strong>
          </div>
          <div>
            <span>要確認</span>
            <strong>{failedCheckCount}</strong>
          </div>
        </section>

        <div className={styles.productConsoleGrid}>
          <div className={styles.productConsoleMain}>
            <ProductConsoleTabs
              tabs={[
                {
                  key: "internal",
                  label: "判断情報 / Decision",
                  content: (
                    <div className={styles.productTabContent}>
                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Decision Summary</p>
                            <h2>このプロダクトの現在地</h2>
                          </div>
                          <span className={toneClass(project.status)}>{statusLabel(project.status)}</span>
                        </div>
                        <p className={styles.productLead}>
                          Current decision. 現在のstatusは <strong>{statusLabel(project.status)}</strong>、公開判断は{" "}
                          <strong>{statusLabel(project.publishDecision)}</strong> です。
                          {project.publishDecisionReason
                            ? ` 理由: ${project.publishDecisionReason}`
                            : " 公開判断の理由はまだ記録されていません。"}
                        </p>
                      </section>

                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Quality Evidence</p>
                            <h2>公開判断に必要なチェック</h2>
                          </div>
                          <span className={toneClass(qualityStatus)}>{statusLabel(qualityStatus)}</span>
                        </div>
                        <p className={styles.help}>
                          Readiness checks. 細かいValidationCheckをすべて並べるのではなく、公開可否に影響する項目を優先して表示します。
                        </p>
                        <div className={styles.consoleRows}>
                          {validationRows.map((row) => (
                            <article className={styles.consoleRow} key={row.label}>
                              <span className={toneClass(row.status)}>{statusLabel(row.status)}</span>
                              <div>
                                <strong>{row.label}</strong>
                                <small>{row.detail}</small>
                              </div>
                              <span className={styles.rowMeta}>{row.status}</span>
                            </article>
                          ))}
                        </div>
                        {latestValidation?.checks.length ? (
                          <details className={styles.detailBlock}>
                            <summary>ValidationCheck全件を表示</summary>
                            <pre className={styles.codeBlock}>
                              <code>
                                {latestValidation.checks
                                  .map((check) => `${check.status} / ${check.key}: ${check.summary ?? "summary未記録"}`)
                                  .join("\n")}
                              </code>
                            </pre>
                          </details>
                        ) : null}
                      </section>

                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Stored Evidence</p>
                            <h2>Artifact storeに残っている根拠</h2>
                          </div>
                          <span className={styles.badge}>{evidenceArtifacts.length}件</span>
                        </div>
                        <p className={styles.help}>
                          Stored proof. DB上の状態だけではなく、生成時に保存されたcontract、proof、publish readinessの実体が存在するかを確認します。
                        </p>
                        <div className={styles.consoleRows}>
                          {evidenceArtifacts.length > 0 ? (
                            evidenceArtifacts.map((item) => (
                              <article className={styles.consoleRow} key={item.path}>
                                <span className={toneClass(item.status)}>{statusLabel(item.status)}</span>
                                <div>
                                  <strong>{item.label}</strong>
                                  <small>{item.summary}</small>
                                  {item.details.length > 0 ? <small>{item.details.join(" / ")}</small> : null}
                                </div>
                                <span className={styles.rowMeta}>{item.storedPath}</span>
                              </article>
                            ))
                          ) : (
                            <p className={styles.help}>追加のcontract/proof JSONはまだ保存されていません。</p>
                          )}
                        </div>

                        <details className={styles.detailBlock}>
                          <summary>保存ファイルのpath / size / checksumを表示</summary>
                          <pre className={styles.codeBlock}>
                            <code>
                              {project.artifacts.length > 0
                                ? project.artifacts
                                    .map(
                                      (artifact) =>
                                        `${artifact.type} / ${artifactSizeLabel(artifact.sizeBytes)} / ${
                                          artifact.checksum ?? "checksum未記録"
                                        }\n${artifact.path}`,
                                    )
                                    .join("\n\n")
                                : "Artifactはまだ記録されていません。"}
                            </code>
                          </pre>
                        </details>

                        {artifactBodyPreviews.length > 0 ? (
                          <details className={styles.detailBlock}>
                            <summary>README / metadata / self-reviewの中身を表示</summary>
                            <div className={styles.previewStack}>
                              {artifactBodyPreviews.map((item) => (
                                <div key={item.label}>
                                  <strong>{item.label}</strong>
                                  <pre className={styles.codeBlock}>
                                    <code>{item.body}</code>
                                  </pre>
                                </div>
                              ))}
                            </div>
                          </details>
                        ) : null}
                      </section>
                    </div>
                  ),
                },
                {
                  key: "summary",
                  label: "Run要約",
                  content: (
                    <div className={styles.productTabContent}>
                      <section className={styles.sectionPanel}>
                        <div className={styles.toolbar}>
                          <div>
                            <p className={styles.kicker}>Run Summary</p>
                            <h2>このプロダクトを作ったRun</h2>
                          </div>
                          <span className={toneClass(project.run.status)}>{statusLabel(project.run.status)}</span>
                        </div>
                        <p className={styles.help}>
                          Run context. ここでは管理判断に必要なRunの要約だけを表示します。prompt、input、response、metadataJsonの全文は通常確認から外し、
                          必要な場合だけRun詳細ログで確認します。
                        </p>
                        <dl className={styles.productMetaList}>
                          <div>
                            <dt>Run ID</dt>
                            <dd>{project.run.id}</dd>
                          </div>
                          <div>
                            <dt>起動種別</dt>
                            <dd>{project.run.triggerType}</dd>
                          </div>
                          <div>
                            <dt>自律度</dt>
                            <dd>{project.run.autonomyLevel}</dd>
                          </div>
                          <div>
                            <dt>実行者</dt>
                            <dd>
                              {project.run.actorType} / {project.run.actorName ?? project.run.actorId ?? "未記録"}
                            </dd>
                          </div>
                          <div>
                            <dt>開始</dt>
                            <dd>{formatDateTimeJst(project.run.startedAt)}</dd>
                          </div>
                          <div>
                            <dt>完了</dt>
                            <dd>{formatDateTimeJst(project.run.completedAt)}</dd>
                          </div>
                          <div>
                            <dt>生成 / 公開 / 失敗</dt>
                            <dd>
                              {project.run.generatedProjectCount} / {project.run.publishedProjectCount} /{" "}
                              {project.run.failedProjectCount}
                            </dd>
                          </div>
                          <div>
                            <dt>証跡件数</dt>
                            <dd>
                              {project.run._count.events} events / {project.run._count.artifacts} artifacts /{" "}
                              {project.run._count.validationChecks} checks
                            </dd>
                          </div>
                        </dl>
                        {project.run.summary || project.run.errorMessage ? (
                          <p className={project.run.errorMessage ? styles.warning : styles.help}>
                            {project.run.errorMessage ?? project.run.summary}
                          </p>
                        ) : null}
                        {recentRunEvents.length > 0 ? (
                          <details className={styles.detailBlock}>
                            <summary>直近のRunイベントを表示</summary>
                            <div className={styles.consoleRows}>
                              {recentRunEvents.map((event) => (
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
                              ))}
                            </div>
                          </details>
                        ) : null}
                        <Link className={styles.secondaryButton} href={`/human/runs/${project.runId}`}>
                          Run詳細ログを見る
                        </Link>
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
                  <p className={styles.kicker}>Publish Moderation</p>
                  <h2>公開状態の操作</h2>
                </div>
                <span className={toneClass(project.publishDecision)}>{statusLabel(project.publishDecision)}</span>
              </div>
              <p className={styles.help}>
                Publish controls. 公開状態だけを操作します。ArtifactやRunの証跡は削除しません。
              </p>
              <p className={styles.help}>
                {publishStateDescription(project.status, project.publishDecision)}
              </p>
              {consoleReadOnly() ? (
                <ConsoleReadOnlyNotice label="審査用環境のため、公開状態の操作は無効化されています（閲覧のみ）。" />
              ) : canApprove || canWithdraw ? (
                <div className={styles.actions}>
                  {canApprove ? (
                    <form action={approveProject}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <button className={styles.button} type="submit">
                        公開を承認
                      </button>
                    </form>
                  ) : null}
                  {canWithdraw ? (
                    <form action={withdrawProject}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <button className={styles.dangerButton} type="submit">
                        非公開にする
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : (
                <p className={styles.help}>現在の状態では操作できる公開アクションはありません。</p>
              )}
            </section>

            <section className={styles.sectionPanel}>
              <p className={styles.kicker}>Provenance</p>
              <h2>作成・承認・公開の記録</h2>
              <dl className={styles.productMetaList}>
                <div>
                  <dt>作成者</dt>
                  <dd>
                    {project.createdByName ?? project.createdById ?? "未記録"} ({project.createdByType})
                  </dd>
                </div>
                <div>
                  <dt>承認要否</dt>
                  <dd>{project.approvalRequired ? "承認が必要" : "自動公開可能"}</dd>
                </div>
                <div>
                  <dt>承認者</dt>
                  <dd>{project.approvedByName ?? project.approvedByType ?? "未承認"}</dd>
                </div>
                <div>
                  <dt>公開者</dt>
                  <dd>{project.publishedByName ?? project.publishedByType ?? "未公開"}</dd>
                </div>
                <div>
                  <dt>公開日時</dt>
                  <dd>{formatDateTimeJst(project.publishedAt)}</dd>
                </div>
                <div>
                  <dt>Theme</dt>
                  <dd>{project.theme.title}</dd>
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
                    <strong>公開ページを見る</strong>
                    <small>ユーザーに見える表示を確認します。</small>
                  </div>
                  <Link href={`/projects/${project.id}`}>開く</Link>
                </article>
                {hasSource ? (
                  <article className={styles.consoleRow}>
                    <span className={styles.badge}>Source</span>
                    <div>
                      <strong>ソースビューアー</strong>
                      <small>READMEや実装ファイルを確認します。</small>
                    </div>
                    <Link href={`/projects/${project.id}/source`}>開く</Link>
                  </article>
                ) : null}
                <article className={styles.consoleRow}>
                  <span className={styles.badge}>Run</span>
                  <div>
                    <strong>Run詳細ログ</strong>
                    <small>このプロダクトを作ったRunの概要、公開判断、検証ログ、詳細証跡を確認します。</small>
                  </div>
                  <Link href={`/human/runs/${project.runId}`}>開く</Link>
                </article>
                <article className={styles.consoleRow}>
                  <span className={styles.badge}>Agent</span>
                  <div>
                    <strong>制作エージェントの管理</strong>
                    <small>Agent単位の設定、生成ログ、反応ログを確認します。</small>
                  </div>
                  <Link href={`/human/agents/${project.agentId}`}>開く</Link>
                </article>
              </div>
            </section>
          </aside>
        </div>
      </div>
      <AppFooter codeHref={hasSource ? `/projects/${project.id}/source` : undefined} />
    </main>
  );
}
