import { jsonPrivateCache, rateLimitResponse, requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";

export const runtime = "nodejs";

const TARGET_PLAYLIST_NAME = "Georgies Spotify Suggesties";
const MAX_PLAYLIST_TRACKS = 500;

type PlaylistItem = { id: string; name: string };

async function getPlaylistById(id: string) {
  try {
    const playlist = await spotifyFetch<{ id: string; name: string }>({
      url: `https://api.spotify.com/v1/playlists/${id}?fields=id,name`,
      userLevel: true,
    });
    if (playlist?.id && playlist?.name === TARGET_PLAYLIST_NAME) {
      return { id: playlist.id, name: playlist.name };
    }
  } catch {
    // ignore
  }
  return null;
}

async function findPlaylistByName(): Promise<PlaylistItem | null> {
  let url: string | null = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) {
    const data = await spotifyFetch<{
      items: { id: string; name: string }[];
      next: string | null;
    }>({
      url,
      userLevel: true,
    });
    const match = data.items?.find((item) => item.name === TARGET_PLAYLIST_NAME);
    if (match) return { id: match.id, name: match.name };
    url = data.next;
  }
  return null;
}

async function createPlaylist(userId: string): Promise<PlaylistItem> {
  const created = await spotifyFetch<{ id: string; name: string }>({
    url: `https://api.spotify.com/v1/users/${userId}/playlists`,
    method: "POST",
    body: {
      name: TARGET_PLAYLIST_NAME,
      public: false,
      description: "Suggesties vanuit GSPlayer20",
    },
    userLevel: true,
  });
  return { id: created.id, name: created.name };
}

async function getPlaylistTrackIds(playlistId: string) {
  const ids = new Set<string>();
  let url: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(id)),next&limit=100`;
  while (url && ids.size < MAX_PLAYLIST_TRACKS) {
    const data = await spotifyFetch<{
      items: { track: { id: string | null } | null }[];
      next: string | null;
    }>({ url, userLevel: true });
    for (const item of data.items || []) {
      const id = item?.track?.id;
      if (id) ids.add(id);
    }
    url = data.next;
  }
  return ids;
}

function uniqueSeeds(seeds: string[]) {
  const result: string[] = [];
  for (const seed of seeds) {
    if (!seed) continue;
    if (result.includes(seed)) continue;
    result.push(seed);
    if (result.length >= 5) break;
  }
  return result;
}

async function getRecommendations(seedTracks: string[], relaxed = false) {
  const url = new URL("https://api.spotify.com/v1/recommendations");
  url.searchParams.set("limit", "20");
  url.searchParams.set("seed_tracks", seedTracks.join(","));
  if (!relaxed) {
    url.searchParams.set("target_energy", "0.7");
    url.searchParams.set("target_valence", "0.55");
    url.searchParams.set("min_popularity", "30");
  } else {
    url.searchParams.set("min_popularity", "15");
  }
  return await spotifyFetch<{ tracks: any[] }>({
    url: url.toString(),
    userLevel: true,
  });
}

export async function POST(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `discover:${session.appUserId}`,
    limit: 90,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const body = await req.json().catch(() => ({}));
  const seedTracks = Array.isArray(body?.seedTracks) ? body.seedTracks : [];
  const existingTrackIds = new Set<string>(
    Array.isArray(body?.existingTrackIds) ? body.existingTrackIds : []
  );
  const playlistIdHint =
    typeof body?.playlistId === "string" ? body.playlistId : null;

  const profile = await spotifyFetch<{ id: string }>({
    url: "https://api.spotify.com/v1/me",
    userLevel: true,
  });
  const userId = profile?.id;
  if (!userId) {
    return jsonPrivateCache({ error: "MISSING_USER" }, 401);
  }

  let playlist: PlaylistItem | null = null;
  if (playlistIdHint) {
    playlist = await getPlaylistById(playlistIdHint);
  }
  if (!playlist) {
    playlist = await findPlaylistByName();
  }
  if (!playlist) {
    playlist = await createPlaylist(userId);
  }

  const playlistTrackIds = await getPlaylistTrackIds(playlist.id);
  const baseSeeds = uniqueSeeds(seedTracks);
  const fallbackSeeds = uniqueSeeds([
    ...baseSeeds,
    ...Array.from(existingTrackIds),
    ...Array.from(playlistTrackIds),
  ]);
  const seeds = baseSeeds.length ? baseSeeds : fallbackSeeds.slice(0, 5);

  if (!seeds.length) {
    return jsonPrivateCache({ playlist, tracks: [] });
  }

  const excluded = new Set<string>([...existingTrackIds, ...playlistTrackIds]);
  const collected: any[] = [];

  const primary = await getRecommendations(seeds, false);
  for (const track of primary.tracks || []) {
    if (!track?.id || excluded.has(track.id)) continue;
    excluded.add(track.id);
    collected.push(track);
  }

  if (collected.length < 5) {
    const relaxed = await getRecommendations(seeds, true);
    for (const track of relaxed.tracks || []) {
      if (!track?.id || excluded.has(track.id)) continue;
      excluded.add(track.id);
      collected.push(track);
      if (collected.length >= 20) break;
    }
  }

  const mapped = collected.map((track) => ({
    id: track.id,
    name: track.name,
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist: any) => artist?.name).filter(Boolean).join(", ")
      : "",
    coverUrl: track.album?.images?.[0]?.url ?? null,
    uri: track.uri,
  }));

  return jsonPrivateCache({ playlist, tracks: mapped });
}
