import { jsonPrivateCache, rateLimitResponse, requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `playlist-add:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return jsonPrivateCache({ error: "MISSING_PLAYLIST" }, 400);
  }

  const body = await req.json().catch(() => ({}));
  const uri = typeof body?.uri === "string" ? body.uri : null;
  const uris = Array.isArray(body?.uris) ? body.uris : null;
  const payloadUris = uris && uris.length ? uris : uri ? [uri] : [];
  if (!payloadUris.length) {
    return jsonPrivateCache({ error: "MISSING_TRACK_URI" }, 400);
  }

  await spotifyFetch({
    url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    method: "POST",
    body: { uris: payloadUris },
    userLevel: true,
  });

  return jsonPrivateCache({ ok: true });
}
