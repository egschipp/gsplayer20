import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import AuthSessionProvider from "./components/SessionProvider";
import MainNav from "./components/MainNav";
import { PlayerProvider } from "./components/player/PlayerProvider";

export const metadata: Metadata = {
  title: "Georgies Player",
  description: "Persoonlijke muziekspeler met Spotify-integratie",
  manifest: "/site.webmanifest?v=4",
  icons: {
    icon: [{ url: "/georgies-player.svg?v=4", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#12bfa2",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="nl">
      <body>
        <a className="skip-link" href="#main-content">
          Naar hoofdinhoud
        </a>
        <AuthSessionProvider>
          <div className="shell header-shell fixed-top">
            <header className="panel">
              <MainNav />
            </header>
          </div>
          <PlayerProvider>{children}</PlayerProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
