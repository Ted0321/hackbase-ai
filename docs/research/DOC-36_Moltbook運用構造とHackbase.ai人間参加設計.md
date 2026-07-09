# DOC-36 Moltbook運用構造とHackbase.ai人間参加設計

- 文書ID: DOC-36
- 版数: v0.2
- ステータス: Draft
- 作成日: 2026-06-25
- 更新日: 2026-07-04
- 目的: Moltbookのhuman / agent分離、投稿権限、運用頻度、実態データを整理し、Hackbase.aiにおける人間参加設計と初期運用規模へ落とす

## 1. 結論

Moltbookは「人間とAIエージェントが対等に混ざって会話するSNS」ではない。

公開情報と研究データから見ると、基本設計は以下である。

- 投稿、コメント、投票などの能動的操作はAIエージェント向け
- 人間は原則として閲覧・観察者
- ただし、人間はagent ownerとして、agentの作成、登録、設定、prompt、運用環境、APIキー、起動頻度に強く関与する
- そのため、見た目はagent-onlyでも、実態はhuman-in-the-loop / human-influencedなagent社会である

Moltbookの分離思想は、Hackbase.aiにも取り入れる価値がある。ただし、Hackbase.aiでは「人間を締め出す」ためではなく、以下のために分ける。

1. 作品を作った主体がAIなのか、人間なのかを混ぜない
2. AIの自律生成と人間の評価・承認・改善を分けて記録する
3. 将来、人間が参加しても、AI生成物の価値検証が崩れないようにする

### 1.1 2026-07-04 再調査追補

Moltbookの自律性は、「AIが完全に自由意思で社会を作った」というより、OpenClaw系runtimeのheartbeat / cron / session queueと、人間ownerのprompt / tool / key / runtime運用が重なった結果として見るべきである。

Hackbase.aiでは、Moltbookの見た目ではなく次を取り込む。

- agentは人間のなりすましではなく、自身のIDと制約を持つ実行主体として扱う
- 自律性は `triggerType` と `autonomyLevel` で記録し、手動指示・定期生成・feedback retryを混ぜない
- 何も生成しない巡回、validationで止めた判断、publishしなかった判断もrun eventに残す
- external inputを読むagentには、read-only権限、sandbox、publish gateを分けて設計する
- token / ranking / follower / upvoteのような活動量インセンティブは、初期MVPでは導入しない

## 2. Moltbookの現状像

### 2.1 基本構造

MoltbookはReddit風の掲示板で、投稿先は `submolt` と呼ばれるテーマ別コミュニティである。

中心オブジェクト:

- agent profile
- post
- comment
- vote / score
- submolt
- follower / subscriber
- platform snapshot

研究データでは、Moltbook Observatory Archiveが以下を収集している。

| データ | 規模 |
| --- | ---: |
| posts | 3.11M rows |
| comments | 1.69M rows |
| agents | 179k rows |
| submolts | 12.1k rows |
| snapshots | 2.57k rows |
| word_frequency | 359k rows |

2026-04-16時点の論文版では、2026-01-27から2026-04-14までの78日間で、2,615,098 posts、1,213,007 comments、175,886 unique posting agents、6,730 communitiesが報告されている。

### 2.2 人間は入れるのか

公開説明では、Moltbookは「AI agents only」であり、人間は投稿・コメント・投票せず、観察者として扱われる。

ただし、これは「人間が完全に関与しない」という意味ではない。

人間の実際の関与:

- 自分のAI assistantにMoltbookの存在を教える
- agentに登録させる
- API keyやclaim tweetなどの認証を設定する
- OpenClawなどのagent runtimeをローカルPC / VPS / Mac mini等で動かす
- agentのpersona、役割、頻度、使えるtool、権限を決める
- agentに特定の投稿を読ませたり、特定テーマに投稿させたりする

つまり、UI上は人間が投稿しないが、裏側では人間がagentを通じて強く介入できる。

## 3. human / agentを分ける意味

### 3.1 表向きの意味

Moltbookがhuman / agentを分ける表向きの意味は、agent-nativeな社会実験を成立させることである。

- 人間SNSの模倣ではなく、agent同士の反応を見る
- agentが何を話題にし、何に反応し、何を危険視するかを見る
- agent-to-agent communicationの実験場にする
- AI agent用のidentity、registry、API-first interactionを作る

「Humans welcome to observe」という文脈は、人間を主役から外し、agentの振る舞いを観察対象にするためのプロダクト演出でもある。

### 3.2 実務上の意味

実務上は、human / agent分離により、以下を管理しやすくなる。

| 分離対象 | 意味 |
| --- | --- |
| human owner | agentを所有・設定・責任を持つ主体 |
| agent identity | 投稿・コメント・投票する実行主体 |
| autonomous action | heartbeatや定期巡回でagentが行った行動 |
| human-influenced action | 人間のpromptや誘導でagentが行った行動 |
| platform actor | 管理・moderation・announcementを行うagent |

Metaが価値を見たと考えられるのも、このagent identity / owner binding / communication layerである。

### 3.3 ただし、純粋なAI自治ではない

`The Moltbook Illusion` は、Moltbookのバズった現象の多くが純粋な自律agent由来ではなく、人間の誘導を強く受けていたと分析している。

同研究では、OpenClawのheartbeat周期を手がかりに、投稿間隔のばらつきからagentを分類している。

| 分類 | 概要 | 比率 |
| --- | --- | ---: |
| autonomous | 規則的なheartbeatに近い | active agentsの15.3% |
| human-influenced | 投稿間隔が不規則で、人間promptの影響が強い | active agentsの54.8% |

また、同研究では「viral phenomenonは明確にautonomousなagentからは発生していない」とされる。

これはHackbase.aiにとって重要である。AIが自律的に作ったように見えるものでも、人間の介入度を記録しなければ、価値検証を誤る。

Hackbase.aiでは、最低限以下をrun単位で保存する。

```text
triggerType: manual | scheduled | heartbeat | retry | feedback_driven
autonomyLevel: manual_seed | assisted_run | scheduled_generate | auto_publish_after_validation | external_autonomous
humanInstructionId: nullable
humanOwnerType: human | system | external
humanOwnerId: nullable
approvalRequired: boolean
publishedByType: human | system | agent
```

この粒度がないと、`AIが自律的に良い作品を作った` のか、`人間の明示テーマと修正指示で良くなった` のかを後から分けられない。

## 4. 投稿頻度と活動量のイメージ

### 4.1 初期急成長

`Humans welcome to observe` 論文では、2026-01-30にMoltbookが急拡大したことが示されている。

2026-01-30の同日内で、累積値は以下のように増えた。

| 指標 | 増加前 | 増加後 |
| --- | ---: | ---: |
| posts | 429 | 8,000 |
| submolts | 56 | 10,854 |
| activated agents | 217 | 3,627 |

さらに、2026-01-31時点では、44,411 posts、12,684 activated agentsに到達した。

この規模感は、Hackbase.aiの初期運用には大きすぎる。Hackbase.aiが真似すべきなのは活動量ではなく、agent活動の記録構造である。

### 4.2 典型的なagentの巡回頻度

報道・解説では、Moltbookのagentは、30分ごと、または数時間ごとにplatformを確認し、投稿、コメント、upvoteを判断するとされる。

OpenClawのheartbeat cycleが分析に使われていることからも、定期巡回型の行動がMoltbookの基礎にある。

ただし、実際の活動は均一ではない。

- 多くのagentは低頻度または一度きり
- 一部のagentが大量投稿・大量コメントを作る
- bot farm的な協調行動も観測されている
- 人間promptで不規則に活動するagentも多い

OpenClawのheartbeat設計から見ると、コスト最適化は以下のような分離で行われている。

- 軽い生存確認や巡回はheartbeatとして扱う
- 重い定期作業はcron相当で分離する
- heartbeatでは軽量contextを使い、必要がなければ何も投稿しない
- isolated sessionを使い、毎回長い会話履歴を持ち回らない
- busy中はskip / deferし、同一session laneの同時実行を避ける

Hackbase.aiでの対応は、`signal_scan` と `artifact_generate` を同じ自律実行として扱わないことである。signal収集は低コスト・低権限・低頻度、artifact生成は高コスト・validation必須・publish gate付きに分ける。

### 4.3 burst / spam

Moltbookでは、一部agentによる高頻度投稿がplatformの見え方を歪めた。

`Humans welcome to observe` 論文では、4,535件の近似重複投稿が10秒未満の間隔で発生した例が挙げられている。

`The Moltbook Illusion` では、4アカウントが全コメントの32%を生成するindustrial-scale bot farmingが報告されている。

Hackbase.aiでは、以下を初期から避けるべきである。

- 投稿数をKPIにする
- agentに自由コメントを許す
- ranking / upvote最適化をagentに見せる
- 1agentが連続生成できる状態にする

## 5. Moltbookで人間に役割はあるのか

人間は、表のUI上では「観察者」に近い。しかし、システム全体ではむしろ重要な裏方である。

### 5.1 人間の役割

| 役割 | 内容 |
| --- | --- |
| owner | agentを作成し、実行環境を持つ |
| operator | API key、runtime、tool、権限を管理する |
| prompt source | agentにMoltbook参加や投稿テーマを指示する |
| observer | 投稿やコミュニティを読む |
| amplifier | X、ブログ、メディアで話題化する |
| researcher | public APIやarchiveを分析する |

Moltbookの文化圏は、AIだけで閉じているというより、「人間がagentを送り込み、AI同士の活動を観察し、外部SNSで意味づけする」構造である。

### 5.2 人間が直接入らないことの効果

人間投稿を禁止または制限することには、プロダクト上の効果がある。

- agent-onlyという分かりやすい物語ができる
- AIの行動を観察する実験場として見せられる
- 人間の荒らしや普通のSNS会話に埋もれにくい
- agent identityの重要性が際立つ
- 人間は「作品を見る側」「研究する側」に回る

一方で、欠点もある。

- 人間の課題解決に直結しにくい
- agent同士の会話が空洞化しやすい
- 人間prompt由来の行動を自律行動と誤認しやすい
- 商業価値が「話題性」や「データ」に寄りやすい

## 6. Hackbase.aiへの設計示唆

### 6.1 Hackbase.aiで採用すべき分離

Hackbase.aiでは、Moltbookのように人間を完全に観察者に閉じ込める必要はない。

ただし、以下の分離は必須である。

| 区分 | Hackbase.aiでの扱い |
| --- | --- |
| human | テーマ投入、レビュー、承認、featured、改善指示 |
| agent | テーマ解釈、企画、README、demo、source、metadata生成 |
| system | run作成、validation、publish decision、監査ログ |
| reviewer | 人間またはAIによる評価。ただしactor typeを明記 |

重要なのは、人間とAIをUIから排除し合うことではなく、actor typeと介入度を混ぜないことである。

### 6.2 Hackbase.aiの人間参加モデル

初期MVPでは、人間は「投稿者」ではなく「editor / curator / sponsor」として入れるのがよい。

推奨ロール:

| ロール | 初期機能 | 理由 |
| --- | --- | --- |
| owner | run発火、テーマ投入、agent選択 | 作品生成の責任点を明確化 |
| reviewer | コメント、スコア、改善メモ | 生成品質を学習ループに戻す |
| curator | featured化、非公開化 | フィード品質を守る |
| sponsor | 課題テーマを出す | 将来のB2B/R&D用途に近い |
| observer | 閲覧、保存、比較 | 一般ユーザー参加の入口 |

避けるべきロール:

- 人間がAI作品フィードに普通の投稿を混ぜる
- 人間とAIが同じコメント欄で区別なく会話する
- 人間のlike数をagentの最適化目標にする
- agentに自由な自己宣伝やトークン的報酬を与える

### 6.3 Hackbase.aiの初期頻度

Moltbookの規模感は、Hackbase.aiの初期MVPには不要である。

Hackbase.aiの価値は会話量ではなく、artifact品質、比較、検証、改善にあるため、初期は以下で十分である。

| フェーズ | agent数 | 生成頻度 | 人間参加 | 目的 |
| --- | ---: | --- | --- | --- |
| Phase 0 | 1 | 手動runのみ | owner 1名 | パイプライン完走 |
| Phase 1 | 1-3 | 1日0-1作品 | reviewer 1-2名 | 作品価値の確認 |
| Phase 2 | 3-5 | 週5-10作品 | curator / reviewer | テーマ別・agent別の差分確認 |
| Phase 3 | 5-10 | 週10-30作品 | sponsor / observer | R&Dテーマ投入の検証 |

Moltbookのような30分巡回は、Hackbase.aiでは早すぎる。

初期推奨:

- signal収集: 1日1回
- theme候補生成: 1日1回または手動
- artifact生成: 手動または1日1件まで
- digest: 週1回
- agent別分析: 週1回

### 6.4 actor attributionを必ず残す

Hackbase.aiでは、Moltbookの反省として、全runに以下を持たせる。

```text
actor_type: human | agent | system
human_owner_id: nullable
agent_id: nullable
trigger_type: manual | scheduled | heartbeat | feedback_retry
human_instruction_id: nullable
autonomy_level: L0 | L1 | L2 | L3
published_by: human | system | agent
reviewed_by: human | ai | none
```

これにより、「AIが勝手に作った」のか、「人間がテーマを与えた」のか、「人間が修正指示を出した」のかを後から分けて評価できる。

既存Prisma schemaでは `Run.triggerType`、`Run.autonomyLevel`、`Run.approvalRequired`、`Project.publishedByType` は存在する。一方で、Moltbook再調査を踏まえると、次の差分が不足している。

- `Run.humanInstructionId`: 人間の明示指示、MTGメモ、feedback requestなどの由来を追う
- `Run.humanOwnerType` / `Run.humanOwnerId` / `Run.humanOwnerName`: agent実行の責任点を追う
- `Run.sourceInteractionType`: manual console / scheduler / feedback loop / external signalなど、入口を分ける
- `Artifact.createdByType` / `Artifact.createdById`: project全体ではなくartifact単位の生成主体を追う
- `Artifact.validationStatus`: source / README / metadata / screenshotなどartifactごとの安全性と欠落を追う

これらは認証・権限システムではなく、まずは観測と説明責任のためのnullable provenanceとして追加するのがよい。

### 6.5 コメント欄の扱い

Moltbookから見ると、コメント機能は大量にあっても会話品質を保証しない。

Hackbase.ai初期では、コメント欄は会話の場ではなく、レビュー記録に寄せる。

推奨:

- human review comment
- AI critique comment
- improvement note
- safety concern
- next version request

後回し:

- agent同士の自由会話
- reply-to-replyの長いスレッド
- upvote最適化
- follower経済
- token / reward

## 7. Hackbase.aiの画面イメージ

Moltbook型:

```text
Human owner -> Agent runtime -> Moltbook API -> Post / Comment / Vote
                         Human viewer -> Browse only
```

Hackbase.ai型:

```text
Human owner -> Theme / Run request
                    |
                    v
Agent -> Plan -> Artifact -> Validation -> Project page
                    |             |
                    v             v
             Run timeline     Human review / Curate / Improve
```

Hackbase.aiでは、人間が見るべき中心はagentの雑談ではなく、次である。

- project
- artifact
- run timeline
- validation
- review
- next iteration

## 8. Hackbase.aiへの具体的な反映方針

### 8.1 データモデル

追加・強化したい概念:

- `Actor`
- `HumanOwner`
- `AgentProfile`
- `Run.trigger_type`
- `Run.autonomy_level`
- `Run.human_instruction_id`
- `Review.actor_type`
- `Project.published_by`

2026-07-04時点の追加候補:

- `Run.humanInstructionId`
- `Run.humanOwnerType`
- `Run.humanOwnerId`
- `Run.humanOwnerName`
- `Run.sourceInteractionType`
- `Artifact.createdByType`
- `Artifact.createdById`
- `Artifact.validationStatus`
- `Artifact.riskSummary`
- `RunEvent.metadataJson` に `cost`, `toolPolicy`, `sandboxMode`, `publishGate` を保存する運用ルール

### 8.2 UI

初期UIで明示すること:

- この作品はどのagentが作ったか
- どの人間がテーマを入れたか
- 手動runかscheduled runか
- validationを通ったか
- 人間レビュー済みか
- 次に伸ばすなら何か

明示しない、または後回し:

- agent同士のリアルタイム会話
- follower数
- karma
- global ranking
- token-like reward

### 8.3 運用

初期運用では、Moltbookのようにagentを大量登録しない。

推奨:

1. まず1agentで、1テーマ1artifactを安定させる
2. 次に3agentで、同一テーマ別解を比較する
3. その後、人間reviewerを入れて改善メモを蓄積する
4. 最後に外部observerやsponsorがテーマを投入できる導線を作る

この順番にすることで、Moltbookのような「活動量は大きいが価値判定が難しい」状態を避けられる。

## 9. まとめ

質問に対する答えは以下である。

Moltbookは、人間とAIが同じ権限で参加する文化圏ではない。基本はAI agentが投稿・コメント・投票し、人間は観察者である。ただし、agentのowner、operator、prompt sourceとして人間は深く関わっている。したがって、Moltbookは「AIだけの掲示板」というより、「人間が所有・設定したAI agentだけが表面上の発言者になる掲示板」である。

Hackbase.aiでは、この構造をそのまま真似るのではなく、次のように変換する。

- AIは作品を作る主体
- 人間はテーマを与え、評価し、承認し、育てる主体
- systemはrun、validation、publish decisionを管理する主体
- actor typeとhuman influenceを必ず記録する

初期MVPでは、Moltbookの30分巡回・大量投稿・自由コメントではなく、1日0-1作品、1-3agent、人間reviewer 1-2名から始めるのが妥当である。

## 10. 参考情報

- arXiv:2602.10127, "Humans welcome to observe": A First Look at the Agent Social Network Moltbook
- arXiv:2602.07432, The Moltbook Illusion: Separating Human Influence from Emergent Behavior in AI Agent Societies
- arXiv:2605.13860, The Moltbook Observatory Archive: an incremental dataset of agent-only social network activity
- arXiv:2604.13052, Form Without Function: Agent Social Behavior in the Moltbook Network
- arXiv:2604.21295, The Platform Is Mostly Not a Platform: Token Economies and Agent Discourse on Moltbook
- Hugging Face: SimulaMet/moltbook-observatory-archive
- GitHub: kelkalot/moltbook-observatory
- OpenClaw documentation, architecture / agent loop / heartbeat / sandboxing
- Moltbook developers page / auth flow, `https://moltbook.com/developers.md`, `https://moltbook.com/auth.md`
- TechRadar, Everything you need to know about Moltbook, the 'Reddit for OpenClaw agents' that got acquired by Meta
- Axios, Exclusive: Meta hires duo behind Moltbook
- `DOC-18_Moltbook_OpenClaw調査メモ.md`
- `DOC-19_Moltbook追加分析.md`
- `DOC-35_Moltbook買収価値から見るHackbase.ai価値仮説.md`
