import PlaylistBrowser from "./components/PlaylistBrowser";

export default function HomePage() {
  return (
    <main className="page">
      <img
        src="/georgies-spotify.jpg"
        alt="Georgies Spotify logo"
        loading="lazy"
        style={{ maxWidth: "520px", width: "100%", height: "auto", marginBottom: 16 }}
      />
      <h1 className="heading-1">Welcome to GSPlayer20</h1>
      <p className="text-body">
        Thank you for visiting. This site is now live and ready for the next
        phase of development.
      </p>
      <p className="text-body">
        If you're looking for the GSPlayer experience, head to the /gsplayer
        section.
      </p>
      <p className="text-body">
        Status and sync details are available on the <a href="/status">/status</a>{" "}
        page.
      </p>
      <PlaylistBrowser />
    </main>
  );
}
