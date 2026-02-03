import type { Metadata } from "next";
import { Space_Grotesk, Manrope } from "next/font/google";
import "./globals.css";
import AuthSessionProvider from "./components/SessionProvider";
import MainNav from "./components/MainNav";

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
        <AuthSessionProvider>
          <header
            className="panel"
            style={{ margin: "0 1rem", marginTop: "1.25rem" }}
          >
            <MainNav />
          </header>
          {children}
        </AuthSessionProvider>
      </body>
    </html>
  );
}
