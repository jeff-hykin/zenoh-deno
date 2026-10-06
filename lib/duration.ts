// Typed durations, compatible with the `typed-duration` package zenoh-ts uses (replaces it).

interface TypedDurationBase {
    type: string
    valueType: "TYPED_DURATION"
    value: number
    unit: string
}
export interface Milliseconds extends TypedDurationBase { type: "MILLISECONDS"; unit: "ms" }
export interface Seconds extends TypedDurationBase { type: "SECONDS"; unit: "s" }
export interface Minutes extends TypedDurationBase { type: "MINUTES"; unit: "m" }
export interface Hours extends TypedDurationBase { type: "HOURS"; unit: "h" }
export interface Days extends TypedDurationBase { type: "DAYS"; unit: "d" }
export type TimeDuration = Milliseconds | Seconds | Minutes | Hours | Days
/** A typed duration, or a plain number of milliseconds. */
export type MaybeTimeDuration = TimeDuration | number

const MILLISECONDS_PER_UNIT: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function isTypedDuration(maybe: unknown): maybe is TimeDuration {
    return typeof maybe === "object" && maybe !== null && (maybe as TimeDuration).valueType === "TYPED_DURATION"
}

function toMilliseconds(time: MaybeTimeDuration): number {
    if (typeof time === "number") {
        return time
    }
    if (!isTypedDuration(time) || !(time.unit in MILLISECONDS_PER_UNIT)) {
        throw new TypeError(`not a duration: ${JSON.stringify(time)}`)
    }
    return time.value * MILLISECONDS_PER_UNIT[time.unit]
}

/** Makes and reads durations of one unit. */
export interface DurationUnit<T extends TimeDuration> {
    of: (value: number) => T
    from: (time: MaybeTimeDuration) => number
}

function unit<T extends TimeDuration>(type: T["type"], unitName: T["unit"]): DurationUnit<T> {
    return {
        of: (value: number): T => ({ type, valueType: "TYPED_DURATION", value, unit: unitName }) as T,
        from: (time: MaybeTimeDuration): number => toMilliseconds(time) / MILLISECONDS_PER_UNIT[unitName],
    }
}

export const Duration: {
    milliseconds: DurationUnit<Milliseconds>
    seconds: DurationUnit<Seconds>
    minutes: DurationUnit<Minutes>
    hours: DurationUnit<Hours>
    days: DurationUnit<Days>
    value: { from: (time: MaybeTimeDuration) => number; of: (time: MaybeTimeDuration, defaultUnit?: string) => string }
    isTypedDuration: (maybe: unknown) => maybe is TimeDuration
} = {
    milliseconds: unit<Milliseconds>("MILLISECONDS", "ms"),
    seconds: unit<Seconds>("SECONDS", "s"),
    minutes: unit<Minutes>("MINUTES", "m"),
    hours: unit<Hours>("HOURS", "h"),
    days: unit<Days>("DAYS", "d"),
    value: {
        from: (time: MaybeTimeDuration): number => (typeof time === "number" ? time : time.value),
        of: (time: MaybeTimeDuration, defaultUnit = "ms"): string => (typeof time === "number" ? `${time}${defaultUnit}` : `${time.value}${time.unit}`),
    },
    isTypedDuration,
}
