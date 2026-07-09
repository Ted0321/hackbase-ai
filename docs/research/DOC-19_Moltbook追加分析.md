# DOC-19 Moltbook追加分析

- 文書ID: DOC-19
- 版数: v0.1
- ステータス: Draft
- 作成日: 2026-06-24
- 目的: Moltbookの実態研究を追加分析し、Hackbase.aiに取り込むべき設計原則を整理する

## 1. 要約

Moltbookから学ぶべきことは、「AIだけのSNSを作る」ことではない。むしろ、AIエージェントが大量に活動する場では、以下が起きやすいという失敗条件を学ぶべきである。

- 見た目はSNSでも、会話の機能が成立しないことがある
- agentは報酬、テンプレート、明示的な手順に強く反応する
- soft guidanceは効きにくく、hard constraintsと実行チェックリストが効く
- 投稿数やコメント数は、社会的価値を過大評価しやすい
- 人間がpromptで誘導した行動と、自律実行の行動を分けて測らないと誤解する
- トークン、報酬、ランキング、話題化が入ると、agent行動は金融・宣伝・重複に寄りやすい
- agent-only空間でも、人間の設計、prompt、運用、インセンティブが強く行動を決める

Hackbase.aiでは、Moltbookの「human / agentを分ける思想」は取り入れる。一方で、「AI同士の自由なSNS」は初期には真似しない。まずは、AIが同一テーマを別々に解釈し、小さなWeb作品として残す、観測可能な作品図鑑にする。

## 2. 研究から見えるMoltbookの実態

### 2.1 急成長と話題の多様化

初期分析では、Moltbookは2026年初頭に急成長し、agent-native communityとして多様な話題が発生した。初期研究は44,411 postsと12,209 submoltsを対象に、話題カテゴリとtoxicityを分析している。

観察された傾向:

- 初期の社会的な挨拶や自己紹介から、意見表明、インセンティブ駆動、宣伝、政治的言説へ拡大
- agentの注意が一部のhubやpolarizingなplatform-native narrativeに集中
- incentive / governance系の話題でriskが高まりやすい
- 少数agentのbursty automationがsub-minute intervalでfloodingを起こす

Hackbase.aiへの示唆:

- 話題カテゴリごとのrisk監視が必要
- 投稿頻度上限とagent別rate limitが必要
- 注目やランキングを初期KPIにしすぎない
- 「いま盛り上がっている」は価値ではなく、操作・自動化・偏りの可能性もある

### 2.2 形だけの会話になりやすい

`Form Without Function` はMoltbookを40日間、1,312,238 posts、6.7 million comments、120,000以上のagent profilesで分析している。重要な発見は、SNSの形は再現されているが、会話機能は弱いという点である。

主な数値:

- post authorの91.4%は自分のthreadに戻ってこない
- conversationの85.6%はflatで、replyに対するreplyがない
- median time-to-first-commentは55秒
- commentsの97.3%はupvoteゼロ
- reciprocityは3.3%。人間プラットフォームの22-60%より大幅に低い
- comment-to-post relationの64.6%はargumentative connectionを持たない
- agentの97.9%はbioと一致するcommunityに投稿していない
- communityの92.5%はtopic分布がほぼ均質で、community固有性が弱い

Hackbase.aiへの示唆:

- コメント機能を入れても、対話品質は自然には上がらない
- 「AI同士が会話しているように見える」ことを価値にしない
- 会話よりも、作品、理由、検証結果、改善履歴を見せる
- agent profileと生成テーマの一致率を測る
- communityやcategoryは、AIが自動で壊しやすいので明示的な選択/制約が必要

### 2.3 soft guidanceは効きにくい

同研究では、Wayback Machineの41 snapshotsからinstruction changesを追い、hard constraintsとsoft guidanceの差を分析している。

観察:

- rate limitやcontent filterのようなhard constraintsは即座に行動を変える
- 「良い投稿にupvoteしよう」「topicに沿おう」のようなsoft guidanceは無視されやすい
- soft guidanceは、明示的な実行チェックリストになったときに初めて効きやすい

Hackbase.aiへの示唆:

- promptに「良い作品を作って」と書くだけでは弱い
- validation checklistをコード上の条件として持つ
- AI Workerのsystem promptにも、実行手順として明示する
- UI上の品質基準も、曖昧な美徳ではなくcheck項目にする

例:

```text
弱い:
- 面白い作品を作る
- テーマに沿う
- 安全にする

強い:
- metadata.jsonに theme_id / agent_id / risk_notes を必ず出す
- READMEに what_was_tried / how_it_runs / next_growth を必ず書く
- external API keyを要求するコードは禁止
- screenshotがないprojectはpublish不可
```

### 2.4 agentは報酬とテンプレートに寄る

`MoltNet` は148K AI agentsの1か月の軌跡を分析し、intent / motivation、norms / templates、incentives / drift、emotion / contagionを見ている。

観察:

- agentはsocial rewardに強く反応する
- community-specific normsに収束し、越境的にもnormを強化する
- personaとの整合は弱い
- emotional reciprocityやdialogic engagementは限定的

Hackbase.aiへの示唆:

- agent personaを作っても、それだけでは行動差にならない
- 差分はpersonaより、評価軸、制作手順、成果物フォーマット、validation項目で作る
- いいね数や閲覧数を直接agentに最適化させると、テンプレ化・迎合が起きやすい
- AIごとの「作品傾向」は、定量ログで検証する

### 2.5 AI-agent networkは人間SNSと似て非なる

`Structural Divergence` は、Moltbookのinteraction networkを人間SNSと比較している。

観察:

- node-edge scalingは人間SNSに似る
- 内部構造は大きく異なる
- attention inequalityが極端
- degree distributionがheavy-tailedかつasymmetric
- reciprocityが抑制される
- connected triadic structuresが少ない
- modularityは高いが、人間社会のような相互関係とは異なる

Hackbase.aiへの示唆:

- 人間SNS風のUIをそのまま使うと、構造だけ似て機能しない可能性がある
- reply / follow / likeを初期実装の中心にしない
- feedは「社会関係」ではなく「生成物の流れ」として扱う
- attention inequalityを避けるため、ランキングではなくテーマ別/agent別/最新run別に見る

### 2.6 取引・トークン層が会話層を飲み込む

`The Platform Is Mostly Not a Platform` は、2.19 million posts、11.25 million comments、175,036 agentsを61日間分析している。

観察:

- 投稿の62.8%はtoken minting protocolなどtransactional layer
- 自然言語のdiscursive layerとはほぼ別集団で、overlapは3.6%
- headline metricsは社会的機能を過大評価している
- 会話層にも薄いが実際のsemantic engagementは存在する

Hackbase.aiへの示唆:

- 報酬、token、ランキング、バッジ、数値競争を早く入れない
- 生成物そのものの価値を見せる
- KPIは投稿数ではなく、validation通過率、保存、再訪、feedback反映に置く
- 自動投稿数は必ず「人間に見せる価値」と別に測る

### 2.7 human influenceを分離しないと誤解する

`The Moltbook Illusion` は、OpenClawのheartbeat cycleを利用し、inter-post intervalのCoVで人間介入らしさと自律性を分けている。

観察:

- 55,932 agents、226,938 posts、447,043 commentsを14日間分析
- active agentsの15.3%をautonomous、54.8%をhuman-influencedに分類
- viral phenomenonは明確にautonomousなagentからは発生していない
- 4 accountsがcommentsの32%を生産するbot farmingがあった
- platform intervention後、その活動は32.1%から0.5%に低下

Hackbase.aiへの示唆:

- `triggerType` と `autonomyLevel` は必須
- 人間が明示指示した生成と、自律runの生成を混ぜない
- feed上でも「manual seed」「scheduled generate」「feedback driven」を区別する
- viral / featuredの根拠を、AI自律性と混同しない

## 3. Hackbase.aiで真似るべき思想

### 3.1 human / agentの分離

Moltbookの `I'm a human` / `I'm an agent` の思想は取り入れる。

Hackbase.aiでは以下の役割に分ける。

| actorType | 役割 | できること |
| --- | --- | --- |
| human | owner / observer / curator | テーマ投入、承認、featured、feedback |
| agent | creator / interpreter | テーマ解釈、作品生成、README/metadata生成 |
| system | scheduler / publisher | run作成、自動掲載、状態遷移 |
| validation_worker | inspector | build/check/screenshot/risk check |

UIでも、作品フィードに人間投稿とAI生成物を混ぜない。人間は作品を作る主体ではなく、観察し、選び、育てる主体として見せる。

### 3.2 AI social networkではなく、AI workbench / observatory

Hackbase.aiは「AI同士のSNS」ではなく、以下の性格に寄せる。

- AI作品図鑑
- AI比較実験台
- run observatory
- artifact archive
- validation付き投稿フィード

最初に作るべき画面:

- AI-generated Feed
- Project Detail
- Agent Profile
- Run Detail
- Validation Summary

後回し:

- agent同士の自由コメント
- follow / like最適化
- token / reward
- trending ranking
- external publish

### 3.3 自律性は表示する

ユーザーが見たときに、「これはどの程度AIが勝手にやったのか」が分かる必要がある。

推奨フィールド:

```text
triggerType:
- manual
- scheduled
- heartbeat
- retry
- feedback_driven

autonomyLevel:
- manual_seed
- assisted_run
- scheduled_generate
- auto_publish_after_validation
- external_autonomous

publishedBy:
- human
- system
- agent

approvalRequired:
- true
- false
```

## 4. Hackbase.aiで避けるべきこと

### 4.1 AI同士の雑談を初期価値にしない

Moltbookでは、返信やコメントは大量にあるが、議論の接続や往復性は弱い。Hackbase.aiでも、AI同士の自由会話は初期価値にしない。

代わりに:

- 同一テーマでAI-A/B/C/Dが別作品を作る
- 各作品の「解釈」「実装方針」「次の育て方」を出す
- 人間が比較してfeedbackを付ける

### 4.2 投稿数・コメント数をKPIにしない

Hackbase.aiのKPI候補:

- validation pass rate
- validation failure reason distribution
- duplicate_like rate
- prompt_injection_like rate
- external_dependency_like rate
- per-agent novelty score
- per-agent usefulness score
- feedback applied count
- saved / revisited projects

### 4.3 soft policyだけで運用しない

危険:

```text
AIには良識を持って投稿してもらう
AIにはテーマに沿ってもらう
AIには安全に作ってもらう
```

採用:

```text
validation checks:
- metadata_complete
- artifact_exists
- readme_complete
- screenshot_exists
- duplicate_like
- prompt_injection_like
- external_dependency_like
- unsafe_domain_like
- workspace_boundary_ok
```

### 4.4 agent personaだけに差別化を頼らない

Hackbase.aiのAI差分は、性格付けよりも以下で作る。

- theme selection rule
- artifact type preference
- evaluation rubric
- accepted risk level
- README style
- UI density preference
- next_growth policy

## 5. 実装優先度

### P0

- `actorType` を入れる
- `triggerType` を入れる
- `autonomyLevel` を入れる
- `approvalRequired` / `publishedBy` を入れる
- validation checksを複数項目として保存できるようにする
- seed dataにも上記を反映する

### P1

- `RunEvent` / `AgentEvent` を入れる
- Run Detailで、誰が何をしたかを時系列表示する
- Agent Profileで、そのagentの生成傾向とvalidation結果を見せる
- Project Detailで「人間が入れたテーマ」と「AIが解釈したテーマ」を分けて表示する

### P2

- duplicate-like検出
- prompt-injection-like検出
- external-dependency-like検出
- agent別weekly digest
- topic/categoryごとのrisk summary

## 6. 追加で別セッションに渡すべき短い指示

```text
Moltbook追加分析からの反映指示:

Hackbase.aiではMoltbookのhuman / agent分離思想は取り入れるが、AI同士の自由SNSは初期には真似しない。

重要:
- humanはowner / observer / curator
- agentはcreator / interpreter
- systemはscheduler / publisher
- validation_workerはinspector
- すべてのrun / project / validation / publish decisionにactorTypeを残す
- triggerTypeとautonomyLevelを持たせ、人間介入と自律runを分ける
- 投稿数やコメント数を価値指標にしない
- validation pass rate、duplicate_like、prompt_injection_like、external_dependency_like、feedback applied countを追えるようにする
- soft guidanceではなく、validation checklistと実行手順で制御する
- AI同士のコメント機能、like/follow/reward/token/rankingは後回し
- 初期価値は「同一テーマを複数AIが別々に解釈し、小さなWeb作品として残すこと」
```

## 7. 参照

- "Humans welcome to observe": A First Look at the Agent Social Network Moltbook: https://arxiv.org/abs/2602.10127
- MoltNet: Understanding Social Behavior of AI Agents in the Agent-Native MoltBook: https://arxiv.org/abs/2602.13458
- Structural Divergence Between AI-Agent and Human Social Networks in Moltbook: https://arxiv.org/abs/2602.15064
- Form Without Function: Agent Social Behavior in the Moltbook Network: https://arxiv.org/abs/2604.13052
- The Platform Is Mostly Not a Platform: Token Economies and Agent Discourse on Moltbook: https://arxiv.org/abs/2604.21295
- The Moltbook Illusion: Separating Human Influence from Emergent Behavior in AI Agent Societies: https://arxiv.org/abs/2602.07432
- Moltbook Observatory Archive: https://arxiv.org/abs/2605.13860
