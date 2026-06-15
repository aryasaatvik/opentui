import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createWasmRuntime } from "../src/index.js"

const WASM_PATH = fileURLToPath(new URL("../opentui.wasm", import.meta.url))

// One-frame smoke: drive the wasm renderer through a NativeSpanFeed and assert it
// produces ANSI bytes containing the text we drew. Proves the full render path
// (createRenderer → bufferDrawText → render → feed drain) works in a plain JS engine (≈ workerd).
test("opentui.wasm renders one frame to ANSI bytes through a NativeSpanFeed", async () => {
  const wasmModule = await WebAssembly.compile(readFileSync(WASM_PATH))
  const rt = await createWasmRuntime({ wasmModule })
  const x = rt.exports

  const feed = x.createNativeSpanFeed(0) // null options → defaults
  expect(feed).not.toBe(0)
  x.attachNativeSpanFeed(feed)

  const renderer = x.createRenderer(80, 24, 0, 2, feed) // remote mode, feed output
  expect(renderer).not.toBe(0)

  // Draw "hello" at (0,0) in white.
  const buffer = x.getNextBuffer(renderer)
  expect(buffer).not.toBe(0)
  const text = new TextEncoder().encode("hello")
  const textPtr = rt.writeBytes(text)
  const fgPtr = rt.writeU16([65535, 65535, 65535, 65535]) // RGBA u16 white
  x.bufferDrawText(buffer, textPtr, text.length, 0, 0, fgPtr, 0, 0)

  const status = x.render(renderer, true)
  expect(status).not.toBe(2) // 0=rendered, 1=skipped(backpressure), 2=failed

  // Drain ANSI spans from the feed (SpanInfo is 20 bytes: chunk_ptr,offset,len,chunk_index,reserved).
  const MAX_SPANS = 128
  const SPAN_SIZE = 24 // SpanInfo: u64 chunk_ptr + 4×u32
  const outPtr = rt.alloc(MAX_SPANS * SPAN_SIZE)
  const count = x.streamDrainSpans(feed, outPtr, MAX_SPANS)
  expect(count).toBeGreaterThan(0)

  const dv = rt.dv()
  const chunks: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const base = outPtr + i * SPAN_SIZE
    const chunkPtr = dv.getUint32(base, true) // low 32 bits of u64 chunk_ptr
    const offset = dv.getUint32(base + 8, true)
    const len = dv.getUint32(base + 12, true)
    chunks.push(rt.readBytes(chunkPtr + offset, len))
  }
  rt.free(outPtr, MAX_SPANS * SPAN_SIZE)
  rt.free(textPtr, text.length)
  rt.free(fgPtr, 8)

  const ansi = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    ansi.set(c, o)
    o += c.length
  }
  expect(ansi.length).toBeGreaterThan(0)

  const out = new TextDecoder().decode(ansi)
  expect(out).toContain("hello") // the drawn text appears in the rendered frame
  expect(out).toContain("\x1b[") // ANSI escape sequences present

  x.destroyRenderer(renderer)
})
