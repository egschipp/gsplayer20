"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SpotifyPlayer, { type PlayerApi } from "./SpotifyPlayer";

type Mode = "playlists" | "artists" | "tracks";

type PlaylistOption = {
  id: string;
  name: string;
  type: "liked" | "playlist";
  spotifyUrl: string;
};

type ArtistOption = {
  id: string;
  name: string;
  spotifyUrl: string;
};

type TrackOption = {
  id: string;
  name: string;
  spotifyUrl: string;
  coverUrl?: string | null;
  trackId?: string | null;
  artistNames?: string | null;
};

type PlaylistLink = { id: string; name: string; spotifyUrl: string };

type TrackItem = {
  id: string;
  trackId?: string | null;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string | null; name: string | null; images: { url: string }[] };
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  albumImageUrl?: string | null;
  playlists: PlaylistLink[];
};

type TrackRow = {
  itemId?: string | null;
  playlistId?: string | null;
  trackId?: string | null;
  name: string | null;
  albumId?: string | null;
  albumName?: string | null;
  albumImageUrl?: string | null;
  coverUrl?: string | null;
  artists?: string | null;
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  addedAt?: number | null;
  addedBySpotifyUserId?: string | null;
  position?: number | null;
  snapshotIdAtSync?: string | null;
  syncRunId?: string | null;
  playlists?: PlaylistLink[];
};

type TrackDetail = {
  id?: string | null;
  itemId?: string | null;
  trackId?: string | null;
  name?: string | null;
  artistsText?: string | null;
  artists?: { id: string; name: string }[];
  albumId?: string | null;
  albumName?: string | null;
  albumImageUrl?: string | null;
  coverUrl?: string | null;
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  addedAt?: number | null;
  addedBySpotifyUserId?: string | null;
  position?: number | null;
  playlistId?: string | null;
  snapshotIdAtSync?: string | null;
  syncRunId?: string | null;
  playlists?: PlaylistLink[];
  spotifyUrl?: string | null;
};

type ArtistDetail = {
  artistId: string;
  name: string;
  genres: string[];
  popularity: number | null;
  tracksCount: number;
  updatedAt?: number | null;
  spotifyUrl?: string | null;
};

const LIKED_OPTION: PlaylistOption = {
  id: "liked",
  name: "Liked Songs",
  type: "liked",
  spotifyUrl: "https://open.spotify.com/collection/tracks",
};

function formatDuration(ms?: number | null) {
  if (!ms || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function formatTimestamp(ms?: number | null) {
  if (!ms || ms <= 0) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatExplicit(value?: number | null) {
  if (value === null || value === undefined) return "—";
  return value ? "Yes" : "No";
}

function dedupeArtistText(value?: string | null) {
  if (!value) return "";
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.length) return "";
  const unique = Array.from(new Set(names));
  return unique.join(", ");
}

function dedupeArtists(
  artists?: { id: string; name: string }[] | null
): { id: string; name: string }[] {
  if (!artists?.length) return [];
  const seen = new Set<string>();
  const unique: { id: string; name: string }[] = [];
  for (const artist of artists) {
    const key = `${artist.id}:${artist.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(artist);
  }
  return unique;
}

export default function PlaylistBrowser() {
  const [mode, setMode] = useState<Mode>("playlists");
  const [playlistOptions, setPlaylistOptions] = useState<PlaylistOption[]>([
    LIKED_OPTION,
  ]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>(
    LIKED_OPTION.id
  );
  const [selectedArtistId, setSelectedArtistId] = useState<string>("");
  const [selectedTrackName, setSelectedTrackName] = useState<string>("");
  const [query, setQuery] = useState<string>(LIKED_OPTION.name);
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackItems, setTrackItems] = useState<TrackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(true);
  const [loadingArtists, setLoadingArtists] = useState(false);
  const [loadingTracksList, setLoadingTracksList] = useState(false);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [selectedTrackDetail, setSelectedTrackDetail] = useState<TrackDetail | null>(
    null
  );
  const [selectedArtistDetail, setSelectedArtistDetail] =
    useState<ArtistDetail | null>(null);
  const [artistDetailLoading, setArtistDetailLoading] = useState(false);
  const [trackArtistsLoading, setTrackArtistsLoading] = useState(false);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const suppressCloseRef = useRef(false);
  const playerApiRef = useRef<PlayerApi | null>(null);
  const MAX_PLAYLIST_CHIPS = 2;

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

  async function handleChatGptClick(trackUrl: string | null) {
    const allPlaylists = playlistOptions.map((pl) => pl.name || "Untitled playlist");
    const prompt = buildChatGptPrompt(trackUrl, allPlaylists);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // ignore clipboard errors
      }
    }
    window.open("https://chatgpt.com", "_blank", "noopener,noreferrer");
  }

  useEffect(() => {
    let cancelled = false;
    async function loadPlaylists() {
      setLoadingPlaylists(true);
      setError(null);
      setAuthRequired(false);
      try {
        const all: PlaylistOption[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/me/playlists", window.location.origin);
          url.searchParams.set("limit", "50");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Please connect Spotify to load playlists.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load playlists.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (p: any): PlaylistOption => ({
                id: p.playlistId,
                name: p.name,
                type: "playlist",
                spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, PlaylistOption>();
        for (const option of all) unique.set(option.id, option);
        const playlistOptions: PlaylistOption[] = Array.from(unique.values()).sort(
          (a: PlaylistOption, b: PlaylistOption) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        const list: PlaylistOption[] = [LIKED_OPTION, ...playlistOptions];
        if (!cancelled) {
          setPlaylistOptions(list);
          if (!selectedPlaylistId) {
            setSelectedPlaylistId(LIKED_OPTION.id);
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load playlists.");
      } finally {
        if (!cancelled) setLoadingPlaylists(false);
      }
    }
    loadPlaylists();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadArtists() {
      setLoadingArtists(true);
      try {
        const all: ArtistOption[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/artists", window.location.origin);
          url.searchParams.set("limit", "100");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Please connect Spotify to load artists.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load artists.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (artist: any): ArtistOption => ({
                id: artist.artistId,
                name: artist.name,
                spotifyUrl: `https://open.spotify.com/artist/${artist.artistId}`,
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, ArtistOption>();
        for (const option of all) unique.set(option.id, option);
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setArtistOptions(list);
          if (!selectedArtistId && list.length) setSelectedArtistId(list[0].id);
        }
      } finally {
        if (!cancelled) setLoadingArtists(false);
      }
    }
    loadArtists();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadTracksList() {
      setLoadingTracksList(true);
      try {
        const all: TrackItem[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/tracks", window.location.origin);
          url.searchParams.set("limit", "100");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Please connect Spotify to load tracks.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load tracks.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (track: any): TrackItem => ({
                id: String(track.id ?? track.trackId ?? ""),
                trackId: track.trackId ?? null,
                name: String(track.name ?? ""),
                artists: Array.isArray(track.artists) ? track.artists : [],
                album: track.album ?? { id: null, name: null, images: [] },
                durationMs: track.durationMs ?? null,
                explicit: track.explicit ?? null,
                popularity: track.popularity ?? null,
                albumImageUrl: track.albumImageUrl ?? null,
                playlists: Array.isArray(track.playlists) ? track.playlists : [],
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, TrackOption>();
        for (const track of all) {
          const name = String(track.name ?? "").trim();
          const key = name.toLowerCase();
          if (!key) continue;
          const artistNames = track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ");
          const coverUrl = track.album?.images?.[0]?.url ?? null;
          const option: TrackOption = {
            id: key,
            name,
            spotifyUrl: `https://open.spotify.com/track/${track.id}`,
            coverUrl,
            trackId: track.id ?? null,
            artistNames: artistNames || null,
          };
          const existing = unique.get(key);
          if (!existing) {
            unique.set(key, option);
          } else if (!existing.coverUrl && option.coverUrl) {
            unique.set(key, option);
          }
        }
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setTrackOptions(list);
          setTrackItems(all);
          if (!selectedTrackName && list.length) setSelectedTrackName(list[0].name);
        }
      } finally {
        if (!cancelled) setLoadingTracksList(false);
      }
    }
    loadTracksList();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedPlaylist = useMemo(() => {
    if (!selectedPlaylistId) return null;
    return (
      playlistOptions.find((opt) => opt.id === selectedPlaylistId) ||
      LIKED_OPTION
    );
  }, [playlistOptions, selectedPlaylistId]);

  const selectedArtist = useMemo(
    () => artistOptions.find((opt) => opt.id === selectedArtistId) || null,
    [artistOptions, selectedArtistId]
  );

  const selectedTrack = useMemo(() => {
    if (!selectedTrackName) return null;
    return trackOptions.find((opt) => opt.name === selectedTrackName) || null;
  }, [trackOptions, selectedTrackName]);

  const selectedOption =
    mode === "playlists"
      ? selectedPlaylist
      : mode === "artists"
      ? selectedArtist
      : selectedTrack;

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list =
      mode === "playlists"
        ? playlistOptions
        : mode === "artists"
        ? artistOptions
        : trackOptions;
    if (!term) return list;
    return list.filter((opt) => opt.name.toLowerCase().includes(term));
  }, [playlistOptions, artistOptions, trackOptions, query, mode]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
    if (mode === "playlists") setSelectedPlaylistId("");
    if (mode === "artists") setSelectedArtistId("");
    if (mode === "tracks") {
      setSelectedTrackName("");
    }
  }, [mode]);

  const filteredTrackItems = useMemo(() => {
    if (!selectedTrackName) return [];
    return trackItems.filter((track) => track.name === selectedTrackName);
  }, [trackItems, selectedTrackName]);

  function renderPlaylistChips(playlists: PlaylistLink[] | undefined) {
    if (!playlists || playlists.length === 0) return <span className="text-subtle">—</span>;
    const visible = playlists.slice(0, MAX_PLAYLIST_CHIPS);
    const remaining = playlists.length - visible.length;
    return (
      <>
        {visible.map((pl) => (
          <a
            key={pl.id}
            href={pl.spotifyUrl}
            target="_blank"
            rel="noreferrer"
            className="playlist-chip"
            onClick={(event) => event.stopPropagation()}
          >
            {pl.name || "Untitled playlist"}
          </a>
        ))}
        {remaining > 0 ? (
          <span className="playlist-more">+{remaining} more</span>
        ) : null}
      </>
    );
  }

  function openDetailFromRow(track: TrackRow) {
    const spotifyUrl = track.trackId
      ? `https://open.spotify.com/track/${track.trackId}`
      : null;
    setSelectedTrackDetail({
      id: track.trackId ?? null,
      itemId: track.itemId ?? null,
      playlistId: track.playlistId ?? null,
      trackId: track.trackId ?? null,
      name: track.name ?? null,
      artistsText: dedupeArtistText(track.artists ?? null) || null,
      artists: [],
      albumId: track.albumId ?? null,
      albumName: track.albumName ?? null,
      albumImageUrl: track.albumImageUrl ?? null,
      coverUrl: track.coverUrl ?? null,
      durationMs: track.durationMs ?? null,
      explicit: track.explicit ?? null,
      popularity: track.popularity ?? null,
      addedAt: track.addedAt ?? null,
      addedBySpotifyUserId: track.addedBySpotifyUserId ?? null,
      position: track.position ?? null,
      snapshotIdAtSync: track.snapshotIdAtSync ?? null,
      syncRunId: track.syncRunId ?? null,
      playlists: track.playlists ?? [],
      spotifyUrl,
    });
  }

  function openDetailFromItem(track: TrackItem) {
    const coverUrl = track.album?.images?.[0]?.url ?? null;
    const spotifyUrl = track.id ? `https://open.spotify.com/track/${track.id}` : null;
    setSelectedTrackDetail({
      id: track.id ?? null,
      trackId: track.trackId ?? track.id ?? null,
      name: track.name ?? null,
      artists: dedupeArtists(track.artists ?? []),
      albumId: track.album?.id ?? null,
      albumName: track.album?.name ?? null,
      albumImageUrl: track.albumImageUrl ?? null,
      coverUrl,
      durationMs: track.durationMs ?? null,
      explicit: track.explicit ?? null,
      popularity: track.popularity ?? null,
      playlists: track.playlists ?? [],
      spotifyUrl,
    });
  }

  async function openArtistDetail(artistId?: string | null, name?: string | null) {
    if (!artistId) return;
    setArtistDetailLoading(true);
    setSelectedArtistDetail({
      artistId,
      name: name || "Unknown artist",
      genres: [],
      popularity: null,
      tracksCount: 0,
      spotifyUrl: `https://open.spotify.com/artist/${artistId}`,
    });
    try {
      const res = await fetch(`/api/spotify/artists/${artistId}`);
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      setSelectedArtistDetail({
        artistId: data.artistId ?? artistId,
        name: data.name ?? name ?? "Unknown artist",
        genres: Array.isArray(data.genres) ? data.genres : [],
        popularity:
          data.popularity === null || data.popularity === undefined
            ? null
            : Number(data.popularity),
        tracksCount: Number(data.tracksCount ?? 0),
        updatedAt: data.updatedAt ?? null,
        spotifyUrl: data.spotifyUrl ?? `https://open.spotify.com/artist/${artistId}`,
      });
    } finally {
      setArtistDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedTrackDetail) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedTrackDetail(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedTrackDetail]);

  useEffect(() => {
    const trackId = selectedTrackDetail?.trackId ?? null;
    if (!trackId) return;
    if (selectedTrackDetail?.artists && selectedTrackDetail.artists.length > 0) return;
    let cancelled = false;
    async function loadTrackArtists() {
      try {
        setTrackArtistsLoading(true);
        const res = await fetch(`/api/spotify/tracks/${trackId}/artists`);
        if (!res.ok) return;
        const data = await res.json();
        const artists = Array.isArray(data?.items)
          ? data.items
              .map((artist: any) => ({
                id: artist.artistId ?? artist.id ?? "",
                name: artist.name ?? "",
              }))
              .filter((artist: { id: string; name: string }) => artist.id || artist.name)
          : [];
        if (!cancelled) {
          setSelectedTrackDetail((prev) =>
            prev
              ? {
                  ...prev,
                  artists: dedupeArtists(artists),
                }
              : prev
          );
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setTrackArtistsLoading(false);
      }
    }
    loadTrackArtists();
    return () => {
      cancelled = true;
    };
  }, [selectedTrackDetail?.trackId, selectedTrackDetail?.artists]);

  useEffect(() => {
    if (!selectedArtistDetail) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedArtistDetail(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedArtistDetail]);

  useEffect(() => {
    let cancelled = false;
    async function loadTracks(cursor?: string | null, append = false) {
      setLoadingTracks(true);
      setError(null);
      try {
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks"
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
        const url = new URL(baseUrl, window.location.origin);
        url.searchParams.set("limit", "50");
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 401) {
            setError("Please connect Spotify to load tracks.");
          } else {
            setError("Failed to load tracks.");
          }
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!cancelled) {
          setTracks((prev) => (append ? prev.concat(items) : items));
          setNextCursor(data.nextCursor ?? null);
        }
      } catch {
        if (!cancelled) setError("Failed to load tracks.");
      } finally {
        if (!cancelled) setLoadingTracks(false);
      }
    }

    if (mode === "tracks") return;

    if (mode === "artists" && !selectedArtist?.id) return;

    if (mode === "playlists" && !selectedPlaylist?.id) return;

    setTracks([]);
    setNextCursor(null);
    loadTracks(null, false);

    return () => {
      cancelled = true;
    };
  }, [mode, selectedPlaylist?.id, selectedPlaylist?.type, selectedArtist?.id]);

  async function loadMore() {
    if (!nextCursor) return;
    if (mode === "playlists" && !selectedPlaylist?.id) return;
    if (mode === "artists" && !selectedArtist?.id) return;
    const cursor = nextCursor;
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks"
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
    const url = new URL(baseUrl, window.location.origin);
    url.searchParams.set("limit", "50");
    url.searchParams.set("cursor", cursor);

    setLoadingTracks(true);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setTracks((prev) => prev.concat(items));
      setNextCursor(data.nextCursor ?? null);
    } finally {
      setLoadingTracks(false);
    }
  }

  function buildQueue(): { uris: string[]; byId: Set<string> } {
    if (mode === "tracks") {
      const uris = filteredTrackItems
        .map((track) => track.id)
        .filter(Boolean)
        .map((id) => `spotify:track:${id}`);
      return { uris, byId: new Set(filteredTrackItems.map((t) => t.id)) };
    }
    const uris = tracks
      .map((track) => track.trackId)
      .filter(Boolean)
      .map((id) => `spotify:track:${id}`);
    return { uris, byId: new Set(tracks.map((t) => t.trackId || "")) };
  }

  async function handlePlayTrack(trackId: string | null | undefined) {
    if (!trackId || !playerApiRef.current) return;
    const queue = buildQueue();
    if (!queue.uris.length) return;
    const targetUri = `spotify:track:${trackId}`;
    await playerApiRef.current.playQueue(queue.uris, targetUri);
  }

  return (
    <section style={{ marginTop: 24 }}>
      <div className="library-sticky">
        <img
          src="/georgies-spotify.png"
          alt="Georgies Spotify logo"
          loading="lazy"
          className="library-logo"
        />
        <SpotifyPlayer
          onReady={(api) => {
            playerApiRef.current = api;
          }}
          onTrackChange={(trackId) => {
            setCurrentTrackId(trackId);
          }}
        />
      </div>
      <div className="segmented" role="tablist" aria-label="Library modes">
        {(["playlists", "artists", "tracks"] as Mode[]).map((value) => (
          <button
            key={value}
            type="button"
            className={`segmented-btn${mode === value ? " active" : ""}`}
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="combo" style={{ minWidth: 260 }}>
          <label className="sr-only" htmlFor="playlist-search">
            Select option
          </label>
          <input
            id="playlist-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setTimeout(() => {
                if (!suppressCloseRef.current) setOpen(false);
                suppressCloseRef.current = false;
              }, 100);
            }}
            className="combo-input"
            aria-label="Select option"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="playlist-options"
            placeholder={
              mode === "playlists"
                ? "Search playlists..."
                : mode === "artists"
                ? "Search artists..."
                : "Search tracks..."
            }
            disabled={
              mode === "playlists"
                ? loadingPlaylists
                : mode === "artists"
                ? loadingArtists
                : loadingTracksList
            }
          />
          {selectedOption || query ? (
            <button
              type="button"
              className="combo-clear"
              aria-label="Clear selection"
              onMouseDown={() => {
                suppressCloseRef.current = true;
                setQuery("");
                setOpen(true);
                if (mode === "playlists") setSelectedPlaylistId("");
                if (mode === "artists") setSelectedArtistId("");
                if (mode === "tracks") {
                  setSelectedTrackName("");
                }
              }}
            >
              ×
            </button>
          ) : null}
          {open ? (
            <div className="combo-list" role="listbox" id="playlist-options">
              {filteredOptions.length === 0 ? (
                <div className="combo-empty">No matches.</div>
              ) : mode === "tracks" ? (
                (filteredOptions as TrackOption[]).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={opt.name === selectedTrackName}
                    className={`combo-item${
                      opt.name === selectedTrackName ? " active" : ""
                    }`}
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
                      setSelectedTrackName(opt.name);
                      setQuery(opt.name);
                      setOpen(false);
                    }}
                  >
                    <span className="combo-track">
                      {opt.coverUrl ? (
                        <img
                          src={opt.coverUrl || undefined}
                          alt=""
                          loading="lazy"
                          className="combo-track-cover"
                        />
                      ) : (
                        <span className="combo-track-cover placeholder" />
                      )}
                      <span>
                        <span className="combo-track-name">{opt.name}</span>
                        {opt.artistNames ? (
                          <span className="text-subtle"> {opt.artistNames}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                filteredOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={
                      mode === "playlists"
                        ? opt.id === selectedPlaylistId
                        : opt.id === selectedArtistId
                    }
                    className={`combo-item${
                      (mode === "playlists" && opt.id === selectedPlaylistId) ||
                      (mode === "artists" && opt.id === selectedArtistId)
                        ? " active"
                        : ""
                    }`}
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
                      if (mode === "playlists") setSelectedPlaylistId(opt.id);
                      if (mode === "artists") setSelectedArtistId(opt.id);
                      setQuery(opt.name);
                      setOpen(false);
                    }}
                  >
                    {opt.name}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      {loadingPlaylists && mode === "playlists" ? (
        <p className="text-body">Loading playlists...</p>
      ) : null}
      {loadingArtists && mode === "artists" ? (
        <p className="text-body">Loading artists...</p>
      ) : null}
      {loadingTracksList && mode === "tracks" ? (
        <p className="text-body">Loading tracks...</p>
      ) : null}
      {error ? (
        <div style={{ color: "#fca5a5" }}>
          <p>{error}</p>
          {authRequired ? (
            <a href="/api/auth/login" className="btn btn-primary">
              Connect Spotify
            </a>
          ) : null}
        </div>
      ) : null}

      {mode !== "tracks" ? (
        <div className="track-list" style={{ marginTop: 16 }}>
          {mode === "playlists" && !selectedPlaylist?.id ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Select a playlist</div>
              <div className="text-body">
                Choose a playlist to see its tracks.
              </div>
            </div>
          ) : null}
          {mode === "artists" && !selectedArtist?.id ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Select an artist</div>
              <div className="text-body">
                Pick an artist to see their tracks and playlists.
              </div>
            </div>
          ) : null}
          {mode === "playlists" && selectedPlaylist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Showing tracks for: <strong>{selectedPlaylist.name}</strong>
            </div>
          ) : null}
          {mode === "artists" && selectedArtist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Showing tracks for: <strong>{selectedArtist.name}</strong>
            </div>
          ) : null}
          {tracks.length ? (
            <div
              className={`track-header${
                mode === "artists" || mode === "playlists" ? " columns-4" : ""
              }`}
            >
              <div />
              <div>Track</div>
              {mode === "artists" || mode === "playlists" ? (
                <div>Playlists</div>
              ) : null}
              <div>Duration / Actions</div>
            </div>
          ) : null}
          {tracks.map((track, idx) => (
            <div
              key={`${track.itemId || track.trackId || idx}`}
              className="track-row"
              style={
                mode === "artists" || mode === "playlists"
                  ? { gridTemplateColumns: "98px 1fr 1fr auto" }
                  : undefined
              }
              role="button"
              tabIndex={0}
              onClick={() => openDetailFromRow(track)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openDetailFromRow(track);
                }
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: 10 }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="play-btn"
                  aria-label="Play track"
                  title="Play"
                  disabled={!track.trackId}
                  onClick={() => handlePlayTrack(track.trackId)}
                >
                  ▶
                </button>
                {track.coverUrl || track.albumImageUrl ? (
                  <img
                    src={track.coverUrl || track.albumImageUrl || undefined}
                    alt={track.albumName || "Album cover"}
                    loading="lazy"
                    style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 12,
                      background: "#2a2a2a",
                    }}
                  />
                )}
              </div>
              <div>
                <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
                  {track.name || "Unknown"}
                  {currentTrackId && track.trackId === currentTrackId ? (
                    <span className="playing-indicator" aria-label="Now playing">
                      ▶
                    </span>
                  ) : null}
                </div>
                <div className="text-body">
                  {dedupeArtistText(track.artists || "") || "Unknown artist"}
                </div>
                {track.albumName ? (
                  <div className="text-subtle">{track.albumName}</div>
                ) : null}
              </div>
              {mode === "artists" || mode === "playlists" ? (
                <div>{renderPlaylistChips(track.playlists)}</div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="text-subtle">
                  {formatDuration(track.durationMs)}
                </div>
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
                  onClick={(event) => {
                    event.stopPropagation();
                    const trackUrl = track.trackId
                      ? `https://open.spotify.com/track/${track.trackId}`
                      : null;
                    handleChatGptClick(trackUrl);
                  }}
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
                {track.trackId ? (
                  <a
                    href={`https://open.spotify.com/track/${track.trackId}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Spotify"
                    title="Open in Spotify"
                    style={{ color: "var(--text-primary)", display: "inline-flex" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="currentColor"
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.6 14.52c-.18.3-.57.4-.87.22-2.4-1.46-5.42-1.8-8.97-1.02-.34.08-.68-.13-.76-.47-.08-.34.13-.68.47-.76 3.86-.86 7.2-.47 9.9 1.18.3.18.4.57.22.87Zm1.24-2.76c-.22.36-.7.48-1.06.26-2.74-1.68-6.92-2.17-10.17-1.18-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.33-.57 11.47 1.36.36.22.48.7.26 1.05Zm.11-2.87c-3.28-1.95-8.69-2.13-11.82-1.18-.49.15-1.02-.13-1.17-.62-.15-.49.13-1.02.62-1.17 3.59-1.09 9.56-.88 13.33 1.36.44.26.58.83.32 1.27-.26.44-.83.58-1.27.32Z" />
                    </svg>
                  </a>
                ) : null}
                {track.trackId ? (
                  <span className="text-subtle">Spotify</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="track-list" style={{ marginTop: 16 }}>
          {selectedTrackName ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks named: <strong>{selectedTrackName}</strong>
            </div>
          ) : null}
          {filteredTrackItems.length ? (
            <div className="track-header columns-4">
              <div />
              <div>Track</div>
              <div>Playlists</div>
              <div>Actions</div>
            </div>
          ) : null}
          {filteredTrackItems.map((track) => {
            const coverUrl = track.album?.images?.[0]?.url ?? null;
            const artistNames = track.artists
              .map((artist) => artist?.name)
              .filter(Boolean)
              .join(", ");
            const uniqueArtistNames = dedupeArtistText(artistNames);
            return (
              <div
                key={track.id}
                className="track-row"
                style={{ gridTemplateColumns: "98px 1fr 1fr auto" }}
                role="button"
                tabIndex={0}
                onClick={() => openDetailFromItem(track)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openDetailFromItem(track);
                  }
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="play-btn"
                    aria-label="Play track"
                    title="Play"
                    onClick={() => handlePlayTrack(track.id)}
                  >
                    ▶
                  </button>
                  {coverUrl ? (
                    <img
                      src={coverUrl || undefined}
                      alt={track.album?.name || "Album cover"}
                      loading="lazy"
                      style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover" }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 12,
                      background: "#2a2a2a",
                    }}
                  />
                )}
                </div>
                <div>
                  <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
                    {track.name}
                    {currentTrackId && track.id === currentTrackId ? (
                      <span className="playing-indicator" aria-label="Now playing">
                        ▶
                      </span>
                    ) : null}
                  </div>
                  <div className="text-body">
                    {uniqueArtistNames || "Unknown artist"}
                  </div>
                  {track.album?.name ? (
                    <div className="text-subtle">{track.album.name}</div>
                  ) : null}
                </div>
                <div>{renderPlaylistChips(track.playlists)}</div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
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
                    onClick={(event) => {
                      event.stopPropagation();
                      const trackUrl = track.id
                        ? `https://open.spotify.com/track/${track.id}`
                        : null;
                      handleChatGptClick(trackUrl);
                    }}
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
                  <a
                    href={`https://open.spotify.com/track/${track.id}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Spotify"
                    title="Open in Spotify"
                    style={{ color: "var(--text-primary)", display: "inline-flex" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="currentColor"
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.6 14.52c-.18.3-.57.4-.87.22-2.4-1.46-5.42-1.8-8.97-1.02-.34.08-.68-.13-.76-.47-.08-.34.13-.68.47-.76 3.86-.86 7.2-.47 9.9 1.18.3.18.4.57.22.87Zm1.24-2.76c-.22.36-.7.48-1.06.26-2.74-1.68-6.92-2.17-10.17-1.18-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.33-.57 11.47 1.36.36.22.48.7.26 1.05Zm.11-2.87c-3.28-1.95-8.69-2.13-11.82-1.18-.49.15-1.02-.13-1.17-.62-.15-.49.13-1.02.62-1.17 3.59-1.09 9.56-.88 13.33 1.36.44.26.58.83.32 1.27-.26.44-.83.58-1.27.32Z" />
                    </svg>
                  </a>
                  <span className="text-subtle" style={{ marginLeft: 6 }}>
                    Spotify
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {mode === "tracks" ? (
          loadingTracksList ? (
            <span className="text-body">Loading tracks...</span>
          ) : null
        ) : loadingTracks ? (
          <span className="text-body">
            Loading tracks...
          </span>
        ) : null}
        {!loadingTracks && nextCursor && mode !== "tracks" ? (
          <button
            onClick={loadMore}
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
          >
            Load more
          </button>
        ) : null}
      </div>

      {selectedTrackDetail && !selectedArtistDetail ? (
        <div
          className="track-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Track details"
          onClick={() => setSelectedTrackDetail(null)}
        >
          <div
            className="track-detail-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="track-detail-header">
              <div className="track-detail-header-left">
                <div className="track-detail-header-cover">
                  {selectedTrackDetail.coverUrl || selectedTrackDetail.albumImageUrl ? (
                    <img
                      src={
                        selectedTrackDetail.coverUrl ||
                        selectedTrackDetail.albumImageUrl ||
                        undefined
                      }
                      alt={selectedTrackDetail.albumName || "Album cover"}
                      loading="lazy"
                    />
                  ) : (
                    <div className="track-detail-header-cover placeholder" />
                  )}
                </div>
                <div>
                  <div className="text-subtle">Track details</div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
                    {selectedTrackDetail.name || "Unknown track"}
                  </div>
                  {selectedTrackDetail.artists?.length ? (
                    <div className="text-body">
                      {selectedTrackDetail.artists.map((artist, index) => (
                        <span key={artist.id}>
                          <button
                            type="button"
                            className="artist-link"
                            onClick={() => openArtistDetail(artist.id, artist.name)}
                          >
                            {artist.name}
                          </button>
                          {index < (selectedTrackDetail.artists?.length ?? 0) - 1
                            ? ", "
                            : ""}
                        </span>
                      ))}
                    </div>
                  ) : selectedTrackDetail.artistsText ? (
                    <div className="text-body">{selectedTrackDetail.artistsText}</div>
                  ) : null}
                  {selectedTrackDetail.albumName ? (
                    <div className="text-subtle">{selectedTrackDetail.albumName}</div>
                  ) : null}
                </div>
              </div>
              <div className="track-detail-header-actions">
                {selectedTrackDetail.spotifyUrl ? (
                  <a
                    href={selectedTrackDetail.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Open in Spotify
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelectedTrackDetail(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="track-detail-body">
              <div className="track-detail-content">
                <div className="track-detail-section">
                  <div className="track-detail-title">Basics</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Duration</div>
                      <div>{formatDuration(selectedTrackDetail.durationMs)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Explicit</div>
                      <div>{formatExplicit(selectedTrackDetail.explicit)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Popularity</div>
                      <div>
                        {selectedTrackDetail.popularity === null ||
                        selectedTrackDetail.popularity === undefined
                          ? "—"
                          : selectedTrackDetail.popularity}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Added at</div>
                      <div>{formatTimestamp(selectedTrackDetail.addedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Album</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Album</div>
                      <div>{selectedTrackDetail.albumName || "—"}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Artists</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedTrackDetail.artists?.length ? (
                        <div>
                          {selectedTrackDetail.artists.map((artist) => (
                            <div key={artist.id}>
                              <button
                                type="button"
                                className="artist-link"
                                onClick={() => openArtistDetail(artist.id, artist.name)}
                              >
                                {artist.name}
                              </button>{" "}
                              {artist.id ? (
                                <span className="text-subtle">({artist.id})</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : trackArtistsLoading ? (
                        <div className="text-subtle">Loading artist info…</div>
                      ) : (
                        <div>{selectedTrackDetail.artistsText || "—"}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Playlists</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedTrackDetail.playlists?.length ? (
                        <div className="track-detail-playlists">
                          {selectedTrackDetail.playlists.map((pl) => (
                            <a
                              key={pl.id}
                              href={pl.spotifyUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {pl.name || "Untitled playlist"}
                            </a>
                          ))}
                        </div>
                      ) : (
                        <div>—</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedArtistDetail ? (
        <div
          className="track-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Artist details"
          onClick={() => setSelectedArtistDetail(null)}
        >
          <div
            className="track-detail-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="track-detail-header">
              <div className="track-detail-header-left">
                <div>
                  <div className="text-subtle">Artist details</div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
                    {selectedArtistDetail.name || "Unknown artist"}
                  </div>
                  {selectedArtistDetail.genres?.length ? (
                    <div className="text-body">
                      {selectedArtistDetail.genres.join(", ")}
                    </div>
                  ) : (
                    <div className="text-subtle">No genres available</div>
                  )}
                </div>
              </div>
              <div className="track-detail-header-actions">
                {selectedArtistDetail.spotifyUrl ? (
                  <a
                    href={selectedArtistDetail.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Open in Spotify
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelectedArtistDetail(null)}
                >
                  Back to track
                </button>
              </div>
            </div>
            <div className="track-detail-body">
              <div className="track-detail-content">
                <div className="track-detail-section">
                  <div className="track-detail-title">Overview</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Popularity</div>
                      <div>
                        {selectedArtistDetail.popularity === null ||
                        selectedArtistDetail.popularity === undefined
                          ? "—"
                          : selectedArtistDetail.popularity}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Tracks in library</div>
                      <div>{selectedArtistDetail.tracksCount ?? 0}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Genres</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedArtistDetail.genres?.length ? (
                        <div className="track-detail-playlists">
                          {selectedArtistDetail.genres.map((genre) => (
                            <span key={genre}>{genre}</span>
                          ))}
                        </div>
                      ) : (
                        <div>—</div>
                      )}
                    </div>
                  </div>
                </div>
                {artistDetailLoading ? (
                  <div className="text-subtle">Loading artist details...</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
