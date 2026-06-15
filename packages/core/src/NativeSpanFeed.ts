import { toArrayBuffer, type Pointer } from "./platform/ffi.js"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import { SpanInfoStruct } from "./zig-structs.js"
import type { NativeSpanFeedOptions } from "./zig-structs.js"

export type { GrowthPolicy, NativeSpanFeedOptions, NativeSpanFeedStats } from "./zig-structs.js"

const enum EventId {
  ChunkAdded = 2,
  Closed = 5,
  Error = 6,
  DataAvailable = 7,
  StateBuffer = 8,
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value
}

function chunkKey(value: Pointer): bigint {
  return typeof value === "bigint" ? value : BigInt(value)
}

type StreamEventHandler = (eventId: number, arg0: Pointer, arg1: number | bigint) => void

export type DataHandler = (data: Uint8Array) => void | Promise<void>

const canThrowAcrossNativeCallback =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  process.versions !== null &&
  typeof process.versions.bun === "string"

/**
 * Zero-copy wrapper over Zig memory; not a full stream interface.
 * Chunk and state typed-array views are borrowed and invalid after destroy.
 */
export class NativeSpanFeed {
  static create(options?: NativeSpanFeedOptions, lib: RenderLib = resolveRenderLib()): NativeSpanFeed {
    const streamPtr = lib.createNativeSpanFeed(options)
    const stream = new NativeSpanFeed(streamPtr, lib)

    lib.registerNativeSpanFeedStream(streamPtr, stream.eventHandler)

    const status = lib.attachNativeSpanFeed(streamPtr)
    if (status !== 0) {
      lib.unregisterNativeSpanFeedStream(streamPtr)
      lib.destroyNativeSpanFeed(streamPtr)
      throw new Error(`Failed to attach stream: ${status}`)
    }

    return stream
  }

  static attach(streamPtr: Pointer, _options?: NativeSpanFeedOptions, lib: RenderLib = resolveRenderLib()): NativeSpanFeed {
    const stream = new NativeSpanFeed(streamPtr, lib)

    lib.registerNativeSpanFeedStream(streamPtr, stream.eventHandler)

    const status = lib.attachNativeSpanFeed(streamPtr)
    if (status !== 0) {
      lib.unregisterNativeSpanFeedStream(streamPtr)
      throw new Error(`Failed to attach stream: ${status}`)
    }

    return stream
  }

  readonly streamPtr: Pointer
  private readonly lib: RenderLib
  private readonly eventHandler: StreamEventHandler
  // Chunk pointers arrive both as native→JS callback args (a JS number for the wasm backend,
  // a bigint for node:ffi) and as struct fields read by bun-ffi-structs (a bigint at 8-byte
  // pointer width, except a number under Bun). Normalize every key to bigint so lookups match
  // regardless of which path produced the pointer.
  private chunkMap = new Map<bigint, ArrayBuffer>()
  private chunkSizes = new Map<bigint, number>()
  private dataHandlers = new Set<DataHandler>()
  private errorHandlers = new Set<(code: number) => void>()
  private drainBuffer: Uint8Array | null = null
  private stateBuffer: Uint8Array | null = null
  private closed = false
  private destroyed = false
  private draining = false
  private pendingDataAvailable = false
  private pendingClose = false
  private closing = false
  private pendingAsyncHandlers = 0
  private inCallback = false
  private closeQueued = false
  private idleResolvers: Array<() => void> = []
  private pendingHandlerError: unknown = null
  private pendingHandlerErrorQueued = false

  private constructor(streamPtr: Pointer, lib: RenderLib) {
    this.streamPtr = streamPtr
    this.lib = lib
    this.eventHandler = (eventId, arg0, arg1) => {
      this.handleEvent(eventId, arg0, arg1)
    }
    this.ensureDrainBuffer()
  }

  private ensureDrainBuffer(): void {
    if (this.drainBuffer) return
    const capacity = 256
    this.drainBuffer = new Uint8Array(capacity * SpanInfoStruct.size)
  }

  onData(handler: DataHandler): () => void {
    this.dataHandlers.add(handler)
    if (this.pendingDataAvailable) {
      this.pendingDataAvailable = false
      this.drainAll()
    }
    return () => this.dataHandlers.delete(handler)
  }

  onError(handler: (code: number) => void): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  private hasPinnedChunks(): boolean {
    if (!this.stateBuffer) return false
    for (const refcount of this.stateBuffer) {
      if (refcount > 0) return true
    }
    return false
  }

  isBackpressured(): boolean {
    return this.pendingAsyncHandlers > 0 || this.pendingDataAvailable || this.hasPinnedChunks()
  }

  close(): void {
    if (this.destroyed) return
    if (this.inCallback || this.draining || this.pendingAsyncHandlers > 0) {
      this.pendingClose = true
      if (!this.closeQueued) {
        this.closeQueued = true
        queueMicrotask(() => {
          this.closeQueued = false
          this.processPendingClose()
        })
      }
      return
    }
    this.performClose()
  }

  private processPendingClose(): void {
    if (!this.pendingClose || this.destroyed) return
    if (this.inCallback || this.draining || this.pendingAsyncHandlers > 0) return
    this.pendingClose = false
    this.performClose()
    this.resolveIdleIfNeeded()
  }

  private performClose(): void {
    if (this.closing) return
    this.closing = true
    if (!this.closed) {
      const status = this.lib.streamClose(this.streamPtr)
      if (status !== 0) {
        this.closing = false
        return
      }
      this.closed = true
    }
    this.finalizeDestroy()
  }

  private finalizeDestroy(): void {
    if (this.destroyed) return
    this.lib.unregisterNativeSpanFeedStream(this.streamPtr)
    this.lib.destroyNativeSpanFeed(this.streamPtr)
    this.destroyed = true
    this.chunkMap.clear()
    this.chunkSizes.clear()
    this.stateBuffer = null
    this.drainBuffer = null
    this.dataHandlers.clear()
    this.errorHandlers.clear()
    this.pendingDataAvailable = false
    this.resolveIdleIfNeeded()
  }

  private isIdle(): boolean {
    return (
      !this.inCallback &&
      !this.draining &&
      this.pendingAsyncHandlers === 0 &&
      !this.pendingDataAvailable &&
      !this.hasPinnedChunks()
    )
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return
    const resolvers = this.idleResolvers.splice(0)
    for (const resolve of resolvers) {
      resolve()
    }
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  private handleEvent(eventId: number, arg0: Pointer, arg1: number | bigint): void {
    this.inCallback = true
    try {
      switch (eventId) {
        case EventId.StateBuffer: {
          const len = toNumber(arg1)
          if (len > 0 && arg0) {
            // toArrayBuffer must alias Zig memory so refcount writes are visible.
            const buffer = toArrayBuffer(arg0, 0, len)
            this.stateBuffer = new Uint8Array(buffer)
          }
          break
        }
        case EventId.DataAvailable: {
          if (this.closing) break
          if (this.dataHandlers.size === 0) {
            this.pendingDataAvailable = true
            break
          }
          this.drainAll()
          break
        }
        case EventId.ChunkAdded: {
          const chunkLen = toNumber(arg1)
          if (chunkLen > 0 && arg0) {
            const key = chunkKey(arg0)
            if (!this.chunkMap.has(key)) {
              const buffer = toArrayBuffer(arg0, 0, chunkLen)
              this.chunkMap.set(key, buffer)
            }
            this.chunkSizes.set(key, chunkLen)
          }
          break
        }
        case EventId.Error: {
          const code = toNumber(arg0)
          for (const handler of this.errorHandlers) handler(code)
          break
        }
        case EventId.Closed: {
          this.closed = true
          break
        }
        default:
          break
      }
    } finally {
      this.inCallback = false
      this.resolveIdleIfNeeded()
    }
  }

  private decrementRefcount(chunkIndex: number): void {
    if (this.stateBuffer && chunkIndex < this.stateBuffer.length) {
      const prev = this.stateBuffer[chunkIndex]
      this.stateBuffer[chunkIndex] = prev > 0 ? prev - 1 : 0
    }
  }

  private queuePendingHandlerError(error: unknown): void {
    this.pendingHandlerError ??= error
    if (this.pendingHandlerErrorQueued) return

    this.pendingHandlerErrorQueued = true
    queueMicrotask(() => {
      this.pendingHandlerErrorQueued = false
      if (this.pendingHandlerError === null) return

      const pendingError = this.pendingHandlerError
      this.pendingHandlerError = null
      throw pendingError
    })
  }

  private throwPendingHandlerError(): void {
    if (this.pendingHandlerError === null) return

    const pendingError = this.pendingHandlerError
    this.pendingHandlerError = null
    throw pendingError
  }

  private drainOnce(): number {
    if (!this.drainBuffer || this.draining || this.pendingClose) return 0
    const capacity = Math.floor(this.drainBuffer.byteLength / SpanInfoStruct.size)
    if (capacity === 0) return 0

    const count = this.lib.streamDrainSpans(this.streamPtr, this.drainBuffer, capacity)
    if (count === 0) return 0

    this.draining = true
    const spans = SpanInfoStruct.unpackList(this.drainBuffer.buffer, count)
    let firstError: unknown = null

    try {
      for (const span of spans) {
        if (span.len === 0) continue

        const size = this.chunkSizes.get(chunkKey(span.chunkPtr))
        if (!size || span.offset + span.len > size) continue

        // Read the span bytes directly from native memory per-span. toArrayBuffer aliases on FFI
        // backends and returns a fresh copy on the WASM backend; reading per-span (instead of
        // slicing a cached whole-chunk view) is correct for both, since WASM cannot alias a
        // sub-region of linear memory as a standalone ArrayBuffer.
        const slice = new Uint8Array(toArrayBuffer(span.chunkPtr, span.offset, span.len))
        let asyncResults: Promise<void>[] | null = null

        for (const handler of this.dataHandlers) {
          try {
            const result = handler(slice)
            // Async handlers keep the chunk pinned until they settle.
            if (result && typeof result.then === "function") {
              asyncResults ??= []
              asyncResults.push(result)
            }
          } catch (e) {
            firstError ??= e
          }
        }

        const shouldStopAfterThisSpan = this.pendingClose

        if (asyncResults) {
          // Use allSettled so rejections still release refcounts.
          const chunkIndex = span.chunkIndex
          this.pendingAsyncHandlers += 1
          Promise.allSettled(asyncResults).then(() => {
            this.decrementRefcount(chunkIndex)
            this.pendingAsyncHandlers -= 1
            this.processPendingClose()
            this.resolveIdleIfNeeded()
          })
        } else {
          this.decrementRefcount(span.chunkIndex)
        }

        if (shouldStopAfterThisSpan) break
      }
    } finally {
      this.draining = false
      this.resolveIdleIfNeeded()
    }

    if (firstError) {
      if (!this.inCallback || canThrowAcrossNativeCallback) {
        throw firstError
      }

      // Node FFI terminates when JS exceptions cross a native callback boundary.
      // Surface the error after the callback returns instead of swallowing it.
      this.queuePendingHandlerError(firstError)
    }

    return count
  }

  drainAll(): void {
    let count = this.drainOnce()
    while (count > 0) {
      count = this.drainOnce()
    }
    if (!this.inCallback) {
      this.throwPendingHandlerError()
    }
  }
}
