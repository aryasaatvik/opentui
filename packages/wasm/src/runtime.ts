// createWasmRuntime: instantiate `opentui.wasm` and expose the export surface plus a
// linear-memory bridge for marshalling data in/out of the module.
//
// NOTE: the OpenTUI native `RenderLib` interface (~270 methods in @opentui/core/zig.ts) is the
// eventual adapter target so the wasm runtime can be injected via `setRenderLib()` and drive the
// full `CliRenderer`. This module provides the foundation that adapter is built on: instantiation,
// the WASI shim, and the pointer/alloc bridge. The renderer/feed/yoga exports are reachable today
// through `runtime.exports` (see the render smoke test for the one-frame path).

import { createWasiShim } from "./wasi.js"

/** Host callbacks the wasm imports from `env` (native→JS, since wasm has no fn table). */
export interface WasmHostImports {
  /** Yoga measure: route `node` to its JS measure fn, which calls `yogaStoreMeasureResult`. */
  ot_yogaMeasure(node: number, width: number, widthMode: number, height: number, heightMode: number): void
  /** Yoga dirtied: route `node` to its JS dirtied fn. */
  ot_yogaDirtied(node: number): void
  /** NativeSpanFeed event: route `streamPtr` to its registered JS event handler. */
  ot_dispatchSpanFeedEvent(streamPtr: number, eventId: number, arg0: number, arg1: bigint): void
}

export interface WasmRuntimeOptions {
  /** Compiled `opentui.wasm` module. */
  wasmModule: WebAssembly.Module
  /** Optional externally-owned memory (the module exports its own by default). */
  memory?: WebAssembly.Memory
  /** Host callbacks the wasm imports. Defaults are no-ops (fine when no measure funcs are set). */
  env?: Partial<WasmHostImports>
}

export interface WasmRuntime {
  /** Raw wasm exports (renderer, NativeSpanFeed, yoga, buffer ops, ot_alloc/ot_free, …). */
  readonly exports: Record<string, any>
  /** The module's linear memory. */
  readonly memory: WebAssembly.Memory
  /** Allocate `size` bytes in wasm memory; returns the pointer (throws on OOM). */
  alloc(size: number): number
  /** Free a pointer previously returned by `alloc` (size must match the allocation). */
  free(ptr: number, size: number): void
  /** Copy bytes into a fresh wasm allocation; returns the pointer (caller frees with the same length). */
  writeBytes(data: Uint8Array): number
  /** Copy u16 values into a fresh wasm allocation; returns the pointer (caller frees with `values.length * 2`). */
  writeU16(values: ArrayLike<number>): number
  /** Read `len` bytes from wasm memory at `ptr` (copied out — safe across later grows). */
  readBytes(ptr: number, len: number): Uint8Array
  /** Fresh `Uint8Array` view over current memory (re-derive after any call that may grow memory). */
  u8(): Uint8Array
  /** Fresh `DataView` over current memory. */
  dv(): DataView
}

export async function createWasmRuntime(options: WasmRuntimeOptions): Promise<WasmRuntime> {
  const wasi = createWasiShim()
  const env: WebAssembly.ModuleImports = {
    ot_yogaMeasure: options.env?.ot_yogaMeasure ?? (() => {}),
    ot_yogaDirtied: options.env?.ot_yogaDirtied ?? (() => {}),
    ot_dispatchSpanFeedEvent: options.env?.ot_dispatchSpanFeedEvent ?? (() => {}),
  }
  if (options.memory) env.memory = options.memory
  const importObject: WebAssembly.Imports = { wasi_snapshot_preview1: wasi.imports, env }

  const instance = await WebAssembly.instantiate(options.wasmModule, importObject)
  wasi.bind(instance)

  const exports = instance.exports as Record<string, any>
  // Reactor initialization (wasi-libc ctors, Yoga static init).
  if (typeof exports._initialize === "function") exports._initialize()

  const memory = exports.memory as WebAssembly.Memory
  const u8 = (): Uint8Array => new Uint8Array(memory.buffer)
  const dv = (): DataView => new DataView(memory.buffer)

  const alloc = (size: number): number => {
    if (size === 0) return 0
    const ptr = exports.ot_alloc(size) as number
    if (ptr === 0) throw new Error(`opentui.wasm ot_alloc(${size}) failed (out of memory)`)
    return ptr
  }
  const free = (ptr: number, size: number): void => {
    if (ptr !== 0 && size !== 0) exports.ot_free(ptr, size)
  }
  const writeBytes = (data: Uint8Array): number => {
    const ptr = alloc(data.length)
    u8().set(data, ptr)
    return ptr
  }
  const writeU16 = (values: ArrayLike<number>): number => {
    const ptr = alloc(values.length * 2)
    new Uint16Array(memory.buffer, ptr, values.length).set(values as ArrayLike<number> & Iterable<number>)
    return ptr
  }
  const readBytes = (ptr: number, len: number): Uint8Array => u8().slice(ptr, ptr + len)

  return { exports, memory, alloc, free, writeBytes, writeU16, readBytes, u8, dv }
}
