import SpotifyStatus from "../components/SpotifyStatus";
import StatusBox from "../components/StatusBox";

export default function StatusPage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>System Status</h1>
      <p>Connectivity, sync, and database health overview.</p>
      <SpotifyStatus />
      <StatusBox />
    </main>
  );
}
