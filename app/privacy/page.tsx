export const metadata = {
  title: "Privacy | Georgies Player",
};

export default function PrivacyPage() {
  return (
    <main id="main-content" tabIndex={-1} className="page about-page">
      <section className="panel about-hero">
        <div className="label">Privacy</div>
        <h1 className="heading-1">Gegevensgebruik</h1>
        <p className="text-body">
          Georgies Player is een persoonlijke speler. De app gebruikt Spotify alleen om de
          functies uit te voeren die je zelf kiest: je bibliotheek tonen en beheren,
          playlists beheren, recent afgespeelde muziek ophalen en afspelen via Spotify
          Connect of de Web Playback SDK.
        </p>

        <h2 className="heading-2">Welke gegevens worden bewaard?</h2>
        <p className="text-body">
          De lokale database bevat je interne Spotify-accountidentificatie, versleutelde
          OAuth-tokens, bibliotheek- en playlistmetadata, synchronisatiestatus en beperkte
          technische foutinformatie. Albumafbeeldingen worden standaard niet permanent
          opgeslagen. De Web Playback SDK vereist het recht om het e-mailadres te lezen,
          maar de app verwerkt of bewaart het e-mailadres niet. Je Spotify-wachtwoord
          wordt nooit ontvangen of bewaard.
        </p>

        <h2 className="heading-2">Delen en bewaartermijn</h2>
        <p className="text-body">
          Spotify-gegevens worden niet verkocht en niet naar advertentie- of AI-diensten
          doorgestuurd. Ze blijven uitsluitend in deze eigen installatie zolang de
          koppeling nodig is. Tijdelijke API-caches verlopen automatisch; bibliotheekdata
          wordt bijgewerkt of verwijderd wanneer Spotify dat aangeeft.
        </p>

        <h2 className="heading-2">Controle en verwijderen</h2>
        <p className="text-body">
          Via Instellingen kun je Spotify ontkoppelen. Daarmee worden tokens, opgeslagen
          bibliotheekgegevens, playlists, synchronisatietaken en gebruikersgebonden caches
          uit deze installatie verwijderd. Je kunt de toegang daarnaast intrekken via je
          Spotify-accountpagina.
        </p>

        <p className="text-subtle">
          Spotify is een handelsmerk van Spotify AB. Georgies Player is een
          onafhankelijke, persoonlijke applicatie en wordt niet door Spotify ondersteund
          of gecertificeerd.
        </p>
        <a href="/login" className="btn btn-secondary">
          Terug naar inloggen
        </a>
      </section>
    </main>
  );
}
