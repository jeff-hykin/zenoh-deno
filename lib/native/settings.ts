// Process-wide settings of the native library.

import { encoder, loadNative } from "./ffi.ts"

/**
 * Starts zenoh's logging to stderr. `filter` is a tracing filter: "info", "debug", "zenoh=trace,warn", ...
 * Returns false if logging was already started.
 */
export async function initLog(filter: string = "info", zenohVersion?: string): Promise<boolean> {
    const native = await loadNative(zenohVersion)
    const bytes = encoder.encode(filter)
    return native.symbols.zd_init_log(bytes, BigInt(bytes.length)) === 0
}

/**
 * Received payloads of at least `bytes` bytes are handed to JS as views on native memory (no
 * copy, freed when garbage-collected); smaller ones are copied, which is cheaper for them.
 * Default 4096. Applies to sessions using that zenoh version's library.
 */
export async function setZeroCopyThreshold(bytes: number, zenohVersion?: string): Promise<void> {
    const native = await loadNative(zenohVersion)
    native.symbols.zd_set_zero_copy_threshold(BigInt(bytes))
}

/** How many received payloads JS still holds views of (for tests and leak hunting). */
export async function nativePayloadsAlive(zenohVersion?: string): Promise<number> {
    const native = await loadNative(zenohVersion)
    return Number(native.symbols.zd_view_count())
}
