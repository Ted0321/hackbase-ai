# DOC-50 プロダクトソースインデックス調査運用計画

## 目的

Hackbase.ai の Step1 で使う `productSourceIndex` を、毎回ゼロから調査するのではなく、GitHub、ハッカソン作品、プロダクトギャラリー由来の小型プロダクト辞書として継続的に厚くする。

このインデックスはリンク集ではない。Step2 が企画へ転用できるように、各プロダクトの入力、出力、価値メカニズム、注目理由、転用可能構造、コピー禁止境界を保存する。

## 正本

- 人間編集の正本: `apps/web/data/product-research/index-tables/*.tsv`
- LLM パイプライン用生成物: `apps/web/data/product-research/source-product-index.json`
- 調査レスポンス投入先: `apps/web/data/research-exploration/*/response.json`
- 取り込み: `npm.cmd run research:index:update`
- 再生成: `npm.cmd run research:index:build`

`source-product-index.json` は手で直接編集しない。調査結果は `response.json` へ置き、保存ゲート経由で TSV と JSON に反映する。

## 登録基準

登録するもの:

- 最近注目され始めた GitHub リポジトリ
- ハッカソン winner / finalist / demo showcase / 小型プロトタイプ
- Product Hunt、Hugging Face Spaces、Show HN、indie launch などの小型公開デモ
- 入力から出力への変換が明確なもの
- UI、AI、ワークフロー、可視化、評価、生成、最適化のどれかに転用可能な構造があるもの

登録しないもの:

- ChatGPT、Claude、Gemini、Cursor、GitHub Copilot、Lovable、v0、Bolt、Replit、Figma、Notion、Slack、Linear などの大手・既知プロダクト
- 単なる awesome-list、フレームワーク、ディレクトリ
- URL だけで価値メカニズムが薄いもの
- `antiCloneBoundary` を明確に書けないもの
- 同一プロダクトの重複登録

## 必須フィールドの判断基準

| フィールド | 書く内容 |
| --- | --- |
| `name` | プロダクト名または repo 名 |
| `sourceCategory` | `github_rising`, `hackathon_demo`, `hackathon_winner`, `product_gallery`, `huggingface_space` など |
| `productUrl` / `codeUrl` / `url` | 最低1つは必須。GitHub は `productUrl` に repo URL を入れる |
| `concept` | 何をするものかを1文で書く |
| `problemSolved` | 解いている具体的な摩擦 |
| `targetUser` | 最初に得する人 |
| `coreUserInput` | ユーザーが渡すもの |
| `outputArtifact` | 返ってくる成果物 |
| `coreMechanism` | 入力から出力へ変える仕組み。40文字以上で具体化する |
| `interactionPattern` | ユーザーが触る、見る、比較する、制御する流れ |
| `whyItGotAttention` | 星、投稿、受賞、公開デモ、反応などの注目理由。35文字以上 |
| `transferableStructure` | 別テーマへ移せる価値構造。35文字以上 |
| `antiCloneBoundary` | コピーしてはいけない名前、領域、見せ方、主張 |
| `bestRemixTargets` | Hackbase.ai 側で転用しやすい領域 |
| `evidenceStrength` | `low`, `medium`, `high` |

## 作業順

1. 保存仕様をこの文書と `product-source-index-schema.json` に合わせる。
2. 調査テンプレートを埋め、1件ごとに価値メカニズムまで書く。
3. ソース巡回リストの順に候補を集める。
4. 初回は GitHub 5件、ハッカソン/Showcase 5件、Gallery 5件を作る。
5. `research:index:update -- --dry-run` で保存前検証を通す。
6. 本調査として合計30件前後まで拡張し、ゲート通過後に反映する。

## 巡回順

1. GitHub API search
   - `topic:ai-agent created:>2025-12-31 pushed:>2026-06-01 stars:>50`
   - `topic:developer-tools created:>2025-12-31 pushed:>2026-06-01 stars:>50`
   - `topic:education created:>2025-12-31 pushed:>2026-06-01 stars:>20`
2. Show HN
   - Algolia API `tags=show_hn`, query `AI`, date descending
   - GitHub repo 付き、または入力と出力が明確な公開デモを優先
3. ハッカソン
   - Devpost 個別ページ
   - AI hackathon winner pages
   - 大学、企業、コミュニティの demo showcase
   - Devpost 検索が空レスポンスの場合は、検索結果から個別 project / winner page を開いて確認
4. Hugging Face Spaces
   - `sort=likes` で反応済みデモ
   - `sort=createdAt` で新規デモ
   - 大手モデル本体ではなく、ユーザーが触れる小型デモを優先
5. Product gallery
   - Product Hunt
   - indie maker launch
   - AI tool directory は証拠が弱いので、公式ページやデモがある場合だけ登録

## 初回登録セット

2026-06-27 時点では、既存インデックスが6件だったため、手動調査レスポンスで24件を追加し、合計30件規模まで拡張する。

内訳:

- GitHub rising: 10件
- Hackathon / Show HN demo: 8件
- Product gallery / Hugging Face Spaces: 6件

Devpost 検索ページは 2026-06-27 の確認時点で HTTP 202 かつ本文空だったため、初回は API で裏取りできる GitHub、Show HN、Hugging Face を優先する。Devpost 個別ページの追加は次回の補強タスクに回す。
