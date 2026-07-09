# 注目プロダクト勝ち筋リサーチ

最終更新: 2026-06-26  
ステータス: Draft

## 目的

Concept Strategist が「悪くないがグッとこない」企画に寄る問題を避けるため、近い領域のハッカソン受賞作、GitHub/OSS、個人開発プロダクト、AIプロダクトローンチを集め、どんな構造が面白さや注目につながっているかを抽出する。

この調査は、すぐにプロンプトへ反映する前の素材集である。個別事例の網羅性よりも、Hackbase.ai の企画生成に転用できる勝ち筋を見つけることを優先する。

## 成果物

- `apps/web/scripts/llm-pipeline/fixtures/product-research-schema.json`
  - 事例収集のスキーマ。
- `apps/web/data/product-research/product_research_dataset.json`
  - 初版の構造化 dataset。
- 本ドキュメント
  - 初期分類と Concept prompt への示唆。

## 追加拡張メモ（53件版）

2026-06-26時点で dataset は53件まで拡張した。内訳は `hackathon_winner: 11`、`github_oss: 5`、`indie_product: 8`、`platform_product: 14`、`research_signal: 15`。`Hackbase.aiApplicability: high` は31件。

初版21件から拡張して見えたのは、単に「面白いAIアプリ」を探すより、次の5つの構造を持つ事例が Hackbase.ai の企画生成に転用しやすいということ。

### 追加観測1. 既存画面にAIの手を入れるものが強い

Lovable、Replit Agent、Base44、v0、Windsurf、DeepWiki などは、AI単体のチャットではなく、既存の作業対象にAIが入り込む。

Concept への示唆:

- 「AIが何を作るか」より「どの既存面にAIが手を伸ばすか」を先に決める。
- 候補面は、YouTube、GitHub、ブラウザ、社内資料、学習メモ、家計、ニュース、行政情報など。
- 画面上では、AIが見たもの、変えたもの、失敗しうる場所を見せる。

### 追加観測2. 学習・理解のパッケージ化は一般ユーザーにも届く

NotebookLM、Glasp、YT-Pilot、DeepWiki などは、素材を「理解しやすい道筋」に変える。エンジニア向けに閉じず、AIに関心がある非エンジニアにも分かりやすい。

Concept への示唆:

- `learning_package` は Concept Strategist の発想パターンに残す。
- ただし単なる要約ではなく、「何から見るか」「どこが分からないか」「次に何を試すか」まで変換する。
- GitHub repo、YouTube動画、ニュース、業務メモを、学習ロードマップや実験手順に変える案は相性が高い。

### 追加観測3. 信頼境界・失敗境界は企画の引きになる

Replit deletion incident、fake GitHub stars / StarScout、Codex Security、VOIX agentic web などは、AIや人気指標をそのまま信じる危うさを扱っている。

Concept への示唆:

- `trust_boundary` と `failure_analysis` は強いが、脅しの診断ツールにしない。
- 「AIに任せる前の練習場」「人気っぽさの見抜き方」「この情報はどこまで信じてよいか」のように、触って理解する形がよい。
- 技術者向けの安全論を、非エンジニアでも分かる小さなシミュレーションへ落とす。

### 追加観測4. 専門家が自分の痛みをAIで道具化する流れは再現性がある

Anthropic hackathon、Pinterest Makeathon、India AI Impact Summit 系の事例では、法律、医療、社内業務、教育、社会参加など、現場の痛みから小さなAI道具が生まれている。

Concept への示唆:

- `domain_pain_to_tool` は継続採用する。
- ただし「業務改善ツール」だけに寄せず、教育、社会参加、趣味、創作、生活の判断にも広げる。
- コンセプト生成時は「誰の、どの面倒な判断が、どんな小さな操作に変わるか」を必ず出させる。

### 追加観測5. 入力が別物に変わる瞬間が見えるものは伝わりやすい

Clueso、NotebookLM、v0、Lovable、Nano Banana hackathon 系の事例は、入力から成果物への変換が分かりやすい。

Concept への示唆:

- `transformation` は引き続き重要。
- ただし「カード化」「要約」だけでは弱い。
- 変換前、変換途中、変換後、比較、ユーザー調整の5点があると、触りたくなる企画になりやすい。

## 53件版の注意点

- `platform_product` と `research_signal` が厚く、純粋な `github_oss` はまだ5件に留まる。
- ハッカソン受賞作は、公開情報の粒度がまちまちで、機能よりストーリーが強く見える偏りがある。
- 次に精度を上げるなら、GitHub Trending/OSS、個人開発アプリ、Product Hunt/Indie Hackers 系の実プロダクトを追加して、実際に使われている小型プロダクトの型を増やす。

## 初期観測

### 1. ドメイン専門家がAIで作る

Anthropic ハッカソン系の事例では、エンジニアではない専門家が、自分の領域の摩擦をAI codingでプロダクト化している。

- 法律/許認可: CrossBeam
- 医療/説明: PostVisit.ai
- インフラ/投資判断: road footage to investment recommendations

勝ち筋は「AIがすごい」ではなく、「専門家が長年知っている面倒な手順を、AIで一気に小さな道具へ変える」こと。

Concept への示唆:

- `domain_pain_to_tool` という発想パターンが必要。
- 表面は一般ユーザー向けでもよい。
- 裏側は `workflow_generation` や `adaptive_explainer` が効く。

### 2. 既存ワークフローの中にAIが入る

OpenClaw、Workspace CLI、Figma Code Layers、Cursor などは、単独のAIチャットではなく、既存の作業面にAIを入れている。

勝ち筋は「新しいAI画面」ではなく、「すでに使っている場所でAIが手を伸ばす」こと。

Concept への示唆:

- 最初の画面は、ユーザーが知っている道具や状況の模型にすると分かりやすい。
- `agentic_workflow` は抽象語ではなく、メール、カレンダー、ブラウザ、デザインキャンバス、GitHub のような具体面に落とす。

### 3. 見えないAIの痕跡を見える化する

AIDev、AI coding agent census、HN star diffusion は、通常見えにくいAI利用やローンチ効果をデータ化している。

勝ち筋は「AIで何かを作る」ではなく、「AIによって起きている変化を観測可能にする」こと。

Concept への示唆:

- Hackbase.ai 自体の世界観と相性が高い。
- `radar`, `observability`, `comparison`, `evidence_weighting` は強い。
- ただしエンジニア向けに閉じすぎないよう、表面テーマを広げる必要がある。

### 4. 失敗と境界が面白い

AutoGPT のループ、Claude の CTF 失敗、ブラウザエージェント/拡張のリスクは、成功事例よりも企画の引きがある。

勝ち筋は「できること」より「どこで壊れるか」「どこまで任せてよいか」を触れる形にすること。

Concept への示唆:

- `failure_analysis`, `trust_boundary`, `simulation` は強い。
- ただし専門家向け注意喚起にすると狭い。
- 一般ユーザー向けには「AIにおつかいを頼む」「AIに任せすぎ診断」のような表テーマが必要。

### 5. 変換が見えると触りたくなる

PostVisit.ai、Figma AI tools、Nano Banana 系ハッカソン、Prompt-to-product 的な発想は、入力が別の形に変わる瞬間が分かりやすい。

勝ち筋は「AIが出力する」ではなく、「AがBに変わる」ことを画面上で見せること。

Concept への示唆:

- `transformation` と `stateChange` は ConceptBrief に必須化した方がよい。
- ただの要約やカード化では弱い。
- 入力、変換途中、出力の3点が見えると強い。

## 面白さパターン初版

### A. Domain Pain to Tool

専門家や現場ユーザーが知っている痛みを、小さなAI道具に変える。

例:

- 許認可手続き
- 医療説明
- インフラ点検
- 業務書類の判断

強い条件:

- 誰が困っているかが明確
- 入力データが具体的
- 出力が次の行動に変わる

### B. Existing Surface + AI Hand

メール、ブラウザ、デザインキャンバス、GitHub、YouTube など、既存の作業面にAIの手を伸ばす。

強い条件:

- ユーザーが既に知っている場所
- AIが何を見て何を動かすかが見える
- 権限や失敗境界も見える

### C. Hidden Trend Observatory

見えにくい変化を検出して見える化する。

例:

- AI agent commit traces
- HN exposure to GitHub stars
- Product Hunt launch signals
- GitHub repo novelty

強い条件:

- 生データの証拠がある
- ランキングではなく「見方」が変わる
- 自分の判断に使える

### D. Failure / Boundary Simulator

AIが失敗する場所、任せすぎる境界、権限の危険を触って理解する。

強い条件:

- ユーザー操作でリスクや結果が変わる
- 恐怖訴求ではなく理解につながる
- 実サービスの安全診断に見せない

### E. Transformation Arcade

ユーザーの入力が別の形に変わる過程を楽しむ。

例:

- アイデア -> 企画
- YouTube履歴 -> 学習ロードマップ
- GitHub repo -> 学習パッケージ
- ニュース -> 行動カード

強い条件:

- 変換前後の差が見える
- 複数ルートを比較できる
- ユーザーが自分の素材を入れたくなる

### F. Evidence-Weighted Decision Helper

流行・プロダクト・リポジトリ・ニュースを、根拠の強さで判断する。

強い条件:

- 何を信じてよいか分かる
- 弱い証拠も明示する
- ユーザーが重みを変えられる

## Concept Strategist への暫定ルール

次の prompt 改修では、`surfacePattern` / `aiMechanismPattern` に加えて、`ideaMove` を必須化する。

候補:

- `domain_pain_to_tool`
- `existing_surface_ai_hand`
- `hidden_trend_observatory`
- `failure_boundary_simulator`
- `transformation_arcade`
- `evidence_weighted_decision`
- `learning_package`
- `self_relevance`

ConceptBrief に追加したい項目:

```json
{
  "ideaMove": "string",
  "ideaMoveReason": "string",
  "userInput": "ユーザーが何を入れるか",
  "stateChange": "操作すると何が変わるか",
  "ahaMoment": "触った人が何に気づくか",
  "whyItIsNotJustSummary": "要約やカード化で終わっていない理由"
}
```

## 現時点の判断

直近の Concept 案で一番近いのは `アイデア変換アーケード` だが、まだ抽象的である。より強くするなら、GitHub/YouTube/業務メモなどユーザーが実際に持っている入力を入れて、変換過程と結果が変わるものにする必要がある。

`AIおつかいサンドボックス` は `Existing Surface + AI Hand` と `Failure / Boundary Simulator` の組み合わせとして筋がよい。ただし、表テーマをもっと日常的にしないとエンジニア寄りに戻る。

`警戒レベル行動カード` は `Domain Pain to Tool` と `Adaptive Explainer` として筋があるが、カード化だけだと弱い。状況選択で結果が変わる `stateChange` が必要。
