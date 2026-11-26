// A typed event bus — the generic replacement for EventTarget + CustomEvent.
// `E` maps event names to payload types; `K extends keyof E` ties the name you pass to the
// payload the listener receives, so `bus.emit('hit', { damage: 'lots' })` doesn't compile.

/** Structural subset of AbortSignal: works with the DOM's and Node's without depending on either. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

type Listener<P> = (payload: P) => void;

export class Bus<E extends object> {
  readonly #listeners = new Map<keyof E, Set<Listener<never>>>();

  /** Subscribe; returns an unsubscribe function. Pass `signal` to unsubscribe on abort. */
  on<K extends keyof E>(
    name: K,
    fn: Listener<E[K]>,
    options: { signal?: AbortSignalLike } = {},
  ): () => void {
    const { signal } = options;
    if (signal?.aborted) return () => {};
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    const off = () => set.delete(fn);
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  /** Synchronous, in subscription order — like EventEmitter / dispatchEvent. */
  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.#listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<E[K]>)(payload); // cast: the map erases K; on() only stores Listener<E[K]> under key K
  }
}
