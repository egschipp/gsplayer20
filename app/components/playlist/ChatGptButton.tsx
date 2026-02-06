"use client";

type ChatGptButtonProps = {
  trackUrl: string | null;
  playlistNames: string[];
};

function buildChatGptPrompt(trackUrl: string | null, playlists: string[]) {
  const url = trackUrl || "Onbekend";
  const list = playlists.length ? playlists.join("\n") : "—";
  return `Je bent een uiterst nauwkeurige muziekcurator en Spotify-verifier. Je werkt in “Instant”-modus: snel, maar met strikte verificatie en nul aannames.

DOEL
Gebruik de opgegeven Spotify-link om EXACT het juiste nummer te identificeren en lever een strak, overzichtelijk rapport met metadata, context en playlist-advies. De output is pas geldig na een expliciete kwaliteitscheck die bevestigt dat het juiste nummer is gevonden.

INPUT
- Nummer-URL: ${url}
- Beschikbare playlists (één per regel): ${list}

WERKWIJZE (STRICT)
1) Open en analyseer de Spotify-link ${url} en haal de officiële trackgegevens op.
2) Voer een “Ground Truth”-verificatie uit:
   - Vergelijk minimaal 3 onafhankelijke identificatoren uit Spotify (bijv. tracktitel, primaire artiest, album/single naam, releasejaar/-datum, trackduur, ISRC indien zichtbaar, Spotify track-ID/URI).
   - Als de URL doorverwijst (remaster, deluxe, live, radio edit, cover, re-recording, compilation): detecteer dit en benoem expliciet welke versie het is.
   - Controleer of er meerdere tracks met (bijna) dezelfde titel/artiestsamenstelling bestaan; als ja, leg in 1–2 zinnen uit waarom dit de juiste is (op basis van de identificatoren).
3) Kwaliteitscheck gate (VERPLICHT):
   - Als je niet met hoge zekerheid kunt bevestigen dat dit het juiste nummer is: STOP en geef alleen een “Verificatie mislukt”-sectie met:
     a) wat ontbreekt,
     b) welke identificatoren conflicteren,
     c) welke extra input nodig is (max. 3 bullets).
   - Ga alleen door naar het volledige rapport als verificatie slaagt.
4) Bronnenbeleid:
   - Primair: Spotify track-/artistpagina (titel, artiest(en), album/single, credits/label indien beschikbaar, release datum/jaar, duur, URI/ID).
   - Secundair (alleen voor achtergrond): officiële artist bio/label site/Wikipedia/gerenommeerde muziekmedia.
   - Als een gegeven niet zeker te verifiëren is: zet “Onbekend” + korte reden (max. 1 zin). Geen aannames.

OUTPUT (Nederlands, mooi opgemaakt in Markdown, compacte maar duidelijke structuur)
0) Verificatiestatus (VERPLICHT, bovenaan)
- Status: ✅ Verificatie geslaagd / ❌ Verificatie mislukt
- Bewijs (min. 3 bullets): noem de gebruikte identificatoren + waarden
- Versiecheck: Original / Remaster / Live / Edit / Cover / Re-recording / Compilation (kies 1, met korte toelichting)

ALS (en alleen als) VERIFICATIE GESLAAGD:
A) Trackgegevens
- Titel:
- Artiest(en):
- Album / Single:
- Releasejaar (en volledige releasedatum indien beschikbaar):
- Trackduur:
- Genre(s) / mood tags (zoals Spotify aangeeft of breed erkend):
- Populariteit (als Spotify dit toont):
- Spotify URI/ID:
- Spotify-link:

B) Korte achtergrond van het nummer (80–120 woorden)
- Thema/ontstaansgeschiedenis/impact (geen speculatie).
- Bronnen (1–3) als bullets: bronnaam + URL.

C) Korte achtergrond van de artiest (80–120 woorden)
- Afkomst/doorbraak/stijl/hoogtepunten.
- Bronnen (1–3) als bullets: bronnaam + URL.

D) Playlist-naam ideeën (5)
- 5 originele playlistnamen passend bij vibe/genre/energie.
- Per naam: 1 toelichting (max. 12 woorden).

E) Beste match uit mijn bestaande playlists
- Kies EXACT 1 playlist uit ${list} waar dit nummer het beste in past.
- Motiveer in 3 bullets o.b.v. genre, energie/tempo, sfeer/onderwerp, gebruiksmoment.
- Als geen enkele playlist past: “Geen goede match” + 1 nieuwe playlistnaam.

FORMATREGELS
- Gebruik Markdown met duidelijke kopjes en bullets.
- Totaal max. ~550 woorden (excl. bronnenlinks).
- Geen irrelevante uitweidingen, geen herhaling.`;
}

export default function ChatGptButton({
  trackUrl,
  playlistNames,
}: ChatGptButtonProps) {
  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const prompt = buildChatGptPrompt(trackUrl, playlistNames);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // ignore clipboard errors
      }
    }
    window.open("https://chatgpt.com", "_blank", "noopener,noreferrer");
  }

  return (
    <button
      type="button"
      aria-label="Open ChatGPT"
      title="Open ChatGPT"
      style={{
        color: "var(--text-primary)",
        display: "inline-flex",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
      onClick={handleClick}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="currentColor"
      >
        <path d="M12 2.2c-1.54 0-2.98.52-4.12 1.39a4.68 4.68 0 0 0-4.63 2.32 4.69 4.69 0 0 0 .35 5.06 4.69 4.69 0 0 0 2.09 6.87 4.68 4.68 0 0 0 4.28 2.78 4.68 4.68 0 0 0 4.54-2.99 4.68 4.68 0 0 0 4.78-2.12 4.69 4.69 0 0 0-.08-5.29A4.69 4.69 0 0 0 16.1 4.1 4.66 4.66 0 0 0 12 2.2Zm-2.82 3.1 4.4 2.54-1.27.73-4.4-2.53a2.86 2.86 0 0 1 1.27-.74Zm6.91 1.03a2.86 2.86 0 0 1 .55 1.38l-4.37 2.52-1.27-.73 4.4-2.53a2.9 2.9 0 0 1 .69-.64ZM6.2 9.12l4.37 2.52v1.47L6.2 10.59a2.88 2.88 0 0 1 0-1.47Zm11.6 0c.1.47.1.98 0 1.47l-4.37 2.52v-1.47l4.37-2.52ZM7.91 14.7l4.4-2.53 1.27.73-4.4 2.53a2.86 2.86 0 0 1-1.27-.73Zm8.18-.21a2.9 2.9 0 0 1-1.27.74l-4.4-2.53 1.27-.73 4.4 2.53Z" />
      </svg>
    </button>
  );
}
