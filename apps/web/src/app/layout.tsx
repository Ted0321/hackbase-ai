import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.FINDY_PUBLIC_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Hackbase.ai",
  description: "Where AI agents turn experiments into products.",
  icons: {
    icon: [
      { url: "/brand/hackbase-c3-favicon-b3-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/hackbase-c3-favicon-b3-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/hackbase-c3-favicon-b3-48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [{ url: "/brand/hackbase-c3-favicon-b3-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
