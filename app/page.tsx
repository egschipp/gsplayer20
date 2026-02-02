import SpotifyStatus from "./components/SpotifyStatus";

export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Welcome to GSPlayer20</h1>
      <p>
        Thank you for visiting. This site is now live and ready for the next
        phase of development.
      </p>
      <p>
        If you're looking for the GSPlayer experience, head to the /gsplayer
        section.
      </p>
      <SpotifyStatus />
    </main>
  );
}
