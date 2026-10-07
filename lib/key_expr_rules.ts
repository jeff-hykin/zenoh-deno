//
// Copyright (c) 2023 ZettaScale Technology
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0, or the Apache License, Version 2.0
// which is available at https://www.apache.org/licenses/LICENSE-2.0.
//
// SPDX-License-Identifier: EPL-2.0 OR Apache-2.0
//
// Contributors:
//   ZettaScale Zenoh Team, <zenoh@zettascale.tech>
//

// Key expression rules, ported from the zenoh-keyexpr crate (identical in zenoh 1.6.2 and 1.10.1):
// validation (borrowed.rs), canon.rs, intersect/classical.rs, include.rs, and zenoh's KeyExpr::concat.
// Plain TS so importing the module loads no native library; tests/key_expr_rules.ts checks them against zenoh.
// Every special character is ASCII, so working on UTF-16 code units matches zenoh working on UTF-8 bytes.

function invalid(keyExpr: string, reason: string): Error {
    return new Error(`Invalid Key Expr \`${keyExpr}\`: ${reason}`)
}
const EMPTY_CHUNK = "empty chunks are forbidden, as well as leading and trailing slashes"
const STAR_IN_CHUNK = "`*` may only be preceded by `/` or `$`"

/** Throws unless `value` is a valid canon key expression (zenoh's `keyexpr::new`). */
export function validate(value: string): void {
    if (value === "" || value.endsWith("/")) {
        throw invalid(value, EMPTY_CHUNK)
    }
    let chunkStart = 0
    let i = 0
    while (i < value.length) {
        const c = value[i]
        if (c > "/" && c !== "?") {
            i += 1
        } else if (c === "/") {
            if (i === chunkStart) {
                throw invalid(value, EMPTY_CHUNK)
            }
            i += 1
            chunkStart = i
        } else if (c === "*") {
            if (i !== chunkStart) {
                throw invalid(value, STAR_IN_CHUNK)
            }
            const next = value[i + 1]
            if (next === undefined) {
                break
            } else if (next === "/") {
                i += 2
                chunkStart = i
            } else if (next === "*") {
                const afterDouble = value[i + 2]
                if (afterDouble === undefined) {
                    break
                } else if (afterDouble === "/" && value[i + 3] === "*") {
                    const [a, b] = [value[i + 4], value[i + 5]]
                    if (a === undefined || a === "/") {
                        throw invalid(value, "`**/*` must be replaced by `*/**` to reach canon-form")
                    } else if (a === "*" && (b === undefined || b === "/")) {
                        throw invalid(value, "`**/**` must be replaced by `**` to reach canon-form")
                    }
                    throw invalid(value, STAR_IN_CHUNK)
                } else if (afterDouble === "/") {
                    i += 3
                    chunkStart = i
                } else {
                    throw invalid(value, STAR_IN_CHUNK)
                }
            } else {
                throw invalid(value, STAR_IN_CHUNK)
            }
        } else if (c === "$") {
            if (value[i + 1] !== "*") {
                throw invalid(value, "`$` is only allowed in `$*`")
            }
            const next = value[i + 2]
            if (next === "$") {
                throw invalid(value, "`$` is not allowed after `$*`")
            } else if ((next === "/" || next === undefined) && i === chunkStart) {
                throw invalid(value, EMPTY_CHUNK)
            } else if (next === undefined) {
                break
            }
            i += 2
        } else if (c === "#" || c === "?") {
            throw invalid(value, "`#` and `?` are forbidden characters")
        } else {
            i += 1
        }
    }
}

/** zenoh's canonize (canon.rs), on a string. */
function canonize(text: string): string {
    let index = 0
    let out = ""
    let doubleWild = false
    while (true) {
        const rest = text.slice(index)
        if (rest === "**") {
            return out + "**"
        } else if (rest.startsWith("**/")) {
            doubleWild = true
            index += 3
            continue
        }
        const afterStar = rest.startsWith("*") ? rest.slice(1) : rest.startsWith("$*") ? rest.slice(2) : undefined
        if (afterStar !== undefined && (afterStar === "" || afterStar.startsWith("/"))) {
            out += "*"
            if (afterStar === "") {
                return doubleWild ? out + "/**" : out
            }
            out += "/"
            index = text.length - afterStar.length + 1
        } else if (rest.startsWith("$*$*")) {
            index += 2
        } else {
            if (doubleWild && rest !== "**") {
                out += "**/"
                doubleWild = false
            }
            let writeStart = index
            while (true) {
                const c = text[index]
                if (c === "/") {
                    index += 1
                    out += text.slice(writeStart, index)
                    break
                } else if (c === "$" && text.slice(index + 1, index + 4) === "*$*") {
                    index += 2
                    out += text.slice(writeStart, index)
                    // zenoh counts with overlapping 2-byte windows, so at most one more `$*` is skipped
                    const skip = text.slice(index + 4, index + 6) === "$*" ? 1 : 0
                    index += (1 + skip) * 2
                    writeStart = index
                } else if (c !== undefined) {
                    index += 1
                } else {
                    return out + text.slice(writeStart, index)
                }
            }
        }
    }
}

/** zenoh's `OwnedKeyExpr::autocanonize`: canonize, then validate. */
export function autocanonize(text: string): string {
    const canon = canonize(text)
    validate(canon)
    return canon
}

export function join(left: string, right: string): string {
    validate(left)
    return autocanonize(`${left}/${right}`)
}

export function concat(left: string, right: string): string {
    validate(left)
    if (left.endsWith("*") && right.startsWith("*")) {
        throw new Error(`Tried to concatenate ${left} (ends with *) and ${right} (starts with *), which would likely have caused bugs. If you're sure you want to do this, concatenate these into a string and then try to convert.`)
    }
    const joined = left + right
    validate(joined)
    return joined
}

// intersect/mod.rs + classical.rs

const hasDirectVerbatim = (chunk: string) => chunk.startsWith("@")
const hasVerbatim = (keyExpr: string) => keyExpr.split("/").some(hasDirectVerbatim)

function starDslIntersect(it1: string, it2: string): boolean {
    while (it1 !== "" && it2 !== "") {
        const [current1, advanced1] = [it1[0], it1.slice(1)]
        const [current2, advanced2] = [it2[0], it2.slice(1)]
        if (current1 === "$" && current2 === "$") {
            if (advanced1.length === 1 || advanced2.length === 1) {
                return true
            }
            return starDslIntersect(advanced1.slice(1), it2) || starDslIntersect(it1, advanced2.slice(1))
        } else if (current1 === "$") {
            if (advanced1.length === 1 || starDslIntersect(advanced1.slice(1), it2)) {
                return true
            }
            it2 = advanced2
        } else if (current2 === "$") {
            if (advanced2.length === 1 || starDslIntersect(it1, advanced2.slice(1))) {
                return true
            }
            it1 = advanced1
        } else if (current1 === current2) {
            it1 = advanced1
            it2 = advanced2
        } else {
            return false
        }
    }
    return (it1 === "" && it2 === "") || it1 === "$*" || it2 === "$*"
}

function chunkIntersect(c1: string, c2: string, starDsl: boolean): boolean {
    if (c1 === c2) {
        return true
    }
    if (hasDirectVerbatim(c1) || hasDirectVerbatim(c2)) {
        return false
    }
    return c1 === "*" || c2 === "*" || (starDsl && starDslIntersect(c1, c2))
}

function nextChunk(s: string): [string, string] {
    const i = s.indexOf("/")
    return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]
}

function itIntersect(it1: string, it2: string, starDsl: boolean): boolean {
    while (it1 !== "" && it2 !== "") {
        const [current1, advanced1] = nextChunk(it1)
        const [current2, advanced2] = nextChunk(it2)
        if (current1 === "**") {
            if (advanced1 === "") {
                return !hasVerbatim(it2)
            }
            return (!hasDirectVerbatim(current2) && itIntersect(it1, advanced2, starDsl)) || itIntersect(advanced1, it2, starDsl)
        } else if (current2 === "**") {
            if (advanced2 === "") {
                return !hasVerbatim(it1)
            }
            return (!hasDirectVerbatim(current1) && itIntersect(advanced1, it2, starDsl)) || itIntersect(it1, advanced2, starDsl)
        } else if (chunkIntersect(current1, current2, starDsl)) {
            it1 = advanced1
            it2 = advanced2
        } else {
            return false
        }
    }
    return (it1 === "" || it1 === "**") && (it2 === "" || it2 === "**")
}

function matchComplexity(keyExpr: string): number {
    if (keyExpr.includes("$")) {
        return 2
    }
    return keyExpr.includes("*") ? 1 : 0
}

export function intersects(left: string, right: string): boolean {
    validate(left)
    validate(right)
    if (left === right) {
        return true
    }
    const complexity = matchComplexity(left) | matchComplexity(right)
    return complexity !== 0 && itIntersect(left, right, complexity !== 1)
}

// include.rs

function chunkIncludes(lchunk: string, rchunk: string): boolean {
    if (lchunk === rchunk) {
        return true
    } else if (hasDirectVerbatim(lchunk) || hasDirectVerbatim(rchunk)) {
        return false
    } else if (lchunk === "*") {
        return true
    } else if (!lchunk.includes("$")) {
        return false
    }
    const pieces = lchunk.split("$*")
    const [prefix, suffix] = [pieces[0], pieces[pieces.length - 1]]
    if (!rchunk.startsWith(prefix)) {
        return false
    }
    rchunk = rchunk.slice(prefix.length)
    if (!rchunk.endsWith(suffix)) {
        return false
    }
    rchunk = rchunk.slice(0, rchunk.length - suffix.length)
    for (const needle of pieces.slice(1, -1)) {
        const position = rchunk.indexOf(needle)
        if (position === -1) {
            return false
        }
        rchunk = rchunk.slice(position + needle.length)
    }
    return true
}

function ltrIncludes(left: string, right: string): boolean {
    while (true) {
        const [lchunk, lrest] = nextChunk(left)
        const lempty = lrest === ""
        if (lchunk === "**") {
            if ((lempty && !hasVerbatim(right)) || (!lempty && ltrIncludes(lrest, right))) {
                return true
            }
            if (hasDirectVerbatim(right)) {
                return false
            }
            right = nextChunk(right)[1]
            if (right === "") {
                return false
            }
        } else {
            const [rchunk, rrest] = nextChunk(right)
            if (rchunk === "" || rchunk === "**" || !chunkIncludes(lchunk, rchunk)) {
                return false
            }
            if (lempty) {
                return rrest === ""
            }
            left = lrest
            right = rrest
        }
    }
}

export function includes(left: string, right: string): boolean {
    validate(left)
    validate(right)
    return left === right || ltrIncludes(left, right)
}
