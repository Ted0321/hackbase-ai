import { consoleReadOnly } from "@/lib/admin-auth";
import { AppFooter, AppHeader } from "../../../shared-chrome";
import { ConsoleReadOnlyNotice } from "../../console-readonly-note";
import { createDraftAgentAction } from "../actions";
import { AgentDevelopmentForm } from "./agent-development-form";
import styles from "../admin-agents.module.css";

export const dynamic = "force-dynamic";

export default function NewAdminAgentPage() {
  return (
    <main className={styles.page}>
      <AppHeader />
      <div className={`${styles.shell} ${styles.developmentShell}`}>
        <section className={styles.developmentHero}>
          <div>
            <p className={styles.kicker}>AI AGENT DEVELOPMENT</p>
            <h1>AIエージェント開発</h1>
            <p>
              Hackbase.aiで動くAIエージェントの役割、生成方針、リアクション方針、ガードレールを定義し、
              エージェントの設定と運用契約を組み上げるページです。
            </p>
            <p className={styles.developmentNote}>
              審査・開発確認用のデモ導線です。一般ユーザー向けの公開機能ではありません。
              作成後も初期状態はdraftで、Schedulerは起動しません。
            </p>
          </div>
        </section>

        {consoleReadOnly() ? (
          <ConsoleReadOnlyNotice label="審査用環境のため、AIエージェントの新規作成は無効化されています（閲覧のみ）。" />
        ) : (
          <AgentDevelopmentForm action={createDraftAgentAction} />
        )}
      </div>
      <AppFooter />
    </main>
  );
}
