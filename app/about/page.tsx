import { getCodebaseStats } from "@/lib/about/codebaseStats";
import AboutFileTypesPanel from "../components/AboutFileTypesPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function AboutPage() {
  const stats = await getCodebaseStats();

  return (
    <main className="page about-page">
      <section className="panel about-hero">
        <div className="label">About</div>
        <h1 className="heading-1">Georgies Spotify</h1>
        <p className="text-body">
          This app was built in Visual Studio Code, together with Codex as an
          engineering assistant. The goal is a stable Spotify experience with
          consistent controls for My Music, Queue and Spotify Connect across
          desktop, tablet and mobile.
        </p>
        <p className="text-body">
          The architecture is built around Next.js (App Router), with a
          component-driven frontend and server-side API routes for Spotify. The
          player uses the Spotify Web Playback SDK for local playback and
          combines it with Spotify Web API calls for device selection,
          transfer, queue handling and playback state synchronization.
        </p>
        <p className="text-body">
          NextAuth is used for authentication and session management. The app
          routes Spotify traffic through its own API endpoints so token
          handling, error management and platform differences remain centralized
          and robust.
        </p>
      </section>

      <section className="panel about-stats">
        <div className="about-stats-header">
          <h2 className="heading-2">Release statistics</h2>
          <div className="text-subtle">
            {stats.appName} v{stats.version} • updated on{" "}
            {formatDateTime(stats.scannedAt)}
          </div>
        </div>

        <div className="about-metrics">
          <div className="about-metric">
            <div className="about-metric-label">Files</div>
            <div className="about-metric-value">{formatNumber(stats.totalFiles)}</div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">Lines of code</div>
            <div className="about-metric-value">{formatNumber(stats.totalLines)}</div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">Non-empty lines</div>
            <div className="about-metric-value">
              {formatNumber(stats.nonEmptyLines)}
            </div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">File types</div>
            <div className="about-metric-value">
              {formatNumber(stats.fileTypes.length)}
            </div>
          </div>
        </div>

        <p className="text-subtle">
          Automatically generated from the codebase in:{" "}
          {stats.scannedRoots.join(", ")}.
        </p>

        <AboutFileTypesPanel fileTypes={stats.fileTypes} />
      </section>
    </main>
  );
}
