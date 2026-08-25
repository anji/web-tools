/**
 * Lazy, cached WASM module loading.
 *
 * Nothing in the JSON site needs WASM yet -- JSON work is cheap in JS. This
 * exists because the sites that follow (images, video, audio, PDF) all do, and
 * they should share one loader with one caching policy rather than each
 * inventing their own.
 */

const cache = new Map<string, Promise<unknown>>();

/**
 * Loads a WASM-backed module once per URL and reuses the promise thereafter, so
 * concurrent callers during a burst of user actions share a single fetch.
 */
export function loadWasmModule<T>(key: string, loader: () => Promise<T>): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = loader().catch((e) => {
      // Don't cache failures: a transient decode error shouldn't poison the tool
      // for the rest of the session.
      cache.delete(key);
      throw e;
    });
    cache.set(key, pending);
  }
  return pending;
}

/**
 * SharedArrayBuffer -- and therefore multi-threaded WASM builds of ffmpeg and
 * friends -- requires the page to be cross-origin isolated via COOP/COEP
 * headers. Sites check this to pick the threaded or single-threaded build.
 */
export function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : false;
}

export function supportsWasm(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}
