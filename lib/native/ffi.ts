// The native library's symbols, loaded once per zenoh version.

import { defaultZenohVersion_, libraryPath } from "./library.ts"

const ABI_VERSION = 2

const SYMBOLS = {
    zd_abi_version: { parameters: [], result: "u32" },
    zd_zenoh_version: { parameters: [], result: "usize" },
    zd_take_result: { parameters: ["buffer", "usize"], result: "usize" },
    zd_result_length: { parameters: [], result: "usize" },
    zd_init_log: { parameters: ["buffer", "usize"], result: "i32" },
    zd_set_zero_copy_threshold: { parameters: ["usize"], result: "void" },
    zd_open: { parameters: ["buffer", "usize", "buffer", "usize"], result: "u32", nonblocking: true },
    zd_send: { parameters: ["u32", "buffer", "usize"], result: "i32" },
    zd_wait: { parameters: ["u32", "i32"], result: "u32", nonblocking: true },
    zd_wake: { parameters: ["u32"], result: "void" },
    zd_drain: { parameters: ["u32", "u32"], result: "usize" },
    zd_close: { parameters: ["u32"], result: "i32", nonblocking: true },
    zd_view_free: { parameters: ["u64"], result: "void" },
    zd_view_count: { parameters: [], result: "usize" },
    zd_keyexpr: { parameters: ["u8", "buffer", "usize", "buffer", "usize"], result: "i32" },
    zd_session_zid: { parameters: ["u32"], result: "usize" },
    zd_shm_provider_new: { parameters: ["usize"], result: "u64" },
    zd_shm_provider_free: { parameters: ["u64"], result: "void" },
    zd_shm_provider_available: { parameters: ["u64"], result: "usize" },
    zd_shm_provider_garbage_collect: { parameters: ["u64"], result: "usize" },
    zd_shm_provider_defragment: { parameters: ["u64"], result: "usize" },
    zd_shm_alloc: { parameters: ["u64", "usize", "u8"], result: "u64" },
    zd_shm_alloc_blocking: { name: "zd_shm_alloc", parameters: ["u64", "usize", "u8"], result: "u64", nonblocking: true },
    zd_shm_buffer_address: { parameters: ["u64"], result: "pointer" },
    zd_shm_buffer_free: { parameters: ["u64"], result: "void" },
    zd_memlock_limit: { parameters: [], result: "u64" },
} as const satisfies Deno.ForeignLibraryInterface

export type NativeSymbols = Deno.DynamicLibrary<typeof SYMBOLS>["symbols"]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A loaded native library plus helpers for its result buffer. */
export class NativeLibrary {
    readonly symbols: NativeSymbols
    readonly zenohVersion: string
    /** bytes this process may lock into RAM (zenoh locks every shared-memory segment it maps); Infinity if unlimited */
    readonly memlockLimit: number

    constructor(symbols: NativeSymbols) {
        this.symbols = symbols
        this.zenohVersion = this.takeText(Number(symbols.zd_zenoh_version()))
        // raises the limit as far as allowed, before any segment is mapped
        const limit = BigInt(symbols.zd_memlock_limit())
        this.memlockLimit = limit === 0xffffffffffffffffn ? Infinity : Number(limit)
    }

    /** The bytes the last synchronous call produced. */
    takeBytes(length: number): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(length)
        if (length > 0) {
            this.symbols.zd_take_result(out, BigInt(length))
        }
        return out
    }

    takeText(length: number): string {
        return decoder.decode(this.takeBytes(length))
    }

    /** The text the last synchronous call produced (a result or an error message). */
    resultText(): string {
        return this.takeText(Number(this.symbols.zd_result_length()))
    }
}

const loaded = new Map<string, Promise<NativeLibrary>>()

/** The native library for a zenoh version (loaded on first use). */
export function loadNative(zenohVersion: string = defaultZenohVersion_()): Promise<NativeLibrary> {
    let library = loaded.get(zenohVersion)
    if (!library) {
        library = (async () => {
            const { symbols } = Deno.dlopen(await libraryPath(zenohVersion), SYMBOLS)
            const abi = symbols.zd_abi_version()
            if (abi !== ABI_VERSION) {
                throw new Error(`zenoh-deno: the native library speaks ABI ${abi}, this module needs ${ABI_VERSION}`)
            }
            return new NativeLibrary(symbols)
        })()
        loaded.set(zenohVersion, library)
        library.catch(() => loaded.delete(zenohVersion))
    }
    return library
}

/**
 * The library key expressions use: whichever was loaded first, else the default version.
 * Key expression rules are the same across zenoh 1.x.
 */
let keyExprLibrary: NativeLibrary | undefined
export async function keyExprNative(): Promise<NativeLibrary> {
    if (!keyExprLibrary) {
        keyExprLibrary = await (loaded.values().next().value ?? loadNative())
    }
    return keyExprLibrary
}

export { encoder, decoder }
