/** @fileoverview Keyed in-flight loads that concurrent callers join, aborted only once every caller has left. @module services/single-flight */

interface Flight<V> {
  controller: AbortController;
  promise: Promise<V>;
  waiters: number;
}

/** One shared load per key; the caller wraps cache reads and writes around `join`. */
export class SingleFlight<K, V> {
  private readonly flights = new Map<K, Flight<V>>();

  /**
   * Join the load running for `key`, or start it with `start`, which receives the shared load's signal.
   * A caller's cancellation rejects only that caller; the shared load aborts when its last caller
   * leaves. The flight clears when `start` settles, so a failed load is never joined by a later call.
   */
  async join(
    key: K,
    signal: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<V>,
  ): Promise<V> {
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<V> = { controller, waiters: 0, promise: start(controller.signal) };
      created.promise = created.promise.finally(() => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      this.flights.set(key, created);
      flight = created;
    }
    const current = flight;
    current.waiters++;
    try {
      if (!signal) return await current.promise;
      return await new Promise<V>((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        signal.addEventListener('abort', cancelled, { once: true });
        current.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancelled));
      });
    } finally {
      current.waiters--;
      if (current.waiters === 0 && this.flights.get(key) === current) {
        current.controller.abort();
        this.flights.delete(key);
        await current.promise.catch(() => undefined);
      }
    }
  }
}
