"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheManager = void 0;
class CacheManager {
    maxEntries;
    ttlMs;
    store = new Map();
    constructor(options = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? 200);
        this.ttlMs = Math.max(1000, options.ttlMs ?? 60_000);
    }
    get(key) {
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
    set(key, value) {
        const now = Date.now();
        this.store.set(key, {
            value,
            expiresAt: now + this.ttlMs,
            lastAccessAt: now,
        });
        this.enforceCapacity();
    }
    delete(key) {
        return this.store.delete(key);
    }
    clear() {
        this.store.clear();
    }
    prune() {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expiresAt) {
                this.store.delete(key);
            }
        }
    }
    stats() {
        return {
            size: this.store.size,
            maxEntries: this.maxEntries,
            ttlMs: this.ttlMs,
        };
    }
    enforceCapacity() {
        if (this.store.size <= this.maxEntries) {
            return;
        }
        let oldestKey;
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
exports.CacheManager = CacheManager;
