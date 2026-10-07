// The TS key expression rules (lib/key_expr_rules.ts) against zenoh's own, through the native library,
// on random key expressions built from the characters that matter.

import { assertEquals } from "jsr:@std/assert@1"
import * as rules from "../lib/key_expr_rules.ts"
import { encoder, loadNative } from "../lib/native/ffi.ts"
import { ZENOH_VERSIONS } from "../lib/native/library.ts"

const PIECES = ["a", "b", "ab", "@a", "@", "*", "**", "$*", "$", "/", "/", "/", "#", "?", "é"]
const OPERATIONS = { validate: 0, join: 1, concat: 2, includes: 3, intersects: 4, autocanonize: 5 } as const

function seededRandom(seed: number): () => number {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
    }
}

// zenoh's canonize panics (and aborts the process) on a `$*$*` within 6 bytes of the end
const panicsInZenoh = (text: string) => [...text.matchAll(/(?=\$\*\$\*)/g)].some((match) => match.index! + 6 > text.length)

function outcome(run: () => unknown): string {
    try {
        return `ok ${run()}`
    } catch {
        return "error"
    }
}

// libraries stay loaded for the life of the process; load them outside the tests' leak check
const libraries = await Promise.all(ZENOH_VERSIONS.map((zenohVersion) => loadNative(zenohVersion)))

for (const [index, zenohVersion] of ZENOH_VERSIONS.entries()) {
    Deno.test(`key expression rules match zenoh ${zenohVersion}`, () => {
        const native = libraries[index]
        const nativeOutcome = (operation: number, a: string, b = "") => {
            const [aBytes, bBytes] = [encoder.encode(a), encoder.encode(b)]
            const result = native.symbols.zd_keyexpr(operation, aBytes, BigInt(aBytes.length), bBytes, BigInt(bBytes.length))
            const text = native.resultText()
            if (result < 0) {
                return "error"
            }
            return operation === OPERATIONS.includes || operation === OPERATIONS.intersects ? `ok ${result === 1}` : `ok ${operation === 0 ? undefined : text}`
        }
        const random = seededRandom(7)
        const randomKeyExpr = () => Array.from({ length: 1 + Math.floor(random() * 7) }, () => PIECES[Math.floor(random() * PIECES.length)]).join("")
        // valid ones too, so includes/intersects get exercised past validation
        const randomValidKeyExpr = () => {
            for (;;) {
                const candidate = randomKeyExpr()
                if (outcome(() => rules.validate(candidate)) !== "error") {
                    return candidate
                }
            }
        }
        for (let i = 0; i < 20000; i++) {
            const [a, b] = i % 2 ? [randomValidKeyExpr(), randomValidKeyExpr()] : [randomKeyExpr(), randomKeyExpr()]
            const cases: [string, string, () => unknown][] = [
                ["validate", a, () => rules.validate(a)],
                ["includes", a, () => rules.includes(a, b)],
                ["intersects", a, () => rules.intersects(a, b)],
                ["concat", a, () => rules.concat(a, b)],
            ]
            if (!panicsInZenoh(a)) {
                cases.push(["autocanonize", a, () => rules.autocanonize(a)])
            }
            if (!panicsInZenoh(`${a}/${b}`)) {
                cases.push(["join", a, () => rules.join(a, b)])
            }
            for (const [name, , run] of cases) {
                const operation = OPERATIONS[name as keyof typeof OPERATIONS]
                assertEquals(outcome(run), nativeOutcome(operation, a, b), `${name}(${JSON.stringify(a)}, ${JSON.stringify(b)})`)
            }
        }
    })
}

Deno.test("canonizing a trailing `$*$*` doesn't crash (zenoh's own canonize panics there)", () => {
    assertEquals(rules.autocanonize("foo$*$*"), "foo$*")
})
