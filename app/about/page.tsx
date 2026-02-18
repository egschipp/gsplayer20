import { getCodebaseStats } from "@/lib/about/codebaseStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatNumber(value: number) {
  return new Intl.NumberFormat("nl-NL").format(value);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("nl-NL", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatFileType(type: string) {
  if (type === "dockerfile") return "Dockerfile";
  if (type === "makefile") return "Makefile";
  return `.${type}`;
}

export default async function AboutPage() {
  const stats = await getCodebaseStats();

  return (
    <main className="page about-page">
      <section className="panel about-hero">
        <div className="label">About</div>
        <h1 className="heading-1">Georgies Spotify</h1>
        <p className="text-body">
          Deze app is ontwikkeld in Visual Studio Code, samen met Codex als
          engineering-assistent. Het doel is een stabiele Spotify-ervaring met
          consistente bediening voor My Music, Queue en Spotify Connect op
          desktop, tablet en mobiel.
        </p>
        <p className="text-body">
          De architectuur is opgebouwd rond Next.js (App Router) met een
          componentgedreven frontend en server-side API-routes voor Spotify.
          De player gebruikt de Spotify Web Playback SDK voor lokale playback en
          combineert dat met Spotify Web API-calls voor device-selectie,
          transfer, queue en status-synchronisatie.
        </p>
        <p className="text-body">
          Voor authenticatie en sessiebeheer wordt NextAuth gebruikt. De app
          routeert Spotify-verkeer via eigen API-endpoints, zodat tokenbeheer,
          foutafhandeling en platformverschillen centraal en robuust blijven.
        </p>
      </section>

      <section className="panel about-stats">
        <div className="about-stats-header">
          <h2 className="heading-2">Release-statistieken</h2>
          <div className="text-subtle">
            {stats.appName} v{stats.version} • bijgewerkt op{" "}
            {formatDateTime(stats.scannedAt)}
          </div>
        </div>

        <div className="about-metrics">
          <div className="about-metric">
            <div className="about-metric-label">Bestanden</div>
            <div className="about-metric-value">{formatNumber(stats.totalFiles)}</div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">Regels code</div>
            <div className="about-metric-value">{formatNumber(stats.totalLines)}</div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">Niet-lege regels</div>
            <div className="about-metric-value">
              {formatNumber(stats.nonEmptyLines)}
            </div>
          </div>
          <div className="about-metric">
            <div className="about-metric-label">Bestandstypen</div>
            <div className="about-metric-value">
              {formatNumber(stats.fileTypes.length)}
            </div>
          </div>
        </div>

        <p className="text-subtle">
          Automatisch bepaald op basis van de codebase in:{" "}
          {stats.scannedRoots.join(", ")}.
        </p>

        <div className="about-table-wrap">
          <table className="about-types-table" aria-label="Overzicht per bestandstype">
            <thead>
              <tr>
                <th>Type</th>
                <th className="num">Bestanden</th>
                <th className="num">Regels</th>
                <th className="num">Niet-leeg</th>
              </tr>
            </thead>
            <tbody>
              {stats.fileTypes.map((row) => (
                <tr key={row.type}>
                  <td>{formatFileType(row.type)}</td>
                  <td className="num">{formatNumber(row.files)}</td>
                  <td className="num">{formatNumber(row.lines)}</td>
                  <td className="num">{formatNumber(row.nonEmptyLines)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
