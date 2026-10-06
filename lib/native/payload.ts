// Payloads in messages to and from an in-process session (format in src/payload.rs). Over a
// ws/ remote-api link payloads stay plain byte sequences, as in zenoh-ts.

import type { ZBytesDeserializer, ZBytesSerializer } from "../ext/serialization.ts"
import { ZBytes } from "../z_bytes.ts"
import type { NativeLibrary } from "./ffi.ts"

// ZBytes and ZShmMut keep these private so the native types stay out of the public API
type ShmBufferInternals = { library_: NativeLibrary; handle_: bigint; isValid(): boolean; markConsumed_(): void }
type Origin = { kind: "native"; handle: bigint; library: object; isShm: boolean; release: () => void } | { kind: "shm"; buffer: ShmBufferInternals }
const wrap = (bytes: Uint8Array, origin?: Origin): ZBytes => (ZBytes as unknown as { wrap_: (bytes: Uint8Array, origin?: Origin) => ZBytes }).wrap_(bytes, origin)
const originOf = (payload: ZBytes): Origin | undefined => (payload as unknown as { origin_: Origin | undefined }).origin_

const TAG_INLINE = 0
const TAG_NATIVE_VIEW = 1
const TAG_SHM_BUFFER = 2
const TAG_NATIVE_HANDLE = 3

const NATIVE = Symbol("zenoh-deno native library")

type Marked = { [NATIVE]?: NativeLibrary }

/** Marks a serializer or deserializer as carrying native-format payloads for `library`. */
export function markNative<T extends ZBytesSerializer | ZBytesDeserializer>(target: T, library: NativeLibrary | undefined): T {
    if (library !== undefined) {
        ;(target as Marked)[NATIVE] = library
    }
    return target
}

// a received view's memory is freed when the JS ArrayBuffer over it is garbage-collected
const viewRegistry = new FinalizationRegistry<{ library: NativeLibrary; handle: bigint }>(({ library, handle }) => {
    library.symbols.zd_view_free(handle)
})

export function readPayload(deserializer: ZBytesDeserializer): ZBytes {
    const library = (deserializer as Marked)[NATIVE]
    if (library === undefined) {
        return new ZBytes(deserializer.deserializeUint8Array())
    }
    const tag = deserializer.deserializeNumberUint8()
    if (tag === TAG_INLINE) {
        return new ZBytes(deserializer.deserializeUint8Array())
    }
    if (tag !== TAG_NATIVE_VIEW) {
        throw new Error(`zenoh-deno: unexpected payload tag ${tag}`)
    }
    const handle = deserializer.deserializeBigintUint64()
    const address = deserializer.deserializeBigintUint64()
    const length = Number(deserializer.deserializeBigintUint64())
    const isShm = deserializer.deserializeBoolean()
    const pointer = Deno.UnsafePointer.create(address)
    if (length === 0 || pointer === null) {
        library.symbols.zd_view_free(handle)
        return wrap(new Uint8Array(0))
    }
    const buffer = Deno.UnsafePointerView.getArrayBuffer(pointer, length)
    const token = {}
    viewRegistry.register(buffer, { library, handle }, token)
    let released = false
    const release = () => {
        if (!released) {
            released = true
            viewRegistry.unregister(token)
            // detach first, so no JS view can reach the memory once it is freed
            try {
                buffer.transfer(0)
            } catch {
                // not detachable: free it anyway, the caller asked for it
            }
            library.symbols.zd_view_free(handle)
        }
    }
    return wrap(new Uint8Array(buffer), { kind: "native", handle, library, isShm, release })
}

export function readOptionalPayload(deserializer: ZBytesDeserializer): ZBytes | undefined {
    return deserializer.deserializeBoolean() ? readPayload(deserializer) : undefined
}

export function writePayload(serializer: ZBytesSerializer, payload: ZBytes): void {
    const library = (serializer as Marked)[NATIVE]
    if (library === undefined) {
        serializer.serializeUint8Array(payload.toBytes())
        return
    }
    const origin = originOf(payload)
    if (origin?.kind === "shm" && origin.buffer.library_ === library && origin.buffer.isValid()) {
        serializer.serializeNumberUint8(TAG_SHM_BUFFER)
        serializer.serializeBigintUint64(origin.buffer.handle_)
        // the native side takes the buffer when it parses the message, which is synchronous
        consumeAfterSend.push(origin.buffer)
        return
    }
    if (origin?.kind === "native" && origin.library === library) {
        serializer.serializeNumberUint8(TAG_NATIVE_HANDLE)
        serializer.serializeBigintUint64(origin.handle)
        // keep the view alive until the native side has taken its own reference
        keepAliveUntilSent.push(payload)
        return
    }
    serializer.serializeNumberUint8(TAG_INLINE)
    serializer.serializeUint8Array(payload.toBytes())
}

export function writeOptionalPayload(serializer: ZBytesSerializer, payload: ZBytes | undefined): void {
    if (payload === undefined) {
        serializer.serializeBoolean(false)
    } else {
        serializer.serializeBoolean(true)
        writePayload(serializer, payload)
    }
}

const consumeAfterSend: ShmBufferInternals[] = []
const keepAliveUntilSent: ZBytes[] = []

/** Called right after a message was handed to the native side: shared-memory buffers it carried are no longer JS's. */
export function messageSent(): void {
    for (const buffer of consumeAfterSend.splice(0)) {
        buffer.markConsumed_()
    }
    keepAliveUntilSent.length = 0
}
