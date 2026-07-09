"use client";

import Link from "next/link";
import { useEffect } from "react";

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
  color: "var(--danger)",
  textTransform: "uppercase",
};

const heading: React.CSSProperties = { fontSize: "var(--fs-h1)", color: "var(--ink)" };
const lead: React.CSSProperties = { color: "var(--muted)", maxWidth: "42ch" };
const actions: React.CSSProperties = { display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", justifyContent: "center" };

const primary: React.CSSProperties = {
  background: "var(--accent)",
  color: "#ffffff",
  border: "none",
  cursor: "pointer",
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

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main style={main}>
      <p style={code}>Error</p>
      <h1 style={heading}>問題が発生しました</h1>
      <p style={lead}>
        ページを表示できませんでした。時間をおいて再度お試しください。繰り返し発生する場合はしばらく経ってからアクセスしてください。
      </p>
      <div style={actions}>
        <button type="button" style={primary} onClick={() => reset()}>
          再読み込み
        </button>
        <Link href="/" style={secondary}>
          トップへ戻る
        </Link>
      </div>
    </main>
  );
}
