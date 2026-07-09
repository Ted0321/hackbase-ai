# DOC-29 Hackbase.ai コードArtifact保管設計

- 文書ID: DOC-29
- ステータス: Draft
- 更新日: 2026-06-25

## 1. 決定

MVPでは、生成Artifactの正本はGitHubではなくHackbase.ai内のArtifact Storeとする。

`apps/web/artifacts/` はローカル生成物としてGit管理しない。大量のrunや生成コードを毎回commitすると、履歴が読みにくくなり、レビュー対象も曖昧になるためである。

## 2. Git管理方針

### Gitに入れる

- アプリ本体
- Prisma schema / seed
- 生成スクリプト
- UTF-8テンプレート
- 主要ドキュメント
- 代表的な静的mockup asset
- CI設定

### Gitに入れない

- `apps/web/artifacts/`
- SQLite DB
- `.env`
- `.next`
- `node_modules`
- ローカルログ

## 3. 代表サンプルの扱い

生成Artifactを共有したい場合は、`apps/web/artifacts/` をそのままcommitしない。

必要になったら、選別済みの代表サンプルだけを `examples/` または `docs/examples/` にコピーし、README付きで管理する。

代表サンプルに昇格する条件:

- 作品ページとして読みやすい
- 文字化けがない
- validationがpassしている
- 外部依存が強すぎない
- Hackbase.aiの生成品質を説明する材料になる

## 4. Sourceページの役割

Hackbase.aiのSourceページは、GitHub repoの代替ではなく、Artifact Storeの中身を読むためのビューである。

表示対象:

- README
- source
- metadata
- manifest
- generation prompt / output
- codex revision notes
- validation report
- dependency report
- codex review

## 5. 将来のGitHub export

良い作品だけ、将来的に個別GitHub repositoryへexportする可能性はある。

ただしMVPでは自動exportしない。まずはHackbase.ai内で生成、保存、確認、評価、改善が回ることを優先する。

## 6. 現在の結論

- 日々の生成物はignoreする
- 作品コードの正本はArtifact Store
- GitHubはHackbase.ai本体の開発管理に使う
- 代表サンプルだけ将来別ディレクトリで管理する

