# zenoh-deno

[zenoh](https://zenoh.io) for Deno. It has the API of [zenoh-ts](https://github.com/eclipse-zenoh/zenoh-ts),
but zenoh runs inside the Deno process (a Rust library loaded with `Deno.dlopen`) instead of behind a
zenohd router with the remote-api plugin. A Deno program is then a zenoh node like any Rust, C or Python
one: it can be a peer, a client or a router, it can listen and scout, and it can use shared memory.

On top of zenoh-ts's API it adds:

- **in-process sessions**: any zenoh config (`Config.fromJson5`, `Config.fromObject`, `Config.fromFile`,
  `config.insertJson5(...)`), or just `new Config("tcp/10.0.0.2:7447")` to be a client of a router.
- **shared-memory publishing**: `ShmProvider` / `ZShmMut`. You write the payload once, into shared memory.
  Subscribers in other processes on the same machine read that same memory, so nothing is copied.
- **zero-copy receiving**: payloads of 4 KiB or more (`setZeroCopyThreshold`) reach JS as views on
  zenoh's memory (or on the shared memory itself), not as copies. They are freed when garbage-collected.
- **several zenoh versions** in one package: `open(config, { zenohVersion: "1.6.2" })`.

zenoh-ts's own way still works: `new Config("ws/127.0.0.1:10000")` talks to a zenohd remote-api plugin
over a websocket, exactly as zenoh-ts does.

```ts
import { Config, open } from "jsr:@robotics/zenoh-deno"

const session = await open(new Config()) // a peer with zenoh's defaults
await session.declareSubscriber("demo/**", {
    handler: (sample) => console.log(`${sample.keyexpr()}: ${sample.payload().toString()}`),
})
await session.put("demo/hello", "world")
```

Run with `deno run --allow-ffi --allow-read --allow-write --allow-net --allow-env --allow-sys your_app.ts`
(or `-A`). Only the first run needs `--allow-net` and `--allow-write`: that is when it downloads the native library.

## The native library

On first use, the module downloads the prebuilt library for your OS, CPU and zenoh version from this
repository's GitHub release. It checks the file against the sha256 recorded in the module, then caches it
(`~/Library/Caches/zenoh-deno`, `~/.cache/zenoh-deno` or `%LOCALAPPDATA%\zenoh-deno`). After that it needs
no network access.

| Platform | zenoh 1.10.1 | zenoh 1.6.2 |
|---|---|---|
| Linux x86_64 (glibc ≥ 2.28) | ✓ | ✓ |
| Linux aarch64 (glibc ≥ 2.28) | ✓ | ✓ |
| macOS Apple silicon (11+) | ✓ | ✓ |
| macOS Intel (11+) | ✓ | ✓ |
| Windows x86_64 | ✓ | ✓ |

The default is the newest zenoh. Pick an older one with `open(config, { zenohVersion: "1.6.2" })` to
match the rest of your zenoh network; this matters most for shared memory. The connectivity API
(`transports()`, `links()` and their event listeners) needs zenoh 1.10 or newer. On 1.6.2 it throws.

## Shared memory

```ts
import { Config, open, ShmProvider } from "jsr:@robotics/zenoh-deno"

const session = await open(new Config())
const publisher = await session.declarePublisher("camera/frame")
const provider = await ShmProvider.create(256 * 1024 * 1024) // a 256 MiB pool

const buffer = provider.alloc(frameSize) // or: await provider.allocAsync(frameSize), which waits for room
renderInto(buffer.bytes()) // a Uint8Array over the shared memory itself
await publisher.put(buffer) // nothing is copied
// the buffer now belongs to zenoh: buffer.bytes() throws, and earlier views of it read as empty
```

On the receiving side, `sample.payload().isShm()` tells you the bytes are still in shared memory, and
`sample.payload().toBytes()` is a view on them. Treat received views as read-only: other subscribers, even
in other processes, read the same memory.

`AllocPolicy` controls what `alloc` does when the pool is full: `JustAlloc`, `GarbageCollect` (the default),
or `Defragment`. `allocAsync` also accepts `BlockOn`, which waits until memory frees up.

Over a `ws/` remote-api link a `ZShmMut` is still accepted, but its bytes are copied.

## Zero-copy receiving

A received payload of at least 4 KiB arrives in JS as a view on memory zenoh owns, not as a copy.
`sample.payload().isZeroCopy()` tells you which case you have. The memory stays alive while JS can still
reach it and is freed after garbage collection. If you re-publish such a payload (to forward it), JS hands
zenoh back the same buffer instead of copying it. `setZeroCopyThreshold(bytes)` changes the 4 KiB cutoff.

## Performance

Publisher and subscriber in separate Deno processes on one machine, one 16 MiB message in flight at a
time (`deno run -A bench/shm_cross_process.ts 16 50`):

<!-- BENCH -->

## Differences from zenoh-ts

- The import is `jsr:@robotics/zenoh-deno`; `@eclipse-zenoh/zenoh-ts/ext` is `jsr:@robotics/zenoh-deno/ext`.
- `new Config()` with no locator, or with a locator that is not `ws/`/`wss/`, makes an in-process session.
  For in-process sessions, `info().zid()` is that session's own id. Over the websocket it is the router's.
- Key expressions are checked by zenoh itself through the native library, not by wasm. The library loads
  when the module is imported, so importing needs `--allow-ffi`.
- zenoh-ts's npm dependencies are replaced by small built-in equivalents. `Duration` is still exported and
  accepts typed durations or plain milliseconds.
- Not ported: zenoh-ts's browser examples and webpack build.

## Tests

`deno run -A scripts/test.ts` downloads zenohd and zenoh-ts's remote-api plugin, starts a router, and runs
the suite twice: once with in-process sessions, then over the websocket. The suite is zenoh-ts's own tests
(`tests/upstream/`) plus this package's tests. Use `--zenoh 1.6.2` to run against zenohd 1.6.2 with that
build. CI runs both versions on Linux (x86_64 and aarch64), macOS (Apple silicon and Intel) and Windows.

## Building the library

```sh
cargo build --release --manifest-path native/zenoh-1.10.1/Cargo.toml --target-dir target
```

In a checkout, the module loads `target/release` (or `target/debug`) instead of downloading. Each
`native/zenoh-<version>/` builds the same `src/` against that zenoh version.

## License

EPL-2.0 OR Apache-2.0, like zenoh-ts. Most of the TypeScript in `lib/` and the Rust in
`src/remote_state.rs` and `src/interface/` comes from zenoh-ts (Copyright ZettaScale Technology).
