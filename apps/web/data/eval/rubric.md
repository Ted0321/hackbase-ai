# Hackbase.ai 品質ルーブリック（プロンプト磨き込み用）

- 版: **v3**（2026-06-30, iter2 選定テイスト反映＝legibility重視）
- 対象パス: 1パス目＝創作コア（concept → requirements → builder）。
- 重み付けの根拠: ユーザー確定優先（2026-06-30）＝**①新規性・非自明さ ＋ ②制作の確実性**。
- 共通言語: reviewer の10次元（`apps/web/scripts/prompt-eval-metrics.ts` の `REVIEW_SCORE_DIMENSIONS`）を採用。
- 版管理: テイスト較正（DOC-71 §3）で good/bad 例を追記するたび v2, v3… と版を上げ、その版で以降を比較する。

## 1. 次元・重み・合格ライン・測り方

| 次元 | 重み | 合格ライン（/5） | 測り方 |
| --- | --- | --- | --- |
| novelty | **最優先** | ≥4 | reviewer-judge＋人間目視 |
| notObviousInsight | **最優先** | ≥4・"言われてみれば"が1文で言える | judge＋目視 |
| differenceFromRecentArtifacts | **最優先** | ≥4・直近と型/操作が被らない | judge＋`conceptDiversity`補助 |
| codeFeasibility | **最優先** | pass（実際に動く） | `check-mvp-artifact`＋syntax/danger(QG-3) |
| artifactCompleteness | **最優先** | pass（README/source/metadata/self-review/操作が揃う） | `check-mvp-artifact`＋`check-interaction-proof` |
| coreInteraction | 維持下限 | 非悪化 | judge＋目視 |
| userClarity | 維持下限 | 非悪化 | judge＋目視 |
| visualSpecificity | 維持下限 | 非悪化 | judge |
| sourceInspectability | 維持下限 | 非悪化 | 機械 |
| safety | **ハードfloor** | 常に pass | 機械（secret/prompt-injection/external-dep） |

- **最優先** = この次元を上げるのが本パスの目的。判定の主対象。
- **維持下限** = 上げる対象ではないが、最優先を上げる過程で**悪化させない**（回帰ゲートで監視）。
- **ハードfloor** = 何があっても割ってはいけない（割ったら不採用）。

## 2. アンチ例（最終成果物がこれなら不合格）

- 汎用ダッシュボード / AI assistant / AI meeting room / AI summary 系の没個性企画
- ソース製品のクローン（ドメイン/UI/主張のコピー）
- 操作しても表示が変わらない（state変化が無い＝静的モック）
- title / oneLiner / README が英語化している（日本語ファースト違反）
- source / README が追えない、metadata/self-review が無い
- ピッチ映えするが画面に核となる操作が無い
- 「分かりやすくする」「考える」だけの抽象便益で、可視メカニズムが無い

## 3. 新規性 ⇄ 確実性 の緊張（本パスの肝）

①を狙うほど②が壊れやすい。両立点は **requirements**（驚きの企画を「静的データ＋1操作で動く」契約に締める）。
- 新規性は concept で作る（judgeで測る／構造diversity指標は十分条件でないので過信しない）。
- 確実性は requirements で締め、builder で完遂（`check-mvp-artifact`/`check-interaction-proof` で機械的に測る）。

## 4. テイスト較正の記録（v2: baseline反映 2026-06-30）

baseline g1-g6 へのユーザー反応を反映。**この具体例が機械judgeより優先する拠り所**。

### 北極星（novelty の定義・確定）
- **「完全な奇抜さ」ではなく「ありきたりに見えて切り口が非自明」**。土台はハッカソン受賞作/テック由来でよい。勝負は"角度(cut)"の非自明さ＝`notObviousInsight` が主指標。
- **テック寄りに寄せる**。生活/家庭/学校/防災/civic の generic テーマに逃げない。
- **sourceProductCards（ハッカソン受賞/テック）を忠実に保ち、少しだけずらす**（クローン禁止だが、今は逆に source から離れすぎ）。topicCards の生活テーマを "destination" にしない（optional flavor 止まり）。
- 人格（persona/makerProfile）は**出さなくてよい**（新規性が出れば誰が作っても可。ここは磨かない）。

### 診断（なぜ収束したか・確定）
- 凍結上流の sourceProductCards は**テック豊富**（g5: SpaceGenes+/Resonant Exoplanets/Astro Sweepers 等ハッカソン受賞、g4: Neuthera創薬/Snapdragon翻訳）。
- だが topicCards は**全シナリオ同一の generic civic 5本**（災害準備/学校お知らせ/自治体手続き…）。
- **concept がテック source核を捨て、generic civic topic へ着地**＝収束の主因。→ concept 段で「sourceProducts 優先・topic 逃げ禁止」に直す（in scope）。

### good 例（望む方向）
- **g4「創作ブレストAI評議会」**（kotoq）: テック寄り＋主観評価を複数AIペルソナに分解する非自明な角度。
- **g5「家庭の備えスコアボード」**（sabo07）: 構造化スコアボード＝操作と評価が明確（form は good）。ただし source（宇宙科学受賞作）から離れた点は要改善（grounding 弱い）。

### bad 例（違う方向）＋どう寄せたいか
- **g2「学校のお知らせ見守り帳」/ g3「安心準備コンパス」/ g6「反応シミュレート漫画」**: generic な家庭/学校/防災で新規性が弱い。→ 同じ source からでもテック領域に留め、非自明な角度を立てる。g3 は g5 とテーマ重複（`differenceFromRecentArtifacts` 違反）。

### judge食い違いログ（機械=good/人間=違う）
- **reviewer-judge は g2/g3/g6（人間=違う）にも novelty 4-5**＝judge が非識別。novelty は当面 judge 数値でなく本ルーブリックの北極星＋人間目視で判定。judge 再較正は別途検討。

### iter2 選定テイスト（v3 追記・重要な軌道修正）
- iter2(ハードルール concept) で **多様性は保持**（g1/g3/g4 とも distinctTemplates=3, pairwiseJaccard=0）＝「ハードルールで幅が狭まる」懸念は実測で否定。生成プールもテック化（g4=ブラウザ堅牢化シミュレータ等, g3=防災から離脱）。
- **ユーザー選定テイスト（最重要修正）**: ユーザーは「最も尖ったテック候補」ではなく **legible（分かりやすい）候補を選ぶ**。g3 は抽象的「AI思考トレースカード」より **「イベントリスク予測マップ」（明言: 分かりやすい方がいい）**。g1 は ③学校お便り(fluff)は却下だが ①足跡スコープ/②政策ボード はOK。
- **確定**: **legibility は積極的な合格条件**（"ありきたりに見える"＝legibleであること自体が要件）。狙い＝**legibleな表面 ＋ grounded(テックsource)で非自明な切り口**。両極端を避ける＝(a) generic fluff(学校お便り=切り口なし) と (b) 抽象すぎるAI-meta(思考トレース=分かりにくい) の両方をNGに。
- **選定ステップは現状OK**（legible-grounded を選べている）。"最も抽象テックを選ばせる"方向には**振らない**。
