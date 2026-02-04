import type { NextAuthOptions } from "next-auth";
import SpotifyProvider from "next-auth/providers/spotify";
import { requireEnv } from "@/lib/env";
import { scopeString } from "@/lib/spotify/scopes";
import { refreshAccessToken } from "@/lib/spotify/tokens";
import {
  deleteTokens,
  getOrCreateUser,
  getRefreshToken,
  upsertTokens,
} from "@/lib/db/queries";
import { endAuthLog, logAuthEvent } from "@/lib/auth/authLog";

export function getAuthOptions(): NextAuthOptions {
  return {
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    session: { strategy: "jwt" },
    useSecureCookies: true,
    cookies: {
      sessionToken: {
        name: "__Secure-next-auth.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: true,
        },
      },
      callbackUrl: {
        name: "__Secure-next-auth.callback-url",
        options: {
          sameSite: "lax",
          path: "/",
          secure: true,
        },
      },
      csrfToken: {
        name: "__Host-next-auth.csrf-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: true,
        },
      },
      pkceCodeVerifier: {
        name: "__Secure-next-auth.pkce.code_verifier",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: true,
        },
      },
      state: {
        name: "__Secure-next-auth.state",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: true,
        },
      },
    },
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
    logger: {
      error(code, metadata) {
        logAuthEvent({
          level: "error",
          event: "nextauth_error",
          errorCode: String(code),
          data: metadata ? { metadata } : undefined,
        });
      },
      warn(code) {
        logAuthEvent({
          level: "warn",
          event: "nextauth_warn",
          errorCode: String(code),
        });
      },
      debug(code, metadata) {
        logAuthEvent({
          level: "debug",
          event: "nextauth_debug",
          data: metadata ? { code, metadata } : { code },
        });
      },
    },
    events: {
      async signIn(message) {
        logAuthEvent({
          level: "info",
          event: "nextauth_signin",
          data: {
            provider: message.account?.provider,
            hasProfile: Boolean(message.profile),
            isNewUser: message.isNewUser ?? false,
          },
        });
        endAuthLog("signin_complete");
      },
      async signOut() {
        logAuthEvent({ level: "info", event: "nextauth_signout" });
      },
      async linkAccount(message) {
        logAuthEvent({
          level: "info",
          event: "nextauth_link_account",
          data: { provider: message.account?.provider },
        });
      },
    },
    callbacks: {
      async jwt({ token, account }) {
        if (account) {
          logAuthEvent({
            level: "info",
            event: "jwt_account_received",
            data: {
              provider: account.provider,
              scope: account.scope,
              hasRefreshToken: Boolean(account.refresh_token),
            },
          });
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

        if (token.error) {
          logAuthEvent({
            level: "warn",
            event: "token_refresh_skipped",
            errorCode: String(token.error),
          });
          return token;
        }

        if (!token.appUserId) {
          return { ...token, error: "MissingUserId" };
        }

        const storedRefresh = await getRefreshToken(token.appUserId as string);
        const refreshed = await refreshAccessToken({
          accessToken: token.accessToken as string | undefined,
          refreshToken: storedRefresh ?? undefined,
          accessTokenExpires: token.accessTokenExpires as number | undefined,
          scope: token.scope as string | undefined,
        });

        if ("error" in refreshed) {
          if (token.appUserId) {
            await deleteTokens(token.appUserId as string);
          }
          logAuthEvent({
            level: "error",
            event: "token_refresh_failed",
            errorCode: refreshed.error,
            data: { error: refreshed.error },
          });
          return {
            ...token,
            error: refreshed.error,
            accessToken: undefined,
            accessTokenExpires: 0,
          };
        }

        if (refreshed.refreshToken) {
          await upsertTokens({
            userId: token.appUserId as string,
            refreshToken: refreshed.refreshToken,
            accessToken: refreshed.accessToken,
            accessExpiresAt: refreshed.accessTokenExpires,
            scope: refreshed.scope,
          });
        }

        const { refreshToken, ...rest } = refreshed as {
          refreshToken?: string;
        } & typeof refreshed;
        return rest;
      },
      async session({ session, token }) {
        session.accessToken = token.accessToken as string | undefined;
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
