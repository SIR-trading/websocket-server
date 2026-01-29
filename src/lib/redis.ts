import { createClient, type RedisClientType } from "redis";

let redis: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("[Redis] REDIS_URL not set, running without Redis");
    return null;
  }

  if (!redis) {
    try {
      redis = createClient({ url }) as RedisClientType;

      redis.on("error", (err) => {
        console.error("[Redis] Connection error:", err);
      });

      redis.on("reconnecting", () => {
        console.log("[Redis] Reconnecting...");
      });

      await redis.connect();
      console.log("[Redis] Connected successfully");
    } catch (error) {
      console.error("[Redis] Failed to connect:", error);
      redis = null;
      return null;
    }
  }

  return redis;
}

export async function closeRedisClient(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    console.log("[Redis] Connection closed");
  }
}
