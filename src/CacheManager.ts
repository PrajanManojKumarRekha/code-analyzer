export interface CacheManagerOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessAt: number;
}

export interface CacheManagerStats {
  size: number;
  maxEntries: number;
  ttlMs: number;
}

export class CacheManager<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(options: CacheManagerOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 200);
    this.ttlMs = Math.max(1000, options.ttlMs ?? 60_000);
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    entry.lastAccessAt = Date.now();
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const now = Date.now();
    this.store.set(key, {
      value,
      expiresAt: now + this.ttlMs,
      lastAccessAt: now,
    });
    this.enforceCapacity();
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  stats(): CacheManagerStats {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }

  private enforceCapacity(): void {
    if (this.store.size <= this.maxEntries) {
      return;
    }

    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.store.entries()) {
      if (entry.lastAccessAt < oldestAccess) {
        oldestAccess = entry.lastAccessAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.store.delete(oldestKey);
    }
  }
}