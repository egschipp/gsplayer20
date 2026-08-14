import type Database from "better-sqlite3";

export function deleteAccountData(sqlite: Database.Database, userId: string): number {
  const removeUser = sqlite.transaction((targetUserId: string) => {
    const user = sqlite
      .prepare("SELECT spotify_user_id FROM users WHERE id = ?")
      .get(targetUserId) as { spotify_user_id?: string } | undefined;
    sqlite
      .prepare(
        `DELETE FROM playlists
         WHERE playlist_id IN (
           SELECT playlist_id FROM user_playlists WHERE user_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_playlists other
           WHERE other.playlist_id = playlists.playlist_id AND other.user_id <> ?
         )`
      )
      .run(targetUserId, targetUserId);
    if (user?.spotify_user_id) {
      sqlite
        .prepare(
          `UPDATE playlists
           SET owner_spotify_user_id = 'deleted', owner_display_name = NULL
           WHERE owner_spotify_user_id = ?`
        )
        .run(user.spotify_user_id);
    }
    const result = sqlite
      .prepare("DELETE FROM users WHERE id = ?")
      .run(targetUserId);
    sqlite
      .prepare(
        `DELETE FROM tracks
         WHERE NOT EXISTS (SELECT 1 FROM user_saved_tracks s WHERE s.track_id = tracks.track_id)
           AND NOT EXISTS (SELECT 1 FROM playlist_items p WHERE p.track_id = tracks.track_id)
           AND NOT EXISTS (SELECT 1 FROM user_recently_played r WHERE r.track_id = tracks.track_id)`
      )
      .run();
    sqlite
      .prepare(
        `DELETE FROM artists
         WHERE NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = artists.artist_id)`
      )
      .run();
    return result.changes;
  });

  return removeUser(userId);
}
