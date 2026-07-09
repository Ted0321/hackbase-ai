# DOC-13 AI自律Hackbase.ai Artifact Storeパス規約

- 文書ID: DOC-13
- 版数: v0.1
- ステータス: Draft
- 作成日: 2026-06-24
- 更新日: 2026-06-24
- オーナー: TBD

## 1. 目的
AI自律Hackbase.ai MVPにおいて、AIが生成した作品ソース、README、metadata、screenshot、build/run/validationログなどを保存するArtifact Storeのパス規約を定義する。

本規約により、自律実行run、テーマ、AI、作品、Validation結果を後から追跡しやすくする。

## 2. 対象範囲
### 対象
- run単位の保存ディレクトリ
- theme候補と採用themeの保存
- project単位の成果物保存
- screenshot保存
- build / run / validationログ保存
- 失敗作品の保存
- Web Appから参照する代表artifact

### 非対象
- クラウドストレージ運用詳細
- CDN配信設計
- バックアップ設計
- 長期アーカイブ方針
- 作品プレビューのSandbox実装詳細

## 3. 基本方針
- Artifactはrun単位でまとめる
- projectは必ずrun、theme、agentと紐づく
- DBにはArtifactの実体ではなく、相対パスとメタ情報を保存する
- 成功作品と失敗作品の両方を保存する
- 生成途中の一時ファイルと掲載対象ファイルを分ける
- 人間がファイルツリーを見ても意味が分かる命名にする
- MVP初期はローカルファイルシステムを前提にする

## 4. ルートディレクトリ
MVP初期のArtifact Storeルートは以下を推奨する。

```text
artifacts/
```

将来的にクラウドストレージへ移行する場合も、以下の相対パス構造を維持する。

## 5. ID命名方針
### 5.1 推奨形式
| 種別 | 形式 | 例 |
|---|---|---|
| run_id | run_YYYYMMDD_HHMMSS | run_20260624_153000 |
| theme_id | theme_slug | theme_ai_tool_overload |
| candidate_id | cand_slug_shortid | cand_ai_tool_overload_a1b2 |
| project_id | proj_agent_theme_shortid | proj_a_tool_triage_f3k9 |
| agent_id | agent_a / agent_b / agent_c / agent_d | agent_a |

### 5.2 注意
- ファイルシステム互換のため、IDは英数字、ハイフン、アンダースコアのみを使う
- 日本語タイトルはmetadataに保存し、パスにはslugを使う
- 日時はJSTでもUTCでもよいが、プロジェクト内で統一する

## 6. 全体ディレクトリ構造
```text
artifacts/
  runs/
    run_20260624_153000/
      run.json
      signals/
      themes/
      projects/
      logs/
      summary/
  published/
    proj_a_tool_triage_f3k9/
  archived/
  rejected/
```

### 6.1 runs/
自律実行runごとの作業成果を保存する。

### 6.2 published/
Web Appが参照しやすい掲載済み作品へのコピーまたは参照用ディレクトリを保存する。

### 6.3 archived/
人間が投稿後にアーカイブした作品を保存する。

### 6.4 rejected/
人間が投稿後に明示的に取り下げた作品を保存する。

## 7. runディレクトリ
```text
artifacts/runs/{run_id}/
  run.json
  signals/
  themes/
  projects/
  logs/
  summary/
```

### 7.1 run.json
run全体のサマリを保存する。

```json
{
  "run_id": "run_20260624_153000",
  "status": "completed_with_failures",
  "trigger_type": "manual",
  "started_at": "2026-06-24T15:30:00+09:00",
  "completed_at": "2026-06-24T15:44:00+09:00",
  "selected_theme_id": "theme_ai_tool_overload",
  "generated_project_count": 4,
  "published_project_count": 3,
  "failed_project_count": 1
}
```

## 8. signalsディレクトリ
```text
artifacts/runs/{run_id}/signals/
  signals.json
  raw/
```

### 8.1 signals.json
収集したシグナルの一覧を保存する。

### 8.2 raw/
外部シグナルや内部メモの元データを保存する。MVP初期では空でもよい。

## 9. themesディレクトリ
```text
artifacts/runs/{run_id}/themes/
  candidates.json
  selected_theme.json
  rejected_candidates/
```

### 9.1 candidates.json
Theme Curatorが生成したテーマ候補をすべて保存する。

### 9.2 selected_theme.json
採用テーマを保存する。

### 9.3 rejected_candidates/
不採用テーマを個別ファイルで保存する場合に使う。

```text
rejected_candidates/
  cand_ai_tool_learning_d4e5.json
  cand_meeting_overload_z9x1.json
```

## 10. projectsディレクトリ
```text
artifacts/runs/{run_id}/projects/
  {project_id}/
    project.json
    source/
    README.md
    metadata.json
    screenshots/
    logs/
    validation/
```

project単位のすべての成果物を保存する。

## 11. project.json
DBに入るprojectメタデータのスナップショットを保存する。

```json
{
  "project_id": "proj_a_tool_triage_f3k9",
  "run_id": "run_20260624_153000",
  "theme_id": "theme_ai_tool_overload",
  "agent_id": "agent_a",
  "title": "Trend Triage Board",
  "status": "auto_published",
  "artifact_root": "runs/run_20260624_153000/projects/proj_a_tool_triage_f3k9"
}
```

## 12. source/
生成された作品ソースを保存する。

```text
source/
  package.json
  index.html
  src/
  public/
```

### 方針
- AIが生成した実体はsource/配下に置く
- 作品が単一HTMLの場合もsource/に置く
- 生成途中ファイルはsource/に混ぜず、logs/またはtmp/へ置く

## 13. README.md
作品の説明と起動手順を保存する。

必須内容:
- 作品概要
- 起動手順
- 何を試した作品か
- 想定ユースケース
- 次にどう育てられるか

## 14. metadata.json
作品表示とValidationに必要なメタデータを保存する。

```json
{
  "title": "Trend Triage Board",
  "one_liner": "話題のOSSを試す・監視・保留・無視に仕分ける整理UI",
  "agent_id": "agent_a",
  "theme_id": "theme_ai_tool_overload",
  "category": "業務支援ミニツール",
  "what_was_tried": "増え続けるAIツールを意思決定しやすく仕分ける体験",
  "use_case": "PMや新規事業担当が新しいツールの試用優先度を決める",
  "how_it_runs": "npm install && npm run dev",
  "next_growth": "チーム評価や試用ログを追加すると実務利用に近づく",
  "screenshot_paths": [
    "screenshots/cover.png"
  ]
}
```

## 15. screenshots/
```text
screenshots/
  cover.png
  desktop.png
  mobile.png
```

### 方針
- cover.png は必須
- desktop.png と mobile.png はP1
- Web Appの作品カードではcover.pngを使う
- Validationではcover.pngの存在をP0条件にする

## 16. logs/
```text
logs/
  generation.log
  build.log
  run.log
  screenshot.log
  error.log
```

### 方針
- AI生成過程の要約はgeneration.logへ保存する
- build結果はbuild.logへ保存する
- 起動結果はrun.logへ保存する
- screenshot取得結果はscreenshot.logへ保存する
- 失敗時の主要エラーはerror.logへ保存する

## 17. validation/
```text
validation/
  validation.json
  checks.json
  report.md
```

### 17.1 validation.json
Validation結果の機械可読なサマリを保存する。

```json
{
  "project_id": "proj_a_tool_triage_f3k9",
  "status": "pass",
  "build_status": "pass",
  "run_status": "pass",
  "screenshot_status": "pass",
  "metadata_status": "pass",
  "risk_status": "pass",
  "duplicate_status": "pass",
  "checked_at": "2026-06-24T15:42:00+09:00"
}
```

### 17.2 checks.json
個別チェックの詳細を保存する。

### 17.3 report.md
人間が読むためのValidationレポートを保存する。

## 18. run logs
run全体のログは以下に保存する。

```text
artifacts/runs/{run_id}/logs/
  scheduler.log
  signal_collector.log
  theme_curator.log
  orchestrator.log
  publisher.log
  errors.log
```

## 19. summary
```text
artifacts/runs/{run_id}/summary/
  run_summary.md
  published_projects.json
  failed_projects.json
```

### 19.1 run_summary.md
人間がrun結果を確認するためのサマリ。

### 19.2 published_projects.json
自動掲載された作品一覧。

### 19.3 failed_projects.json
Validation失敗または生成失敗した作品一覧。

## 20. publishedディレクトリ
```text
artifacts/published/
  {project_id}/
    project.json
    metadata.json
    README.md
    screenshots/
    source_ref.json
```

### 方針
- published/ はWeb Appが参照しやすい掲載済み作品の入口にする
- sourceはコピーしてもよいが、初期はsource_ref.jsonでrun配下を参照する方針を推奨する
- 作品の実体は原則 runs/{run_id}/projects/{project_id}/ に残す

### source_ref.json
```json
{
  "artifact_root": "runs/run_20260624_153000/projects/proj_a_tool_triage_f3k9",
  "source_path": "runs/run_20260624_153000/projects/proj_a_tool_triage_f3k9/source"
}
```

## 21. failed projectの扱い
Validationに失敗した作品もrun配下に保存する。

```text
artifacts/runs/{run_id}/projects/{project_id}/
```

ただし published/ には出さない。

### 保存する理由
- 失敗理由を後から確認する
- AI別の失敗傾向を見る
- Validation改善に使う
- 再実行や修正の材料にする

## 22. archived / rejected
### archived
投稿後に、人間がショーケースから外したが記録として残す作品。

### rejected
投稿後に、不適切または低品質として明示的に取り下げた作品。

```text
artifacts/archived/{project_id}/
artifacts/rejected/{project_id}/
```

MVP初期では、実体を移動せずDB statusだけ変更し、必要に応じて参照ファイルを置く運用でもよい。

## 23. DBに保存するパス
DBにはArtifact Storeルートからの相対パスを保存する。

例:

```text
runs/run_20260624_153000/projects/proj_a_tool_triage_f3k9
runs/run_20260624_153000/projects/proj_a_tool_triage_f3k9/screenshots/cover.png
published/proj_a_tool_triage_f3k9
```

絶対パスは環境差分が大きいため、原則DBへ保存しない。

## 24. パスとDBの対応
| DB項目 | 保存例 |
|---|---|
| projects.artifact_root | runs/{run_id}/projects/{project_id} |
| projects.thumbnail_path | runs/{run_id}/projects/{project_id}/screenshots/cover.png |
| artifacts.path | runs/{run_id}/projects/{project_id}/README.md |
| artifacts.type | readme / metadata / screenshot / source / build_log |

## 25. 命名ルール
### ディレクトリ
- 小文字英数字、ハイフン、アンダースコアを使う
- 日本語は使わない
- 空白は使わない

### ファイル
- 固定名にできるものは固定名にする
- screenshotの代表画像は cover.png にする
- JSONはUTF-8で保存する
- MarkdownはUTF-8で保存する

## 26. MVP初期の最小構成
最初は以下だけでよい。

```text
artifacts/
  runs/
    {run_id}/
      run.json
      themes/
        candidates.json
        selected_theme.json
      projects/
        {project_id}/
          project.json
          source/
          README.md
          metadata.json
          screenshots/
            cover.png
          logs/
            build.log
            run.log
            error.log
          validation/
            validation.json
      summary/
        run_summary.md
  published/
    {project_id}/
      source_ref.json
      metadata.json
      screenshots/
        cover.png
```

## 27. 未決事項
- published/ にsourceをコピーするか、参照だけにするか
- archived / rejected で実体を移動するか、DB statusだけ変えるか
- run_idの時刻をUTCにするかJSTにするか
- screenshotのdesktop/mobileをMVP初期から必須にするか
- Artifact Storeを将来クラウドへ移行する際のパス互換方針
- source/内にnode_modules等の生成物を保存しないルールの徹底方法

## 28. 次アクション
- SQLite / Prisma想定の簡易DDLを作成する
- 初期シードデータを作成する
- Validation結果JSONスキーマを定義する
- 作品プレビュー配信方式を設計する
