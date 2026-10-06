// The API zenoh-deno adds to zenoh-ts's: configs for in-process sessions, picking a zenoh version,
// and what an older zenoh build does with APIs it lacks.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1"
import { Config, open, Sample, ZENOH_VERSIONS } from "../mod.ts"
import { TEST_MODE, TEST_ZENOH_VERSION } from "./config.ts"
import { loadNative } from "../lib/native/ffi.ts"

const native = TEST_MODE === "native"
// native libraries stay loaded for the life of the process; load them outside any test's leak check
if (native) {
    for (const zenohVersion of ZENOH_VERSIONS) {
        await loadNative(zenohVersion)
    }
}
const quiet = { mode: "peer", scouting: { multicast: { enabled: false } }, listen: { endpoints: [] } }

Deno.test({ name: "native api: configs from JSON5, objects and inserts", ignore: !native }, async () => {
    const fromJson5 = await open(Config.fromJson5(`{ mode: 'peer', scouting: { multicast: { enabled: false } }, listen: { endpoints: [] } }`))
    await fromJson5.close()
    const inserted = await open(new Config().insertJson5("scouting/multicast/enabled", "false").insertJson5("listen/endpoints", "[]"))
    await inserted.close()
    assertThrows(() => new Config("ws/127.0.0.1:10000").insertJson5("mode", '"peer"'))
    assert(new Config("ws://127.0.0.1:10000").isRemoteApi())
    assert(!new Config("tcp/127.0.0.1:7447").isRemoteApi())
    await assertRejects(() => open(Config.fromJson5("{ mode: 'not-a-mode' }")), Error, "invalid zenoh config")
    await assertRejects(() => open(new Config().insertJson5("no/such/setting", "1")), Error, "no/such/setting")
})

Deno.test({ name: "native api: every zenoh version opens, and sessions of different versions talk", ignore: !native }, async () => {
    assertEquals(ZENOH_VERSIONS.length >= 2, true)
    const endpoint = "tcp/127.0.0.1:47447"
    const [first, second] = ZENOH_VERSIONS
    const a = await open(Config.fromObject({ ...quiet, listen: { endpoints: [endpoint] } }), { zenohVersion: first })
    const b = await open(Config.fromObject({ ...quiet, connect: { endpoints: [endpoint] } }), { zenohVersion: second })
    try {
        const received: Sample[] = []
        const subscriber = await b.declareSubscriber("versions/**", { handler: (sample) => received.push(sample) })
        await new Promise((resolve) => setTimeout(resolve, 500))
        await a.put("versions/hello", `from zenoh ${first}`)
        for (let i = 0; i < 50 && received.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assertEquals(received.map((sample) => sample.payload().toString()), [`from zenoh ${first}`])
        await subscriber.undeclare()
    } finally {
        await a.close()
        await b.close()
    }
    await assertRejects(() => open(Config.fromObject(quiet), { zenohVersion: "0.0.1" }), Error, "no build for zenoh 0.0.1")
})

Deno.test({ name: "native api: the connectivity API needs zenoh 1.10", ignore: !native }, async () => {
    const session = await open(Config.fromObject(quiet))
    try {
        const info = await session.info()
        assert(info.zid().toString().length > 0)
        if ((TEST_ZENOH_VERSION ?? ZENOH_VERSIONS[0]).startsWith("1.6.")) {
            await assertRejects(() => info.transports(), Error, "needs zenoh 1.10")
        } else {
            assert(Array.isArray(await info.transports()))
        }
    } finally {
        await session.close()
    }
})
