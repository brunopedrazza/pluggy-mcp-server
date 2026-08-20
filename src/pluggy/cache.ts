/**
 * In-memory cache.
 *
 * Nothing is written to disk. The VM holding this process is reachable from the
 * internet, and a cached statement on disk is a liability that an in-memory one
 * is not.
 *
 * Freshness is not managed with a TTL. Cache keys embed the item's
 * `lastUpdatedAt`, so while Pluggy has not synced the key is stable and the
 * entry is served; the moment it syncs, the key changes and the old entry is
 * unreachable. That makes serving stale data structurally impossible rather
 * than merely unlikely.
 */

type Entry = { value: unknown; expiresAt: number | null }

export class Cache {
  #entries = new Map<string, Entry>()
  #pending = new Map<string, Promise<unknown>>()

  /**
   * Returns the cached value, or loads it.
   *
   * Concurrent callers for the same key share one load. Without this, a client
   * that fires several tool calls at once would trigger several full statement
   * sweeps against Pluggy for the same data.
   *
   * @param versionPrefix When given, sibling entries under this prefix are
   *   evicted on write. Used with `lastUpdatedAt`-stamped keys so a sync does
   *   not leave the previous sweep resident forever.
   */
  async through<T>(
    key: string,
    load: () => Promise<T>,
    options: { ttlMs?: number; versionPrefix?: string } = {},
  ): Promise<T> {
    const hit = this.#entries.get(key)
    if (hit && (hit.expiresAt === null || hit.expiresAt > Date.now())) return hit.value as T

    const inFlight = this.#pending.get(key)
    if (inFlight) return inFlight as Promise<T>

    const promise = load()
      .then((value) => {
        if (options.versionPrefix) this.#evictPrefix(options.versionPrefix, key)
        this.#entries.set(key, {
          value,
          expiresAt: options.ttlMs === undefined ? null : Date.now() + options.ttlMs,
        })
        this.#pending.delete(key)
        return value
      })
      .catch((error: unknown) => {
        // Failures are never cached: a transient Pluggy error must not pin an
        // item into a broken state until the next sync.
        this.#pending.delete(key)
        throw error
      })

    this.#pending.set(key, promise)
    return promise
  }

  #evictPrefix(prefix: string, keep: string): void {
    for (const key of this.#entries.keys()) {
      if (key !== keep && key.startsWith(prefix)) this.#entries.delete(key)
    }
  }

  /** Drops everything. Used after a refresh so the next read re-resolves the item. */
  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}
