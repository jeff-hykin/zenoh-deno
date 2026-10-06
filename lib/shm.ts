// Shared memory: write a payload once, straight into memory that subscribers on this machine
// read in place. Only for in-process (native) sessions; over a ws/ remote-api link the bytes are copied.

import { loadNative, NativeLibrary } from "./native/ffi.ts"

/** What an allocation does when the provider has no free block of the requested size. */
export enum AllocPolicy {
    /** fail right away */
    JustAlloc = 0,
    /** reclaim buffers subscribers are done with, then retry (the default) */
    GarbageCollect = 1,
    /** also defragment, then retry */
    Defragment = 2,
    /** also wait until memory frees up (only with {@link ShmProvider.allocAsync}) */
    BlockOn = 3,
}

const providerRegistry = new FinalizationRegistry<{ library: NativeLibrary; handle: bigint }>(({ library, handle }) => {
    library.symbols.zd_shm_provider_free(handle)
})
const bufferRegistry = new FinalizationRegistry<{ library: NativeLibrary; handle: bigint }>(({ library, handle }) => {
    library.symbols.zd_shm_buffer_free(handle)
})

export interface ShmProviderOptions {
    /** which zenoh version's native library to use; must match the sessions publishing its buffers */
    zenohVersion?: string
}

/**
 * A pool of shared memory to allocate payload buffers from.
 *
 * ```ts
 * const provider = await ShmProvider.create(64 * 1024 * 1024)
 * const buffer = provider.alloc(frame.length)
 * buffer.bytes().set(frame)          // or write into it directly
 * await publisher.put(buffer)        // no copy: subscribers on this machine map the same memory
 * ```
 */
export class ShmProvider {
    private closed_ = false

    private constructor(
        private readonly library_: NativeLibrary,
        private readonly handle_: bigint,
        /** the pool's size in bytes */
        readonly size: number,
    ) {
        providerRegistry.register(this, { library: library_, handle: handle_ }, this)
    }

    /** Creates a provider backed by `size` bytes of shared memory. */
    static async create(size: number, options: ShmProviderOptions = {}): Promise<ShmProvider> {
        const library = await loadNative(options.zenohVersion)
        const handle = BigInt(library.symbols.zd_shm_provider_new(BigInt(size)))
        if (handle === 0n) {
            throw new Error(lastError(library) || `could not create a shared-memory provider of ${size} bytes`)
        }
        if (size > library.memlockLimit / 2) {
            // zenoh locks (mlock) shared memory wherever it is mapped; a subscriber that cannot lock a segment drops the sample
            console.warn(
                `zenoh-deno: a ${size}-byte shared-memory pool is more than half this process's locked-memory limit ` +
                    `(${library.memlockLimit} bytes). zenoh locks shared memory into RAM where it is mapped, and a subscriber ` +
                    `that cannot lock it drops the sample. Raise the limit (ulimit -l, or LimitMEMLOCK= for a systemd service) ` +
                    `in publishing and subscribing processes alike.`,
            )
        }
        return new ShmProvider(library, handle, size)
    }

    private checkOpen() {
        if (this.closed_) {
            throw new Error("the shared-memory provider is closed")
        }
    }

    /** Allocates a buffer of `length` bytes. Throws if there is no room (see {@link AllocPolicy}). */
    alloc(length: number, policy: AllocPolicy = AllocPolicy.GarbageCollect): ZShmMut {
        this.checkOpen()
        if (policy === AllocPolicy.BlockOn) {
            throw new Error("AllocPolicy.BlockOn waits, so it needs allocAsync")
        }
        const handle = BigInt(this.library_.symbols.zd_shm_alloc(this.handle_, BigInt(length), policy))
        if (handle === 0n) {
            throw new Error(lastError(this.library_) || `could not allocate ${length} bytes of shared memory`)
        }
        return newZShmMut(this.library_, handle, length)
    }

    /** Allocates without blocking the JS thread; with BlockOn (the default here), waits for room. */
    async allocAsync(length: number, policy: AllocPolicy = AllocPolicy.BlockOn): Promise<ZShmMut> {
        this.checkOpen()
        const handle = BigInt(await this.library_.symbols.zd_shm_alloc_blocking(this.handle_, BigInt(length), policy))
        if (handle === 0n) {
            throw new Error(`could not allocate ${length} bytes of shared memory`)
        }
        return newZShmMut(this.library_, handle, length)
    }

    /** Free bytes in the pool. */
    available(): number {
        return Number(this.library_.symbols.zd_shm_provider_available(this.handle_))
    }

    /** Reclaims buffers no one uses any more; returns the bytes reclaimed. */
    garbageCollect(): number {
        return Number(this.library_.symbols.zd_shm_provider_garbage_collect(this.handle_))
    }

    /** Merges free space; returns the size of the largest free block. */
    defragment(): number {
        return Number(this.library_.symbols.zd_shm_provider_defragment(this.handle_))
    }

    /** Releases the pool (its memory goes away once every buffer from it is gone). */
    close(): void {
        if (!this.closed_) {
            this.closed_ = true
            providerRegistry.unregister(this)
            this.library_.symbols.zd_shm_provider_free(this.handle_)
        }
    }

    [Symbol.dispose](): void {
        this.close()
    }
}

function lastError(library: NativeLibrary): string {
    return library.resultText()
}

/**
 * A shared-memory buffer being written. Publishing it (put, reply, ...) hands the memory to zenoh
 * without copying it; after that {@link bytes} throws and earlier views of it become empty.
 */
export class ZShmMut {
    private view_: Uint8Array<ArrayBuffer> | undefined

    private constructor(
        private readonly library_: NativeLibrary,
        private readonly handle_: bigint,
        private readonly length_: number,
    ) {
        bufferRegistry.register(this, { library: library_, handle: handle_ }, this)
    }

    /** The buffer's bytes, a view on the shared memory itself: write the payload here. */
    bytes(): Uint8Array<ArrayBuffer> {
        if (this.view_ === undefined) {
            if (!this.isValid()) {
                throw new Error("this shared-memory buffer was already published or freed")
            }
            const address = this.library_.symbols.zd_shm_buffer_address(this.handle_)
            if (address === null) {
                throw new Error("this shared-memory buffer was already published or freed")
            }
            this.view_ = new Uint8Array(this.length_ === 0 ? new ArrayBuffer(0) : Deno.UnsafePointerView.getArrayBuffer(address, this.length_))
        }
        return this.view_
    }

    len(): number {
        return this.length_
    }

    private consumed_ = false

    /** False once published or freed. */
    isValid(): boolean {
        return !this.consumed_
    }

    /** the native side now owns the memory: cut JS's access to it */
    private markConsumed_(): void {
        this.consumed_ = true
        bufferRegistry.unregister(this)
        detach(this.view_)
        this.view_ = undefined
    }

    /** Frees the buffer without publishing it. */
    free(): void {
        if (!this.consumed_) {
            this.library_.symbols.zd_shm_buffer_free(this.handle_)
            this.markConsumed_()
        }
    }
}

/** Detaches an ArrayBuffer so views of it read as empty instead of touching memory JS no longer owns. */
function detach(view: Uint8Array<ArrayBuffer> | undefined) {
    if (view !== undefined && view.buffer.byteLength > 0) {
        try {
            view.buffer.transfer(0)
        } catch {
            // not detachable; JS must just not use it any more
        }
    }
}

// ZShmMut's constructor is private to keep the native types out of the public API
function newZShmMut(library: NativeLibrary, handle: bigint, length: number): ZShmMut {
    return new (ZShmMut as unknown as new (library: NativeLibrary, handle: bigint, length: number) => ZShmMut)(library, handle, length)
}
