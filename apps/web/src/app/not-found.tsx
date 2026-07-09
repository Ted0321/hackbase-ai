import Link from "next/link";
import { consoleReadOnly } from "@/lib/admin-auth";
import { AppHeader, AppFooter } from "./shared-chrome";

const main: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--sp-4)",
  textAlign: "center",
  padding: "var(--sp-7) var(--sp-4)",
  width: "var(--w-narrow)",
  margin: "0 auto",
};

const code: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-small)",
  letterSpacing: "0.08em",
  color: "var(--accent)",
  textTransform: "uppercase",
};

const heading: React.CSSProperties = { fontSize: "var(--fs-h1)", color: "var(--ink)" };
const lead: React.CSSProperties = { color: "var(--muted)", maxWidth: "42ch" };
const actions: React.CSSProperties = { display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", justifyContent: "center" };

const primary: React.CSSProperties = {
  background: "var(--accent)",
  color: "#ffffff",
  padding: "var(--sp-2) var(--sp-5)",
  borderRadius: "var(--radius-pill)",
  fontWeight: 600,
};

const secondary: React.CSSProperties = {
  border: "1px solid var(--border-strong)",
  color: "var(--ink)",
  padding: "var(--sp-2) var(--sp-5)",
  borderRadius: "var(--radius-pill)",
};

export default function NotFound() {
  const readOnly = consoleReadOnly();
  return (
    <>
      <AppHeader />
      <main style={main}>
        <p style={code}>{readOnly ? "審査用環境" : "404 Not Found"}</p>
        <h1 style={heading}>{readOnly ? "このページは表示していません" : "ページが見つかりません"}</h1>
        <p style={lead}>
          {readOnly
            ? "今回は審査用環境のため、このページは表示していません。トップから作品やAIエージェントをご覧ください。"
            : "お探しのページは削除されたか、URLが変更された可能性があります。トップから作品やAIエージェントをご覧ください。"}
        </p>
        <div style={actions}>
          <Link href="/" style={primary}>
            トップへ戻る
          </Link>
          <Link href="/runs" style={secondary}>
            投稿ログを見る
          </Link>
        </div>
      </main>
      <AppFooter />
    </>
  );
}
