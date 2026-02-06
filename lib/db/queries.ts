import { and, eq, desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  oauthTokens,
  users,
  userPlaylists,
  userSavedTracks,
  playlists,
  tracks,
  artists,
  trackArtists,
} from "@/lib/db/schema";
import { encryptToken, decryptToken } from "@/lib/crypto";

export async function getOrCreateUser(spotifyUserId: string) {
  const db = getDb();
  const id = cryptoRandomId();
  await db
    .insert(users)
    .values({ id, spotifyUserId })
    .onConflictDoNothing()
    .run();
  const row = await db
    .select()
    .from(users)
    .where(eq(users.spotifyUserId, spotifyUserId))
    .get();
  if (!row) {
    throw new Error("UserCreateFailed");
  }
  return row;
}

export async function upsertTokens(params: {
  userId: string;
  refreshToken: string;
  accessToken?: string;
  accessExpiresAt?: number;
  scope?: string;
}) {
  const db = getDb();
  const encrypted = encryptToken(params.refreshToken);

  await db
    .insert(oauthTokens)
    .values({
      userId: params.userId,
      refreshTokenEnc: encrypted.payload,
      accessToken: params.accessToken ?? null,
      accessExpiresAt: params.accessExpiresAt ?? null,
      scope: params.scope ?? null,
      encKeyVersion: encrypted.keyVersion,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: oauthTokens.userId,
      set: {
        refreshTokenEnc: encrypted.payload,
        accessToken: params.accessToken ?? null,
        accessExpiresAt: params.accessExpiresAt ?? null,
        scope: params.scope ?? null,
        encKeyVersion: encrypted.keyVersion,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export async function getRefreshToken(userId: string) {
  const db = getDb();
  const row = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, userId))
    .get();
  if (!row) return null;
  return decryptToken(row.refreshTokenEnc);
}

export async function deleteTokens(userId: string) {
  const db = getDb();
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId)).run();
}

export async function getUserIdBySpotifyId(spotifyUserId: string) {
  const db = getDb();
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.spotifyUserId, spotifyUserId))
    .get();
  return row?.id ?? null;
}

export function cryptoRandomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function updateUserSavedTrackSeen(userId: string, trackId: string) {
  const db = getDb();
  await db
    .insert(userSavedTracks)
    .values({
      userId,
      trackId,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [userSavedTracks.userId, userSavedTracks.trackId],
      set: { lastSeenAt: Date.now() },
    })
    .run();
}

export async function upsertTrack(params: {
  trackId: string;
  name: string;
  durationMs: number;
  explicit: boolean;
  albumId?: string | null;
  popularity?: number | null;
}) {
  const db = getDb();
  await db
    .insert(tracks)
    .values({
      trackId: params.trackId,
      name: params.name,
      durationMs: params.durationMs,
      explicit: params.explicit ? 1 : 0,
      albumId: params.albumId ?? null,
      popularity: params.popularity ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: tracks.trackId,
      set: {
        name: params.name,
        durationMs: params.durationMs,
        explicit: params.explicit ? 1 : 0,
        albumId: params.albumId ?? null,
        popularity: params.popularity ?? null,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export async function upsertArtist(params: {
  artistId: string;
  name: string;
  genres?: string[] | null;
  popularity?: number | null;
}) {
  const db = getDb();
  await db
    .insert(artists)
    .values({
      artistId: params.artistId,
      name: params.name,
      genres: params.genres ? JSON.stringify(params.genres) : null,
      popularity: params.popularity ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: artists.artistId,
      set: {
        name: params.name,
        genres: params.genres ? JSON.stringify(params.genres) : null,
        popularity: params.popularity ?? null,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export async function upsertTrackArtist(trackId: string, artistId: string) {
  const db = getDb();
  await db
    .insert(trackArtists)
    .values({ trackId, artistId })
    .onConflictDoNothing()
    .run();
}

export async function upsertPlaylist(params: {
  playlistId: string;
  name: string;
  ownerSpotifyUserId: string;
  isPublic?: boolean | null;
  collaborative?: boolean | null;
  snapshotId?: string | null;
  tracksTotal?: number | null;
}) {
  const db = getDb();
  await db
    .insert(playlists)
    .values({
      playlistId: params.playlistId,
      name: params.name,
      ownerSpotifyUserId: params.ownerSpotifyUserId,
      isPublic: params.isPublic === null ? null : params.isPublic ? 1 : 0,
      collaborative:
        params.collaborative === null
          ? null
          : params.collaborative
          ? 1
          : 0,
      snapshotId: params.snapshotId ?? null,
      tracksTotal: params.tracksTotal ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: playlists.playlistId,
      set: {
        name: params.name,
        ownerSpotifyUserId: params.ownerSpotifyUserId,
        isPublic: params.isPublic === null ? null : params.isPublic ? 1 : 0,
        collaborative:
          params.collaborative === null
            ? null
            : params.collaborative
            ? 1
            : 0,
        snapshotId: params.snapshotId ?? null,
        tracksTotal: params.tracksTotal ?? null,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export async function upsertUserPlaylist(userId: string, playlistId: string) {
  const db = getDb();
  await db
    .insert(userPlaylists)
    .values({ userId, playlistId, lastSeenAt: Date.now() })
    .onConflictDoUpdate({
      target: [userPlaylists.userId, userPlaylists.playlistId],
      set: { lastSeenAt: Date.now() },
    })
    .run();
}

export async function setLastSeen(userId: string, trackId: string, addedAt: number) {
  const db = getDb();
  await db
    .insert(userSavedTracks)
    .values({ userId, trackId, addedAt, lastSeenAt: Date.now() })
    .onConflictDoUpdate({
      target: [userSavedTracks.userId, userSavedTracks.trackId],
      set: { lastSeenAt: Date.now(), addedAt },
    })
    .run();
}

export async function getLatestSavedAddedAt(userId: string) {
  const db = getDb();
  const row = await db
    .select({ addedAt: userSavedTracks.addedAt })
    .from(userSavedTracks)
    .where(eq(userSavedTracks.userId, userId))
    .orderBy(desc(userSavedTracks.addedAt))
    .limit(1)
    .get();
  return row?.addedAt ?? null;
}
