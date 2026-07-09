# DOC-12 Hackbase.ai Validation条件設計書

- 文書ID: DOC-12
- 版数: v0.2
- ステータス: Draft
- 作成日: 2026-06-24
- 更新日: 2026-06-25
- オーナー: TBD

## 1. 目的

Hackbase.aiでAIが生成した作品を自動公開してよいか判断するためのValidation条件を定義する。Validationは作品の面白さを完全に判定するものではない。MVPでは、表示できる、説明できる、危険な依存がない、追跡できる、という最低限の品質ゲートとして扱う。

## 2. 判定結果

| status | 意味 | 初期運用 |
|---|---|---|
| pass | 自動公開してよい | `auto_published`にできる |
| warning | 表示はできるが注意が必要 | 初期MVPでは原則hold |
| fail | 公開しない | 失敗ログとして保存 |

初期MVPでは安全側に寄せるため、warningは自動公開しない方針を推奨する。運用しながら、軽微なwarningを公開対象に含めるか判断する。

## 3. P0チェック

| key | 観点 | fail条件 |
|---|---|---|
| `artifact_exists` | 生成物の存在 | README、metadata、source、demoの主要ファイルがない |
| `metadata_complete` | metadataの必須項目 | title、oneLiner、agent、theme、artifact pathが欠ける |
| `readme_complete` | READMEの説明 | 作品概要、使い方、構成、制約がない |
| `source_exists` | コード参照 | 主要ソースが保存されていない |
| `external_dependency_like` | 外部依存 | ログイン、課金API、秘密情報、外部書き込みが前提 |
| `secret_like` | 秘密情報 | API key、token、password、private keyらしき文字列がある |
| `prompt_injection_like` | 入力汚染 | signal本文に危険な命令や外部指示が混ざっている |
| `risk_domain_like` | 高リスク領域 | 医療、法律、金融判断、政治説得、監視、危害に該当 |

## 4. P1チェック

| key | 観点 | warning条件 |
|---|---|---|
| `mockup_exists` | 画面イメージ | モックアップやスクリーンショットがない |
| `display_check` | 表示崩れ | 空白画面、エラー画面、主要テキストのはみ出し |
| `duplicate_like` | 重複 | 既存作品とタイトル、oneLiner、構成がかなり近い |
| `architecture_diagram_exists` | 図解 | 複雑な作品なのに構成図がない |
| `process_diagram_exists` | 流れ | 何を入力し、どう判断し、何を出すかが読めない |
| `japanese_copy_complete` | 日本語表現 | 日本向けページなのに主要説明が英語のまま |

P1は作品の紹介品質を上げるための項目である。初期はwarningとして保存し、公開停止の対象にするかは運用で調整する。

## 5. 自動公開ロジック

初期MVPの推奨:

```text
if any P0 check fails:
  status = fail
  publishDecision = blocked
elif any P1 check warns:
  status = warning
  publishDecision = held_for_review
else:
  status = pass
  publishDecision = auto_published
```

ただし、`approvalRequired`がtrueのrunでは、passでも人間承認待ちにできる。

## 6. 作品ページに出す情報

ユーザーに見せるValidationは、内部ログではなく理解しやすい形に変換する。

- 表示できるか
- READMEがあるか
- コードが見られるか
- モックアップがあるか
- 外部APIや秘密情報を前提にしていないか
- 重複っぽさや危険な入力が検出されていないか

詳細なcheck keyはRun detailやSource pageに置く。

## 7. 保存項目

Validation:

- `projectId`
- `runId`
- `status`
- `actorType`, `actorId`, `actorName`
- `summary`
- `errorMessage`
- `checkedAt`

ValidationCheck:

- `validationId`
- `key`
- `status`: pass / warning / fail / skipped
- `summary`
- `detailsJson`

## 8. 未決事項

- screenshotの取得方法をPlaywrightにするか、生成画像・静的mockupから始めるか。
- duplicate判定を文字列類似で始めるか、embeddingを使うか。
- warningのどこまでを自動公開対象に戻すか。
- コード品質チェックをlint/build中心にするか、AIレビューも入れるか。
- GitHub連携後にCI結果をValidationへ取り込むか。
