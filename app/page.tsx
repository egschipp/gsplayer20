import PlaylistBrowser from "./components/PlaylistBrowser";

export default function HomePage() {
  return (
    <main className="page">
      <img
        src="/georgies-spotify.png"
        alt="Georgies Spotify logo"
        loading="lazy"
        style={{ maxWidth: "520px", width: "100%", height: "auto", marginBottom: 16 }}
      />
      <PlaylistBrowser />
    </main>
  );
}
