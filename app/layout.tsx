import type { Metadata } from "next";
import { Space_Grotesk, Manrope } from "next/font/google";
import "./globals.css";

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const bodyFont = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
});

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
    <html lang="nl" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <header
          className="panel"
          style={{ margin: "0 1rem", marginTop: "1.25rem" }}
        >
          <nav className="nav">
            <a href="/" className="nav-link">
              GSPlayer
            </a>
            <a href="/status" className="nav-link secondary">
              Status
            </a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
