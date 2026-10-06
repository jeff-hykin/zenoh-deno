// A link to a zenoh session running inside this process, in place of zenoh-ts's websocket to a
// zenohd remote-api plugin. It carries the same messages, with payloads in the native format
// (see payload.ts).

import { encoder, loadNative, NativeLibrary } from "./ffi.ts"

const WAIT_TIMEOUT_MS = 60_000
const MAX_MESSAGES_PER_DRAIN = 1024

/** What SessionInner needs from a link (implemented by RemoteLink and NativeLink). */
export interface Link {
    readonly native?: NativeLibrary
    onmessage(onmessage: (msg: Uint8Array) => void): void
    send(msg: Uint8Array): Promise<void>
    isOk(): boolean
    close(): Promise<void>
}

export class NativeLink implements Link {
    private onmessage_: (msg: Uint8Array) => void = () => {}
    private open_ = true
    private pumpDone: Promise<void>

    private constructor(readonly native: NativeLibrary, readonly sessionId: number) {
        this.pumpDone = this.pump()
    }

    /** Opens a session from a JSON5 zenoh config, with the native library for `zenohVersion`. */
    static async open(configJson5: string, zenohVersion?: string): Promise<NativeLink> {
        const native = await loadNative(zenohVersion)
        const config = encoder.encode(configJson5)
        const error = new Uint8Array(4096)
        const sessionId = await native.symbols.zd_open(config, BigInt(config.length), error, BigInt(error.length))
        if (sessionId === 0) {
            const end = error.indexOf(0)
            throw new Error(new TextDecoder().decode(error.subarray(0, end < 0 ? error.length : end)))
        }
        return new NativeLink(native, sessionId)
    }

    private async pump() {
        const { symbols } = this.native
        while (this.open_) {
            const status = await symbols.zd_wait(this.sessionId, WAIT_TIMEOUT_MS)
            if (status === 2) {
                break
            }
            if (status !== 1) {
                continue
            }
            for (;;) {
                const length = Number(symbols.zd_drain(this.sessionId, MAX_MESSAGES_PER_DRAIN))
                if (length === 0) {
                    break
                }
                const batch = this.native.takeBytes(length)
                const view = new DataView(batch.buffer)
                let offset = 0
                while (offset < length) {
                    const size = view.getUint32(offset, true)
                    offset += 4
                    const message = batch.subarray(offset, offset + size)
                    offset += size
                    try {
                        this.onmessage_(message)
                    } catch (error) {
                        console.warn(error)
                    }
                }
            }
        }
    }

    onmessage(onmessage: (msg: Uint8Array) => void) {
        this.onmessage_ = onmessage
    }

    send(msg: Uint8Array): Promise<void> {
        const status = this.open_ ? this.native.symbols.zd_send(this.sessionId, msg as Uint8Array<ArrayBuffer>, BigInt(msg.length)) : -1
        if (status === -1) {
            return Promise.reject(new Error("zenoh session is closed"))
        }
        if (status !== 0) {
            // the native side logged why; a request is also answered with the error
            return Promise.reject(new Error("zenoh-deno: the native library rejected a malformed message"))
        }
        return Promise.resolve()
    }

    isOk(): boolean {
        return this.open_
    }

    async close() {
        if (!this.open_) {
            return
        }
        this.open_ = false
        this.native.symbols.zd_wake(this.sessionId)
        await this.native.symbols.zd_close(this.sessionId)
        await this.pumpDone
    }

    /** The zenoh id of this session (hex). */
    zid(): string {
        return this.native.takeText(Number(this.native.symbols.zd_session_zid(this.sessionId)))
    }
}
