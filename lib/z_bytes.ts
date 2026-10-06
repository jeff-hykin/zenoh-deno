//
// Copyright (c) 2024 ZettaScale Technology
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0, or the Apache License, Version 2.0
// which is available at https://www.apache.org/licenses/LICENSE-2.0.
//
// SPDX-License-Identifier: EPL-2.0 OR Apache-2.0
//
// Contributors:
//   ZettaScale Zenoh Team, <zenoh@zettascale.tech>
//

import type { ZShmMut } from "./shm.ts";

/**
 * Union Type to convert various primitives and containers into ZBytes
 */
export type IntoZBytes =
    | ZBytes
    | ZShmMut
    | Uint8Array
    | String
    | string;

/** @internal where a ZBytes's bytes live when they are not a plain JS copy */
export type ZBytesOrigin =
    | { kind: "native"; handle: bigint; library: object; isShm: boolean }
    | { kind: "shm"; buffer: ZShmMut };

/**
 * Class to represent an Array of Bytes received from Zenoh
 */
export class ZBytes {
    private buffer_: Uint8Array;
    /** @internal */
    origin_: ZBytesOrigin | undefined;

    /**
     * new function to create a ZBytes 
     * 
     * A Uint8Array is copied. A ZShmMut is not: publishing the result sends the shared memory
     * itself (in-process sessions only), after which the ZShmMut can no longer be used.
     * 
     * @returns ZBytes
     */
    constructor(bytes: IntoZBytes) {
        if (bytes instanceof ZBytes) {
            this.buffer_ = bytes.buffer_;
            this.origin_ = bytes.origin_;
        } else if (bytes instanceof String || typeof bytes === "string") {
            const encoder = new TextEncoder();
            const encoded = encoder.encode(bytes.toString());
            this.buffer_ = encoded;
        } else if (bytes instanceof Uint8Array) {
            this.buffer_ = Uint8Array.from(bytes);
        } else {
            this.buffer_ = bytes.bytes();
            this.origin_ = { kind: "shm", buffer: bytes };
        }
    }

    /** @internal wraps bytes without copying them */
    static wrap_(bytes: Uint8Array, origin?: ZBytesOrigin): ZBytes {
        const zbytes = Object.create(ZBytes.prototype) as ZBytes;
        zbytes.buffer_ = bytes;
        zbytes.origin_ = origin;
        return zbytes;
    }

    /**
     * Whether these bytes are in shared memory: received from a publisher that wrote them into
     * shared memory (a view on that memory, not a copy), or made from a ZShmMut.
     */
    public isShm(): boolean {
        return this.origin_?.kind === "shm" || (this.origin_?.kind === "native" && this.origin_.isShm);
    }

    /**
     * Whether {@link toBytes} is a view on memory zenoh owns (a received payload above the
     * zero-copy threshold, or shared memory) rather than a copy in the JS heap. Such views
     * must be treated as read-only: other subscribers, even in other processes, may see the same memory.
     */
    public isZeroCopy(): boolean {
        return this.origin_ !== undefined;
    }

    /**
    * returns the length of the ZBytes buffer
    * 
    * @returns number
    */
    public len(): number {
        return this.buffer_.length;
    }

    /**
    * returns if the ZBytes Buffer is empty
    * 
    * @returns boolean
    */
    public isEmpty(): boolean {
        return this.buffer_.length == 0;
    }

    /**
     * returns an empty ZBytes buffer
     * 
     * @returns ZBytes
     */
    public empty(): ZBytes {
        return new ZBytes(new Uint8Array());
    }

    /**
     * returns the underlying Uint8Array buffer
     * 
     * @returns Uint8Array
     */
    public toBytes(): Uint8Array {
        return this.buffer_
    }

    /**
     * decodes the underlying Uint8Array buffer as UTF-8 string
     * 
     * @returns string
     */
    public toString(): string {
        let decoder = new TextDecoder();
        return decoder.decode(this.buffer_)
    }

}