export const CHATGPT_PROMPT_TOKENS = [
  "[TRACK_URL]",
  "[PLAYLISTS]",
  "[TRACK_META]",
  "[TRACK_ID]",
  "[TRACK_NAME]",
  "[ARTIST_IDS]",
  "[ARTIST_NAMES]",
  "[ALBUM_ID]",
  "[ALBUM_RELEASE_DATE]",
  "[DURATION_MS]",
  "[ISRC]",
  "[EXPLICIT]",
  "[POPULARITY]",
] as const;

export const CHATGPT_PROMPT_TOKEN_LABELS: { token: string; label: string }[] = [
  { token: "[TRACK_URL]", label: "Spotify track URL" },
  { token: "[PLAYLISTS]", label: "Beschikbare playlists" },
  { token: "[TRACK_META]", label: "Verificatie-metadata (samenvatting)" },
  { token: "[TRACK_ID]", label: "Primaire verificatie-ID" },
  { token: "[TRACK_NAME]", label: "Tracknaam validatie" },
  { token: "[ARTIST_IDS]", label: "Unieke artiest-ID validatie" },
  { token: "[ARTIST_NAMES]", label: "Cross-check met verwachte artiest" },
  { token: "[ALBUM_ID]", label: "Albumvalidatie" },
  { token: "[ALBUM_RELEASE_DATE]", label: "Chronologische verificatie" },
  { token: "[DURATION_MS]", label: "Exacte technische verificatie" },
  { token: "[ISRC]", label: "Sterke unieke identificator (indien aanwezig)" },
  { token: "[EXPLICIT]", label: "Consistentiecontrole" },
  { token: "[POPULARITY]", label: "Plausibiliteitscontrole" },
];

export const CHATGPT_PROMPT_TEMPLATE = `Je bent een uiterst nauwkeurige muziekcurator en Spotify-verifier. Je werkt in “Instant”-modus: snel, maar met strikte verificatie en nul aannames.

DOEL
Gebruik de opgegeven Spotify-link om EXACT het juiste nummer te identificeren en lever een strak, overzichtelijk rapport met metadata, context en playlist-advies. De output is pas geldig na een expliciete kwaliteitscheck die bevestigt dat het juiste nummer is gevonden.

INPUT
- Nummer-URL: [TRACK_URL]
- Beschikbare playlists (één per regel): [PLAYLISTS]
- Verificatie-metadata (door app geleverd): [TRACK_META]

WERKWIJZE (STRICT)
1) Open en analyseer de Spotify-link [TRACK_URL] en haal de officiële trackgegevens op.
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
- Kies EXACT 1 playlist uit [PLAYLISTS] waar dit nummer het beste in past.
- Motiveer in 3 bullets o.b.v. genre, energie/tempo, sfeer/onderwerp, gebruiksmoment.
- Als geen enkele playlist past: “Geen goede match” + 1 nieuwe playlistnaam.

FORMATREGELS
- Gebruik Markdown met duidelijke kopjes en bullets.
- Totaal max. ~550 woorden (excl. bronnenlinks).
- Geen irrelevante uitweidingen, geen herhaling.`;

export function fillChatGptPrompt(
  template: string,
  trackUrl: string | null,
  playlists: string[],
  trackMeta?: string,
  metaTokens?: {
    id?: string | null;
    name?: string | null;
    artistIds?: string[];
    artistNames?: string[];
    albumId?: string | null;
    albumReleaseDate?: string | null;
    durationMs?: number | null;
    isrc?: string | null;
    explicit?: boolean | number | null;
    popularity?: number | null;
  }
) {
  const url = trackUrl || "Onbekend";
  const emojiStart = /^\s*\p{Extended_Pictographic}/u;
  const excludedStart = /^\s*(📆|🧑🏻‍🎤)/u;
  const filteredPlaylists = playlists.filter(
    (name) => emojiStart.test(name) && !excludedStart.test(name)
  );
  const list = filteredPlaylists.length ? filteredPlaylists.join("\n") : "—";
  const meta = trackMeta?.trim() ? trackMeta.trim() : "—";
  const explicitValue =
    metaTokens?.explicit === true || metaTokens?.explicit === 1
      ? "ja"
      : metaTokens?.explicit === false || metaTokens?.explicit === 0
      ? "nee"
      : "Onbekend";
  const popularityValue =
    metaTokens?.popularity === null || metaTokens?.popularity === undefined
      ? "Onbekend"
      : String(metaTokens.popularity);
  const replacements: Record<string, string> = {
    "[TRACK_URL]": url,
    "[PLAYLISTS]": list,
    "[TRACK_META]": meta,
    "[TRACK_ID]": metaTokens?.id ?? "Onbekend",
    "[TRACK_NAME]": metaTokens?.name ?? "Onbekend",
    "[ARTIST_IDS]": metaTokens?.artistIds?.length
      ? metaTokens.artistIds.join(", ")
      : "Onbekend",
    "[ARTIST_NAMES]": metaTokens?.artistNames?.length
      ? metaTokens.artistNames.join(", ")
      : "Onbekend",
    "[ALBUM_ID]": metaTokens?.albumId ?? "Onbekend",
    "[ALBUM_RELEASE_DATE]": metaTokens?.albumReleaseDate ?? "Onbekend",
    "[DURATION_MS]":
      metaTokens?.durationMs === null || metaTokens?.durationMs === undefined
        ? "Onbekend"
        : String(metaTokens.durationMs),
    "[ISRC]": metaTokens?.isrc ?? "Onbekend",
    "[EXPLICIT]": explicitValue,
    "[POPULARITY]": popularityValue,
  };
  let next = template;
  for (const [token, value] of Object.entries(replacements)) {
    next = next.replaceAll(token, value);
  }
  return next;
}

export function normalizePromptTemplate(value: string) {
  let next = value ?? "";
  for (const token of CHATGPT_PROMPT_TOKENS) {
    if (!next.includes(token)) {
      next = `${next.trim()}\n\n${token}`;
    }
  }
  return next;
}
