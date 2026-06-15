// Side-effect module: must be imported BEFORE `bun-ffi-structs` so it runs first.
//
// bun-ffi-structs derives its pointer width from `process.arch` at import time
// (`x64`/`arm64` → 8 bytes, anything else → 4) and bakes it into every struct's
// layout. Cloudflare Workers (workerd) leave `process.arch` undefined, which would
// yield a 4-byte layout — but the OpenTUI wasm module exposes its FFI structs with
// 8-byte (u64) pointer/length fields at the boundary. Force an 8-byte arch when the
// runtime doesn't report one so the TS struct layout matches the wasm module.
//
// No-op on Node/Bun, which already report a real 64-bit arch.
const proc = (globalThis as { process?: { arch?: string } }).process
if (proc && proc.arch !== "x64" && proc.arch !== "arm64") {
  try {
    proc.arch = "x64"
  } catch {
    // Runtime doesn't allow writing process.arch; struct pointer width may be wrong.
  }
}
