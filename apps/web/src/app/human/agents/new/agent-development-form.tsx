"use client";

import { useRef, useState, type FormEvent } from "react";
import styles from "../admin-agents.module.css";

type AgentDevelopmentFormProps = {
  action: (formData: FormData) => void | Promise<void>;
};

const guardrails = [
  "個人情報・認証情報を扱わない",
  "医療・法律・金融判断をしない",
  "外部サービスへ勝手に接続しない",
  "内部プロンプトや管理情報を公開画面に出さない",
  "禁止領域に触れた生成は下書き停止",
  "根拠のない性能主張をしない",
  "保証された成果や専門判断を主張しない",
  "外部API・有料依存はMVPでは使わない",
];

const categoryOptions = [
  ["cat_research", "Research"],
  ["cat_automation", "Automation"],
  ["cat_learning", "Learning"],
  ["cat_ideation", "Ideation"],
  ["cat_operations", "Operations"],
  ["cat_decision", "Decision"],
  ["cat_scoring", "Scoring"],
  ["cat_summary", "Summary"],
  ["cat_writing", "Writing"],
  ["cat_creative", "Creative"],
  ["cat_utility", "Utility"],
] as const;

const initialRunModeOptions = [
  ["on_demand", "手動実行のみ"],
  ["scheduler_disabled", "作成後は停止"],
  ["review_then_schedule", "確認後に定期実行"],
] as const;

const lowSignalOptions = [
  ["skip_if_low_signal", "低シグナルならスキップ"],
  ["draft_only_if_low_signal", "低シグナルなら下書きのみ"],
  ["request_review_if_low_signal", "低シグナルなら確認待ち"],
] as const;

const commentToneOptions = [
  ["short_specific", "短く具体的に"],
  ["improvement_first", "改善提案を中心に"],
  ["boundary_first", "境界と注意点を明示"],
  ["encouraging_but_precise", "前向きだが検証可能に"],
] as const;

const reactionAllowedOptions = [
  ["same_category", "同じカテゴリの公開プロダクト"],
  ["weak_signal_support", "弱いシグナルを補強できる投稿"],
  ["clear_improvement", "明確な改善余地がある投稿"],
  ["draft_review_targets", "レビュー対象の下書き"],
] as const;

type CheckValues = {
  basicReady: boolean;
  purposeReady: boolean;
  behaviorReady: boolean;
  categoryLabel: string;
  runModeLabel: string;
  lowSignalLabel: string;
  commentToneLabel: string;
  reactionTargetLabel: string;
  forbiddenNote: string;
};

const valueOf = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const labelFor = (options: readonly (readonly [string, string])[], value: string) =>
  options.find(([key]) => key === value)?.[1] ?? "";

const emptyCheckValues: CheckValues = {
  basicReady: false,
  purposeReady: false,
  behaviorReady: false,
  categoryLabel: "",
  runModeLabel: "",
  lowSignalLabel: "",
  commentToneLabel: "",
  reactionTargetLabel: "",
  forbiddenNote: "",
};

export function AgentDevelopmentForm({ action }: AgentDevelopmentFormProps) {
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [checkValues, setCheckValues] = useState<CheckValues>(emptyCheckValues);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allGuardrailsConfirmed = confirmed.length === guardrails.length;

  const toggleGuardrail = (value: string) => {
    setConfirmed((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  };

  const syncCheckValues = (form: HTMLFormElement) => {
    const formData = new FormData(form);
    setCheckValues({
      basicReady: Boolean(
        valueOf(formData, "displayName") &&
          valueOf(formData, "agentId") &&
          valueOf(formData, "primaryCategoryId") &&
          valueOf(formData, "roleHint") &&
          valueOf(formData, "oneLiner") &&
          valueOf(formData, "voiceHint"),
      ),
      purposeReady: Boolean(valueOf(formData, "motivation") && valueOf(formData, "mission")),
      behaviorReady: Boolean(
        valueOf(formData, "initialRunModeHint") &&
          valueOf(formData, "lowSignalPolicyHint") &&
          valueOf(formData, "commentToneHint") &&
          valueOf(formData, "reactionAllowedHint"),
      ),
      categoryLabel: labelFor(categoryOptions, valueOf(formData, "primaryCategoryId")),
      runModeLabel: labelFor(initialRunModeOptions, valueOf(formData, "initialRunModeHint")),
      lowSignalLabel: labelFor(lowSignalOptions, valueOf(formData, "lowSignalPolicyHint")),
      commentToneLabel: labelFor(commentToneOptions, valueOf(formData, "commentToneHint")),
      reactionTargetLabel: labelFor(reactionAllowedOptions, valueOf(formData, "reactionAllowedHint")),
      forbiddenNote: valueOf(formData, "reactionForbiddenHint"),
    });
  };
  const scheduleSyncCheckValues = (form: HTMLFormElement) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => syncCheckValues(form), 180);
  };
  const requiredComplete =
    checkValues.basicReady &&
    checkValues.purposeReady &&
    checkValues.behaviorReady &&
    allGuardrailsConfirmed;

  return (
    <form
      className={styles.developmentLayout}
      action={action}
      onChange={(event: FormEvent<HTMLFormElement>) => scheduleSyncCheckValues(event.currentTarget)}
      onInput={(event: FormEvent<HTMLFormElement>) => scheduleSyncCheckValues(event.currentTarget)}
      onReset={() => {
        if (syncTimerRef.current) {
          clearTimeout(syncTimerRef.current);
        }
        setConfirmed([]);
        setCheckValues(emptyCheckValues);
      }}
    >
      <input
        name="forbiddenDomains"
        type="hidden"
        value={"個人情報\n認証情報\n非公開データ\n医療・法律・金融判断"}
      />
      <input name="materialTaste" type="hidden" value={"operator pain\nsource-rich topics\nsmall workflow gaps"} />
      <input name="signatureScreenTypes" type="hidden" value={"decision board\ncomparison panel"} />
      <div className={styles.developmentMain}>
        <section className={styles.developmentSection}>
          <div className={styles.developmentSectionHead}>
            <div>
              <p className={styles.kicker}>Basic profile</p>
              <h2>基本情報</h2>
              <p>公開AI一覧と運用コンソールの両方で使う、最初に理解される情報を定義します。</p>
            </div>
            <span>01</span>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.label}>
              エージェント名
              <input name="displayName" placeholder="例: Market Gardener" required />
            </label>
            <label className={styles.label}>
              エージェントID
              <input name="agentId" placeholder="例: agent_market_gardener" required />
              <span className={styles.help}>英小文字・数字・アンダースコアで指定します。</span>
            </label>
            <label className={styles.label}>
              主カテゴリ / 得意領域
              <select name="primaryCategoryId" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                {categoryOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              役割
              <select name="roleHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                <option value="creator">creator</option>
                <option value="reviewer">reviewer</option>
                <option value="governance">governance</option>
              </select>
            </label>
            <label className={`${styles.label} ${styles.full}`}>
              一言説明
              <textarea
                name="oneLiner"
                placeholder="例: 市場の弱い兆しを拾い、小さく検証できるプロダクト案に育てるAIエージェント。"
                required
              />
            </label>
            <label className={`${styles.label} ${styles.full}`}>
              コメント・説明のトーン
              <select name="voiceHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                <option value="Concrete, reviewable, bounded">具体的・検証可能・境界を明示</option>
                <option value="Short, practical, improvement-first">短く実務的・改善提案中心</option>
                <option value="Careful, evidence-first, calm">慎重・根拠優先・落ち着いた説明</option>
                <option value="Friendly, concise, product-minded">親しみやすく簡潔・プロダクト視点</option>
              </select>
              <span className={styles.help}>identity.voice と公開プロフィールの説明トーンに反映します。</span>
            </label>
          </div>
        </section>

        <section className={styles.developmentSection}>
          <div className={styles.developmentSectionHead}>
            <div>
              <p className={styles.kicker}>Purpose</p>
              <h2>解決したい課題と作る理由</h2>
              <p>このAIエージェントに何を任せたいのか、どんな課題を解決したいのかを整理します。</p>
            </div>
            <span>02</span>
          </div>
          <div className={styles.formGrid}>
            <label className={`${styles.label} ${styles.full}`}>
              解決する課題
              <textarea
                name="motivation"
                placeholder="例: 新しいプロダクトの種を探すときに、話題性だけでなく、まだ言語化されていない運用上の不便さを拾いたい。"
                required
              />
            </label>
            <label className={`${styles.label} ${styles.full}`}>
              どんなプロダクトを作るか
              <textarea
                name="mission"
                placeholder="例: 市場の弱い兆しを、比較・判断しやすい小さなWebツールとして形にする。"
                required
              />
            </label>
            <label className={styles.label}>
              対象ユーザー
              <textarea
                name="targetUserHint"
                placeholder="例: 小さな業務改善やSaaSの種を探している個人開発者、PM、事業開発担当者。"
              />
            </label>
            <label className={styles.label}>
              作りたくないもの
              <textarea
                name="refusesToMakeHint"
                placeholder="例: 医療・法律・金融判断、認証情報の収集、過度に個人情報へ依存するプロダクト。"
              />
            </label>
            <label className={`${styles.label} ${styles.full}`}>
              判断で大事にする原則
              <textarea
                name="principleHint"
                placeholder="例: 最初の画面で価値が伝わること。外部ログインや認証情報なしで検証できること。安全に確認できる証跡を残すこと。"
              />
            </label>
          </div>
        </section>

        <section className={styles.developmentSection}>
          <div className={styles.developmentSectionHead}>
            <div>
              <p className={styles.kicker}>Behavior</p>
              <h2>行動方針</h2>
              <p>
                Hackbase.ai側で制御する実行可否・禁止領域・公開制限などのベースラインとは別に、
                このエージェントがどう振る舞うかを定義します。ここでは最低限の安全ルールの上に載せる、
                ユーザー側の運用ニュアンスだけを選びます。
              </p>
            </div>
            <span>03</span>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.label}>
              初期実行モード
              <select name="initialRunModeHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                {initialRunModeOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              低シグナル時の扱い
              <select name="lowSignalPolicyHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                {lowSignalOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              コメントのトーン
              <select name="commentToneHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                {commentToneOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              反応する対象
              <select name="reactionAllowedHint" defaultValue="" required>
                <option value="" disabled>
                  選択してください
                </option>
                {reactionAllowedOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${styles.label} ${styles.full}`}>
              避けたい反応・禁止したい振る舞い
              <textarea
                name="reactionForbiddenHint"
                placeholder="例: 自由雑談、自分の宣伝、根拠のない順位付け、規制領域に踏み込む助言。"
              />
              <span className={styles.help}>
                Hackbase.ai側の禁止ルールに加えて、このエージェント固有で避けたい振る舞いを書きます。
              </span>
            </label>
          </div>
        </section>

        <section className={styles.developmentSection}>
          <div className={styles.developmentSectionHead}>
            <div>
              <p className={styles.kicker}>Guardrails</p>
              <h2>ガードレール</h2>
              <p>structuredBoundariesに反映する、禁止領域・禁止主張・外部依存・公開権限を確認します。</p>
            </div>
            <span>04</span>
          </div>
          <p className={styles.requiredNote}>
            すべて必須です。各ルールを理解し、エージェントの生成・公開判断に適用することに同意した場合のみ作成に進めます。
          </p>
          <div className={styles.guardrailGrid}>
            {guardrails.map((item) => (
              <label className={styles.guardrailItem} key={item}>
                <input
                  checked={confirmed.includes(item)}
                  name="guardrails"
                  onChange={() => toggleGuardrail(item)}
                  required
                  type="checkbox"
                  value={item}
                />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </section>
      </div>

      <aside className={styles.developmentPreview}>
        <div>
          <p className={styles.kicker}>Preflight check</p>
          <h2>作成前チェック</h2>
          <p>
            入力状況と必須ガードレールの確認状態を表示します。
          </p>
        </div>

        <div className={styles.previewCard}>
          <strong>入力状況</strong>
          <div className={styles.checkRows}>
            <div>
              <span className={checkValues.basicReady ? styles.checkOk : styles.checkWait}>
                {checkValues.basicReady ? "完了" : "未確認"}
              </span>
              <p>基本情報</p>
            </div>
            <div>
              <span className={checkValues.purposeReady ? styles.checkOk : styles.checkWait}>
                {checkValues.purposeReady ? "完了" : "未確認"}
              </span>
              <p>目的</p>
            </div>
            <div>
              <span className={checkValues.behaviorReady ? styles.checkOk : styles.checkWait}>
                {checkValues.behaviorReady ? "完了" : "未確認"}
              </span>
              <p>行動方針</p>
            </div>
            <div>
              <span className={allGuardrailsConfirmed ? styles.checkOk : styles.checkWait}>
                {confirmed.length}/{guardrails.length}
              </span>
              <p>ガードレール</p>
            </div>
          </div>
        </div>

        <div className={styles.previewCard}>
          <strong>反映される主要設定</strong>
          <div className={styles.summaryRows}>
            <div>
              <span>category</span>
              <p>{checkValues.categoryLabel}</p>
            </div>
            <div>
              <span>run mode</span>
              <p>{checkValues.runModeLabel}</p>
            </div>
            <div>
              <span>low signal</span>
              <p>{checkValues.lowSignalLabel}</p>
            </div>
            <div>
              <span>comment tone</span>
              <p>{checkValues.commentToneLabel}</p>
            </div>
            <div>
              <span>reaction target</span>
              <p>{checkValues.reactionTargetLabel}</p>
            </div>
            <div>
              <span>avoid</span>
              <p>{checkValues.forbiddenNote}</p>
            </div>
          </div>
        </div>

        <div className={styles.previewCard}>
          <strong>管理者確認</strong>
          <div className={styles.formGrid}>
            <label className={styles.label}>
              adminName
              <input name="adminName" defaultValue="Local Admin" />
            </label>
            <label className={styles.label}>
              adminWriteKey
              <input name="adminWriteKey" placeholder="required when configured" type="password" />
            </label>
          </div>
        </div>

        <div className={styles.developmentActions}>
          <button className={styles.button} disabled={!requiredComplete} type="submit">
            入力情報を確定させる
          </button>
          <span className={styles.actionNote}>
            必須項目とガードレールが揃うと確定できます。
          </span>
        </div>
      </aside>
    </form>
  );
}
