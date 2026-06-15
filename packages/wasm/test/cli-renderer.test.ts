import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { createWasmRenderLib } from "../src/render-lib.ts"
import { setRenderLib, createCliRenderer, TextRenderable } from "@opentui/core"

// Integration: drive the FULL CliRenderer through the wasm RenderLib (not the direct-draw path).
test("createCliRenderer() renders a frame through the wasm RenderLib", async () => {
  const wasmModule = await WebAssembly.compile(readFileSync(fileURLToPath(new URL("../opentui.wasm", import.meta.url))))
  const lib = await createWasmRenderLib({ wasmModule })
  setRenderLib(lib)

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
  const stdin = new Readable({ read() {} }) // never emits

  const renderer = await createCliRenderer({
    stdin: stdin as any,
    stdout: stdout as any,
    width: 80,
    height: 24,
    remote: true,
    exitOnCtrlC: false,
    exitSignals: [],
    consoleMode: "disabled",
  })

  const text = new TextRenderable(renderer, { content: "Hello from OpenTUI WASM" })
  renderer.root.add(text)

  renderer.start()
  renderer.requestRender()
  await new Promise((r) => setTimeout(r, 200))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const m = new Uint8Array(acc.length + c.length)
      m.set(acc)
      m.set(c, acc.length)
      return m
    }, new Uint8Array(0)),
  )
  console.log(`stdout bytes: ${total}; has ANSI: ${out.includes("\x1b[")}; has text: ${out.includes("Hello from OpenTUI WASM")}`)
  expect(total).toBeGreaterThan(0)
  expect(out).toContain("\x1b[")
  expect(out).toContain("Hello from OpenTUI WASM") // text laid out by Yoga + rendered, all over wasm

  // getTerminalCapabilities reads char* term name/version from linear memory (u64 ptr + len) via the
  // swappable toArrayBuffer — exercises the wasm caps path that bun-ffi-structs' baked toArrayBuffer can't.
  const internals = renderer as unknown as { lib: typeof lib; rendererPtr: number }
  internals.lib.processCapabilityResponse(internals.rendererPtr, "\x1bP>|ghostty 1.1.3\x1b\\")
  const caps = internals.lib.getTerminalCapabilities(internals.rendererPtr)
  expect(caps.terminal.name).toBe("ghostty")
  expect(caps.terminal.version).toBe("1.1.3")
  expect(caps.terminal.from_xtversion).toBe(true)
  expect(typeof caps.rgb).toBe("boolean")

  renderer.destroy()
})
