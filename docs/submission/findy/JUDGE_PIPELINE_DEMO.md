# 審査員向けパイプライン起動デモ手順

作成日: 2026-06-28

このメモは、審査員に「AIエージェントが企画から投稿まで進む流れ」をその場で見せるための最短手順である。通常の作品閲覧デモとは別に、`/human` の審査デモボタンから新しいrunを作る。

## 1. 見せたいこと

- Hackbase.aiは、AIエージェントが作った作品を並べるだけではない。
- Research Cacheの材料から制作パイプラインを起動し、新しいrunと作品を生成できる。
- 生成後は、run detailでテーマ、候補、生成物、validation、公開状態を追える。
- 人間コンソールでは、エージェント、scheduler、レビュー、observabilityも同じ管理画面で見られる。

## 2. 事前確認

公開環境で見せる場合:

- Cloud Runの最新デプロイが完了していること。
- トップページ `/` に「審査デモを起動」CTAが表示されること。
- `/human` に「審査員デモ生成」セクションが表示されること。
- `npm run deploy:check -- --base-url=https://prodia-web-235acvjdba-an.a.run.app` が通っていること。

ローカルで見せる場合:

```powershell
cd apps/web
npm run demo:judge:check
npm run demo:judge:smoke
```

`demo:judge:smoke` は実際にrunを1件作る。録画前に余計なrunを増やしたくない場合は、`demo:judge:check` だけを使う。

## 3. 操作手順

### 0. トップページ

URL:

```text
https://prodia-web-235acvjdba-an.a.run.app/
```

操作:

1. トップページを開く。
2. ヒーローの「審査デモを起動」をクリックする。

話すこと:

> ここから審査員向けに、AI制作パイプラインをその場で起動できます。単なる静的デモではなく、生成runを作って、その工程証跡まで追えます。

### 1. 人間コンソール

URL:

```text
/human
```

操作:

1. 「審査員デモ生成」セクションまで移動する。
2. 「審査員デモ生成を開始」をクリックする。
3. 生成完了後、`/runs/{runId}` に遷移することを確認する。

話すこと:

> このボタンはResearch Cacheと保存済みプロダクト資料を使って、制作パイプラインを起動します。外部調査の再取得ではなく、審査中に安定して見せられる生成部分に絞っています。

### 2. Run detail

URL:

```text
/runs/{runId}
```

確認する箇所:

- run id
- trigger type
- generated theme / signal
- project candidate
- published project
- validation / artifact / source
- judge proof strip

話すこと:

> 生成されたものは、チャットログではなくrunとして残ります。どの材料から、どのテーマで、何が生成され、公開されたかを後から検証できます。

### 3. 生成された作品

操作:

1. run detail内の生成作品を開く。
2. project detail、demo、sourceの順に見せる。

話すこと:

> Hackbase.aiでは作品ページだけでなく、デモ、説明、ソース、validationをまとめて保存します。AIの出力を、提出可能な小さなproduct artifactとして扱っています。

### 4. 管理・観測面

URL:

```text
/human
```

確認する箇所:

- Agent operations
- Scheduler
- Reviewer / governance related rows
- Admin observability
- Model usage / human decisions / reviewer learning

話すこと:

> 制作担当エージェントだけでなく、レビュー、スケジュール、モデル利用量、人間判断、学習に使うフィードバックも管理対象にしています。MVPでは最小限ですが、運用に必要な観測点を先に置いています。

## 4. 失敗時の逃げ道

ボタン生成が失敗した場合:

1. `/runs` を開く。
2. 最新runまたは `run_20260624_seed` を開く。
3. 「本番デモでは安定性のためseed runも用意しています」と説明する。

代替URL:

```text
/runs
/runs/run_20260624_seed
```

話すこと:

> ライブ生成が失敗しても、同じデータ構造と表示面を持つseed runで工程証跡を確認できます。審査では失敗時もプロダクトの設計意図を見せられるようにしています。

## 5. 30秒説明

> Hackbase.aiは、AIエージェントが外部シグナルや保存済み資料から小さなWebプロダクトを作り、その過程をrunとして保存する場所です。この審査デモボタンを押すと、Research Cacheから制作パイプラインが走り、新しい作品と工程証跡が生成されます。作られたものだけでなく、材料、テーマ、生成結果、validation、公開状態まで追えるのが特徴です。

## 6. 録画チェック

- [ ] 公開URLまたはローカルURLが意図通りである。
- [ ] トップページの「審査デモを起動」が映っている。
- [ ] `/human` の「審査員デモ生成を開始」を押している。
- [ ] 生成後の `/runs/{runId}` が映っている。
- [ ] run detailから作品ページまたはdemo/sourceへ遷移している。
- [ ] 失敗時に備えて `/runs/run_20260624_seed` を開ける。
- [ ] localhost、secret、個人情報、不要なブラウザUIが映っていない。
