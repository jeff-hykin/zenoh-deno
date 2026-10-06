// A subscriber in its own process, for the cross-process zero-copy tests and benchmark.
//   deno run -A subscriber_process.ts <connect endpoint> <key> <count> [zenohVersion]
// Prints one JSON line when ready, then one per sample ({ n, length, isShm, latencyMs, firstByte }).

import { Config, open } from "../../mod.ts"

const [endpoint, key, countText, zenohVersion] = Deno.args
const count = Number(countText)
const session = await open(
    Config.fromObject({ mode: "peer", connect: { endpoints: [endpoint] }, scouting: { multicast: { enabled: false } }, listen: { endpoints: [] } }),
    { zenohVersion },
)
let received = 0
let done: () => void = () => {}
const finished = new Promise<void>((resolve) => (done = resolve))
const subscriber = await session.declareSubscriber(key, {
    handler: (sample) => {
        const payload = sample.payload()
        const bytes = payload.toBytes()
        // the publisher stamps its send time (ms since epoch, f64) in the first 8 bytes
        const sentAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true)
        console.log(JSON.stringify({ n: received, length: bytes.length, isShm: payload.isShm(), zeroCopy: payload.isZeroCopy(), latencyMs: performance.timeOrigin + performance.now() - sentAt, lastByte: bytes[bytes.length - 1] }))
        received++
        if (received >= count) {
            done()
        }
    },
})
console.log(JSON.stringify({ ready: true }))
await finished
await subscriber.undeclare()
await session.close()
