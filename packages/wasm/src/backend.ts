// A WASM FFI backend for @opentui/core's platform/ffi seam. It lets the existing `FFIRenderLib`
// (zig.ts) run unchanged over the wasm module: symbol calls dispatch to wasm exports with
// pointer/buffer marshalling into linear memory, and native→JS callbacks (yoga measure/dirtied,
// NativeSpanFeed events) are routed through the wasm `env` imports.
//
// Pointer model: `ptr(buffer)` immediately allocates a region in linear memory, copies the bytes in,
// and returns a real numeric offset (so it can be stored inside a struct field — nested data pointers).
// Every region is recorded; after each symbol call returns, regions are copied back (so output params
// and out-structs are visible to JS) and freed.
import type { WasmRuntime, WasmHostImports } from "./runtime.js"

const PTR_TYPES = new Set(["ptr", "pointer", "buffer", "cstring"])
const U64 = new Set(["u64", "i64", "uint64_t", "int64_t"])
const DEBUG = typeof process !== "undefined" && process.env?.WASM_DEBUG === "1"

function toView(v: unknown): Uint8Array | null {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength)
  return null
}

export interface WasmFfi {
  // Shape-compatible with @opentui/core's FfiBackend (cast at the call site).
  backend: unknown
  env: WasmHostImports
  setRuntime(runtime: WasmRuntime): void
}

export function createWasmBackend(): WasmFfi {
  let rt: WasmRuntime
  const callbacks = new Map<number, (...a: any[]) => any>()
  let nextCb = 0x7f00_0000
  const measureFns = new Map<number, (...a: any[]) => any>()
  const dirtiedFns = new Map<number, () => void>()
  let feedCallback: ((...a: any[]) => any) | null = null

  // Regions allocated for the in-flight symbol call; copied back + freed after it returns.
  const pending: Array<{ wptr: number; view: Uint8Array; len: number }> = []

  const allocPending = (view: Uint8Array): number => {
    const len = view.byteLength
    if (len === 0) return 0
    const wptr = rt.alloc(len)
    rt.u8().set(view, wptr)
    pending.push({ wptr, view, len })
    return wptr
  }
  const flushPending = (): void => {
    if (pending.length === 0) return
    const mem = rt.u8()
    for (const p of pending) {
      p.view.set(mem.subarray(p.wptr, p.wptr + p.len)) // copy-back (out-params / out-structs)
      rt.free(p.wptr, p.len)
    }
    pending.length = 0
  }

  const marshalArg = (a: any, type: string | undefined): number | bigint => {
    if (type && PTR_TYPES.has(type)) {
      if (a == null) return 0
      if (typeof a === "number") return a // already an offset (from ptr()) or a callback pseudo-ptr
      if (typeof a === "bigint") return Number(a)
      const view = toView(a)
      return view ? allocPending(view) : 0
    }
    if (type === "bool") return a ? 1 : 0
    if (type && U64.has(type)) return typeof a === "bigint" ? a : BigInt(Math.trunc(Number(a)))
    return Number(a)
  }

  const makeSymbol = (name: string, def: { args?: string[]; returns?: string }) => {
    const argTypes = def.args ?? []
    const ret = def.returns
    return (...callArgs: any[]): any => {
      // Intercept callback-setters so native→JS dispatch (via env imports) can find the JS fn.
      if (name === "yogaNodeSetMeasureFunc") {
        const fn = callbacks.get(Number(callArgs[1]))
        if (fn) measureFns.set(Number(callArgs[0]), fn)
      } else if (name === "yogaNodeUnsetMeasureFunc") {
        measureFns.delete(Number(callArgs[0]))
      } else if (name === "yogaNodeSetDirtiedFunc") {
        const fn = callbacks.get(Number(callArgs[1]))
        if (fn) dirtiedFns.set(Number(callArgs[0]), fn as () => void)
      } else if (name === "streamSetCallback") {
        feedCallback = callbacks.get(Number(callArgs[1])) ?? null
      }
      const wargs = callArgs.map((a, i) => marshalArg(a, argTypes[i]))
      const fn = (rt.exports as Record<string, (...a: any[]) => any>)[name]
      if (typeof fn !== "function") throw new Error(`opentui.wasm export not found: ${name}`)
      if (DEBUG) console.error(`-> ${name}`)
      // flushPending() copies out-params back to their JS views and frees the linear-memory regions.
      // It MUST run even if the export throws, or the pending regions leak and a later flush would
      // copy back / double-free addresses the allocator may have since reused.
      let result: any
      try {
        result = fn(...wargs)
      } finally {
        flushPending()
      }
      if (ret === "bool") return result !== 0
      return result
    }
  }

  const env: WasmHostImports = {
    ot_yogaMeasure: (node, width, widthMode, height, heightMode) => {
      measureFns.get(node)?.(0, width, widthMode, height, heightMode)
    },
    ot_yogaDirtied: (node) => {
      dirtiedFns.get(node)?.()
    },
    ot_dispatchSpanFeedEvent: (streamPtr, eventId, arg0, arg1) => {
      feedCallback?.(streamPtr, eventId, arg0, arg1)
    },
  }

  const backend = {
    dlopen(_path: string | URL, symbols: Record<string, { args?: string[]; returns?: string }>) {
      const syms: Record<string, (...a: any[]) => any> = {}
      for (const [name, def] of Object.entries(symbols)) syms[name] = makeSymbol(name, def)
      return {
        symbols: syms,
        createCallback(callback: (...a: any[]) => any) {
          const id = ++nextCb
          callbacks.set(id, callback)
          return {
            get ptr() {
              return id
            },
            threadsafe: false,
            close() {
              callbacks.delete(id)
            },
          }
        },
        close() {},
      }
    },
    ptr(value: ArrayBufferLike | ArrayBufferView): any {
      const view = toView(value)
      return view ? allocPending(view) : 0
    },
    suffix: "",
    toArrayBuffer(pointer: number | bigint, offset: number | undefined, length: number): ArrayBuffer {
      const ptr = Number(pointer) + (offset ?? 0)
      return rt.u8().slice(ptr, ptr + length).buffer
    },
  }

  return { backend, env, setRuntime: (runtime) => { rt = runtime } }
}
