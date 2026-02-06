import Image from "next/image";
import SpotifyStatus from "../components/SpotifyStatus";
import StatusBox from "../components/StatusBox";

export default function StatusPage() {
  return (
    <main className="page">
      <Image
        src="/georgies-spotify.png"
        alt="Georgies Spotify logo"
        width={210}
        height={70}
        style={{ maxWidth: "210px", width: "100%", height: "auto", marginBottom: 12 }}
        priority
      />
      <SpotifyStatus showBadges={false} />
      <StatusBox />
    </main>
  );
}
