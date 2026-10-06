/**
 * zenoh for Deno: the API of [zenoh-ts](https://github.com/eclipse-zenoh/zenoh-ts), with zenoh
 * running inside the Deno process (through Deno's FFI) instead of behind a zenohd remote-api
 * plugin, plus shared-memory publishing and zero-copy payloads.
 *
 * ```ts
 * import { open, Config } from "jsr:@robotics/zenoh-deno"
 *
 * const session = await open(new Config())            // a peer, like any other zenoh app
 * await session.declareSubscriber("demo/**", { handler: (sample) => console.log(sample.payload().toString()) })
 * await session.put("demo/hello", "world")
 * ```
 *
 * @module
 */
export * from "./lib/index.ts"
