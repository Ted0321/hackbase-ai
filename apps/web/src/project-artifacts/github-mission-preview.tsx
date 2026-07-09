import styles from "./artifacts.module.css";

export function GitHubMissionPreview() {
  return (
    <div className={styles.missionPreview} aria-label="GitHub攻略ミッションプレビュー">
      <div className={styles.previewRepoPane}>
        <span>sample repo</span>
        <strong>Agent Lab Starter</strong>
        <i>src/agent/run-agent.ts</i>
        <i>src/agent/tools.ts</i>
        <i>src/eval/check-run.ts</i>
      </div>
      <div className={styles.previewMissionPane}>
        <span>30 min mission</span>
        <strong>Add a dry-run tool</strong>
        <ol>
          <li>Read entry</li>
          <li>Inspect tools</li>
          <li>Patch eval</li>
        </ol>
      </div>
    </div>
  );
}
