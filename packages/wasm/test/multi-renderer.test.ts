import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { createWasmRenderLib } from "../src/render-lib.ts"
import { createCliRenderer, TextRenderable } from "@opentui/core"

// SPIKE: two independent renderers ("rooms") must coexist in one process/isolate, each rendering
// its own content correctly. This is the gating requirement for multiplayer (many DOs share a V8
// isolate on Cloudflare). Today's global setRenderLib()/setFfiBackend() model is expected to FAIL
// this — the test pinpoints how.

async function makeRoom(text: string, wasmModule: WebAssembly.Module) {
  const lib = await createWasmRenderLib({ wasmModule })
  const chunks: Uint8Array[] = []
  const stdout = {
    columns: 80,
    rows: 24,
    write: (d: string | Uint8Array, cb?: () => void) => {
      chunks.push(typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d))
      cb?.()
      return true
    },
  }
  const renderer = await createCliRenderer({
    renderLib: lib, // instance-scoped — no global setRenderLib()
    stdin: new Readable({ read() {} }) as never,
    stdout: stdout as never,
    width: 80,
    height: 24,
    remote: true,
    exitOnCtrlC: false,
    exitSignals: [],
    consoleMode: "disabled",
  })
  const label = new TextRenderable(renderer, { content: text })
  renderer.root.add(label)
  const output = () => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))
  return { lib, renderer, label, output, clear: () => (chunks.length = 0) }
}

test("two independent renderers coexist in one process", async () => {
  const wasmModule = await WebAssembly.compile(readFileSync(fileURLToPath(new URL("../opentui.wasm", import.meta.url))))

  const roomA = await makeRoom("ROOM-AAA", wasmModule)
  const roomB = await makeRoom("ROOM-BBB", wasmModule)

  // Each room must be its own lib (instance-scoped), not the shared singleton.
  expect(roomA.lib).not.toBe(roomB.lib)

  // Interleave: render A, then B, then A again — each must emit ONLY its own text.
  await roomA.renderer.renderOnce()
  expect(roomA.output()).toContain("ROOM-AAA")

  await roomB.renderer.renderOnce()
  expect(roomB.output()).toContain("ROOM-BBB")

  // A must still render correctly after B was built + rendered. Append to A's content; diff-based
  // rendering emits only the changed tail ("-v2"), proving A's renderer kept its OWN prior frame
  // ("ROOM-AAA") and backend intact — no corruption from B having rendered in between.
  roomA.clear()
  roomA.label.content = "ROOM-AAA-v2"
  await roomA.renderer.renderOnce()
  expect(roomA.output()).toContain("-v2") // A's own incremental change rendered
  expect(roomA.output()).not.toContain("BBB") // and no contamination from B's backend

  roomA.renderer.destroy()
  roomB.renderer.destroy()
})
