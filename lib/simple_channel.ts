// A multi-producer single-consumer async channel (replaces the `channel-ts` package).

export enum ChannelState {
    empty = "empty",
    receiver = "receiver",
    data = "data",
    close = "close",
}

export enum TryReceivedKind {
    value = "value",
    notReceived = "no",
    close = "close",
}

export type TryReceived<T> = { kind: TryReceivedKind.value; value: T } | { kind: TryReceivedKind.notReceived } | { kind: TryReceivedKind.close }

export class SimpleChannel<T> {
    private receivers: Array<[(value: T) => void, (reason?: unknown) => void]> = []
    private data: T[] = []
    private closed = false

    get state(): ChannelState {
        if (this.data.length > 0) {
            return ChannelState.data
        }
        if (this.closed) {
            return ChannelState.close
        }
        return this.receivers.length > 0 ? ChannelState.receiver : ChannelState.empty
    }

    tryReceive(): TryReceived<T> {
        if (this.data.length > 0) {
            return { kind: TryReceivedKind.value, value: this.data.shift() as T }
        }
        return this.closed ? { kind: TryReceivedKind.close } : { kind: TryReceivedKind.notReceived }
    }

    /** Resolves with the next value; rejects once the channel is closed and drained. */
    receive(): Promise<T> {
        if (this.data.length > 0) {
            return Promise.resolve(this.data.shift() as T)
        }
        if (this.closed) {
            return Promise.reject(new Error("channel closed"))
        }
        return new Promise((resolve, reject) => this.receivers.push([resolve, reject]))
    }

    send(value: T): void {
        if (this.closed) {
            throw new Error("sending on closed channel")
        }
        const receiver = this.receivers.shift()
        if (receiver) {
            receiver[0](value)
        } else {
            this.data.push(value)
        }
    }

    close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        for (const [, reject] of this.receivers.splice(0)) {
            reject(new Error("channel closed"))
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
        try {
            while (true) {
                yield await this.receive()
            }
        } catch {
            // closed
        }
    }
}
