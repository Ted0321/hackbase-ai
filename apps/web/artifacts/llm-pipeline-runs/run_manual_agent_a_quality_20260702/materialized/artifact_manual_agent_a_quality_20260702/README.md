# artifact_manual_agent_a_quality_20260702

This directory is a materialized LLM BuildPlan artifact candidate.

This MVP runs on static sample data.

## Readiness

- First screen value: ITインシデントの概要、複数の専門家AIによる分析、推奨されるアクションの選択肢が最初の画面で明確に提示され、オペレーターが意思決定の文脈をすぐに理解できる。
- Core interaction: ユーザーは、複数の専門家AIの意見（原因分析、リスク、復旧策）を比較検討し、「次の一手」を選択し、最終的に人間が承認するという明確なインタラクションが提供されている。
- State change: ユーザーが「次の一手」を選択すると、その選択がハイライトされ、詳細が表示される。さらに承認ボタンをクリックすると、最終決定としてUIが更新される。
- Inspectable output: 選択されたアクションと、それが人間によって承認されたステータスが明確に表示される。各AIの分析、リスク、確信度も常時確認可能である。
- Static data boundary: すべてのインシデント情報、AIの推奨、可能なアクションは`source/data/product.ts`内の静的データとして提供されている。
- Remaining weakness: 現状の承認プロセスは単純なクリックだが、実際の運用では複数の承認者やステップが必要となる場合がある。これはMVPの範囲外。

## Interaction Proof Plan

- Primary action: Identify & Terminate Long-Running Queries
- Initial state: 複数の専門家AIが意見、リスク、復旧策の候補を提示し、対立点と共通の推奨が可視化されている状態。ユーザーはまだ「次の一手」を選択しておらず、最終決定はされていない。
- Expected state: ユーザーが選択した「Identify & Terminate Long-Running Queries」が画面に確定済みとして表示され、関連するAIエージェントの推奨理由やリスク評価がその決定に基づいて更新された状態。「承認済」と表示され、最終決定者が「Human Operator」と明示されている。
- Visible evidence: 選択されたアクション: Identify & Terminate Long-Running Queries; 担当AI: Db Expert, Ops Expert; ✅ 承認済; この決定により、次のフェーズへ移行します。; 最終決定者: Human Operator

## Visual Identity

- Logo: 複数の思考が一点に収束する様を抽象的に表現したロゴ。ITインシデントの警告を思わせる要素（雷、感嘆符）を控えめに配置し、明瞭さと意思決定支援を強調。
- Thumbnail: インシデント詳細入力エリア、複数の専門家AI（例：DB Expert AI, Network Expert AI）による異なる分析意見が明確に並び、対立する見解が強調されたUI画面。下部には「次の一手」を選択するコントロールが大きく表示され、人間による承認ポイントが可視化されている。プロフェッショナルでクリーンなデザイン。
- Screenshot: ITインシデントの概要が入力され、複数のAIエージェント（例：DB Expert AI, Network Expert AI）が原因分析、リスク評価、復旧策について異なる見解を提示している画面。中央に対立する意見がハイライトされ、画面下部に「次の一手」を決定するための選択肢と、人間による承認ステータスが表示されている。
- Visual readiness: ready

## MVP Contract

- Required files: `source/README.md`, `source/metadata.json`, `source/manifest.json`, `source/source/app/page.tsx`, `source/source/components/ProductWorkspace.tsx`, `source/source/data/product.ts`, `source/validation/self-review.json`
- Non-goals: No live external API integration; No login-only experience; No paid API dependency; No external publishing; AIによる唯一の最適解や自動復旧の提供; 高リスクな専門的判断の自動化; 意思決定ループのない一般的なステータスダッシュボード; 純粋な説明ツールに終始すること; 消費者向けゲームであること
- Forbidden dependencies: external API; secret; login-only flow; paid API; external publishing; legal_decision_automation; medical_decision_automation; financial_decision_automation; fully automated professional judgment; guaranteed outcome

## Files

- `source/README.md`: 製品の概要、ユーザー体験、インタラクション、および制限を説明する。
- `source/metadata.json`: 製品のメタデータ、ターゲットユーザー、コアインタラクション、視覚的アイデンティティ、プロセス、アーキテクチャ、ソース計画、および既知のリスクを含む。
- `source/manifest.json`: すべてのファイルとエントリーポイントをリストアップする。
- `source/source/app/page.tsx`: アプリケーションのエントリーポイント。
- `source/source/components/ProductWorkspace.tsx`: メインのインタラクティブUIを構築する。
- `source/source/data/product.ts`: アプリケーションで使用される静的サンプルデータを提供する。
- `source/source/styles.css`: アーティファクト固有のスタイル設定。
- `source/validation/self-review.json`: ProdiaのMVP基準に対してアーティファクトを評価する。

## Demo Placeholder

- `demo-placeholder.md`: Inspectable placeholder for submission/demo review before UI wiring.

## DB Write

skipped: BuildPlan materialization is artifact-only for this session. Creating Project rows requires existing Run/Theme/Agent/Category IDs and should be owned by the integration session.
