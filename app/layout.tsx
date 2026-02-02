import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GSPlayer20",
  description: "Next.js app for GSPlayer20",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <body style={{ margin: 0 }}>
        <header
          style={{
            padding: "12px 24px",
            borderBottom: "1px solid #e2e8f0",
            fontFamily: "system-ui",
          }}
        >
          <nav style={{ display: "flex", gap: 16 }}>
            <a href="/" style={{ color: "#0f172a", textDecoration: "none" }}>
              GSPlayer
            </a>
            <a href="/status" style={{ color: "#0f172a" }}>
              Status
            </a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
