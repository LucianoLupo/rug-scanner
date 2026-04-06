import { Redis } from '@upstash/redis';

export class CacheService {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get<T>(key);
    return value ?? null;
  }

  async set(key: string, value: unknown, ttlSeconds: number = 1800): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }
}
