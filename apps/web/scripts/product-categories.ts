/**
 * プロダクトカテゴリーのカタログ(スクリプト側の単一参照点)。
 *
 * 正は prisma/seed.ts の categories(= DB Category テーブル)。定義を増減・変更するときは
 * seed.ts と本ファイルの両方を必ず同期すること(二重管理注意のコメントを seed.ts 側にも付記済み)。
 *
 * 用途:
 * - builder プロンプトへ渡すカタログ(選定基準つき)と、builder 出力 categoryId の whitelist 検証
 * - publish 時のフォールバック連鎖(builder選択 → templatePattern表 → agent主カテゴリ → cat_utility)
 */

export type ProductCategory = {
  id: string;
  name: string;
  jaLabel: string;
  // builder / backfill プロンプトに渡す「このカテゴリーを選ぶべき時」の1行基準。
  pickWhen: string;
};

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  { id: "cat_research", name: "Research", jaLabel: "調査・リサーチ", pickWhen: "情報源をたどって調べる・探索する・証拠を集めることが主価値のとき" },
  { id: "cat_automation", name: "Automation", jaLabel: "自動化", pickWhen: "繰り返し作業や定型処理を減らすことが主価値のとき" },
  { id: "cat_learning", name: "Learning", jaLabel: "学習支援", pickWhen: "理解・練習・学びを速めることが主価値のとき" },
  { id: "cat_ideation", name: "Ideation", jaLabel: "アイデア発想", pickWhen: "アイデアの生成・リミックス・発想の拡張が主価値のとき" },
  { id: "cat_operations", name: "Operations", jaLabel: "運用支援", pickWhen: "運用手順・ルーティング・トリアージそのものが製品の本質のときだけ" },
  { id: "cat_decision", name: "Decision", jaLabel: "判断支援", pickWhen: "選択肢・トレードオフ・次アクションの判断を助けることが主価値のとき" },
  { id: "cat_scoring", name: "Scoring", jaLabel: "評価・採点", pickWhen: "ランキング・採点・重み付け評価が主価値のとき" },
  { id: "cat_summary", name: "Summary", jaLabel: "要約・整理", pickWhen: "長い情報の凝縮・ブリーフィング・ダイジェスト化が主価値のとき" },
  { id: "cat_writing", name: "Writing", jaLabel: "文章作成", pickWhen: "文章の下書き・リライト・言い回し支援が主価値のとき" },
  { id: "cat_creative", name: "Creative", jaLabel: "表現・制作", pickWhen: "生成表現・ストーリーテリング・創作的なプレゼンテーションが主価値のとき" },
  { id: "cat_utility", name: "Utility", jaLabel: "便利ツール", pickWhen: "日常の小さな実務を助ける実用小道具が主価値のとき" },
];

export const isProductCategoryId = (value: unknown): value is string =>
  typeof value === "string" && PRODUCT_CATEGORIES.some((category) => category.id === value);

/**
 * templatePatternId → カテゴリーの決定論マッピング。
 * generate-from-briefs.ts の categoryForBrief() と同じ表(あちらは既存経路のためリファクタせず複製)。
 * builder がカテゴリーを出さなかった・不正だったときの publish 側第2フォールバックに使う。
 */
export const TEMPLATE_PATTERN_CATEGORY: Record<string, string> = {
  signal_map: "cat_research",
  source_to_mission: "cat_research",
  guided_explainer_path: "cat_learning",
  transformation_studio: "cat_creative",
  remix_roulette: "cat_ideation",
  evidence_decision_board: "cat_decision",
  boundary_simulator: "cat_utility",
  ops_steward_console: "cat_operations",
};
