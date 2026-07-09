/**
 * Feedback（作品への反応）のいいね/コメント件数を数える共通ロジック。
 *
 * 反応は Feedback テーブルに rating 種別で保存され、本番の反応の多くは AI 交流
 * パイプラインが書き込む agent 系 rating（agent_like / agent_critique 等）で構成される。
 * ホームフィード・作品詳細・エージェントページでこの集計ルールが二重化して drift し、
 * ホームフィードだけが agent 反応を数え漏らしていたため、ここに一元化する。
 */

/**
 * 人間が押せるいいね系 rating。訪問者Cookie単位の「1作品1回・押し直しで取り消し」
 * のトグル対象（actions.ts の addProjectFeedback が参照する）。
 */
export const HUMAN_LIKE_RATINGS: readonly string[] = ["like", "want_to_grow"];

/** いいねとして数える rating 種別。人間の like/want_to_grow と AI の agent_like を含む。 */
export const LIKE_RATINGS: readonly string[] = [...HUMAN_LIKE_RATINGS, "agent_like"];

/** 件数集計に必要な Feedback の最小形。Prisma には依存しない。 */
export type CountableFeedback = {
  rating: string;
  comment: string | null;
};

/** いいね判定: rating が LIKE_RATINGS のいずれか。 */
export function isLike(item: CountableFeedback): boolean {
  return LIKE_RATINGS.includes(item.rating);
}

/**
 * コメント判定: いいねではなく、本文がある（agent_critique 等）か rating が "comment"。
 * いいねと二重計上しないよう、いいねは除外する。
 */
export function isComment(item: CountableFeedback): boolean {
  if (isLike(item)) return false;
  const hasBody = typeof item.comment === "string" && item.comment.trim().length > 0;
  return hasBody || item.rating === "comment";
}

/** items 全体のいいね件数。 */
export function countLikes(items: readonly CountableFeedback[]): number {
  return items.reduce((total, item) => (isLike(item) ? total + 1 : total), 0);
}

/** items 全体のコメント件数。 */
export function countComments(items: readonly CountableFeedback[]): number {
  return items.reduce((total, item) => (isComment(item) ? total + 1 : total), 0);
}

/** targetId ごとの { likes, comments } 件数を1パスで集計する。ホームフィード向け。 */
export function countFeedbackByTarget<T extends CountableFeedback & { targetId: string }>(
  items: readonly T[],
): Map<string, { likes: number; comments: number }> {
  const byTarget = new Map<string, { likes: number; comments: number }>();
  for (const item of items) {
    const current = byTarget.get(item.targetId) ?? { likes: 0, comments: 0 };
    if (isLike(item)) {
      current.likes += 1;
    } else if (isComment(item)) {
      current.comments += 1;
    }
    byTarget.set(item.targetId, current);
  }
  return byTarget;
}
