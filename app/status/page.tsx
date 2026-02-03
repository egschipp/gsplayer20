import SpotifyStatus from "../components/SpotifyStatus";
import StatusBox from "../components/StatusBox";

export default function StatusPage() {
  return (
    <main className="page">
      <img
        src="/georgies-spotify.png"
        alt="Georgies Spotify logo"
        loading="lazy"
        style={{ maxWidth: "420px", width: "100%", height: "auto", marginBottom: 12 }}
      />
      <h1 className="heading-1">System Status</h1>
      <p className="text-body">Connectivity, sync, and database health overview.</p>
      <SpotifyStatus showBadges={false} />
      <StatusBox />
    </main>
  );
}
