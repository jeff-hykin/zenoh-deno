// Zero-copy: received payloads as views on native memory, shared-memory publishing, and the
// cross-process shared-memory path (which must beat copying).

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1"
import { Config, nativePayloadsAlive, open, Sample, Session, setZeroCopyThreshold, ShmProvider, ZBytes } from "../mod.ts"
import { runOnce } from "../bench/shm_cross_process.ts"
import { TEST_MODE, TEST_ZENOH_VERSION } from "./config.ts"

const native = TEST_MODE === "native"
let nextPort = 37447

async function pair(): Promise<[Session, Session]> {
    const endpoint = `tcp/127.0.0.1:${nextPort++}`
    const options = { zenohVersion: TEST_ZENOH_VERSION }
    const a = await open(Config.fromObject({ mode: "peer", listen: { endpoints: [endpoint] }, scouting: { multicast: { enabled: false } } }), options)
    const b = await open(Config.fromObject({ mode: "peer", connect: { endpoints: [endpoint] }, listen: { endpoints: [] }, scouting: { multicast: { enabled: false } } }), options)
    return [a, b]
}

async function receive(subscriberSession: Session, key: string, publish: () => Promise<void>): Promise<Sample> {
    let resolve: (sample: Sample) => void = () => {}
    const received = new Promise<Sample>((r) => (resolve = r))
    const subscriber = await subscriberSession.declareSubscriber(key, { handler: (sample) => resolve(sample) })
    await new Promise((r) => setTimeout(r, 300))
    await publish()
    const sample = await received
    await subscriber.undeclare()
    return sample
}

Deno.test({ name: "zero-copy: small payloads are copied, big ones are views on native memory", ignore: !native }, async () => {
    const [a, b] = await pair()
    try {
        const small = await receive(b, "zc/small", () => a.put("zc/small", "hello"))
        assertEquals(small.payload().toString(), "hello")
        assert(!small.payload().isZeroCopy())

        const bytes = new Uint8Array(1 << 20).map((_, i) => i % 251)
        const big = await receive(b, "zc/big", () => a.put("zc/big", bytes))
        assert(big.payload().isZeroCopy(), "a 1 MiB payload should be a view, not a copy")
        assert(!big.payload().isShm())
        assertEquals(big.payload().toBytes(), bytes)

        // release() frees the native memory now and empties the views
        const view = big.payload().toBytes()
        const alive = await nativePayloadsAlive(TEST_ZENOH_VERSION)
        big.payload().release()
        assertEquals(view.length, 0)
        assertEquals(await nativePayloadsAlive(TEST_ZENOH_VERSION), alive - 1)

        await setZeroCopyThreshold(64, TEST_ZENOH_VERSION)
        const medium = await receive(b, "zc/medium", () => a.put("zc/medium", new Uint8Array(100)))
        assert(medium.payload().isZeroCopy(), "the threshold is adjustable")
    } finally {
        await setZeroCopyThreshold(4096, TEST_ZENOH_VERSION)
        await a.close()
        await b.close()
    }
})

Deno.test({ name: "zero-copy: views are freed once garbage-collected", ignore: !native }, async () => {
    // needs --expose-gc, so in a child process
    const script = `
        import { Config, open, nativePayloadsAlive } from ${JSON.stringify(new URL("../mod.ts", import.meta.url).href)}
        const version = ${JSON.stringify(TEST_ZENOH_VERSION ?? null)} ?? undefined
        const config = (extra) => Config.fromObject({ mode: "peer", scouting: { multicast: { enabled: false } }, ...extra })
        const a = await open(config({ listen: { endpoints: ["tcp/127.0.0.1:${nextPort}"] } }), { zenohVersion: version })
        const b = await open(config({ connect: { endpoints: ["tcp/127.0.0.1:${nextPort++}"] }, listen: { endpoints: [] } }), { zenohVersion: version })
        let count = 0
        const sub = await b.declareSubscriber("gc/**", { handler: (s) => { count += s.payload().len() > 0 ? 1 : 0 } })
        await new Promise((r) => setTimeout(r, 300))
        for (let i = 0; i < 20; i++) await a.put("gc/x", new Uint8Array(1 << 16))
        while (count < 20) await new Promise((r) => setTimeout(r, 10))
        const before = await nativePayloadsAlive(version)
        for (let i = 0; i < 10 && (await nativePayloadsAlive(version)) > 0; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)) }
        console.log(JSON.stringify({ before, after: await nativePayloadsAlive(version) }))
        await sub.undeclare(); await a.close(); await b.close()
    `
    const output = await new Deno.Command(Deno.execPath(), { args: ["eval", "--v8-flags=--expose-gc", script], stderr: "inherit" }).output()
    assert(output.success)
    const { before, after } = JSON.parse(new TextDecoder().decode(output.stdout).trim().split("\n").pop()!)
    assert(before >= 20, `expected 20 live views, got ${before}`)
    assertEquals(after, 0)
})

Deno.test({ name: "zero-copy: shared-memory publishing hands the buffer over without a copy", ignore: !native }, async () => {
    const [a, b] = await pair()
    const provider = await ShmProvider.create(4 << 20, { zenohVersion: TEST_ZENOH_VERSION })
    try {
        const buffer = provider.alloc(1 << 20)
        const view = buffer.bytes()
        view.fill(42)
        const sample = await receive(b, "zc/shm", () => a.put("zc/shm", buffer))
        assert(sample.payload().isShm(), "received as shared memory")
        assertEquals(sample.payload().len(), 1 << 20)
        assertEquals(sample.payload().toBytes()[12345], 42)
        // the publisher's access to the memory is gone
        assert(!buffer.isValid(), "published buffers are no longer valid")
        assertEquals(view.length, 0)
        assertThrows(() => buffer.bytes())

        // through a publisher, and as a ZBytes
        const publisher = await a.declarePublisher("zc/shm2")
        const second = provider.alloc(1000)
        second.bytes().fill(7)
        const viaPublisher = await receive(b, "zc/shm2", () => publisher.put(new ZBytes(second)))
        assert(viaPublisher.payload().isShm(), "a small shared-memory payload is still received as shared memory")
        assertEquals(viaPublisher.payload().toBytes()[999], 7)
        await publisher.undeclare()

        // a buffer can be freed unpublished, and the pool reclaims what subscribers dropped
        provider.alloc(1000).free()
        assert(provider.available() <= 4 << 20)
    } finally {
        provider.close()
        await a.close()
        await b.close()
    }
})

Deno.test({ name: "zero-copy: a received payload is re-published without copying it into JS", ignore: !native }, async () => {
    const [a, b] = await pair()
    try {
        const original = new Uint8Array(1 << 16).map((_, i) => i % 13)
        const first = await receive(b, "zc/forward/in", () => a.put("zc/forward/in", original))
        assert(first.payload().isZeroCopy())
        const forwarded = await receive(a, "zc/forward/out", () => b.put("zc/forward/out", first.payload()))
        assertEquals(forwarded.payload().toBytes(), original)
    } finally {
        await a.close()
        await b.close()
    }
})

Deno.test({ name: "zero-copy: across processes, shared memory arrives as shared memory and beats copying", ignore: !native }, async () => {
    const size = 16 << 20
    const copy = await runOnce("copy", size, 20, TEST_ZENOH_VERSION)
    const shm = await runOnce("shm", size, 20, TEST_ZENOH_VERSION)
    console.log(JSON.stringify({ copy, shm }))
    assert(shm.allShm, "every shared-memory sample should arrive as shared memory in the other process")
    assert(!copy.allShm)
    assert(shm.allZeroCopy && copy.allZeroCopy, "16 MiB payloads are views either way on the receiving side")
    assert(shm.medianLatencyMs < copy.medianLatencyMs, `shm ${shm.medianLatencyMs} ms vs copy ${copy.medianLatencyMs} ms`)
})

Deno.test("zero-copy: over a ws/ remote-api link, a ZShmMut payload falls back to a copy", { ignore: TEST_MODE !== "ws" }, async () => {
    const provider = await ShmProvider.create(1 << 20, { zenohVersion: TEST_ZENOH_VERSION })
    const { testConfig } = await import("./config.ts")
    const a = await open(testConfig())
    const b = await open(testConfig())
    try {
        const buffer = provider.alloc(64)
        buffer.bytes().fill(9)
        const sample = await receive(b, "zc/ws", () => a.put("zc/ws", buffer))
        assertEquals(sample.payload().toBytes(), new Uint8Array(64).fill(9))
        assert(!sample.payload().isShm())
    } finally {
        provider.close()
        await a.close()
        await b.close()
    }
})
