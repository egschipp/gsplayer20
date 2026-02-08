import PlaylistBrowser from "./components/PlaylistBrowser";
import { PlayerProvider } from "./components/player/PlayerProvider";

export default function HomePage() {
  return (
    <main className="page">
      <PlayerProvider>
        <PlaylistBrowser />
      </PlayerProvider>
    </main>
  );
}
