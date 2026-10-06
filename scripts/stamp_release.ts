// Writes the release version and the sha256 of each built library into the module.
// usage: deno run --allow-read --allow-write scripts/stamp_release.ts <version> <dist dir>

import { ZENOH_VERSIONS } from "../lib/native/library.ts"

const [version, dist] = Deno.args
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "") || !dist) {
    console.error("usage: stamp_release.ts <version> <dist dir>")
    Deno.exit(1)
}

async function sha256(path: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)))
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const checksums: Record<string, string> = {}
for await (const entry of Deno.readDir(dist)) {
    if (entry.isFile && /zenoh_deno_.*\.(so|dylib|dll)$/.test(entry.name)) {
        checksums[entry.name] = await sha256(`${dist}/${entry.name}`)
    }
}
const platforms = ["linux-x86_64", "linux-aarch64", "darwin-x86_64", "darwin-aarch64", "windows-x86_64"]
for (const zenohVersion of ZENOH_VERSIONS) {
    const stem = `zenoh_deno_${zenohVersion.replaceAll(".", "_")}-`
    for (const platform of platforms) {
        if (!Object.keys(checksums).some((name) => name.includes(stem) && name.includes(platform))) {
            console.error(`missing the ${platform} library for zenoh ${zenohVersion} in ${dist}`)
            Deno.exit(1)
        }
    }
}
const sorted = Object.fromEntries(Object.entries(checksums).sort())

Deno.writeTextFileSync(
    "lib/native/binary_checksums.ts",
    `// sha256 of each release binary, written by the release workflow\nexport const CHECKSUMS: Record<string, string> = ${JSON.stringify(sorted, null, 4)}\n`,
)
Deno.writeTextFileSync("lib/version.ts", `// the release this module downloads its native library from\nexport const VERSION = "${version}"\n`)

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"))
denoJson.version = version
Deno.writeTextFileSync("deno.json", JSON.stringify(denoJson, null, 4) + "\n")
console.log(sorted)
