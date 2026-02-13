import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Manrope } from "next/font/google";
import "./globals.css";
import AuthSessionProvider from "./components/SessionProvider";
import MainNav from "./components/MainNav";
import { PlayerProvider } from "./components/player/PlayerProvider";

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const bodyFont = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Georgies Spotify",
  description: "Georgies Spotify player",
  manifest: "/site.webmanifest?v=3",
  icons: {
    icon: [
      { url: "/favicon.ico?v=3" },
      { url: "/favicon-32x32.png?v=3", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png?v=3", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png?v=3", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#12bfa2",
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
          <PlayerProvider>
            <div className="shell header-shell fixed-top">
              <header className="panel">
                <MainNav />
              </header>
            </div>
            {children}
          </PlayerProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
