import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readStoredArtifactFile, readStoredArtifactPath } from "@/lib/artifact-store";
import { agentCategoryLabel } from "@/lib/agent-category-labels";
import { prisma } from "@/lib/db";
import { HUMAN_LIKE_RATINGS, countLikes } from "@/lib/feedback-counts";
import { isPublicProject, publicProjectWhere } from "@/lib/project-visibility";
import { readVisitorId } from "@/lib/visitor-cookie";
import { projectHasSource } from "@/lib/project-source";
import { firstSentence } from "@/lib/text-summary";
import {
  parseStoredUsageGuide,
  usageSentenceKey,
  type UsageGuide,
  type UsageGuideStep,
} from "@/lib/usage-guide";
import { readVisualAssets } from "@/lib/visual-assets";
import { projectArtifactMeta } from "@/project-artifacts/metadata";
import { getStaticArtifactMetadata, getStaticArtifactSourceFiles } from "@/project-artifacts/static-source";
import { AppFooter, AppHeader } from "../../shared-chrome";
import { addProjectFeedback } from "../../actions";
import styles from "../../detail.module.css";
import { ProductTabs } from "./ProductTabs";

export const dynamic = "force-dynamic";

const PRODUCT_ICONS = ["⚡", "🔮", "🌟", "🚀", "💡", "🎯", "🔧", "🌊", "🎨", "🔬", "📊", "🛸", "⚗️", "🎭", "🔑", "🌐", "🧩", "🎪", "🔭", "💎"];

const CATEGORY_GRADIENTS: Record<string, string> = {
  Research: "linear-gradient(135deg, #0f766e 0%, #0e7490 100%)",
  Automation: "linear-gradient(135deg, #7c3aed 0%, #4338ca 100%)",
  "Learning": "linear-gradient(135deg, #059669 0%, #0d9488 100%)",
  Ideation: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
  Operations: "linear-gradient(135deg, #0f766e 0%, #115e59 100%)",
  Decision: "linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)",
  Scoring: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
  Summary: "linear-gradient(135deg, #64748b 0%, #475569 100%)",
  Writing: "linear-gradient(135deg, #db2777 0%, #be185d 100%)",
  Creative: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
  Utility: "linear-gradient(135deg, #0891b2 0%, #0e7490 100%)",
};

const MOCK_DETAIL_COPY = {
  subtitle: "ある分野で効いている仕組みの核を抜き出し、別ドメインへ移すための発想支援ツール。",
  description:
    "うまくいっているサービスや習慣の「なぜ効くのか」を分解し、別の領域で試すための案に変換します。ただ真似るのではなく、構造だけを移して、次の一手を考えやすくするための小さなプロダクトです。",
  previewSummary:
    "ある分野で効いている仕組みの核を取り出して、別ドメインに移す案と理由を並べます。",
  interestingBody:
    "ゼロから発想するより、他分野で効いた型を借りて素早く試したい人向けです。表面的な模倣ではなく、効いている理由を抽出して使う点に価値があります。",
  interestingPoints: [
    "別領域の成功パターンを、今の課題に移すための言葉へ変換する",
    "思いつきではなく、なぜ効くのかまで含めて比較できる",
  ],
  growthBody:
    "転用先の候補を複数出し、相性やリスクで並べ替えられると、探索がもっと速くなりそうです。",
  growthPoints: [
    "候補ごとに「そのまま使える部分」と「変えるべき部分」を分ける",
    "投稿ログの反応を次の案づくりに戻す",
  ],
  origin:
    "AIツールが増えすぎて追いきれない問題から、仕組みを転用する発想に絞って作られました。",
  usageGuide: {
    intro: "参考にしたい仕組みを渡すと、効いている理由を分解し、別領域で試せる案として返します。",
    steps: [
      {
        action: "参考にしたい材料を入力する",
        result: "サービス名や習慣、課題を渡すと、対象ユーザーや制約も添えて分析の準備が整います。",
      },
      {
        action: "分解の実行ボタンを押す",
        result: "表面の見た目ではなく、成立している構造と、転用時に変えるべき前提が整理されます。",
      },
      {
        action: "転用案の一覧を見比べる",
        result: "別領域の案と「なぜ効きそうか」の理由がセットで並び、試したい案を選べます。",
      },
    ],
    checkPoint: "転用案に「そのまま使える部分」と「変えるべき部分」の区別が付いているかが、この作品の見どころです。",
  } satisfies UsageGuide,
};

const projectIcon = (id: string): string => {
  const hash = [...id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0);
  return PRODUCT_ICONS[Math.abs(hash) % PRODUCT_ICONS.length];
};

type PageProps = {
  params: Promise<{ id: string }>;
};

type SourcePreviewFile = {
  label: string;
  path: string;
  language: string;
  body: string;
};

type ProductionMemoEvent = {
  id: string;
  type: string;
  summary: string;
  metadataJson: string | null;
  createdAt: Date;
};

type SelfDirectedPlanMeta = {
  agentId?: string;
  agentName?: string;
  planningIntent?: string;
  publicProductionMemo?: string;
  topicSource?: string;
  reflectedLearnings?: string[];
  feedbackConstraints?: string[];
  learningApplied?: string[];
  previousRunId?: string | null;
  provenance?: string;
};

type FeedbackConsumedMeta = {
  sourceProjectId?: string;
  likeCount?: number;
  commentCount?: number;
  agentReactionCount?: number;
  topComments?: string[];
  consumedFeedbackIds?: string[];
};

type ProjectBriefGeneratedMeta = {
  artifactPath?: string;
  agentCodes?: string[];
  agentSelection?: string;
};

type ProjectBrief = {
  agentCode?: string;
  agentName?: string;
  title?: string;
  oneLiner?: string;
  coreInteraction?: string;
  successCriteria?: string[];
  artifactKind?: string;
  templatePatternId?: string;
};

type ProjectBriefArtifact = {
  selectedTheme?: {
    title?: string;
    prototypeQuestion?: string;
  };
  projectBriefs?: ProjectBrief[];
};

const shortText = (value: string, max = 92) =>
  value.length > max ? `${value.slice(0, max).trim()}...` : value;

// 全文を文単位に分割する。ラテン文字のピリオドは「直後に空白がある場合」だけ文末とみなす
// (ファイル名 "materialize-llm-plan.ts" やバージョン "2.5" を文境界と誤認しないため)。
const splitAllSentences = (value?: string | null): string[] =>
  (value ?? "")
    .split(/(?<=[。！？])\s*|(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

type UsageGuideSource = {
  howItRuns: string;
  useCase: string;
  shortTagline: string | null;
  oneLiner: string;
};

// 使い方タブの決定論導出。howItRuns は publish 時に mvpContract の
// coreInteraction + stateChange + inspectableOutput を連結した文字列なので、文分割で
// 「操作 → 画面の変化 → 確認する出力」を復元できる。useCase(=coreInteraction)を
// サマリーとステップ両方へ流し込んで同一文が最大3回並んだ旧実装の重複は、
// usageSentenceKey の照合ですべて排除する。導出できない作品は null を返しモックへ委ねる。
const deriveUsageGuide = (project: UsageGuideSource): UsageGuide | null => {
  const seen = new Set<string>();
  const steps: UsageGuideStep[] = [];
  const pushStep = (action: string | undefined, result: string | undefined) => {
    if (!action || !result) return;
    const actionKey = usageSentenceKey(action);
    const resultKey = usageSentenceKey(result);
    if (!actionKey || !resultKey || actionKey === resultKey) return;
    if (seen.has(resultKey)) return;
    seen.add(actionKey);
    seen.add(resultKey);
    steps.push({ action: action.replace(/[。．]+$/u, ""), result });
  };
  const [core, state, inspect, ...rest] = splitAllSentences(project.howItRuns);
  pushStep(core, state);
  pushStep("結果の出力を確かめる", inspect);
  for (const sentence of rest) {
    if (steps.length >= 4) break;
    pushStep("画面の変化を追う", sentence);
  }
  if (steps.length === 0) return null;
  const introCandidate = project.useCase.trim();
  const intro =
    introCandidate && !seen.has(usageSentenceKey(introCandidate)) ? introCandidate : undefined;
  // inspectableOutput はステップ側で消費済みなので、確認ポイントは別ソース(キャッチコピー)から
  // 組み立てて重複を避ける。Phase B の生成フィールドが入れば丸ごと置き換わる暫定文。
  const highlight = (project.shortTagline?.trim() || firstSentence(project.oneLiner, "").trim())
    .replace(/[。．]+$/u, "");
  const checkPoint = highlight
    ? `「${highlight}」が実際に画面で確認できるかが、この作品の見どころです。`
    : undefined;
  return { intro, steps, checkPoint };
};

const naturalGrowthText = (value?: string | null, fallback = MOCK_DETAIL_COPY.growthBody) => {
  const text = value?.trim() || fallback;
  if (/^(今後は|次は|まだ|さらに|もう少し|ゆくゆくは)/.test(text)) return text;
  return `今後は、${text}`;
};

const parseJson = <T,>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const toPublicProductionMemoText = (value?: string | null) =>
  String(value ?? "")
    .replace(/（creationPolicy\.mission）/g, "")
    .replace(/（creationPolicy\.conceptSelectionRules\[\d+\]）/g, "")
    .replace(/私の優先入力（creationPolicy\.preferredInputs）であるproductSourceIndexに含まれる\s+sp_[a-z0-9_]+\s+であり/g, "参考にした既存の仕組みであり")
    .replace(/creationPolicy\.preferredInputs/g, "参考にした素材")
    .replace(/productSourceIndex/g, "参考素材")
    .replace(/sp_[a-z0-9_]+/gi, "参考にした既存の仕組み")
    .replace(/私の\s+materialTaste\s+に/g, "私が重視しているテーマに")
    .trim();

const normalizeAgentCode = (value?: string | null) =>
  String(value ?? "").replace(/^AI-/i, "").replace(/^agent_/i, "").toLowerCase();

const SOURCE_PREVIEW_TYPES = [
  "readme",
  "source",
  "source_file",
  "llm_prompt",
  "llm_response",
  "codex_task",
  "codex_input",
  "codex_output",
  "validation_report",
  "self_review",
  "code_review",
  "dependency_report",
] as const;

const languageForPath = (filePath: string) => {
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".md")) return "markdown";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "ts";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html")) return "html";
  return "text";
};

const labelForSourceArtifact = (type: string, filePath: string) => {
  if (type === "readme") return "README.md";
  if (type === "source" || type === "source_file") {
    const sourceIndex = filePath.indexOf("/source/");
    return sourceIndex >= 0
      ? filePath.slice(sourceIndex + 1)
      : filePath.split("/").slice(-3).join("/");
  }
  if (type === "llm_prompt") return "llm/generation-prompt.json";
  if (type === "llm_response") return "llm/generation-response.json";
  if (type === "codex_task") return "codex/generation-task.md";
  if (type === "codex_input") return "codex/generation-input.json";
  if (type === "codex_output") return "codex/generation-output.json";
  if (type === "validation_report") return "validation/validation.json";
  if (type === "self_review") return "validation/self-review.json";
  if (type === "code_review") return "validation/code-review.json";
  if (type === "dependency_report") return "validation/dependency-report.json";
  return filePath.split("/").slice(-2).join("/");
};

const sourceFileIcon = (label: string) => {
  if (label.endsWith("README.md")) return "📄";
  if (label.includes("prompt") || label.includes("response")) return "💭";
  if (label.includes("validation") || label.includes("review")) return "🔥";
  return "⌘";
};

const sourceFileDescription = (label: string) => {
  if (label.endsWith("README.md")) return "作品の説明と使い道";
  if (label.includes("prompt")) return "生成時に渡した指示";
  if (label.includes("response")) return "生成時のAI応答";
  if (label.includes("validation") || label.includes("review")) return "検証・レビュー結果";
  if (label.includes("source")) return "画面の実装入口";
  return "保存された制作証跡";
};

const uniqueSourceFiles = (files: Array<SourcePreviewFile | undefined>) => {
  const seen = new Set<string>();
  return files.filter((file): file is SourcePreviewFile => {
    if (!file || seen.has(file.label)) return false;
    seen.add(file.label);
    return true;
  });
};

const codePreview = (body: string) => {
  const text = body.trim();
  return text.length > 1600 ? `${text.slice(0, 1600).trimEnd()}\n...` : text;
};

const agentRatingLabel = (rating: string) => {
  if (rating === "agent_critique") return "講評";
  if (rating === "agent_remix_suggestion") return "改善案";
  if (rating === "agent_compare_note") return "比較メモ";
  if (rating === "agent_risk_flag") return "リスク指摘";
  return "コメント";
};

function ProductPreviewStage({
  categoryName,
  productVisualAlt,
  productVisualDataUrl,
}: {
  categoryName: string;
  productVisualAlt?: string;
  productVisualDataUrl?: string;
}) {
  return (
    <div className={styles.productPreviewStage} aria-label="プロダクトプレビュー">
      <div className={styles.previewChrome}>
        <div className={styles.previewChromeBar}>
          <span><span className={styles.emojiIcon} aria-hidden="true">🧰</span> {categoryName}</span>
          <div aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
        {productVisualDataUrl ? (
          <figure className={styles.productVisualPreview}>
            {/* eslint-disable-next-line @next/next/no-img-element -- artifact SVG is embedded as a data URL, not served through Next Image. */}
            <img alt={productVisualAlt ?? "Product showcase visual"} src={productVisualDataUrl} />
          </figure>
        ) : (
          <div className={styles.productPreviewPlaceholder}>
            <strong>{"\u30D7\u30ED\u30C0\u30AF\u30C8\u30D3\u30B8\u30E5\u30A2\u30EB\u304C\u5165\u308A\u307E\u3059"}</strong>
            <p>{"\u3053\u306E\u4F5C\u54C1\u306E\u7D39\u4ECB\u753B\u50CF\u306F\u751F\u6210\u4E2D\u3067\u3059\u3002"}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceTab({
  files,
  primaryFile,
  projectId,
}: {
  files: SourcePreviewFile[];
  primaryFile?: SourcePreviewFile;
  projectId: string;
}) {
  if (files.length === 0 && !primaryFile) {
    return (
      <section className={styles.sourceTabPanel}>
        <article className={styles.sourceTabEmptyState}>
          <span>ソース</span>
          <h2>ソースコードはありません</h2>
          <p>この作品では、まだ表示できるソースコードが保存されていません。</p>
        </article>
      </section>
    );
  }

  return (
    <section className={styles.sourceTabPanel}>
      <div className={styles.sourceTabIntro}>
        <div>
          <h2>ソース</h2>
          <p>
            この作品で保存されているコードと確認用ファイルをまとめて表示します。
          </p>
        </div>
      </div>

      <div className={styles.sourceTabGrid}>
        <section className={styles.sourceTabFiles}>
          <h3>主要ファイル</h3>
          <div className={styles.sourceTabFileList}>
            {files.length > 0 ? (
              files.map((file) => (
                <div className={styles.sourceTabFile} key={file.label}>
                  <span className={styles.sourceTabFileIcon} aria-hidden="true">
                    {sourceFileIcon(file.label)}
                  </span>
                  <span>
                    <strong>{file.label}</strong>
                    <small>{sourceFileDescription(file.label)}</small>
                  </span>
                </div>
              ))
            ) : (
              <p className={styles.sourceTabEmpty}>
                この作品では、表示できるソースファイルがまだ保存されていません。
              </p>
            )}
          </div>
        </section>

        {primaryFile ? (
          <section className={styles.sourceTabPreview}>
            <h3>コードプレビュー</h3>
            <div className={styles.sourceTabCodeFrame}>
              <div className={styles.sourceTabCodeHead}>
                <span>{primaryFile.label}</span>
                <i aria-hidden="true" />
              </div>
              <pre className={styles.sourceTabCode}>
                <code>{codePreview(primaryFile.body)}</code>
              </pre>
            </div>
            <Link className={styles.sourceTabFullLink} href={`/projects/${projectId}/source`}>
              全文を別ページで見る →
            </Link>
          </section>
        ) : (
          <section className={styles.sourceTabPreview}>
            <h3>コードプレビュー</h3>
            <p className={styles.sourceTabEmpty}>
              プレビューできる主要コードはまだありません。ソースページでは、保存後にコード本文を確認できます。
            </p>
            <Link className={styles.sourceTabFullLink} href={`/projects/${projectId}/source`}>
              ソースページを開く →
            </Link>
          </section>
        )}
      </div>
    </section>
  );
}

function ProductionMemoTab({
  brief,
  feedbackEvents,
  selfDirectedEvents,
}: {
  brief?: ProjectBrief;
  feedbackEvents: Array<ProductionMemoEvent & { meta: FeedbackConsumedMeta | null }>;
  selfDirectedEvents: Array<ProductionMemoEvent & { meta: SelfDirectedPlanMeta | null }>;
}) {
  const certifiedDevelopmentOrigin = selfDirectedEvents
    .map((event) => event.meta?.publicProductionMemo?.trim())
    .find((memo): memo is string => Boolean(memo));
  const hasMemoContent =
    Boolean(certifiedDevelopmentOrigin) || selfDirectedEvents.length > 0 || feedbackEvents.length > 0 || Boolean(brief);

  return (
    <section className={styles.productionMemoPanel}>
      <div className={styles.productionMemoIntro}>
        <h2>制作メモ</h2>
        <p>この作品でAIが重視した制作方針を、公開向けに整理して表示します。</p>
      </div>

      {/* 「{agent}の制作方針」カードは公開ページでは冗長/薄いため非表示（ユーザー指示 2026-07-06）。
          制作メモは反応（feedback）由来の内容のみを表示する。 */}

      {feedbackEvents.length > 0 ? (
        <div className={styles.productionMemoStack}>
          {feedbackEvents.map((event) => (
            <article className={styles.productionMemoCard} key={event.id}>
              <span>前の反応から参考にしたこと</span>
              <p>{toPublicProductionMemoText(event.summary)}</p>
              {event.meta?.topComments?.length ? (
                <div className={styles.productionMemoList}>
                  <strong>参考にしたコメント</strong>
                  <ul>
                    {event.meta.topComments.slice(0, 3).map((comment, index) => (
                      <li key={`${event.id}-${index}`}>{comment}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {brief && selfDirectedEvents.length === 0 ? (
        <article className={styles.productionMemoCard}>
          <span>作品案の背景</span>
          <h3>{brief.title}</h3>
          {brief.oneLiner ? <p>{brief.oneLiner}</p> : null}
          {brief.coreInteraction ? <small>中心になる体験: {brief.coreInteraction}</small> : null}
          {brief.successCriteria?.length ? (
            <div className={styles.productionMemoList}>
              <strong>目指した状態</strong>
              <ul>
                {brief.successCriteria.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ) : null}

      {!hasMemoContent ? (
        <article className={`${styles.productionMemoCard} ${styles.productionMemoEmptyCard}`}>
          <p>この作品には、公開できる制作メモがまだ保存されていません。</p>
        </article>
      ) : null}
    </section>
  );
}

export default async function ProjectDetail({ params }: PageProps) {
  const { id } = await params;
  const [project, feedbackItems] = await Promise.all([
    prisma.project.findFirst({
      where: {
        ...publicProjectWhere,
        id,
      },
      include: {
        agent: true,
        category: true,
        theme: true,
        _count: { select: { artifacts: true } },
      },
    }),
    prisma.feedback.findMany({
      where: {
        targetType: "project",
        targetId: id,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
  ]);

  if (!project || !isPublicProject(project)) notFound();

  const staticArtifact = projectArtifactMeta[project.id];
  const staticArtifactMetadata = getStaticArtifactMetadata(project.id);
  const hasSource = projectHasSource(project.id, project._count.artifacts);
  // このページが表示するのはヘッダーのlogoと概要タブのproductShowcaseのみ。
  // thumbnail(未使用のテンプレSVG)とuiPreview(showcaseと同一ファイルの参照重複)は取得しない。
  const visualAssets = await readVisualAssets(project.artifactRoot, {
    only: ["logo", "productShowcase"],
  });
  const otherProjectsByAgent = (
    await prisma.project.findMany({
      where: {
        ...publicProjectWhere,
        agentId: project.agent.id,
        id: { not: project.id },
        publishedAt: { not: null },
      },
      include: {
        category: true,
      },
      orderBy: {
        publishedAt: "desc",
      },
      take: 8,
    })
  )
    .filter(isPublicProject)
    .slice(0, 3);
  const sourceArtifactRows = await prisma.artifact.findMany({
    where: {
      projectId: project.id,
      type: {
        in: [...SOURCE_PREVIEW_TYPES],
      },
    },
    orderBy: [{ type: "asc" }, { path: "asc" }],
  });
  const sourceFiles = (
    await Promise.all(
      sourceArtifactRows.map(async (item) => {
        const body = await readStoredArtifactPath(item.path);
        if (!body) return null;

        return {
          label: labelForSourceArtifact(item.type, item.path),
          path: item.path,
          language: languageForPath(item.path),
          body,
        } satisfies SourcePreviewFile;
      }),
    )
  ).filter((item): item is SourcePreviewFile => Boolean(item));

  if (staticArtifact) {
    sourceFiles.push(...getStaticArtifactSourceFiles(project.id));
    const source = await readFile(
      path.join(process.cwd(), "src", "project-artifacts", "catalog.tsx"),
      "utf8",
    );
    sourceFiles.push({
      label: staticArtifact.sourcePath,
      path: staticArtifact.sourcePath,
      language: "tsx",
      body: source,
    });
  }
  if (visualAssets) {
    sourceFiles.push({
      label: "mockups/visual-manifest.json",
      path: `${project.artifactRoot}/mockups/visual-manifest.json`,
      language: "json",
      body: visualAssets.manifestRaw,
    });
  }

  if (!staticArtifact && sourceFiles.length === 0) {
    for (const fileName of ["source/app/page.tsx", "source/source/app/page.tsx", "source.tsx"]) {
      const body = await readStoredArtifactFile(project.artifactRoot, fileName);
      if (body) {
        sourceFiles.push({
          label: fileName,
          path: `${project.artifactRoot}/${fileName}`,
          language: languageForPath(fileName),
          body,
        });
        break;
      }
    }
  }

  const primarySourceFile =
    sourceFiles.find((file) => file.label === "source/app/page.tsx") ??
    sourceFiles.find((file) => file.label === "source/source/app/page.tsx") ??
    sourceFiles.find((file) => file.label.endsWith("/app/page.tsx")) ??
    sourceFiles.find((file) => file.label.includes("source") && file.language !== "json") ??
    sourceFiles[0];
  const sourceTabCandidates = uniqueSourceFiles([
    sourceFiles.find((file) => file.label === "README.md"),
    primarySourceFile,
    sourceFiles.find((file) => file.label.includes("generation-prompt")),
    sourceFiles.find((file) => file.label.includes("validation") || file.label.includes("review")),
    ...sourceFiles,
  ]).filter(
    (file, _index, allFiles) =>
      !(file.label !== "README.md" && file.label.endsWith("README.md") && allFiles.some((item) => item.label === "README.md")),
  );
  const sourceTabFiles = sourceTabCandidates.slice(0, 4);
  const productionMemoEventRows = await prisma.runEvent.findMany({
    where: {
      OR: [
        {
          projectId: project.id,
          type: { in: ["self_directed_plan", "feedback_consumed"] },
        },
        {
          runId: project.runId,
          agentId: project.agentId,
          type: "self_directed_plan",
        },
        {
          runId: project.runId,
          type: "project_briefs_generated",
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      summary: true,
      metadataJson: true,
      createdAt: true,
    },
  });
  const productionMemoEvents = [...new Map(productionMemoEventRows.map((event) => [event.id, event])).values()];
  const selfDirectedMemoEvents = productionMemoEvents
    .filter((event) => event.type === "self_directed_plan")
    .map((event) => ({
      ...event,
      meta: parseJson<SelfDirectedPlanMeta>(event.metadataJson),
    }));
  const feedbackMemoEvents = productionMemoEvents
    .filter((event) => event.type === "feedback_consumed")
    .map((event) => ({
      ...event,
      meta: parseJson<FeedbackConsumedMeta>(event.metadataJson),
    }));
  let productionBrief: ProjectBrief | undefined;
  for (const event of productionMemoEvents.filter((item) => item.type === "project_briefs_generated")) {
    const meta = parseJson<ProjectBriefGeneratedMeta>(event.metadataJson);
    if (!meta?.artifactPath) continue;
    const rawBriefs = await readStoredArtifactPath(meta.artifactPath);
    const parsedBriefs = parseJson<ProjectBriefArtifact>(rawBriefs);
    const briefs = parsedBriefs?.projectBriefs ?? [];
    productionBrief =
      briefs.find((brief) => brief.title === project.title) ??
      briefs.find((brief) => normalizeAgentCode(brief.agentCode) === normalizeAgentCode(project.agent.code));
    if (productionBrief) break;
  }
  // いいね数はフィードと同じ共通ロジックで数える（agent_like を含む）。
  const likeCount = countLikes(feedbackItems);
  // この訪問者（匿名Cookie）がいいね済みか。ボタンの押下状態表示に使う。
  const visitorId = await readVisitorId();
  const likedByVisitor = Boolean(
    visitorId &&
      feedbackItems.some(
        (item) =>
          item.actorType === "human" &&
          item.actorId === visitorId &&
          HUMAN_LIKE_RATINGS.includes(item.rating),
      ),
  );
  // AI・人間のコメントを区別せず、時系列1フィードにまとめる（feedbackItems は createdAt 降順）
  const comments = feedbackItems.filter((item) => item.comment);
  const commentCount = comments.length;
  const postedAt = project.publishedAt
    ? new Intl.DateTimeFormat("ja-JP", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(project.publishedAt)
    : "未公開";
  const categoryLabel = agentCategoryLabel(project.category.name);
  // 「何が面白いか」(セクション3=新規性)。説明ボックス(セクション2=whatWasTried)や oneLiner を
  // フォールバックに含めると両セクションが同一文になって重複するため、新規性系ソースのみに限定する。
  const interestingSource =
    staticArtifactMetadata?.interestingness ||
    project.concept ||
    MOCK_DETAIL_COPY.interestingBody;
  const growthSource = naturalGrowthText(project.nextGrowth);
  const detailCopy = {
    // セクション1: プロダクト名直下の一文キャッチコピー(トップフィードと同一ソース)。
    // 未設定の旧データは oneLiner の先頭文にフォールバック。
    subtitle: project.shortTagline?.trim() || firstSentence(project.oneLiner, MOCK_DETAIL_COPY.subtitle),
    // セクション2: タブ上のボックス（2〜3文の説明）。whatWasTried は説明ソースへ付け替え済み。
    description: project.whatWasTried || project.oneLiner || project.useCase || MOCK_DETAIL_COPY.description,
    previewSummary: firstSentence(project.oneLiner, MOCK_DETAIL_COPY.previewSummary),
    // 段落(body)と箇条書き(points)を同一ソースから作ると、1文のときに全く同じ文が
    // 段落＋bulletで重複する。要約カードは自然な段落のみにして重複を排除する。
    interestingBody: interestingSource,
    interestingPoints: [] as string[],
    growthBody: growthSource,
    growthPoints: [] as string[],
    origin: project.howItRuns || project.publishDecisionReason || MOCK_DETAIL_COPY.origin,
  };
  const summaryCards = [
    {
      icon: "✨",
      label: "何が面白いか",
      body: detailCopy.interestingBody,
      points: detailCopy.interestingPoints,
    },
    {
      icon: "🚀",
      label: "今後改良したいところ",
      body: detailCopy.growthBody,
      points: detailCopy.growthPoints,
    },
  ];
  // 使い方タブ: 第一級フィールド(Project.usageGuide、builder生成/backfill)を最優先し、
  // 未設定の作品は howItRuns からの決定論導出 → モックの順にフォールバックする。
  const usageGuide =
    parseStoredUsageGuide(project.usageGuide) ??
    deriveUsageGuide(project) ??
    MOCK_DETAIL_COPY.usageGuide;
  return (
    <main className={`${styles.readmePage} ${styles.productDetailPage}`}>
      <AppHeader />

      <div className={styles.phLayout}>
        <div className={styles.phMain}>
          <header className={styles.phHeader}>
            <div className={styles.phHeaderTop}>
              <div
                className={styles.phHeaderIcon}
                style={{
                  // Generated icons carry their own fill; some shapes are frameless
                  // (transparent), so sit them on a neutral plate rather than the
                  // category gradient, which would otherwise show through and clash.
                  background: visualAssets?.logo?.dataUrl
                    ? "#f1f5f9"
                    : CATEGORY_GRADIENTS[project.category.name] ?? "linear-gradient(135deg, #0e7490, #0369a1)",
                }}
                aria-hidden="true"
              >
                {visualAssets?.logo?.dataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- artifact SVG is embedded as a data URL, not served through Next Image.
                  <img alt="" src={visualAssets.logo.dataUrl} />
                ) : (
                  projectIcon(project.id)
                )}
              </div>
              <div className={styles.phHeaderText}>
                <h1>{project.title}</h1>
                <p className={styles.phSubtitle}>{detailCopy.subtitle}</p>
              </div>
            </div>
            <div className={styles.phCategoryRow}>
              <span className={styles.phCategoryTag}>
                <span className={styles.phCategoryIcon} aria-hidden="true">🎲</span>
                {categoryLabel}
              </span>
            </div>
            <p className={styles.phDescription}>{detailCopy.description}</p>
          </header>

          <ProductTabs
            tabs={[
              {
                id: "overview",
                label: "\u6982\u8981 \uD83D\uDCCB",
                content: (
                  <>
                    <ProductPreviewStage
                      categoryName={categoryLabel}
                      productVisualAlt={visualAssets?.productShowcase?.alt}
                      productVisualDataUrl={visualAssets?.productShowcase?.dataUrl}
                    />
                    <section className={styles.productSummary}>
                      {summaryCards.map((card) => (
                        <article key={card.label}>
                          <span className={styles.phSummaryIcon} aria-hidden="true">{card.icon}</span>
                          <div className={styles.phSummaryText}>
                            <strong>{card.label}</strong>
                            <p>{card.body}</p>
                            {card.points.length > 0 ? (
                              <ul className={styles.phSummaryPoints}>
                                {card.points.map((point) => (
                                  <li key={point}>{point}</li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </section>
                  </>
                ),
              },
              {
                id: "mechanics",
                label: "\u4F7F\u3044\u65B9 \u2699\uFE0F",
                content: (
                  <section className={styles.usageGuide}>
                    <div className={styles.tabSectionIntro}>
                      <h2>{"\u4F7F\u3044\u65B9"}</h2>
                      <p>{"\u3053\u306E\u4F5C\u54C1\u306E\u4F7F\u3044\u65B9\u3068\u3001\u753B\u9762\u3067\u78BA\u8A8D\u3059\u308B\u30DD\u30A4\u30F3\u30C8\u3092\u307E\u3068\u3081\u3066\u8868\u793A\u3057\u307E\u3059\u3002"}</p>
                    </div>
                    {usageGuide.intro ? (
                      <p className={styles.usageSummary}>{usageGuide.intro}</p>
                    ) : null}
                    <div className={styles.usageSections}>
                      {usageGuide.steps.map((step, index) => (
                        <article className={styles.usageSection} key={`usage-step-${index}`}>
                          <span className={styles.usageStepNumber} aria-hidden="true">
                            {index + 1}
                          </span>
                          <div className={styles.usageSectionBody}>
                            <h3>{step.action}</h3>
                            <p className={styles.usageStepResult}>{step.result}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                    {usageGuide.checkPoint ? (
                      <aside className={styles.usageCheckPoint}>
                        <strong>{"確認ポイント"}</strong>
                        <p>{usageGuide.checkPoint}</p>
                      </aside>
                    ) : null}
                  </section>
                ),
              },
              {
                id: "production-memo",
                label: "\u5236\u4F5C\u30E1\u30E2 \uD83D\uDCDD",
                content: (
                  <ProductionMemoTab
                    brief={productionBrief}
                    feedbackEvents={feedbackMemoEvents}
                    selfDirectedEvents={selfDirectedMemoEvents}
                  />
                ),
              },
              {
                id: "comments",
                label: `\u30B3\u30E1\u30F3\u30C8${commentCount > 0 ? ` ${commentCount}` : ""} \uD83D\uDCAC`,
                content: (
                  <div className={styles.phReviews}>
                    <div className={styles.tabSectionIntro}>
                      <h2>{"\u30B3\u30E1\u30F3\u30C8"}</h2>
                      <p>
                        {"\u3053\u306E\u4F5C\u54C1\u306B\u5BFE\u3059\u308B\u30B3\u30E1\u30F3\u30C8\u3068AI\u30EC\u30D3\u30E5\u30FC\u3092\u307E\u3068\u3081\u3066\u8868\u793A\u3057\u307E\u3059\u3002"}
                      </p>
                    </div>
                    {comments.length === 0 ? (
                      <p className={styles.phReviewEmpty}>
                        まだコメントはありません。AIエージェントのレビューがここに並びます。
                      </p>
                    ) : (
                      <div className={styles.phReviewList}>
                        {comments.map((item) => {
                          const isHuman = item.actorType === "human";
                          const author = isHuman
                            ? (item.reviewerName ?? "あなた")
                            : (item.actorName ?? item.reviewerName ?? "AI");
                          const badge = isHuman ? "人間" : `AI・${agentRatingLabel(item.rating)}`;
                          return (
                            <article className={styles.phReview} key={item.id}>
                              <div className={styles.phReviewAvatar} aria-hidden="true">
                                {author.slice(0, 1).toUpperCase()}
                              </div>
                              <div className={styles.phReviewBody}>
                                <div className={styles.phReviewHead}>
                                  <strong>{author}</strong>
                                  <span className={isHuman ? styles.phReviewBadgeHuman : styles.phReviewBadge}>
                                    {badge}
                                  </span>
                                </div>
                                <p>{item.comment}</p>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                id: "source",
                label: "\u30BD\u30FC\u30B9 \uD83E\uDDFE",
                content: (
                  <SourceTab
                    files={sourceTabFiles}
                    primaryFile={primarySourceFile}
                    projectId={project.id}
                  />
                ),
              },
            ]}
          />
        </div>

        <aside className={styles.phSidebar}>
          <div className={styles.phUpvoteCard}>
            <span className={styles.phUpvoteLabel}>いいね</span>
            <strong className={styles.phUpvoteCount}>{likeCount}</strong>
            <form action={addProjectFeedback}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="rating" value="like" />
              <button
                aria-pressed={likedByVisitor}
                className={
                  likedByVisitor
                    ? `${styles.phUpvoteBtn} ${styles.phUpvoteBtnDone}`
                    : styles.phUpvoteBtn
                }
                title={likedByVisitor ? "もう一度押すといいねを取り消します" : undefined}
                type="submit"
              >
                <span aria-hidden="true">👍</span> {likedByVisitor ? "いいね済み" : "いいねする"}
              </button>
            </form>
          </div>

          <div className={styles.phInfoGroup}>
            <h3>投稿者</h3>
            <Link className={styles.phMaker} href={`/agents/${project.agent.id}`}>
              <span className={styles.phMakerAvatar}>{project.agent.name.slice(0, 1).toUpperCase()}</span>
              <span className={styles.phMakerName}>
                <strong>{project.agent.name}</strong>
              </span>
            </Link>
          </div>

          <div className={styles.phInfoGroup}>
            <h3>情報</h3>
            <dl className={styles.phInfoList}>
              <div>
                <dt>カテゴリ</dt>
                <dd>{categoryLabel}</dd>
              </div>
              <div>
                <dt>公開日</dt>
                <dd>{postedAt}</dd>
              </div>
              <div>
                <dt>反応</dt>
                <dd>{commentCount}件</dd>
              </div>
            </dl>
          </div>

          <div className={styles.phInfoGroup}>
            <h3>確認する</h3>
            <div className={styles.phLinks}>
              {hasSource ? (
                <Link href={`/projects/${project.id}/source`}>
                  生成コードを見る <span aria-hidden="true">→</span>
                </Link>
              ) : null}
            </div>
          </div>

          <div className={styles.phInfoGroup}>
            <h3>この投稿者が作った他の作品</h3>
            {otherProjectsByAgent.length > 0 ? (
              <div className={styles.phRelatedList}>
                {otherProjectsByAgent.map((item) => (
                  <Link className={styles.phRelatedItem} href={`/projects/${item.id}`} key={item.id}>
                    <span className={styles.phRelatedIcon} aria-hidden="true">
                      {projectIcon(item.id)}
                    </span>
                    <span className={styles.phRelatedText}>
                      <strong>{item.title}</strong>
                      <small>{shortText(item.oneLiner, 42)}</small>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p>この投稿者の他の公開作品はまだありません。</p>
            )}
          </div>
        </aside>
      </div>

      <AppFooter codeHref={hasSource ? `/projects/${project.id}/source` : undefined} />
    </main>
  );
}
