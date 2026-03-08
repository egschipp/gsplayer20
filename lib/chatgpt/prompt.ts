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
  { token: "[PLAYLISTS]", label: "Available playlists" },
  { token: "[TRACK_META]", label: "Verification metadata (summary)" },
  { token: "[TRACK_ID]", label: "Primary verification ID" },
  { token: "[TRACK_NAME]", label: "Track name validation" },
  { token: "[ARTIST_IDS]", label: "Unique artist ID validation" },
  { token: "[ARTIST_NAMES]", label: "Cross-check with expected artist" },
  { token: "[ALBUM_ID]", label: "Album validation" },
  { token: "[ALBUM_RELEASE_DATE]", label: "Chronological verification" },
  { token: "[DURATION_MS]", label: "Exact technical verification" },
  { token: "[ISRC]", label: "Strong unique identifier (if available)" },
  { token: "[EXPLICIT]", label: "Consistency check" },
  { token: "[POPULARITY]", label: "Plausibility check" },
];

export const CHATGPT_PROMPT_TEMPLATE = `You are an extremely precise music curator and Spotify verifier. You operate in “Instant” mode: fast, but with strict verification and zero assumptions.

GOAL
Use the provided Spotify link to identify the EXACT correct track and deliver a concise, well-structured report with metadata, context, and playlist advice. The output is only valid after an explicit quality check confirms the correct track was found.

INPUT
- Track URL: [TRACK_URL]
- Available playlists (one per line): [PLAYLISTS]
- Verification metadata (provided by the app): [TRACK_META]

METHOD (STRICT)
1) Open and analyze the Spotify link [TRACK_URL] and retrieve the official track data.
2) Perform a “Ground Truth” verification:
   - Compare at least 3 independent identifiers from Spotify (for example track title, primary artist, album/single name, release year/date, track duration, ISRC if visible, Spotify track ID/URI).
   - If the URL redirects (remaster, deluxe, live, radio edit, cover, re-recording, compilation): detect it and explicitly state which version it is.
   - Check whether multiple tracks exist with the same or nearly the same title/artist combination; if so, explain in 1-2 sentences why this is the correct one based on the identifiers.
3) Quality gate (REQUIRED):
   - If you cannot confirm with high confidence that this is the correct track: STOP and provide only a “Verification failed” section with:
     a) what is missing,
     b) which identifiers conflict,
     c) what additional input is needed (max. 3 bullets).
   - Only continue to the full report if verification succeeds.
4) Source policy:
   - Primary: Spotify track/artist page (title, artist(s), album/single, credits/label if available, release date/year, duration, URI/ID).
   - Secondary (background only): official artist bio/label site/Wikipedia/reputable music media.
   - If a datum cannot be verified reliably: write “Unknown” + brief reason (max. 1 sentence). No assumptions.

OUTPUT (English, cleanly formatted in Markdown, compact but clear structure)
0) Verification status (REQUIRED, at the top)
- Status: ✅ Verification passed / ❌ Verification failed
- Evidence (min. 3 bullets): list the identifiers used + their values
- Version check: Original / Remaster / Live / Edit / Cover / Re-recording / Compilation (pick 1, with brief explanation)

IF (and only if) VERIFICATION PASSED:
A) Track details
- Title:
- Artist(s):
- Album / Single:
- Release year (and full release date if available):
- Track duration:
- Genre(s) / mood tags (as shown by Spotify or broadly recognized):
- Popularity (if Spotify shows it):
- Spotify URI/ID:
- Spotify link:

B) Short background of the track (80-120 words)
- Theme/origin/impact (no speculation).
- Sources (1-3) as bullets: source name + URL.

C) Short background of the artist (80-120 words)
- Origin/breakthrough/style/highlights.
- Sources (1-3) as bullets: source name + URL.

D) Playlist name ideas (5)
- 5 original playlist names matching the vibe/genre/energy.
- For each name: 1 explanation (max. 12 words).

E) Best match from my existing playlists
- Pick EXACTLY 1 playlist from [PLAYLISTS] where this track fits best.
- Justify it in 3 bullets based on genre, energy/tempo, mood/topic, and listening moment.
- If no playlist fits: “No strong match” + 1 new playlist name.

FORMAT RULES
- Use Markdown with clear headings and bullets.
- Total max. ~550 words (excluding source links).
- No irrelevant tangents, no repetition.`;

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
  const url = trackUrl || "Unknown";
  const emojiStart =
    /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;
  const calendarStart = /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*📆/u;
  const filteredPlaylists = playlists.filter(
    (name) => emojiStart.test(name) && !calendarStart.test(name)
  );
  const list = filteredPlaylists.length ? filteredPlaylists.join("\n") : "—";
  const meta = trackMeta?.trim() ? trackMeta.trim() : "—";
  const explicitValue =
    metaTokens?.explicit === true || metaTokens?.explicit === 1
      ? "yes"
      : metaTokens?.explicit === false || metaTokens?.explicit === 0
      ? "no"
      : "Unknown";
  const popularityValue =
    metaTokens?.popularity === null || metaTokens?.popularity === undefined
      ? "Unknown"
      : String(metaTokens.popularity);
  const replacements: Record<string, string> = {
    "[TRACK_URL]": url,
    "[PLAYLISTS]": list,
    "[TRACK_META]": meta,
    "[TRACK_ID]": metaTokens?.id ?? "Unknown",
    "[TRACK_NAME]": metaTokens?.name ?? "Unknown",
    "[ARTIST_IDS]": metaTokens?.artistIds?.length
      ? metaTokens.artistIds.join(", ")
      : "Unknown",
    "[ARTIST_NAMES]": metaTokens?.artistNames?.length
      ? metaTokens.artistNames.join(", ")
      : "Unknown",
    "[ALBUM_ID]": metaTokens?.albumId ?? "Unknown",
    "[ALBUM_RELEASE_DATE]": metaTokens?.albumReleaseDate ?? "Unknown",
    "[DURATION_MS]":
      metaTokens?.durationMs === null || metaTokens?.durationMs === undefined
        ? "Unknown"
        : String(metaTokens.durationMs),
    "[ISRC]": metaTokens?.isrc ?? "Unknown",
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
