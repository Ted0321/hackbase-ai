import { readFile } from "node:fs/promises";
import path from "node:path";
import { readStoredArtifactFile, readStoredArtifactPath } from "@/lib/artifact-store";
import { prisma } from "@/lib/db";
import { isPublicProject, publicProjectWhere } from "@/lib/project-visibility";
import { projectArtifactMeta } from "@/project-artifacts/metadata";
import { getStaticArtifactSourceFiles } from "@/project-artifacts/static-source";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import styles from "../../../detail.module.css";
import {
  SourceCodeViewer,
  type SourceCodeFile,
  type SourceFileCategory,
} from "./SourceCodeViewer";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

type RawSourceCodeFile = Omit<
  SourceCodeFile,
  "category" | "categoryLabel" | "description" | "lineCount"
> & {
  description?: string;
};

const codeLanguages = new Set(["tsx", "ts", "jsx", "js", "css", "html"]);

const sourceCategoryLabels: Record<SourceFileCategory, string> = {
  readme: "README",
  entry: "エントリー",
  core: "コアロジック",
  component: "UI部品",
  data: "データ",
  integration: "外部連携",
  style: "スタイル",
  markup: "HTML",
  script: "スクリプト",
  other: "その他",
};

const languageForPath = (filePath: string) => {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "ts";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".js")) return "js";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html")) return "html";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".md")) return "markdown";
  return "text";
};

const labelForSourceArtifact = (filePath: string) => {
  const sourceIndex = filePath.indexOf("/source/");
  return sourceIndex >= 0
    ? filePath.slice(sourceIndex + 1)
    : filePath.split("/").slice(-3).join("/");
};

const readFallbackSourceFile = async (artifactRoot: string): Promise<RawSourceCodeFile | null> => {
  for (const fileName of ["source/app/page.tsx", "source/source/app/page.tsx", "source.tsx"]) {
    const body = await readStoredArtifactFile(artifactRoot, fileName);
    if (body) {
      return {
        body,
        label: fileName,
        language: languageForPath(fileName),
        path: `${artifactRoot}/${fileName}`,
      };
    }
  }
  return null;
};

const lineCount = (body: string) => body.split(/\r\n|\r|\n/).length;

const categoryForSourceFile = (file: Pick<RawSourceCodeFile, "label" | "language">) => {
  const label = file.label.toLowerCase();
  let category: SourceFileCategory = "other";

  if (label.includes("readme") || file.language === "markdown") {
    category = "readme";
  } else if (label.endsWith("/app/page.tsx") || label.endsWith("source.tsx")) {
    category = "entry";
  } else if (label.includes("/core/")) {
    category = "core";
  } else if (label.includes("/components/")) {
    category = "component";
  } else if (label.includes("/data/")) {
    category = "data";
  } else if (label.includes("/integrations/")) {
    category = "integration";
  } else if (file.language === "css") {
    category = "style";
  } else if (file.language === "html") {
    category = "markup";
  } else if (file.language === "js" || file.language === "ts") {
    category = "script";
  }

  return {
    category,
    categoryLabel: sourceCategoryLabels[category],
  };
};

const fileDescription = (category: SourceFileCategory) => {
  switch (category) {
    case "readme":
      return "このコード一式の概要です";
    case "entry":
      return "画面を立ち上げる中心ファイルです";
    case "core":
      return "AI呼び出しパターンと処理フローの中核ロジックです";
    case "component":
      return "画面を構成するUI部品です";
    case "data":
      return "表示や判定に使うデータです";
    case "integration":
      return "外部サービスや処理との接続部分です";
    case "style":
      return "見た目を整えるCSSです";
    case "markup":
      return "HTML構造です";
    case "script":
      return "補助的な処理です";
    default:
      return "その他の実装ファイルです";
  }
};

const createReadmeFile = (projectTitle: string, files: SourceCodeFile[]): SourceCodeFile => {
  const rows = files
    .map((file) => `- ${file.categoryLabel}: \`${file.label}\` - ${file.description}`)
    .join("\n");
  const body = `# ${projectTitle} のソースと検証結果

このページでは、保存されている実装ファイルと確認用の証跡を1つずつ確認できます。左側のファイルを選ぶと、右側にその内容を表示します。

## ファイルの見方

- README: このコード一式の概要です。
- エントリー: 画面を立ち上げる中心ファイルです。
- コアロジック: AI呼び出しと処理の中核です。
- UI部品: 画面を構成する部品です。
- データ: 表示や判定に使う情報です。
- 外部連携: 外部サービスや処理との接続部分です。
- スタイル: 見た目を整えるCSSです。

## この作品に含まれるファイル

${rows || "- 表示できる実装ファイルや検証結果はまだありません。"}
`;

  return {
    body,
    category: "readme",
    categoryLabel: sourceCategoryLabels.readme,
    createdByName: "Hackbase",
    createdByType: "system",
    description: "ソースと検証結果の見方",
    label: "README.md",
    language: "markdown",
    lineCount: lineCount(body),
    path: "README.md",
    validationStatus: "not_checked",
  };
};

const sortCodeFiles = (files: SourceCodeFile[]) => {
  const score = (file: SourceCodeFile) => {
    if (file.label.endsWith("/app/page.tsx")) return 0;
    if (file.label.endsWith("source.tsx")) return 1;
    if (file.label.includes("/core/")) return 2;
    if (file.label.includes("/components/")) return 3;
    if (file.label.includes("/data/")) return 4;
    if (file.label.includes("/integrations/")) return 5;
    if (file.label.endsWith(".css")) return 6;
    return 9;
  };

  return [...files].sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label));
};

const readLocalCatalogSource = async () => {
  try {
    return await readFile(path.join(process.cwd(), "src", "project-artifacts", "catalog.tsx"), "utf8");
  } catch {
    return null;
  }
};

export default async function ProjectSource({ params }: PageProps) {
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: {
      ...publicProjectWhere,
      id,
    },
    include: {
      category: true,
    },
  });

  if (!project || !isPublicProject(project)) {
    notFound();
  }

  const artifact = projectArtifactMeta[project.id];

  const artifactRows = await prisma.artifact.findMany({
    where: {
      projectId: project.id,
      type: {
        in: ["source", "source_file"],
      },
    },
    orderBy: [{ type: "asc" }, { path: "asc" }],
  });
  const files = (
    await Promise.all(
      artifactRows.map(async (item): Promise<RawSourceCodeFile | null> => {
        const language = languageForPath(item.path);
        if (!codeLanguages.has(language)) return null;

        const body = await readStoredArtifactPath(item.path);
        if (!body) return null;

        return {
          body,
          createdByName: item.createdByName,
          createdByType: item.createdByType,
          label: labelForSourceArtifact(item.path),
          language,
          path: item.path,
          riskSummary: item.riskSummary,
          validationStatus: item.validationStatus,
        } satisfies RawSourceCodeFile;
      }),
    )
  ).filter((item): item is RawSourceCodeFile => Boolean(item));

  if (artifact) {
    files.push(
      ...getStaticArtifactSourceFiles(project.id)
        .filter((file) => codeLanguages.has(file.language))
        .map((file) => ({
          body: file.body,
          label: file.label,
          language: file.language,
          path: file.path,
        })),
    );
    const source = await readLocalCatalogSource();
    if (source) {
      files.push({
        body: source,
        label: artifact.sourcePath,
        language: "tsx",
        path: artifact.sourcePath,
      });
    }
  }

  if (!artifact && files.length === 0) {
    const fallbackSource = await readFallbackSourceFile(project.artifactRoot);
    if (fallbackSource) {
      files.push(fallbackSource);
    }
  }

  const categorizedFiles = sortCodeFiles(
    files.map((file) => {
      const category = categoryForSourceFile(file);
      return {
        ...file,
        ...category,
        description: file.description ?? fileDescription(category.category),
        lineCount: lineCount(file.body),
      };
    }),
  );
  const sourceFiles =
    categorizedFiles.length > 0
      ? [createReadmeFile(project.title, categorizedFiles), ...categorizedFiles]
      : [];

  return (
    <main className={`${styles.page} ${styles.fixedChromePage} ${styles.sourceEvidencePage}`}>
      <AppHeader />

      <Link className={styles.back} href={`/projects/${project.id}`}>
        ← プロダクトに戻る
      </Link>

      <section className={styles.sourceViewerHero}>
        <p className={styles.kicker}>Source & Review</p>
        <h1>ソースと検証結果</h1>
        <p>
          {project.title} の保存済みソースと確認用の証跡を表示します。READMEから概要を確認し、必要に応じて実装ファイルを開いてください。
        </p>
        <p>
          紹介画像やアイコンは、プロダクトを説明するためのコンセプトビジュアルです。実装コードではなく、動作するUIのソースでもありません。
        </p>
      </section>

      {sourceFiles.length > 0 ? (
        <SourceCodeViewer files={sourceFiles} />
      ) : (
        <section className={styles.sourceViewerEmpty}>
          <h2>ソースコードはありません</h2>
          <p>この作品では、まだ表示できるソースコードが保存されていません。</p>
          <Link href={`/projects/${project.id}`}>プロダクトに戻る</Link>
        </section>
      )}

      <AppFooter codeHref={`/projects/${project.id}/source`} />
    </main>
  );
}
