# Golden 評価セット（プロンプト磨き込み用・固定入力）

- 版: v1（2026-06-30, たたき台）
- 目的: concept→requirements→builder を**比較可能な固定入力**で回し、プロンプト前後を同条件で評価する。
- 設計: 実在エージェント（`apps/web/scripts/agent-roster.ts`）の人格差 × テンプレ/サーフェスの型の広さをカバー。1つの型に過適合せず磨きが汎化するように選ぶ。

## 1. シナリオ（6本コア＋2本オプション）

| # | agent | handle | 作り手の型 | 主なtemplate pattern | テーマ意図（凍結対象のsignal域） | カバレッジ理由 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | agent_a | mugi99 | 運用判断ツール | evidence_decision_board / source_to_mission | 運用・障害対応・調整コストの現場signal | 確実性重・decision loop |
| G2 | agent_b | pino_3 | 遊べるリミックス | remix_roulette / draw-lock-remix | 堅いテーマに隠れた「つい触る角度」 | **新規性重**・touchability・game_like |
| G3 | agent_h | driftq | what-ifシミュ | boundary_simulator / scenario controls | 設定でリスク/結果が変わるトレードオフ判断 | 操作→**state変化**の確実性・simulation |
| G4 | agent_k | kotoq | dev小物変換 | transformation_studio / input-transform-output | GitHub/dev作業のラフ入力→整形 | builder実装の**確実性**・before/after |
| G5 | agent_e | sabo07 | 採点スコアボード | evidence_decision_board / scorecard | 候補が多く基準が曖昧な比較 | 重み可変→順位変化・evaluation |
| G6 | agent_c | yomu | 解説ルート | guided_explainer_path / comparison panel | 用語が多く誤解しやすい先端トピック | surface多様性・explainer型 |
| G7 *(opt)* | agent_g | mob42 | 来歴/出典 | provenance_map / citation trail | 主張の出どころが曖昧なトピック | source-first型 |
| G8 *(opt)* | agent_d | lattice | 構造マップ | signal_map / timeline | 多アクターの関係・依存 | map型 |

カバーされる template pattern: source_to_mission / evidence_decision_board / remix_roulette / boundary_simulator / transformation_studio / guided_explainer_path（＋provenance / signal_map）。
カバーされる surfacePattern: decision_helper / playful_game / simulation / work_simplifier / evaluation / learning_explainer。
作り手 voice の幅: direct・playful・exploratory・hacky・rigorous・calm。

> テーマ意図は「どの域のsignalを選ぶか」のヒント。**実際の具体signalは凍結時（§3）に実research cacheから確定**し、以後そのスナップショットを使う（代表性のため合成でなく実データで凍結）。

## 2. 上流ピン留めの仕組み（なぜ固定できるか）

`scripts/llm-pipeline/prepare-step.ts` の依存は `concept ← research+combination`、`requirements ← concept`、`builder ← concept+requirements`。各stepの入力は `collectPreviousResponses(runId, step)` が **run ディレクトリ内の前段 `response.json` から組み立てる**。

したがって各シナリオで **`research/response.json` と `combination/response.json` を1回作って凍結**すれば、以後は `concept→requirements→builder` だけを再実行しても**同じ上流**から始まる（差はLLMサンプリングのみ）。

## 3. ディレクトリ構成

```
apps/web/data/eval/
  rubric.md / rubric.json          … 品質基準 v1
  golden/
    README.md                      … 本書
    scenarios.json                 … シナリオ定義（機械可読）
    pinned/<scenarioId>/           … 凍結した上流スナップショット
      research.response.json
      combination.response.json
      meta.json                    … agent / theme / 凍結日時 / 元runId
```

## 4. 手順

### 4.1 凍結（各シナリオ1回・要 GEMINI_API_KEY）

ヘルパ `scripts/pin-golden-upstream.ts`（実装済み）が core=true の6本について research+combination を実行し、`research.response.json`＋`combination.response.json` を `pinned/<id>/`（＋`meta.json`）へ凍結する。冪等（凍結済みはskip、`--force`で作り直し）。

```powershell
npm.cmd run eval:golden:pin:dry     # 段取り確認（Gemini呼び出し無し）
npm.cmd run eval:golden:pin         # 6本を凍結（未凍結のみ・実Gemini）
# サブセット/作り直し: tsx scripts/pin-golden-upstream.ts --ids g2,g4 [--force]
```

内部的には各シナリオで `run-gemini --run golden_<id> --agent <agentId> --steps research,combination` を実行し、`artifacts/llm-pipeline-runs/golden_<id>/{research,combination}/response.json` を `pinned/<id>/` へコピーする。

### 4.2 baseline / 反復（concept→builder のみ・上流は凍結を再注入）

```powershell
# 凍結を新しい run dir に展開してから concept→builder を実行
#   artifacts/llm-pipeline-runs/<runId>/research/response.json    <- pinned/g1/research.response.json
#   artifacts/llm-pipeline-runs/<runId>/combination/response.json <- pinned/g1/combination.response.json
npm.cmd run llm:pipeline:run-gemini -- --run <runId> --agent agent_a --steps concept,requirements,builder
```

- baseline: 現行プロンプトで全シナリオを回し、最終成果物をルーブリックで採点する。
- 反復: プロンプト1本を直すたび、全シナリオを同手順で回し `eval:prompt` ＋人間 before/after 判定を行う。

## 5. 注意

- 凍結は実Gemini呼び出し（research+combination × シナリオ数）。コストガード（B-1, 日次$10/500req）内。
- 完全な決定論ではない（LLMサンプリング）。だから**回帰はnoiseBand(0.5)超えのみ有意**として扱う（`prompt-eval-metrics.ts` の `judgeRegression`）。
- シナリオ追加/削除は版を上げて記録する（比較の土台が変わるため）。
