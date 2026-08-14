import { z } from "zod";

export const SpotifyTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export const SpotifyUserProfileSchema = z
  .object({
    account_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    display_name: z.string().nullable().optional(),
    product: z.string().optional(),
    images: z
      .array(
        z
          .object({
            url: z.string().url(),
            height: z.number().nullable().optional(),
            width: z.number().nullable().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export const SpotifyPlaybackStateSchema = z
  .object({
    timestamp: z.number().optional(),
    progress_ms: z.number().nullable().optional(),
    is_playing: z.boolean().optional(),
    shuffle_state: z.boolean().optional(),
    repeat_state: z.enum(["off", "track", "context"]).optional(),
    currently_playing_type: z.enum(["track", "episode", "ad", "unknown"]).optional(),
    actions: z
      .object({ disallows: z.record(z.string(), z.boolean().nullable()).optional() })
      .passthrough()
      .optional(),
    device: z
      .object({
        id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    context: z
      .object({ uri: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    item: z
      .object({
        id: z.string().nullable().optional(),
        uri: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        duration_ms: z.number().optional(),
        artists: z
          .array(z.object({ name: z.string().nullable().optional() }).passthrough())
          .optional(),
        album: z
          .object({
            images: z
              .array(z.object({ url: z.string().nullable().optional() }).passthrough())
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
