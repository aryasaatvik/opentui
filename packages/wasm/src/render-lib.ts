// createWasmRenderLib — wires the wasm module into @opentui/core's RenderLib seam so that
// `createCliRenderer({ renderLib })` drives the renderer through WebAssembly. Each call builds a
// fresh, self-contained RenderLib over its OWN wasm backend (not the global singleton), so multiple
// renderers — one per Durable Object room — coexist in a single isolate.
import { setFfiBackend, createRenderLib, type RenderLib } from "@opentui/core"
import { createWasmRuntime, type WasmRuntimeOptions } from "./runtime.js"
import { createWasmBackend } from "./backend.js"

export async function createWasmRenderLib(options: WasmRuntimeOptions): Promise<RenderLib> {
  const wasm = createWasmBackend()
  const runtime = await createWasmRuntime({ ...options, env: wasm.env })
  wasm.setRuntime(runtime)

  // Make this wasm backend active, then build a fresh RenderLib over it. The lib captures this
  // backend and re-activates it before every call (see FFIRenderLib.activate), so a later room's
  // createWasmRenderLib() no longer corrupts this one through the global FFI backend.
  setFfiBackend(wasm.backend as Parameters<typeof setFfiBackend>[0], { wasm: true })
  return createRenderLib("wasm") // "wasm" path is a marker; the backend ignores it
}
