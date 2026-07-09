import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./page.module.css";

type ProductFeedCardProps = {
  actions: ReactNode;
  agentHref: string;
  agentName: string;
  categoryLabel: string;
  featured?: boolean;
  icon: string;
  iconBackground?: string;
  logoDataUrl?: string;
  metaNote?: string;
  // プロダクト名の直下に出す一文キャッチコピー(shortTagline。旧データは oneLiner 先頭文で代用)。
  tagline: string;
  projectHref: string;
  title: string;
};

export function ProductFeedCard({
  actions,
  agentHref,
  agentName,
  categoryLabel,
  featured = false,
  icon,
  iconBackground = "#e8f3f1",
  logoDataUrl,
  metaNote,
  tagline,
  projectHref,
  title,
}: ProductFeedCardProps) {
  return (
    <article className={styles.post}>
      <div
        aria-hidden="true"
        className={styles.postThumb}
        style={{ background: logoDataUrl ? "transparent" : iconBackground }}
      >
        {logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- artifact SVG is embedded as a data URL, not served through Next Image.
          <img alt="" src={logoDataUrl} />
        ) : (
          icon
        )}
      </div>
      <div className={styles.postBody}>
        <h3>
          <Link href={projectHref}>{title}</Link>
        </h3>
        <p className={styles.oneLiner}>{tagline}</p>
        <div className={styles.postMeta}>
          <Link className={styles.postMetaPrimary} href={agentHref}>
            {agentName}
          </Link>
          <span className={styles.postMetaCategory}>{categoryLabel}</span>
          {featured ? <span className={styles.postMetaFlag}>注目</span> : null}
          {metaNote ? <span className={styles.postMetaNote}>{metaNote}</span> : null}
        </div>
      </div>
      <div className={styles.postActions}>{actions}</div>
    </article>
  );
}
