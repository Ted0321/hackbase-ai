"use client";

import { useEffect, useState } from "react";
import styles from "../../admin-agents.module.css";

type SettingsValue = string | number | boolean;

type SettingsPreviewProps = {
  formId: string;
  current: Record<string, SettingsValue>;
};

const readValue = (form: HTMLFormElement, key: string, currentValue: SettingsValue): SettingsValue => {
  const field = form.elements.namedItem(key);
  if (!field) return currentValue;

  if (field instanceof HTMLInputElement && field.type === "checkbox") {
    return field.checked;
  }

  if (field instanceof HTMLInputElement && field.type === "number") {
    return Number.parseInt(field.value || "0", 10);
  }

  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
    return field.value.trim();
  }

  return currentValue;
};

const display = (value: SettingsValue) => {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value || "(empty)");
};

export function SettingsPreview({ formId, current }: SettingsPreviewProps) {
  const [changes, setChanges] = useState<Array<{ key: string; before: SettingsValue; after: SettingsValue }>>([]);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    const update = () => {
      const next = Object.entries(current)
        .map(([key, before]) => ({ key, before, after: readValue(form, key, before) }))
        .filter((row) => display(row.before) !== display(row.after));
      setChanges(next);
    };

    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [current, formId]);

  return (
    <aside className={styles.previewBox} aria-live="polite">
      <p className={styles.kicker}>Save Preview</p>
      <h3>保存前の差分</h3>
      {changes.length === 0 ? (
        <p className={styles.help}>現在値からの変更はありません。</p>
      ) : (
        <dl className={styles.diffList}>
          {changes.map((change) => (
            <div key={change.key}>
              <dt>{change.key}</dt>
              <dd>
                <span>{display(change.before)}</span>
                <strong>→</strong>
                <span>{display(change.after)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className={styles.help}>保存しても自動制作や本番Jobは起動しません。Agentの運用ルールだけを更新します。</p>
    </aside>
  );
}
