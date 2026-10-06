// A Deno session exchanging data with zenoh nodes that are not Deno: the test router (zenohd)
// publishes what its REST plugin is given, and its storage plugin stores puts and answers gets.

import { assert, assertEquals } from "jsr:@std/assert@1"
import { Encoding, open, Reply, Sample, SampleKind } from "../mod.ts"
import { testConfig } from "./config.ts"

const REST = "http://127.0.0.1:18000"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("interop: a sample published by zenohd (REST plugin) reaches a Deno subscriber", async () => {
    const session = await open(testConfig())
    try {
        const received: Sample[] = []
        const subscriber = await session.declareSubscriber("interop/rest/**", { handler: (sample) => received.push(sample) })
        await sleep(500)
        const response = await fetch(`${REST}/interop/rest/hello`, { method: "PUT", body: "from zenohd", headers: { "content-type": "text/plain" } })
        await response.body?.cancel()
        assert(response.ok, `REST put: ${response.status}`)
        for (let i = 0; i < 50 && received.length === 0; i++) {
            await sleep(50)
        }
        assertEquals(received.length, 1)
        assertEquals(received[0].keyexpr().toString(), "interop/rest/hello")
        assertEquals(received[0].payload().toString(), "from zenohd")
        await subscriber.undeclare()
    } finally {
        await session.close()
    }
})

Deno.test("interop: zenohd's storage stores a Deno put and answers a Deno get", async () => {
    const session = await open(testConfig())
    try {
        const key = `interop/storage/${crypto.randomUUID()}`
        await session.put(key, "stored by deno", { encoding: Encoding.TEXT_PLAIN })
        await sleep(500)
        const replies: Reply[] = []
        const receiver = await session.get(key)
        for await (const reply of receiver!) {
            replies.push(reply)
        }
        assertEquals(replies.length, 1)
        const result = replies[0].result()
        assert(result instanceof Sample, "the storage should answer with a sample")
        assertEquals(result.payload().toString(), "stored by deno")
        assertEquals(result.kind(), SampleKind.PUT)

        // and zenohd's REST plugin reads it through the same storage
        const response = await fetch(`${REST}/${key}`)
        const body = await response.json()
        assertEquals(body[0].value, "stored by deno")
    } finally {
        await session.close()
    }
})

Deno.test("interop: zenohd answers a query on its admin space", async () => {
    const session = await open(testConfig())
    try {
        const replies: Reply[] = []
        for await (const reply of (await session.get("@/*/router"))!) {
            replies.push(reply)
        }
        assert(replies.length >= 1, "zenohd should answer @/*/router")
        const result = replies[0].result()
        assert(result instanceof Sample)
        const info = JSON.parse(result.payload().toString())
        assert(typeof info.zid === "string" && info.zid.length > 0)
    } finally {
        await session.close()
    }
})
