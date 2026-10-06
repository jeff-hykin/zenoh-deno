// Where test sessions connect. scripts/test.ts starts a zenohd router (with zenoh-ts's remote-api
// plugin) and runs the suite twice: in-process sessions that are clients of that router (native),
// and zenoh-ts's own way, over the plugin's websocket (ws).

import { Config, initLog } from "../mod.ts"
import { setDefaultZenohVersion_ } from "../lib/native/library.ts"
import { loadNative } from "../lib/native/ffi.ts"

export const TEST_MODE = Deno.env.get("ZENOH_DENO_TEST_MODE") ?? "native"
/** which zenoh build in-process sessions use (scripts/test.ts runs the suite once per version) */
export const TEST_ZENOH_VERSION: string | undefined = Deno.env.get("ZENOH_DENO_TEST_ZENOH_VERSION") || undefined
if (TEST_ZENOH_VERSION) {
    setDefaultZenohVersion_(TEST_ZENOH_VERSION)
    // libraries stay loaded for the life of the process; load it outside any test's leak check
    await loadNative(TEST_ZENOH_VERSION)
}

// ZENOH_DENO_TEST_LOG=zenoh=debug (a tracing filter) turns on zenoh's own logging for a run
const testLog = Deno.env.get("ZENOH_DENO_TEST_LOG")
if (testLog) {
    await initLog(testLog, TEST_ZENOH_VERSION)
}

export const ROUTER_TCP = Deno.env.get("ZENOH_DENO_TEST_ROUTER") ?? "tcp/127.0.0.1:17447"
export const ROUTER_WS = Deno.env.get("ZENOH_DENO_TEST_WS") ?? "ws/127.0.0.1:10000"

export function testConfig(): Config {
    if (TEST_MODE === "ws") {
        return new Config(ROUTER_WS)
    }
    return new Config(ROUTER_TCP)
}
