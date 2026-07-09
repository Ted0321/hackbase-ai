// run-agent-interactions-scheduler.ts (Lane3) の日次配分ロジックのうち、副作用のない純粋関数だけを
// 独立させたモジュール。スケジューラー本体はimport時にmain()を即実行するため、テストからは
// 直接importできない — この分離により drawSlotGroup/drawDailyCount を単体テストできる。

// 1日あたりの反応件数を、上限内でランダムに決める（0..maxDaily、~1に偏らせる）。
export const drawDailyCount = (maxDaily: number, random: () => number = Math.random): number => {
  const r = random();
  const count = r < 0.15 ? 0 : r < 0.75 ? 1 : 2;
  return Math.min(count, Math.max(0, maxDaily));
};

// 日次プールの残り比率(poolRatio)と、そのエージェント自身の性格由来のいいね確率
// (personaLikeProbability, agent-interaction-policy.ts の personaLikeProbability())を
// POOL_BALANCE_WEIGHT でブレンドして最終確率を出す。1.0なら旧来の「プールのみ(完全均等強制)」、
// 0.0なら「性格のみ(旧来の確率的選択そのもの)」。0.5は「性格を活かしつつ、日次目標に緩やかに
// 寄せる」折衷案(2026-07-08、ユーザーとの相談で採用)。
//
// 枯渇時の強制(片方が0なら残り全部をもう片方へ)は常に効くため、ブレンド比に関わらず
// 「日をまたいで見れば目標付近に着地する」性質は保たれる。ブレンド比が大きいほど1日ごとの
// 実際の内訳が目標(例:6/6)からブレやすくなる代わりに、個々のエージェントの「いいね好き/
// 講評好き」という性格が反応の選ばれ方に反映されやすくなる。
export const POOL_BALANCE_WEIGHT = 0.5;

// 残プール比とエージェントの性格をブレンドした重み付き抽選で次の1スロットのグループを決める。
// 片方が枯渇したら残り全部をもう片方へ強制するため、最終的な合計は必ず(likeLimit, commentLimit)
// に一致する(十分な数の対象作品/エージェントが存在する限り)。
export const drawSlotGroup = (args: {
  remainingLike: number;
  remainingComment: number;
  // 未指定(null)ならプール比のみで判定(性格情報が無い呼び出し元向けの後方互換)。
  personaLikeProbability?: number | null;
  poolBalanceWeight?: number;
  random?: () => number;
}): "like" | "comment" | null => {
  const { remainingLike, remainingComment } = args;
  if (remainingLike <= 0 && remainingComment <= 0) return null;
  if (remainingLike <= 0) return "comment";
  if (remainingComment <= 0) return "like";

  const poolRatio = remainingLike / (remainingLike + remainingComment);
  const persona = args.personaLikeProbability ?? null;
  const poolWeight = args.poolBalanceWeight ?? POOL_BALANCE_WEIGHT;
  const likeProbability = persona === null ? poolRatio : poolWeight * poolRatio + (1 - poolWeight) * persona;

  const random = args.random ?? Math.random;
  return random() < likeProbability ? "like" : "comment";
};
