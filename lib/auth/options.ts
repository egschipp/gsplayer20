import type { NextAuthOptions } from "next-auth";
import SpotifyProvider from "next-auth/providers/spotify";
import { requireEnv } from "@/lib/env";
import { scopeString } from "@/lib/spotify/scopes";
import { refreshAccessToken } from "@/lib/spotify/tokens";
import { getOrCreateUser, upsertTokens } from "@/lib/db/queries";

export function getAuthOptions(): NextAuthOptions {
  return {
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    session: { strategy: "jwt" },
    providers: [
      SpotifyProvider({
        clientId: requireEnv("SPOTIFY_CLIENT_ID"),
        clientSecret: requireEnv("SPOTIFY_CLIENT_SECRET"),
        authorization: {
          params: {
            scope: scopeString(),
            show_dialog: "true",
          },
        },
        checks: ["pkce", "state"],
      }),
    ],
    callbacks: {
      async jwt({ token, account }) {
        if (account) {
          const expiresIn =
            typeof account.expires_in === "number"
              ? account.expires_in
              : Number(account.expires_in ?? 3600);
          const expiresAt =
            typeof account.expires_at === "number"
              ? account.expires_at * 1000
              : Date.now() + expiresIn * 1000;

          const spotifyUserId = account.providerAccountId;
          const user = await getOrCreateUser(spotifyUserId);

          if (account.refresh_token) {
            await upsertTokens({
              userId: user.id,
              refreshToken: account.refresh_token,
              accessToken: account.access_token ?? undefined,
              accessExpiresAt: expiresAt,
              scope: account.scope ?? undefined,
            });
          }

          return {
            ...token,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            accessTokenExpires: expiresAt,
            scope: account.scope,
            spotifyUserId,
            appUserId: user.id,
          };
        }

        if (
          token.accessTokenExpires &&
          Date.now() < token.accessTokenExpires - 60_000
        ) {
          return token;
        }

        return await refreshAccessToken(token as {
          accessToken?: string;
          refreshToken?: string;
          accessTokenExpires?: number;
          scope?: string;
        });
      },
      async session({ session, token }) {
        session.accessToken = token.accessToken as string | undefined;
        session.refreshToken = token.refreshToken as string | undefined;
        session.expiresAt = token.accessTokenExpires as number | undefined;
        session.scope = token.scope as string | undefined;
        session.error = token.error as string | undefined;
        session.spotifyUserId = token.spotifyUserId as string | undefined;
        session.appUserId = token.appUserId as string | undefined;
        return session;
      },
    },
  };
}
