export type Mode = "playlists" | "artists" | "tracks";

export type PlaylistOption = {
  id: string;
  name: string;
  type: "liked" | "playlist";
  spotifyUrl: string;
};

export type ArtistOption = {
  id: string;
  name: string;
  spotifyUrl: string;
};

export type TrackOption = {
  id: string;
  name: string;
  spotifyUrl: string;
  coverUrl?: string | null;
  trackId?: string | null;
  artistNames?: string | null;
};

export type PlaylistLink = { id: string; name: string; spotifyUrl: string };

export type TrackItem = {
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

export type TrackRow = {
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

export type TrackDetail = {
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

export type ArtistDetail = {
  artistId: string;
  name: string;
  genres: string[];
  popularity: number | null;
  tracksCount: number;
  updatedAt?: number | null;
  spotifyUrl?: string | null;
};

export const LIKED_OPTION: PlaylistOption = {
  id: "liked",
  name: "Liked Songs",
  type: "liked",
  spotifyUrl: "https://open.spotify.com/collection/tracks",
};
