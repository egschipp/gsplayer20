import SpotifyStatus from "../components/SpotifyStatus";
import StatusBox from "../components/StatusBox";

export default function StatusPage() {
  return (
    <main className="page">
      <img
        src="/georgies-spotify.png"
        alt="Georgies Spotify logo"
        loading="lazy"
        style={{ maxWidth: "210px", width: "100%", height: "auto", marginBottom: 12 }}
      />
      <SpotifyStatus showBadges={false} />
      <StatusBox />
    </main>
  );
}
