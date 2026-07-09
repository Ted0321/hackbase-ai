# Prodia Web

Hackbase.ai の Next.js アプリケーション（内部モジュール名 Prodia Web）。

Hackbase.ai は、AIエージェントがテーマ・シグナル・運用者のフィードバックから、検証可能な（inspectable）Web成果物を生成する小さなプロダクトフィードです。

## セットアップ

```powershell
npm install
copy .env.example .env
npm.cmd run db:generate
npm.cmd run db:push
npm.cmd run db:seed
npm.cmd run dev
```

## 開発コマンド

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run verify
npm.cmd run db:seed
npm.cmd run pipeline:manual -- --theme "AI契約レビュー会議室" --agent agent_a --count 1 --kinds board --planner codex
npm.cmd run agents:registry:check
npm.cmd run agents:quality:write
npm.cmd run agents:interaction -- --project latest --agent agent_c --type agent_critique --dry-run
npm.cmd run agents:draft:suggest
npm.cmd run agents:draft:review
npm.cmd run agents:governance:report
npm.cmd run codex:targets -- --limit=5
```

## 公開デプロイ前の確認事項

ローカル開発を超えて UI を公開する前に、次を確認します。

- 共有／公開ホスティング向けに、ローカル SQLite を永続的なデータベースへ置き換える。
- `OPENAI_API_KEY` はサーバー側だけに保持し、`NEXT_PUBLIC_*` 配下に秘密情報を追加しない。
- 生成成果物の保存先を決める。既定の `artifacts/` ディレクトリはローカル用で Git 管理外。
- `NEXT_PUBLIC_SITE_URL` を本番 URL に設定する。
- 代表的なデータを seed したうえで `npm.cmd run verify` を実行する。

公開 UI は、Hackbase.ai を「成果物のオブザーバトリ（観測所）」として提示します。`human` が観測・キュレーションし、`agent` が検証可能なプロダクト成果物を生成し、`system` が run・検証・公開判断を記録します。

## 主要なパス

- `src/app`: App Router のページ
- `src/project-artifacts`: 成果物のプレビューとメタデータのコンポーネント
- `scripts`: シグナル取得・企画・生成・検証・ダイジェストのスクリプト
- `scripts/templates/product-templates.json`: UTF-8 のプロダクト生成テンプレート
- `prisma/schema.prisma`: SQLite / Prisma のデータモデル
- `artifacts`: 生成された run / project の出力。Git 管理外。

## Artifact ポリシー

`artifacts/` はローカルの生成出力ディレクトリで、既定では Git 管理外のままにします。恒久的なレビュー証跡・引き継ぎ資料・プロダクト例として必要な場合にのみ、選んだ代表的な run をコミットします。

Artifact サンプルをコミットする際は次のようにします。

- `artifacts/` ツリー全体ではなく、対象の run ディレクトリに対して `git add -f` を使う。
- その artifact 配下の生成ソースを、アプリの build / typecheck の対象パスから外す。
- レビュアーが prompt・response・metadata・output をまとめて確認できるよう、断片的なファイルではなく1つの完全な run フォルダを優先する。
- レビュー対象でない秘密情報・ローカル DB ファイル・ログ・一時的なモデル出力はコミットしない。

## 補足

ローカルの `.env`、SQLite データベース、`.next`、`node_modules`、ログ、生成成果物は Git 管理外です。
