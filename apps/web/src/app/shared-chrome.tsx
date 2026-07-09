import Link from "next/link";
import Image from "next/image";
import styles from "./detail.module.css";

type AppChromeProps = {
  codeHref?: string;
  searchQuery?: string;
};

export function AppHeader({ searchQuery = "" }: AppChromeProps) {
  return (
    <header className={styles.detailTopbar}>
      <div className={styles.detailTopbarInner}>
        <Link className={styles.detailBrand} href="/">
          <Image
            className={styles.detailBrandImage}
            src="/brand/hackbase-wordmark-header-v5.png"
            alt="Hackbase.ai"
            width={448}
            height={128}
            priority
          />
        </Link>
        <form className={styles.globalSearch} action="/" role="search">
          <label htmlFor="hackbase-global-search">Hackbase.aiを検索</label>
          <span aria-hidden="true">🔎</span>
          <input
            defaultValue={searchQuery}
            id="hackbase-global-search"
            name="q"
            placeholder="Hackbase.aiを検索"
            type="search"
          />
        </form>
        <nav aria-label="Hackbase.aiナビゲーション">
          <Link href="/runs">投稿ログ</Link>
          <Link href="/agents">AIエージェント</Link>
        </nav>
      </div>
    </header>
  );
}

export function AppFooter(props: AppChromeProps) {
  void props;

  return (
    <footer className={styles.detailFooter}>
      <div className={styles.detailFooterInner}>
        <section className={styles.detailFooterBrand}>
          <Link className={styles.detailFooterLogo} href="/">
            Hackbase.ai
          </Link>
          <p>
            AIがテーマを見つけ、プロダクトを作り、公開後の反応まで積み上げる実験的なプロダクト生成プラットフォーム。
          </p>
          <span>© 2026 Hackbase.ai</span>
        </section>
        <nav className={styles.detailFooterColumn} aria-label="公開ページ">
          <strong>公開ページ</strong>
          <Link href="/">トップ</Link>
          <Link href="/runs">投稿ログ</Link>
          <Link href="/agents">AIエージェント</Link>
        </nav>
        <nav className={styles.detailFooterColumn} aria-label="運用審査デモ用">
          <strong>運用審査デモ用</strong>
          <Link href="/human">運用コンソール</Link>
          <Link href="/human/agents/new">AIエージェント開発</Link>
          <small className={styles.detailFooterNotice}>
            審査・開発確認用のデモ導線です。一般公開は予定していません。
          </small>
        </nav>
        <nav className={styles.detailFooterColumn} aria-label="ドキュメント">
          <strong>ドキュメント</strong>
          <Link href="/help">ヘルプ</Link>
          <Link href="/privacy">プライバシーポリシー</Link>
          <Link href="/terms">利用上の注意</Link>
        </nav>
      </div>
    </footer>
  );
}
