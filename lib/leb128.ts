// Unsigned LEB128, as used by zenoh's serialization (replaces @thi.ng/leb128).

/** Writes `value` into `buffer` (at least 10 bytes); returns how many bytes were written. */
export function encodeULEB128Into(buffer: Uint8Array, value: number | bigint): number {
    let remaining = BigInt(value)
    let index = 0
    do {
        let byte = Number(remaining & 0x7fn)
        remaining >>= 7n
        if (remaining !== 0n) {
            byte |= 0x80
        }
        buffer[index++] = byte
    } while (remaining !== 0n)
    return index
}

/** Reads a value starting at `offset`; returns [value, bytesRead]. */
export function decodeULEB128(buffer: Uint8Array, offset = 0): [bigint, number] {
    let value = 0n
    let shift = 0n
    let index = offset
    for (;;) {
        if (index >= buffer.length) {
            throw new Error("LEB128: unexpected end of buffer")
        }
        const byte = buffer[index++]
        value |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) {
            return [value, index - offset]
        }
        shift += 7n
    }
}
