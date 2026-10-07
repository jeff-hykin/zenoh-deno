// Finds (or downloads and verifies) the native library for this OS/CPU and zenoh version.

import { VERSION } from "../version.ts"
import { CHECKSUMS } from "./binary_checksums.ts"

const REPOSITORY = "jeff-hykin/zenoh-deno"

/** The zenoh versions this release ships a native library for; the first is the default. */
export const ZENOH_VERSIONS = ["1.10.1", "1.6.2"] as const
export const DEFAULT_ZENOH_VERSION: string = ZENOH_VERSIONS[0]

let defaultVersion: string = DEFAULT_ZENOH_VERSION

/** @internal the version used when open() is given none (the test suite runs every version) */
export function setDefaultZenohVersion_(zenohVersion: string): void {
    defaultVersion = zenohVersion
}

/** @internal */
export function defaultZenohVersion_(): string {
    return defaultVersion
}

/** e.g. "darwin-aarch64" */
export function platformName(): string {
    return `${Deno.build.os}-${Deno.build.arch}`
}

function libraryStem(zenohVersion: string): string {
    return `zenoh_deno_${zenohVersion.replaceAll(".", "_")}`
}

/** The release asset's file name for a platform and zenoh version. */
export function binaryName(zenohVersion: string, platform: string = platformName()): string {
    const [os] = platform.split("-")
    const stem = libraryStem(zenohVersion)
    if (os === "windows") {
        return `${stem}-${platform}.dll`
    }
    return `lib${stem}-${platform}.${os === "darwin" ? "dylib" : "so"}`
}

function localName(zenohVersion: string): string {
    const stem = libraryStem(zenohVersion)
    return { darwin: `lib${stem}.dylib`, windows: `${stem}.dll` }[Deno.build.os as string] ?? `lib${stem}.so`
}

function env(name: string): string | undefined {
    try {
        return Deno.env.get(name)
    } catch {
        return undefined
    }
}

function cacheDirectory(): string {
    const home = env("HOME") ?? env("USERPROFILE") ?? "."
    if (Deno.build.os === "darwin") {
        return `${home}/Library/Caches/zenoh-deno`
    }
    if (Deno.build.os === "windows") {
        return `${env("LOCALAPPDATA") ?? home}/zenoh-deno`
    }
    return `${env("XDG_CACHE_HOME") ?? `${home}/.cache`}/zenoh-deno`
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function exists(path: string | URL): boolean {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

function filePath(url: URL): string {
    return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1")
}

/**
 * The path of the native library for `zenohVersion`. When this module is a local file: what
 * `cargo build` made (a checkout), else the release bundle's prebuilt/ next to this file (offline,
 * e.g. nix). Otherwise the cached download from the GitHub release. Prebuilt and downloaded files
 * are checked against the sha256 recorded in this module.
 */
export async function libraryPath(zenohVersion: string): Promise<string> {
    if (!(ZENOH_VERSIONS as readonly string[]).includes(zenohVersion)) {
        throw new Error(`zenoh-deno ${VERSION} has no build for zenoh ${zenohVersion}; it has ${ZENOH_VERSIONS.join(", ")}`)
    }
    if (import.meta.url.startsWith("file:")) {
        for (const profile of ["release", "debug"]) {
            const url = new URL(`../../target/${profile}/${localName(zenohVersion)}`, import.meta.url)
            if (exists(url)) {
                return filePath(url)
            }
        }
    }
    const name = binaryName(zenohVersion)
    const expected = CHECKSUMS[name]
    if (!expected) {
        throw new Error(`zenoh-deno ${VERSION} has no prebuilt library for ${platformName()} with zenoh ${zenohVersion}`)
    }
    if (import.meta.url.startsWith("file:")) {
        const bundled = new URL(`./prebuilt/${name}`, import.meta.url)
        if (exists(bundled)) {
            const actual = await sha256(Deno.readFileSync(bundled))
            if (actual !== expected) {
                throw new Error(`zenoh-deno: ${filePath(bundled)} has sha256 ${actual}, expected ${expected}; refusing to load it`)
            }
            return filePath(bundled)
        }
    }
    const directory = `${cacheDirectory()}/${VERSION}`
    const path = `${directory}/${name}`
    if (exists(path) && (await sha256(Deno.readFileSync(path))) === expected) {
        return path
    }
    const url = `https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${name}`
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`zenoh-deno: downloading ${url} failed: ${response.status} ${response.statusText}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const actual = await sha256(bytes)
    if (actual !== expected) {
        throw new Error(`zenoh-deno: ${url} has sha256 ${actual}, expected ${expected}; refusing to load it`)
    }
    Deno.mkdirSync(directory, { recursive: true })
    // write then rename, so a concurrent process never loads a half-written file
    const temporary = `${path}.${crypto.randomUUID()}.partial`
    Deno.writeFileSync(temporary, bytes)
    Deno.renameSync(temporary, path)
    return path
}
