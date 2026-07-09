import { CONSOLE_READONLY_NOTICE } from "@/lib/admin-auth";

const noteStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-3) var(--sp-4)",
  border: "1px dashed var(--border-strong)",
  borderRadius: "10px",
  color: "var(--muted)",
  fontSize: "var(--fs-small)",
  lineHeight: 1.5,
};

/**
 * 審査(読み取り専用)モードで、mutationボタンの代わりに表示する無効化ノート。
 * どのコンソール画面(CSS module差異)からでも使えるよう自己完結スタイル。
 */
export function ConsoleReadOnlyNotice({ label }: { label?: string }) {
  return (
    <p style={noteStyle}>
      <span aria-hidden>🔒</span>
      <span>{label ?? CONSOLE_READONLY_NOTICE}</span>
    </p>
  );
}
