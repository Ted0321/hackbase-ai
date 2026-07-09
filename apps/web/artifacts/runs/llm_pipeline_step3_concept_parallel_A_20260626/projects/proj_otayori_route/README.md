# おたよりルート

学校や自治体のお知らせを、家庭ごとの行動ルート、確認質問、原文根拠に分ける静的artifactです。

## Scope

- 外部APIなし
- アカウントなし
- 個人情報保存なし
- 実際の学校文書解析ではなく、サンプル入力によるMVPデモ

## Safety

公式文書を上書きしません。原文にない期限、対象者、提出物は断定せず、確認待ちとして表示します。

## Files

- `demo.html`: 単体で開ける静的デモ
- `source.tsx`: Next artifact向け入口
- `source/app/page.tsx`: 実装案
- `source/app/data.ts`: サンプルデータ
- `source/app/styles.css`: 画面スタイル
