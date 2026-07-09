# DOC-18 Moltbook / OpenClaw 調査メモ

- 文書ID: DOC-18
- 版数: v0.1
- ステータス: Draft
- 作成日: 2026-06-24
- 目的: Moltbook系の公開情報から、Hackbase.ai / AI自律Hackbase.ai に転用できるAIエージェント運用設計を抽出する

## 1. 結論

Moltbook本体のサービスコードは、現時点で公式公開を確認できない。参考にできる公開物は主に以下の3系統である。

1. OpenClaw: Moltbook参加エージェントの主要基盤とされるOSSエージェントランタイム
2. Moltbook Observatory: Moltbook APIを読む観測・収集・分析ダッシュボード
3. Moltbook Observatory Archive / 研究論文: 投稿・コメント・エージェント行動の実データと分析結果

Hackbase.aiにとって重要なのは、MoltbookのUIや投稿内容そのものよりも、次の設計パターンである。

- エージェントを人間ユーザーの代替ではなく、明示的な主体として扱う
- 定期実行、heartbeat、cron、キュー、セッション分離で自律性を制御する
- 収集・生成・投稿・検証・観測を分離し、全行動をログ化する
- 高頻度なAI活動は「創発」だけでなく、スパム、重複、暗号資産系ノイズ、プロンプトインジェクションを増幅する
- 公開投稿や外部入力をエージェントに読ませる場合、権限分離とサンドボックスが必須になる

## 2. 公開コード/資料の所在

### 2.1 OpenClaw

- リポジトリ: https://github.com/openclaw/openclaw
- 役割: ローカル実行のパーソナルAIエージェント基盤
- 主要要素:
  - Gateway daemon
  - WebSocket API
  - Agent loop
  - session / workspace / memory
  - heartbeat
  - cron
  - multi-agent routing
  - sandbox
  - per-agent tools / skills / auth profiles

OpenClawのREADMEでは、Gatewayが制御プレーンであり、WhatsApp、Telegram、Slack、Discordなど複数チャネルからエージェントを操作できると説明されている。セキュリティモデル上、main sessionではツールがホスト上で動くため、グループや外部チャネルではsandbox設定が重要になる。

### 2.2 Moltbook Observatory

- リポジトリ: https://github.com/kelkalot/moltbook-observatory
- 役割: Moltbook APIを読み取り専用で監視するFastAPI + SQLiteベースの観測システム
- 主な構成:
  - `observatory/main.py`: FastAPI起動、DB初期化、scheduler起動
  - `observatory/poller/scheduler.py`: 定期ポーリング定義
  - `observatory/poller/client.py`: Moltbook APIクライアント
  - `observatory/database/`: SQLite schema / connection
  - `observatory/analyzer/`: trend / sentiment / stats
  - `observatory/web/`: dashboard / REST API

Observatoryは「投稿しない、コメントしない、投票しない」読み取り専用の設計で、Hackbase.aiの観測系にも近い。

### 2.3 Moltbook Observatory Archive / 分析コード

- 論文: https://arxiv.org/abs/2605.13860
- データセット: https://huggingface.co/datasets/SimulaMet/moltbook-observatory-archive
- 分析コード: https://github.com/kelkalot/moltbook-observatory-paper

2026-04-15 snapshotでは、78日分の観測データとして以下が公開されている。

| テーブル | 件数 | 内容 |
| --- | ---: | --- |
| agents | 175,886 | agent profile / karma / follower count / owner handle |
| posts | 2,615,098 | post title / content / submolt / score / comment count |
| comments | 1,213,007 | postへのコメント、parent_id、score |
| submolts | 6,730 | community metadata |
| snapshots | 約1,800 | hourly platform metrics |
| word_frequency | 約200,000 | hourly word frequency |

分析コードは、risk, sentiment, agent_score, network, similarity, temporal, engagement, clustering などに分かれている。

## 3. OpenClawから読むエージェント設計

### 3.1 Agent loop

OpenClawのAgent loopは、以下の流れとして説明されている。

1. Gateway RPCまたはCLIから `agent` / `agent.wait` が呼ばれる
2. sessionを解決し、runIdを返す
3. model / auth profile / skills snapshotを解決する
4. sessionごとに直列化されたqueueで `runEmbeddedAgent` を実行する
5. assistant stream / tool stream / lifecycle streamを発火する
6. transcriptやrun metadataを永続化する

Hackbase.aiへの示唆:

- Runは必ず `run_id` を持つ
- AI Worker単位ではなく、session lane単位で直列化する
- tool実行、assistant出力、lifecycleを別イベントとして保存する
- 生成結果だけでなく「途中で何を見て、どのtoolを使ったか」を観測対象にする

### 3.2 Heartbeat

OpenClawのheartbeatは、定期的なmain session turnである。デフォルトは30分間隔で、何もなければ `HEARTBEAT_OK` を返して通知を抑制できる。

重要な設定:

- `every`: 例 `30m`, `1h`, `0m`
- `target`: `last`, `none`, channel id
- `lightContext`: heartbeat用の軽量context
- `isolatedSession`: 会話履歴を持たない新規sessionで実行
- `skipWhenBusy`: 他作業中は延期
- `activeHours`: 実行時間帯制限

Hackbase.aiへの示唆:

- 「自律実行」は1種類にしない
- 軽い巡回はheartbeat、作品生成はrun、定期バッチはcronに分ける
- 何も作らない巡回を正常系として扱う
- 通知/投稿しない判断もログに残す

### 3.3 Cron / scheduled execution

OpenClawはcronを、heartbeatより重い「隔離された定期作業」として扱う。cronは独立したagent turnとしてtimeoutやrun logを持てる。

Hackbase.aiへの示唆:

- `daily_theme_scan`
- `weekly_agent_digest`
- `trend_backfill`
- `validation_retry`

のような定期作業はheartbeatではなくcron相当で扱う。

### 3.4 Multi-agent routing

OpenClawでは、agentは単なるpersonaではなく、workspace、auth profiles、model registry、session storeを持つ独立スコープとされる。agentごとに `~/.openclaw/agents/<agentId>/` 以下の状態を持ち、チャネルやアカウントとのbindingで振り分ける。

Hackbase.aiへの示唆:

- AI-A/B/C/Dは「プロンプト違い」ではなく、独立したagent profileとして扱う
- 各agentに以下を持たせる
  - workspace / prompt / policy
  - allowed tools
  - model設定
  - session history
  - generated artifacts
  - risk / validation stats
- 複数agentの作品差分を見せるなら、生成履歴もagent単位で分離する

### 3.5 Delegate / 権限設計

OpenClawのdelegate architectureは、組織で動くエージェントを「人間のなりすまし」ではなく「自身のIDを持つ代理主体」として扱う。

能力階層:

| Tier | 内容 | Hackbase.aiでの対応 |
| --- | --- | --- |
| Tier 1 | Read-only + Draft | テーマ調査、候補生成、投稿案作成 |
| Tier 2 | Send on behalf | 人間承認後の投稿、通知 |
| Tier 3 | Proactive | 承認済み範囲での自動生成、自動公開 |

Hackbase.aiのMVPでは、Tier 1.5程度が妥当である。生成と検証は自動、公開はvalidation通過後に限定し、外部公開や課金、実ユーザー影響のある操作は人間承認に残す。

### 3.6 Sandbox / tool policy

OpenClawはmulti-agentでもworkspaceはhard sandboxではないと明記している。相対パスはworkspace内でも、絶対パスではhostへ到達し得るため、sandbox設定が必要になる。

Hackbase.aiへの示唆:

- 作品生成AIに外部入力を読ませる場合は、最初からsandbox前提にする
- tool policyで `read`, `write`, `exec`, `browser`, `network`, `publish` を分ける
- AI投稿フィードや外部投稿を読むagentには、書き込み/公開権限を直接渡さない

## 4. Observatoryから読む収集・分析設計

### 4.1 ポーリング頻度

Moltbook Observatoryのschedulerは、以下の頻度でAPIを読む。

| Job | 頻度 | 内容 |
| --- | --- | --- |
| posts | 2分ごと | new 50件、hot 25件 |
| comments | 2分ごと | コメント付きpost最大50件 |
| agent profiles | 15分ごと | 未更新agent 20件 |
| submolts | 1時間ごと | community metadata |
| trends | 10分ごと | word frequency |
| snapshots | 1時間ごと | platform metrics |

Hackbase.aiにそのまま当てるなら、MVPでは以下が現実的。

| Job | MVP頻度 | 内容 |
| --- | --- | --- |
| signal_scan | 手動または1日1回 | テーマ候補収集 |
| theme_curate | runごと | テーマ候補を正規化 |
| project_generate | runごと | AI-A/B/C/Dが作品生成 |
| validation | runごと | build / metadata / screenshot / risk check |
| feed_snapshot | run完了時 | 投稿フィード用の集計 |
| agent_digest | 週1回 | agentごとの傾向分析 |

Moltbookほど高頻度にする必要はない。Hackbase.aiの価値はリアルタイム会話ではなく、AIごとの作品差分と継続的な成長にあるため、初期は「1日1回以下 + 手動run」で十分。

### 4.2 データモデル

Observatoryの公開データは、Hackbase.aiにも転用しやすい。

| Observatory | Hackbase.ai対応 |
| --- | --- |
| agents | AI profile |
| posts | published project / feed item |
| comments | human feedback / AI review comment |
| submolts | theme category / community |
| snapshots | run summary / platform metrics |
| word_frequency | trend signal / theme signal |

Hackbase.aiでは追加で以下が必要。

- runs
- theme_candidates
- selected_themes
- validations
- artifacts
- tool_events
- generation_decisions
- publish_decisions

### 4.3 分析指標

Moltbook Observatory Archiveの分析では、以下が重要。

- duplicate spam
- bot comments
- prompt-injection posts
- crypto-related posts
- pump-and-dump subset
- near-duplicate clusters
- sentiment
- per-agent risk score
- reply graph
- self-interaction rate
- organic engagement ratio

Hackbase.aiで使うべき指標:

| 指標 | 用途 |
| --- | --- |
| duplicate_rate | 似た作品ばかり出すagentを検出 |
| prompt_injection_flag | 外部入力由来の危険指示を検出 |
| self_reference_rate | 内輪化/自己言及過多を検出 |
| external_dependency_flag | 外部API/課金/認証が必要な作品を検出 |
| artifact_validity | source / README / metadata / screenshotの欠落検出 |
| novelty_score | 同テーマ内での差分評価 |
| usefulness_score | 実用性評価 |
| inspectability_score | 人間が読んで理解できるか |

## 5. Moltbook研究からの注意点

### 5.1 投稿数は価値を過大評価しやすい

Moltbook研究では、投稿やコメントの総数が大きくても、暗号資産・bot・重複・プロトコル的な投稿が多く、実質的な対話量とは限らないと示されている。

Hackbase.aiでは、作品数をKPIにしすぎない。見るべきは以下。

- 採用されたテーマ数
- validation通過率
- 人間が保存/再訪した作品数
- AIごとの差分の分かりやすさ
- 次の制作に反映されたfeedback数

### 5.2 「自律性」と「人間介入」は分けて観測する

Moltbook Illusion系の研究は、投稿間隔や活動パターンから人間介入らしさを推定している。Hackbase.aiでも、runのtrigger種別を明示する必要がある。

推奨フィールド:

- `trigger_type`: manual / scheduled / heartbeat / retry / feedback_driven
- `human_instruction_id`
- `autonomy_level`: draft_only / auto_generate / auto_publish_after_validation
- `approval_required`
- `approved_by`
- `published_by`: human / system / agent

### 5.3 エージェント同士の会話は目的なしに増やさない

Moltbookでは、agent同士の投稿・返信が「社会的に見える」一方で、並列独白や重複、スパムも多い。Hackbase.aiでは、AI同士のコメント機能を初期から入れるより、以下のように限定する方がよい。

- AI Worker同士は直接会話させない
- Orchestratorが同一テーマを配布し、成果物だけを比較する
- AI Review Workerを別枠で設ける場合も、権限はread-onlyにする
- feed上の会話より、作品差分・生成理由・次の改善案を優先する

## 6. Hackbase.aiへの設計案

### 6.1 自律レベル

| Level | 名前 | 内容 | MVP採用 |
| --- | --- | --- | --- |
| L0 | Manual seed | 人間がテーマを指定し、AIが生成 | 採用 |
| L1 | Assisted run | AIが候補を出し、人間が選ぶ | 採用 |
| L2 | Scheduled generate | 定期的に生成し、validation通過分を内部公開 | 採用候補 |
| L3 | Auto publish | validation通過後に自動でfeed掲載 | 条件付き |
| L4 | External autonomous | 外部公開/外部投稿まで自律 | MVP非採用 |

初期はL1から始め、L2/L3はrun観測とvalidationが安定してから入れる。

### 6.2 推奨コンポーネント

```text
Scheduler / Manual Trigger
  -> Signal Collector
  -> Theme Curator
  -> Theme Selector
  -> Orchestrator
  -> AI Workers
  -> Artifact Store
  -> Validation Worker
  -> Publisher
  -> Observatory / Run Analytics
  -> Feedback Collector
```

Observatoryは後付けではなく、最初からrun table / event table / validation tableとして組み込む。

### 6.3 推奨頻度

| 種別 | 頻度 | 目的 |
| --- | --- | --- |
| heartbeat | 30分から2時間 | 何か急ぎがあるかだけ確認。MVPでは不要でもよい |
| manual run | 任意 | 開発中の主経路 |
| scheduled run | 1日1回以下 | 自動生成の継続性を見る |
| weekly digest | 週1回 | AIごとの傾向、重複、改善点を見る |
| validation retry | run失敗時のみ | 一時的な失敗の再試行 |

### 6.4 生成対象

Moltbook的な「会話」を直接真似るより、Hackbase.aiでは以下を作らせる方が価値に直結する。

- 小さなWeb試作品
- 比較可能なUIパターン
- テーマ解釈の違いが分かるREADME
- 生成理由/次の育て方
- validation付きartifact

### 6.5 安全設計

MVPで最低限入れるべき制約:

- 外部公開なし
- 課金APIなし
- 秘密情報入力なし
- 生成AIはworkspace配下のみ書き込み
- feed掲載前にmetadata / source / README / screenshotを検証
- prompt injectionっぽい入力をflag化
- tool call / publish decision / validation resultを保存

## 7. 実装に落とす次アクション

1. `RunEvent` または `AgentEvent` テーブルを追加し、agent loop相当の履歴を保存する
2. `trigger_type` / `autonomy_level` / `approval_required` をrunまたはprojectに追加する
3. Validationに `duplicate_like`, `prompt_injection_like`, `external_dependency_like` の軽量チェックを追加する
4. 管理画面では、作品数よりもrun履歴、失敗理由、AIごとの傾向を見せる
5. AI同士の自由会話機能は後回しにし、まずは同一テーマ・別AI・別artifactの比較に集中する

## 8. 参照

- OpenClaw repository: https://github.com/openclaw/openclaw
- OpenClaw architecture: https://docs.openclaw.ai/concepts/architecture
- OpenClaw agent loop: https://docs.openclaw.ai/concepts/agent-loop
- OpenClaw heartbeat: https://docs.openclaw.ai/gateway/heartbeat
- OpenClaw multi-agent routing: https://docs.openclaw.ai/concepts/multi-agent
- OpenClaw delegate architecture: https://docs.openclaw.ai/concepts/delegate-architecture
- OpenClaw sandboxing: https://docs.openclaw.ai/gateway/sandboxing
- Moltbook Observatory: https://github.com/kelkalot/moltbook-observatory
- Moltbook Observatory Archive paper: https://arxiv.org/abs/2605.13860
- Moltbook Observatory dataset: https://huggingface.co/datasets/SimulaMet/moltbook-observatory-archive
- Moltbook Observatory analysis code: https://github.com/kelkalot/moltbook-observatory-paper
- The Platform Is Mostly Not a Platform: https://arxiv.org/abs/2604.21295
- The Moltbook Illusion: https://arxiv.org/abs/2602.07432
