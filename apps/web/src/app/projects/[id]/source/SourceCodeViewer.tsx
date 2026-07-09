"use client";

import { useMemo, useState } from "react";
import styles from "../../../detail.module.css";

export type SourceFileCategory =
  | "readme"
  | "entry"
  | "core"
  | "component"
  | "data"
  | "integration"
  | "style"
  | "markup"
  | "script"
  | "other";

export type SourceCodeFile = {
  body: string;
  category: SourceFileCategory;
  categoryLabel: string;
  createdByName?: string | null;
  createdByType?: string | null;
  description?: string;
  label: string;
  language: string;
  lineCount?: number;
  riskSummary?: string | null;
  path: string;
  validationStatus?: string | null;
};

export type SourceProvenanceSummary = {
  sourceProductUsed?: string;
  sourceProductUse?: string;
  sourceBoundary?: string;
  antiCloneBoundary?: string;
  interactionPrimaryAction?: string;
  interactionExpectedState?: string;
  visibleEvidence?: string[];
};

const iconForFile = (file: SourceCodeFile) => {
  switch (file.category) {
    case "readme":
      return "📄";
    case "entry":
      return "🚪";
    case "core":
      return "🧠";
    case "component":
      return "🧩";
    case "data":
      return "📊";
    case "integration":
      return "🔌";
    case "style":
      return "🎨";
    case "markup":
      return "🏷️";
    case "script":
      return "⚙️";
    default:
      return "🗂️";
  }
};

const compactLabel = (label: string) => {
  if (label.length <= 42) return label;
  const parts = label.split("/");
  if (parts.length <= 2) return label;
  return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
};

const categoryOrder: SourceFileCategory[] = [
  "readme",
  "entry",
  "core",
  "component",
  "data",
  "integration",
  "style",
  "markup",
  "script",
  "other",
];

const actorLabel = (file: SourceCodeFile) => {
  if (file.createdByName) return file.createdByName;
  if (file.createdByType) return file.createdByType;
  return "未記録";
};

const validationLabel = (value: string | null | undefined) => {
  switch (value) {
    case "pass":
    case "passed":
    case "ok":
      return "pass";
    case "fail":
    case "failed":
      return "fail";
    case "pending":
      return "pending";
    case "not_checked":
      return "未確認";
    case "not_recorded":
      return "未記録";
    default:
      return "未記録";
  }
};

const validationClass = (value: string | null | undefined) => {
  switch (validationLabel(value)) {
    case "pass":
      return styles.sourceMetaBadgeOk;
    case "fail":
      return styles.sourceMetaBadgeWarn;
    default:
      return styles.sourceMetaBadge;
  }
};

export function SourceCodeViewer({ files }: { files: SourceCodeFile[] }) {
  const [activePath, setActivePath] = useState(files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);
  const activeFile = useMemo(
    () => files.find((file) => file.path === activePath) ?? files[0],
    [activePath, files],
  );
  const groupedFiles = useMemo(
    () =>
      categoryOrder
        .map((category) => ({
          category,
          files: files.filter((file) => file.category === category),
          label: files.find((file) => file.category === category)?.categoryLabel ?? "",
        }))
        .filter((group) => group.files.length > 0),
    [files],
  );

  const copyCode = async () => {
    if (!activeFile) return;
    await navigator.clipboard?.writeText(activeFile.body);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  if (!activeFile) return null;

  return (
    <section className={styles.sourceViewer} aria-label="ソースと検証結果ビューア">
      <aside className={styles.sourceFileNav}>
        <div className={styles.sourceFileNavHead}>
          <h2>ファイル一覧</h2>
          <span>{files.length}件</span>
        </div>
        <p className={styles.sourceFileNavLead}>
          README、画面、UI部品、データ、スタイルなど、確認したい役割ごとにファイルを整理しています。
        </p>
        <div className={styles.sourceFileList}>
          {groupedFiles.map((group) => (
            <div className={styles.sourceFileGroup} key={group.category}>
              <p>{group.label}</p>
              {group.files.map((file) => {
                const isActive = file.path === activeFile.path;
                return (
                  <button
                    className={isActive ? styles.sourceFileButtonActive : styles.sourceFileButton}
                    key={file.path}
                    onClick={() => setActivePath(file.path)}
                    type="button"
                  >
                    <span className={styles.sourceFileIcon} aria-hidden="true">
                      {iconForFile(file)}
                    </span>
                    <span className={styles.sourceFileText}>
                      <strong title={file.label}>{compactLabel(file.label)}</strong>
                      <small>
                        {file.description ?? file.categoryLabel}
                        {file.lineCount ? ` / ${file.lineCount} lines` : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <section className={styles.sourceCodeArea}>
        <div className={styles.sourceCodeHead}>
          <div>
            <h2 title={activeFile.label}>{activeFile.label}</h2>
            <p>
              {activeFile.categoryLabel} / {activeFile.language}
              {activeFile.lineCount ? ` / ${activeFile.lineCount} lines` : ""}
            </p>
            <div className={styles.sourceMetaBadges}>
              <span className={styles.sourceMetaBadge}>作成: {actorLabel(activeFile)}</span>
              <span className={validationClass(activeFile.validationStatus)}>
                検証: {validationLabel(activeFile.validationStatus)}
              </span>
              {activeFile.riskSummary ? (
                <span className={styles.sourceMetaBadgeWarn}>注意: {activeFile.riskSummary}</span>
              ) : null}
            </div>
          </div>
          <button className={styles.sourceCopyButton} onClick={copyCode} type="button">
            {copied ? "コピー済み" : "コピー"}
          </button>
        </div>
        <div className={styles.sourceCodeFrame}>
          <div className={styles.sourceCodeFrameTop}>
            <span title={activeFile.label}>{activeFile.label}</span>
            <span className={styles.sourceDots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
          <pre className={styles.sourceViewerCode}>
            <code>{activeFile.body}</code>
          </pre>
        </div>
      </section>
    </section>
  );
}
