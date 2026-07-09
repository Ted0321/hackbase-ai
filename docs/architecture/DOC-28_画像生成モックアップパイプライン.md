# DOC-28 画像生成モックアップパイプライン

- 文書ID: DOC-28
- バージョン: v0.1
- ステータス: Draft
- 作成日: 2026-06-25
- 更新日: 2026-06-25

## 1. 目的

Hackbase.aiでは、作品説明だけでなく「そのプロダクトを使うとどんな画面になるか」を見せることを重視する。

そのため、生成パイプラインの正式ステップとして、最低2枚のモックアップ画像を扱う。

- トップ画面
- 作業画面

## 2. MVPでの扱い

MVPでは、画像生成そのものを毎回自動実行する必要はない。ただし、生成された画像やテンプレート画像をArtifact Storeに保存し、作品ごとに追跡できるようにする。

現時点の実装方針:

- TradingAgents系テーマは、テーマ固有のWebPモックを使用する
- それ以外のテーマは、汎用SVGモックを使用する
- 生成時に `mockup_image` Artifactとして保存する
- 生成時に `mockup_manifest` Artifactとして保存する
- Sourceページからモック画像を確認できるようにする

## 3. 生成ステップ

将来的な正式パイプラインは次の順番にする。

1. テーマ選定
2. エージェント選定
3. 作品brief生成
4. UIモック方針生成
5. トップ画面モック生成
6. 作業画面モック生成
7. 画像最適化
8. Artifact Store保存
9. 作品ページ表示

## 4. 画像プロンプト標準

トップ画面:

```text
A polished dark-mode product UI screenshot mockup for a Japanese SaaS called "{productName}".
Show the dashboard top page only.
Design direction: Moltbook-inspired dark tech interface, black/charcoal background, red-orange and teal accents, crisp utilitarian SaaS layout, dense but readable.
UI content: large title "{productName}", subtitle "{oneLiner}", primary input area, option selectors, primary action button, and source/status cards.
Make it look like a realistic web app screenshot, crisp Japanese text, no browser chrome, no people, no logos.
Aspect ratio 16:9.
```

作業画面:

```text
A polished dark-mode product UI screenshot mockup for a Japanese SaaS called "{productName}".
Show the main workspace only.
Design direction: Moltbook-inspired dark tech interface, black/charcoal background, red-orange and teal accents, crisp utilitarian SaaS layout, dense but readable.
UI content: left-side role cards, central work area, comparison/debate area, right-side review panel, and bottom decision/output memo.
Make it look like a realistic web app screenshot, crisp Japanese text, no browser chrome, no people, no logos.
Aspect ratio 16:9.
```

## 5. 最適化

公開表示ではWebPを優先する。

現時点では `apps/web/scripts/optimize-mockups.ts` を使い、`public/mockups` のPNGを幅1280px、WebP品質82へ変換する。

```bash
npm run mockups:optimize
```

## 6. Artifact Store規約

生成runごとの保存先:

```text
artifacts/runs/{run_id}/{project_id}/mockups/mockup-top.*
artifacts/runs/{run_id}/{project_id}/mockups/mockup-workspace.*
artifacts/runs/{run_id}/{project_id}/mockups/mockup-manifest.json
```

DB上のArtifact種別:

- `mockup_image`
- `mockup_manifest`

`mockup_manifest.json` には以下を入れる。

- productId
- theme
- mode
- optimization
- images
- prompts

## 7. 今はやらないこと

MVPでは以下は後回しにする。

- 毎回の画像生成API自動実行
- Figma連携
- GitHubへの画像自動push
- ユーザーごとの画像バリエーション生成
- 外部APIキーや秘密情報を使う画像生成
