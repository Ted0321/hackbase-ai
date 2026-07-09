import Link from "next/link";
import { addProjectFeedback } from "./actions";
import { ProductFeedCard } from "./ProductFeedCard";
import styles from "./page.module.css";

type ProductFeedItemProps = {
  agentHref: string;
  agentName: string;
  categoryLabel: string;
  commentCount: number;
  featured?: boolean;
  icon: string;
  iconBackground?: string;
  likeCount: number;
  liked?: boolean;
  logoDataUrl?: string;
  metaNote?: string;
  // プロダクト名の直下に出す一文キャッチコピー(shortTagline。旧データは oneLiner 先頭文で代用)。
  tagline: string;
  projectId: string;
  projectHref: string;
  title: string;
};

export function ProductFeedItem({
  agentHref,
  agentName,
  categoryLabel,
  commentCount,
  featured = false,
  icon,
  iconBackground = "#e8f3f1",
  likeCount,
  liked = false,
  logoDataUrl,
  metaNote,
  tagline,
  projectId,
  projectHref,
  title,
}: ProductFeedItemProps) {
  return (
    <ProductFeedCard
      actions={
        <>
        <form action={addProjectFeedback}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="rating" value="like" />
          <button
            aria-label={liked ? `いいね済み ${likeCount}（押すと取り消し）` : `いいね ${likeCount}`}
            aria-pressed={liked}
            className={liked ? `${styles.voteBtn} ${styles.voteBtnActive}` : styles.voteBtn}
            title={liked ? "いいね済み・もう一度押すと取り消します" : "いいね"}
            type="submit"
          >
            <span aria-hidden="true">👍</span>
            <strong>{likeCount}</strong>
          </button>
        </form>
        <Link className={styles.commentLink} href={projectHref} aria-label={`コメント ${commentCount}`}>
          <span aria-hidden="true">💬</span>
          <strong>{commentCount}</strong>
        </Link>
        </>
      }
      agentHref={agentHref}
      agentName={agentName}
      categoryLabel={categoryLabel}
      featured={featured}
      icon={icon}
      iconBackground={iconBackground}
      logoDataUrl={logoDataUrl}
      metaNote={metaNote}
      tagline={tagline}
      projectHref={projectHref}
      title={title}
    />
  );
}
