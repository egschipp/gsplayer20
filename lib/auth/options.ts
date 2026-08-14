import type { NextAuthOptions } from "next-auth";
import SpotifyProvider from "next-auth/providers/spotify";
import { requireEnv } from "@/lib/env";
import { scopeString } from "@/lib/spotify/scopes";
import { getOrCreateUser, upsertTokens } from "@/lib/db/queries";
import { endAuthLog, logAuthEvent } from "@/lib/auth/authLog";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import { createCorrelationId } from "@/lib/observability/correlation";
import { getSqlite } from "@/lib/db/client";
import { deleteAccountData } from "@/src/features/account/data/delete-account-data";

export function getAuthOptions(): NextAuthOptions {
  if (!process.env.NEXTAUTH_URL && process.env.AUTH_URL) {
    process.env.NEXTAUTH_URL = process.env.AUTH_URL;
  }
  const authUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL || "";
  const secureCookies = authUrl.startsWith("https://");
  const cookiePrefix = secureCookies ? "__Secure-" : "";
  return {
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    session: { strategy: "jwt" },
    useSecureCookies: secureCookies,
    cookies: {
      sessionToken: {
        name: `${cookiePrefix}next-auth.session-token`,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: secureCookies,
        },
      },
      callbackUrl: {
        name: `${cookiePrefix}next-auth.callback-url`,
        options: {
          sameSite: "lax",
          path: "/",
          secure: secureCookies,
        },
      },
      csrfToken: {
        name: secureCookies ? "__Host-next-auth.csrf-token" : "next-auth.csrf-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: secureCookies,
        },
      },
      pkceCodeVerifier: {
        name: `${cookiePrefix}next-auth.pkce.code_verifier`,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: secureCookies,
        },
      },
      state: {
        name: `${cookiePrefix}next-auth.state`,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: secureCookies,
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
            ...(process.env.SPOTIFY_FORCE_CONSENT === "true"
              ? { show_dialog: "true" }
              : {}),
          },
        },
        checks: ["pkce", "state"],
        profile(profile: Record<string, unknown>) {
          const images = Array.isArray(profile.images) ? profile.images : [];
          const firstImage = images[0] as { url?: unknown } | undefined;
          const publicId = typeof profile.id === "string" ? profile.id : "";
          const accountId =
            typeof profile.account_id === "string" && profile.account_id.trim()
              ? profile.account_id.trim()
              : publicId;
          return {
            id: accountId,
            name: typeof profile.display_name === "string" ? profile.display_name : null,
            // The Playback SDK requires user-read-email, but this app deliberately
            // does not copy that value into its own session or database.
            email: null,
            image: typeof firstImage?.url === "string" ? firstImage.url : null,
          };
        },
      }),
    ],
    logger: {
      error(code, metadata) {
        const error = (metadata as any)?.error;
        const cause = error?.cause ?? error?.cause?.error ?? error?.cause?.data;
        logAuthEvent({
          level: "error",
          event: "nextauth_error",
          errorCode: String(code),
          data: metadata
            ? {
                errorSummary: {
                  name: error?.name,
                  message: String(error?.message || "").slice(0, 300),
                  status: cause?.status ?? cause?.statusCode,
                  error: cause?.error,
                },
              }
            : undefined,
        });
      },
      warn(code) {
        logAuthEvent({
          level: "warn",
          event: "nextauth_warn",
          errorCode: String(code),
        });
      },
      debug(code) {
        logAuthEvent({
          level: "debug",
          event: "nextauth_debug",
          data: { code },
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
      async signOut(message) {
        const appUserId =
          "token" in message && typeof message.token?.appUserId === "string"
            ? message.token.appUserId
            : null;
        if (appUserId) {
          try {
            deleteAccountData(getSqlite(), appUserId);
          } catch {
            logAuthEvent({
              level: "error",
              event: "nextauth_signout_account_cleanup_failed",
              errorCode: "ACCOUNT_DELETE_FAILED",
            });
          }
        }
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
      async jwt({ token, account, profile }) {
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

          const spotifyAccountId = account.providerAccountId;
          const rawProfile = profile as Record<string, unknown> | undefined;
          const spotifyUserId =
            typeof rawProfile?.id === "string" && rawProfile.id.trim()
              ? rawProfile.id.trim()
              : spotifyAccountId;
          const user = await getOrCreateUser({ spotifyUserId, spotifyAccountId });

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
            spotifyAccountId,
            appUserId: user.id,
          };
        }

        if (token.accessTokenExpires && Date.now() < token.accessTokenExpires - 60_000) {
          return token;
        }

        const terminalErrors = new Set([
          "MissingRefreshToken",
          "REFRESH_EXPIRED",
          "INVALID_GRANT",
          "MissingUserId",
        ]);
        if (token.error && terminalErrors.has(String(token.error))) {
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

        const refreshed = await getValidAccessTokenForUser({
          userId: token.appUserId as string,
          correlationId: createCorrelationId(),
        });

        if (!refreshed.ok) {
          logAuthEvent({
            level: "error",
            event: "token_refresh_failed",
            errorCode: refreshed.code,
            data: { error: refreshed.code },
          });
          if (
            refreshed.code === "INVALID_GRANT" ||
            refreshed.code === "MISSING_REFRESH_TOKEN"
          ) {
            return {
              ...token,
              error: refreshed.code,
              accessToken: undefined,
              accessTokenExpires: 0,
            };
          }
          return {
            ...token,
            error: "REFRESH_TEMPORARY_FAILURE",
          };
        }

        return {
          ...token,
          error: undefined,
          accessToken: refreshed.accessToken,
          accessTokenExpires: refreshed.accessExpiresAt ?? token.accessTokenExpires,
          scope: refreshed.scope ?? (token.scope as string | undefined),
        };
      },
      async session({ session, token }) {
        session.expiresAt = token.accessTokenExpires as number | undefined;
        session.scope = token.scope as string | undefined;
        session.error = token.error as string | undefined;
        session.spotifyUserId = token.spotifyUserId as string | undefined;
        session.spotifyAccountId = token.spotifyAccountId as string | undefined;
        session.appUserId = token.appUserId as string | undefined;
        return session;
      },
    },
  };
}
