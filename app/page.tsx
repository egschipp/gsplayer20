export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <img
        src="/georgies-spotify.jpg"
        alt="Georgies Spotify logo"
        loading="lazy"
        style={{ maxWidth: 520, width: "100%", height: "auto", marginBottom: 16 }}
      />
      <h1>Welcome to GSPlayer20</h1>
      <p>
        Thank you for visiting. This site is now live and ready for the next
        phase of development.
      </p>
      <p>
        If you're looking for the GSPlayer experience, head to the /gsplayer
        section.
      </p>
      <p>
        Status and sync details are available on the <a href="/status">/status</a>{" "}
        page.
      </p>
    </main>
  );
}
