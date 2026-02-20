import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  playlistItems,
  tracks,
  userPlaylists,
  userSavedTracks,
  syncState,
  trackArtists,
  artists,
  playlists,
} from "@/lib/db/schema";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  jsonNoStore,
  jsonPrivateCache,
  rateLimitResponse,
  requireAppUser,
  requireSameOrigin,
} from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

function normalizeTrackId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (TRACK_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const id = raw.split(":").pop() ?? "";
    return TRACK_ID_REGEX.test(id) ? id : null;
  }
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    if (match?.[1]) return match[1];
  } catch {
    // ignore
  }
  return null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `playlist-items:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return jsonPrivateCache({ error: "MISSING_PLAYLIST" }, 400);
  }

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 50)
      : 50;
  const cursor = searchParams.get("cursor");
  const live = searchParams.get("live") === "1";

  const db = getDb();
  const baseWhere = and(
    eq(userPlaylists.userId, session.appUserId as string),
    eq(playlistItems.playlistId, playlistId)
  );
  if (!baseWhere) {
    return jsonError("INVALID_PLAYLIST", 400);
  }
  let whereClause = baseWhere;

  if (cursor && !live) {
    const decoded = tryDecodeCursor(cursor);
    if (!decoded) {
      return jsonError("INVALID_CURSOR", 400);
    }
    const cursorWhere = and(
      baseWhere,
      or(
        gt(playlistItems.position, decoded.addedAt),
        and(
          eq(playlistItems.position, decoded.addedAt),
          gt(playlistItems.itemId, decoded.id)
        )
      )
    );
    if (!cursorWhere) {
      return jsonError("INVALID_CURSOR", 400);
    }
    whereClause = cursorWhere;
  }

  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      playlistId: playlistItems.playlistId,
      trackId: tracks.trackId,
      name: tracks.name,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      isLocal: tracks.isLocal,
      linkedFromTrackId: tracks.linkedFromTrackId,
      restrictionsReason: tracks.restrictionsReason,
      popularity: tracks.popularity,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      artists: sql<string | null>`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
      saved: sql<number>`max(${userSavedTracks.trackId} IS NOT NULL)`,
      addedAt: playlistItems.addedAt,
      addedBySpotifyUserId: playlistItems.addedBySpotifyUserId,
      position: playlistItems.position,
      snapshotIdAtSync: playlistItems.snapshotIdAtSync,
      syncRunId: playlistItems.syncRunId,
    })
    .from(playlistItems)
    .innerJoin(
      userPlaylists,
      eq(userPlaylists.playlistId, playlistItems.playlistId)
    )
    .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, tracks.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .where(whereClause)
    .groupBy(
      playlistItems.itemId,
      playlistItems.playlistId,
      playlistItems.addedAt,
      playlistItems.position,
      tracks.trackId
    )
    .orderBy(asc(playlistItems.position), asc(playlistItems.itemId))
    .limit(limit);

  if (live || (!rows.length && !cursor)) {
    const parsedOffset = Number(cursor ?? "0");
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
    try {
      const liveResponse = await spotifyFetch<{
        items?: Array<{
          added_at?: string;
          added_by?: { id?: string };
          track?: {
            id?: string;
            name?: string;
            duration_ms?: number;
            explicit?: boolean;
            is_local?: boolean;
            linked_from?: { id?: string | null };
            restrictions?: { reason?: string | null };
            popularity?: number;
            album?: {
              id?: string;
              name?: string;
              release_date?: string;
              images?: Array<{ url?: string }>;
            };
            artists?: Array<{ name?: string }>;
          };
        }>;
        next?: string | null;
      }>({
        url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          playlistId
        )}/tracks?limit=${limit}&offset=${offset}`,
        userLevel: true,
      });

      const now = Date.now();
      const mapped = (Array.isArray(liveResponse?.items) ? liveResponse.items : [])
        .map((item, index) => {
          const track = item?.track;
          const trackId = typeof track?.id === "string" ? track.id : null;
          const releaseDate = track?.album?.release_date ?? null;
          const releaseYear =
            releaseDate && /^\d{4}/.test(releaseDate)
              ? Number(releaseDate.slice(0, 4))
              : null;
          const addedAtValue = item?.added_at ? Date.parse(item.added_at) : NaN;
          const albumImageUrl =
            track?.album?.images?.find((img) => typeof img?.url === "string")?.url ??
            null;
          const trackName = track?.name ?? "Onbekend nummer";
          return {
            itemId: `${playlistId}:${offset + index}:${trackId ?? "unknown"}`,
            playlistId,
            trackId,
            name: trackName,
            albumId: track?.album?.id ?? null,
            albumName: track?.album?.name ?? null,
            albumReleaseDate: releaseDate,
            releaseYear,
            albumImageUrl,
            coverUrl: albumImageUrl,
            durationMs:
              typeof track?.duration_ms === "number" ? track.duration_ms : null,
            explicit:
              typeof track?.explicit === "boolean"
                ? track.explicit
                  ? 1
                  : 0
                : null,
            isLocal:
              typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
            linkedFromTrackId:
              typeof track?.linked_from?.id === "string" ? track.linked_from.id : null,
            restrictionsReason:
              typeof track?.restrictions?.reason === "string"
                ? track.restrictions.reason
                : null,
            popularity:
              typeof track?.popularity === "number" ? track.popularity : null,
            artists: Array.isArray(track?.artists)
              ? track.artists
                  .map((artist) => artist?.name)
                  .filter(Boolean)
                  .join(", ")
              : null,
            addedAt: Number.isFinite(addedAtValue) ? addedAtValue : null,
            addedBySpotifyUserId: item?.added_by?.id ?? null,
            position: index,
            snapshotIdAtSync: null,
            syncRunId: null,
            playlists: [
              {
                id: playlistId,
                name: "Geselecteerde playlist",
                spotifyUrl: `https://open.spotify.com/playlist/${playlistId}`,
              },
            ],
          };
        })
        .filter(Boolean);

      return jsonNoStore({
        items: mapped,
        nextCursor: liveResponse?.next ? String(offset + mapped.length) : null,
        asOf: now,
        sync: {
          status: "live",
          lastSuccessfulAt: now,
          lagSec: 0,
        },
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) return jsonError("UNAUTHENTICATED", 401);
        if (error.status === 403) return jsonError("FORBIDDEN", 403);
        if (error.status === 404) return jsonError("PLAYLIST_NOT_FOUND", 404);
        if (error.status === 429) return jsonError("SPOTIFY_RATE_LIMIT", 429);
        return jsonError("SPOTIFY_UPSTREAM", 502);
      }
      if (String(error).includes("UserNotAuthenticated")) {
        return jsonError("UNAUTHENTICATED", 401);
      }
      return jsonError("SPOTIFY_UPSTREAM", 502);
    }
  }

  const trackIds = rows
    .map((row) => row.trackId)
    .filter((id): id is string => Boolean(id));
  const playlistRows = trackIds.length
    ? await db
        .select({
          trackId: playlistItems.trackId,
          playlistId: playlists.playlistId,
          playlistName: playlists.name,
        })
        .from(playlistItems)
        .innerJoin(playlists, eq(playlists.playlistId, playlistItems.playlistId))
        .innerJoin(
          userPlaylists,
          and(
            eq(userPlaylists.playlistId, playlists.playlistId),
            eq(userPlaylists.userId, session.appUserId as string)
          )
        )
        .where(inArray(playlistItems.trackId, trackIds))
    : [];

  const playlistsByTrack = new Map<string, { id: string; name: string }[]>();
  for (const row of playlistRows) {
    if (!row.trackId || !row.playlistId) continue;
    const list = playlistsByTrack.get(row.trackId) ?? [];
    if (!list.find((item) => item.id === row.playlistId)) {
      list.push({ id: row.playlistId, name: row.playlistName ?? "" });
      playlistsByTrack.set(row.trackId, list);
    }
  }

  const last = rows[rows.length - 1];
  const nextCursor = last
    ? encodeCursor(last.position ?? 0, last.itemId)
    : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, `playlist_items:${playlistId}`)
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;

  return jsonPrivateCache({
    items: rows.map((row) => ({
      ...row,
      coverUrl: row.hasCover ? `/api/spotify/cover/${row.trackId}` : row.albumImageUrl,
      playlists: [
        ...(row.saved
          ? [
              {
                id: "liked",
                name: "Liked Songs",
                spotifyUrl: "https://open.spotify.com/collection/tracks",
              },
            ]
          : []),
        ...((row.trackId ? playlistsByTrack.get(row.trackId) : null) ?? []).map(
          (pl) => ({
          ...pl,
          spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
          })
        ),
      ],
    })),
    nextCursor,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `playlist-items:add:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) return jsonError("MISSING_PLAYLIST", 400);

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
        playlistId
      )}/tracks`,
      method: "POST",
      body: { uris: [`spotify:track:${trackId}`] },
      userLevel: true,
    });
    return jsonNoStore({ playlistId, trackId, added: true });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonError("UNAUTHENTICATED", 401);
      if (error.status === 403) return jsonError("FORBIDDEN", 403);
      if (error.status === 404) return jsonError("PLAYLIST_NOT_FOUND", 404);
      if (error.status === 429) return jsonError("SPOTIFY_RATE_LIMIT", 429);
      return jsonError("SPOTIFY_UPSTREAM", 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonError("UNAUTHENTICATED", 401);
    }
    return jsonError("SPOTIFY_UPSTREAM", 502);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `playlist-items:remove:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) return jsonError("MISSING_PLAYLIST", 400);

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
        playlistId
      )}/tracks`,
      method: "DELETE",
      body: { tracks: [{ uri: `spotify:track:${trackId}` }] },
      userLevel: true,
    });
    return jsonNoStore({ playlistId, trackId, removed: true });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonError("UNAUTHENTICATED", 401);
      if (error.status === 403) return jsonError("FORBIDDEN", 403);
      if (error.status === 404) return jsonError("PLAYLIST_NOT_FOUND", 404);
      if (error.status === 429) return jsonError("SPOTIFY_RATE_LIMIT", 429);
      return jsonError("SPOTIFY_UPSTREAM", 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonError("UNAUTHENTICATED", 401);
    }
    return jsonError("SPOTIFY_UPSTREAM", 502);
  }
}
