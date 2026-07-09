# おたよりルート MVP Task Design

## MVP Goal

学校や自治体のお知らせを貼ると、家庭向けの「今日やること」「今週やること」「確認待ち」と、各カードの原文根拠が一画面で分かる静的デモを成立させる。

## Scope

MVPでやる:

- サンプルお知らせを使った静的デモ
- 原文入力欄、家庭メモ、学年入力
- 行動カード3分類: 今日やる / 今週やる / 確認待ち
- 行動カードと原文根拠の対応表示
- 不明点を「まだ判断しないこと」として表示
- 公式文書を上書きしない安全注記
- `validate-artifact` が通るartifact一式

MVPでやらない:

- LLM/APIによる実解析
- PDF/OCR/メール連携
- DB登録、Project一覧掲載、認証
- 先生・学校への送信
- 個人情報保存
- 複数画面化、管理ダッシュボード化

## Task Breakdown

### T1. Static Demo Baseline

目的: 単体で開ける `demo.html` をMVPの正本として整える。

作業:

- ファーストビューに `おたよりルート`、価値説明、安全注記を表示
- 左: お知らせ本文と家庭条件
- 中央: 行動カード
- 右: 不明点/確認待ち
- モバイルでは縦積みにする

完了条件:

- `demo.html` をブラウザで開いて、5秒で何のプロダクトか分かる
- 横幅980px未満でもテキストがはみ出さない

### T2. Sample Data and Evidence Mapping

目的: 「AIが勝手に判断していない」ことを見せる。

作業:

- サンプルお知らせを1件に固定
- `sourceSnippets` を4件用意
- `actionCards` を4件用意
- 各カードに `sourceSnippetId` を持たせる
- カードクリックで対応原文をハイライト

完了条件:

- 行動カードごとに根拠原文が1つ以上見える
- 昼食など未確定情報は行動断定せず確認待ちに入る

### T3. Safety Boundary Copy

目的: 学校・自治体の公式指示を代替しているように見せない。

作業:

- ヘッダーに安全注記を置く
- 不明点パネルに「まだ判断しないこと」を表示
- 原文にない情報を断定しない文言に統一
- 個人情報入力を促す文言を避ける

完了条件:

- 安全注記がファーストビューで読める
- 未確定情報が行動カードではなく確認待ちに分離されている

### T4. Source Draft Alignment

目的: `demo.html` と `source/app/*` の内容をズレさせない。

作業:

- `source/app/data.ts` のサンプルと `demo.html` のサンプルを一致させる
- `source/app/page.tsx` の構造を `demo.html` と同じ3領域にする
- `source/app/styles.css` を `demo.html` の主要スタイルと揃える

完了条件:

- `demo.html` と `source/app/page.tsx` の表示意図が同じ
- Builder stepの `files` と実体ファイルが対応している

### T5. Artifact Validation

目的: Prodiaのartifactとして最低限の検証を通す。

作業:

- `metadata.json` に required fields を入れる
- `README.md`, `diagrams/*`, `mockups/*`, `validation/self-review.json` を揃える
- `npm.cmd run validate:artifact -- artifacts/runs/llm_pipeline_step3_concept_parallel_A_20260626/projects/proj_otayori_route` を実行

完了条件:

- `Validation pass: 11/11 checks passed.`
- secret scan が pass

## Recommended Order

1. T1 Static Demo Baseline
2. T2 Sample Data and Evidence Mapping
3. T3 Safety Boundary Copy
4. T4 Source Draft Alignment
5. T5 Artifact Validation

## Definition of Done

- 静的デモが単体HTMLとして開ける
- 行動カード、原文根拠、不明点が一画面にある
- 公式文書を上書きしない境界が明示されている
- `validate-artifact` がpass
- 本格AI解析、DB登録、外部連携は未実装として明記されている
