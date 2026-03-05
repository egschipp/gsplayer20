import { Redis } from "@upstash/redis";

let redisClient: Redis | null | undefined;

function readConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

export function getRedisClient(): Redis | null {
  if (redisClient !== undefined) {
    return redisClient;
  }

  const config = readConfig();
  if (!config) {
    redisClient = null;
    return redisClient;
  }

  redisClient = new Redis({
    url: config.url,
    token: config.token,
  });

  return redisClient;
}
