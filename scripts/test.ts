// Runs the test suite against a zenohd router: once with in-process sessions (native), once over
// zenoh-ts's remote-api websocket (ws) to prove the zenoh-ts path still works.
//   deno run -A scripts/test.ts [--zenoh 1.10.1] [--mode native|ws|both] [deno test args...]
// zenohd and its remote-api plugin are downloaded into .zenohd/<version>/ on first use.

const args = [...Deno.args]
function option(name: string, fallback: string): string {
    const index = args.indexOf(name)
    if (index < 0) {
        return fallback
    }
    const [, value] = args.splice(index, 2)
    return value
}
const zenohVersion = option("--zenoh", "1.10.1")
// zenoh-ts's TS speaks the 1.10.1 remote-api protocol, so the ws suite runs only against that plugin
const mode = option("--mode", zenohVersion === "1.10.1" ? "both" : "native")
const root = new URL("..", import.meta.url).pathname
const zenohdDirectory = `${root}.zenohd/${zenohVersion}`

const TRIPLES: Record<string, string> = {
    "darwin-aarch64": "aarch64-apple-darwin",
    "darwin-x86_64": "x86_64-apple-darwin",
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "linux-aarch64": "aarch64-unknown-linux-gnu",
    "windows-x86_64": "x86_64-pc-windows-msvc",
}

async function run(command: string, commandArgs: string[], cwd?: string) {
    const { code } = await new Deno.Command(command, { args: commandArgs, cwd, stdout: "inherit", stderr: "inherit" }).output()
    if (code !== 0) {
        throw new Error(`${command} ${commandArgs.join(" ")} exited with ${code}`)
    }
}

async function ensureZenohd(): Promise<string> {
    const exe = Deno.build.os === "windows" ? "zenohd.exe" : "zenohd"
    const path = `${zenohdDirectory}/${exe}`
    try {
        Deno.statSync(path)
        return path
    } catch {
        // download below
    }
    const triple = TRIPLES[`${Deno.build.os}-${Deno.build.arch}`]
    Deno.mkdirSync(zenohdDirectory, { recursive: true })
    const assets = [["eclipse-zenoh/zenoh", `zenoh-${zenohVersion}-${triple}-standalone.zip`]]
    if (mode !== "native") {
        assets.push(["eclipse-zenoh/zenoh-ts", `zenoh-ts-${zenohVersion}-${triple}-standalone.zip`])
    }
    for (const [repository, asset] of assets) {
        const url = `https://github.com/${repository}/releases/download/${zenohVersion}/${asset}`
        console.log(`downloading ${url}`)
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`${url}: ${response.status}`)
        }
        const zip = `${zenohdDirectory}/${asset}`
        Deno.writeFileSync(zip, new Uint8Array(await response.arrayBuffer()))
        if (Deno.build.os === "windows") {
            await run("tar", ["-xf", zip, "-C", zenohdDirectory])
        } else {
            await run("unzip", ["-oq", zip, "-d", zenohdDirectory])
        }
        Deno.removeSync(zip)
    }
    return path
}

const zenohd = await ensureZenohd()
const routerConfig = {
    mode: "router",
    listen: { endpoints: ["tcp/127.0.0.1:17447"] },
    scouting: { multicast: { enabled: false }, gossip: { enabled: false } },
    // non-Deno zenoh nodes for tests/interop.test.ts: zenohd's REST plugin publishes, its storage answers queries
    plugins_loading: { enabled: true, search_dirs: [zenohdDirectory] },
    plugins: {
        rest: { http_port: "18000" },
        storage_manager: { storages: { interop: { key_expr: "interop/storage/**", volume: "memory" } } },
        ...(mode === "native" ? {} : { remote_api: { websocket_port: "10000" } }),
    },
    timestamping: { enabled: { router: true, peer: true, client: true } },
}
const configPath = `${zenohdDirectory}/test_router.json5`
Deno.writeTextFileSync(configPath, JSON.stringify(routerConfig))
const router = new Deno.Command(zenohd, { args: ["-c", configPath], stdout: "null", stderr: "piped" }).spawn()

let failed = false
try {
    // wait for the router's ports
    for (let attempt = 0; ; attempt++) {
        try {
            const connections = await Promise.all((mode === "native" ? [17447, 18000] : [17447, 18000, 10000]).map((port) => Deno.connect({ port })))
            connections.forEach((connection) => connection.close())
            break
        } catch (error) {
            if (attempt > 100) {
                throw error
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    const modes = mode === "both" ? ["native", "ws"] : [mode]
    console.log(`::summary-lines-expected::${modes.length}`)
    for (const testMode of modes) {
        console.log(`\n=== ${testMode} sessions, zenoh ${zenohVersion} ===`)
        const testArgs = args.length > 0 ? args : ["tests/"]
        const { code } = await new Deno.Command(Deno.execPath(), {
            args: ["test", "--allow-all", ...testArgs],
            cwd: root,
            env: { ZENOH_DENO_TEST_MODE: testMode, ZENOH_DENO_TEST_ZENOH_VERSION: zenohVersion },
            stdout: "inherit",
            stderr: "inherit",
        }).output()
        if (code !== 0) {
            failed = true
        }
    }
} finally {
    router.kill()
    await router.status
}
Deno.exit(failed ? 1 : 0)
