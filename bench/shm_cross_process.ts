// Publisher here, subscriber in another Deno process: big payloads through shared memory vs copied.
//   deno run -A bench/shm_cross_process.ts [sizeMiB=16] [count=50] [zenohVersion]
// Prints a markdown table; exported for tests/zero_copy.test.ts.

import { CongestionControl, Config, open, Reliability, ShmProvider } from "../mod.ts"

export interface RunResult {
    mode: "shm" | "copy"
    sizeBytes: number
    count: number
    medianLatencyMs: number
    p90LatencyMs: number
    throughputMiBps: number
    allShm: boolean
    allZeroCopy: boolean
}

let nextPort = 27447

export async function runOnce(mode: "shm" | "copy", sizeBytes: number, count: number, zenohVersion?: string): Promise<RunResult> {
    const port = nextPort++
    const endpoint = `tcp/127.0.0.1:${port}`
    const session = await open(
        Config.fromObject({ mode: "peer", listen: { endpoints: [endpoint] }, scouting: { multicast: { enabled: false } } }),
        { zenohVersion },
    )
    const key = `bench/shm/${mode}`
    const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", new URL("../tests/helpers/subscriber_process.ts", import.meta.url).pathname, endpoint, key, String(count), ...(zenohVersion ? [zenohVersion] : [])],
        stdout: "piped",
        stderr: "inherit",
    }).spawn()
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
        buffer: "",
        transform(chunk, controller) {
            // @ts-ignore: line splitter state
            const text = (this.buffer ?? "") + chunk
            const parts = text.split("\n")
            // @ts-ignore: line splitter state
            this.buffer = parts.pop()
            parts.filter(Boolean).forEach((line) => controller.enqueue(line))
        },
    } as Transformer<string, string> & { buffer: string })).getReader()
    const ready = JSON.parse((await lines.read()).value!)
    if (!ready.ready) {
        throw new Error("subscriber did not start")
    }
    // big messages must not be dropped when the send queue is full
    const publisher = await session.declarePublisher(key, { congestionControl: CongestionControl.BLOCK, reliability: Reliability.RELIABLE })
    // wait until the subscriber is matched
    for (let i = 0; i < 100 && !(await publisher.matchingStatus()).matching(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const provider = mode === "shm" ? await ShmProvider.create(sizeBytes * 4, { zenohVersion }) : undefined
    const plain = new Uint8Array(sizeBytes)
    const samples: { latencyMs: number; isShm: boolean; zeroCopy: boolean; length: number; lastByte: number }[] = []
    const started = performance.now()
    for (let n = 0; n < count; n++) {
        const stamp = (bytes: Uint8Array) => {
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(0, performance.timeOrigin + performance.now(), true)
            bytes[bytes.length - 1] = n % 256
        }
        if (provider) {
            const buffer = await provider.allocAsync(sizeBytes)
            stamp(buffer.bytes())
            await publisher.put(buffer)
        } else {
            stamp(plain)
            await publisher.put(plain)
        }
        // one in flight at a time: wait for the subscriber's line
        const { value } = await lines.read()
        samples.push(JSON.parse(value!))
    }
    const elapsedMs = performance.now() - started
    await child.status
    await publisher.undeclare()
    provider?.close()
    await session.close()
    const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b)
    return {
        mode,
        sizeBytes,
        count,
        medianLatencyMs: latencies[Math.floor(latencies.length / 2)],
        p90LatencyMs: latencies[Math.floor(latencies.length * 0.9)],
        throughputMiBps: (sizeBytes * count) / (1 << 20) / (elapsedMs / 1000),
        allShm: samples.every((sample) => sample.isShm),
        allZeroCopy: samples.every((sample) => sample.zeroCopy),
    }
}

if (import.meta.main) {
    const sizeMiB = Number(Deno.args[0] ?? 16)
    const count = Number(Deno.args[1] ?? 50)
    const zenohVersion = Deno.args[2]
    const results = [await runOnce("copy", sizeMiB << 20, count, zenohVersion), await runOnce("shm", sizeMiB << 20, count, zenohVersion)]
    console.log(`| path | payload | n | median latency | p90 latency | throughput | arrived as shm |`)
    console.log(`|---|---|---|---|---|---|---|`)
    for (const r of results) {
        console.log(`| ${r.mode} | ${r.sizeBytes >> 20} MiB | ${r.count} | ${r.medianLatencyMs.toFixed(2)} ms | ${r.p90LatencyMs.toFixed(2)} ms | ${r.throughputMiBps.toFixed(0)} MiB/s | ${r.allShm} |`)
    }
}
