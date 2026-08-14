import dynamic from "next/dynamic";

const PlaylistBrowser = dynamic(() => import("./components/PlaylistBrowser"), {
  loading: () => (
    <section className="card" style={{ marginTop: 24 }}>
      <p className="text-body">My Music laden...</p>
    </section>
  ),
});

export default function HomePage() {
  return (
    <main id="main-content" tabIndex={-1} className="page page-mymusic">
      <PlaylistBrowser />
    </main>
  );
}
