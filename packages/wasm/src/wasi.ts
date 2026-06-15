// Minimal WASI `reactor` shim for the OpenTUI wasm module.
//
// `opentui.wasm` is built `wasm32-wasi` (wasi-libc provides malloc/STL for Yoga), but the
// renderer's happy path never performs real filesystem / clock / process I/O — the 16 WASI
// imports are only touched by libc init and diagnostic paths (Yoga AssertFatal/Log → stderr).
// This shim provides just enough correct behavior to initialize and run. It does NOT grant any
// real host access, which is exactly what we want inside a Cloudflare Worker.
//
// The one correctness landmine: `fd_prestat_get` MUST return EBADF to terminate wasi-libc's
// preopen scan. Returning success makes libc chase a non-existent preopened directory and trap.

const WASI_ESUCCESS = 0
const WASI_EBADF = 8

export interface WasiShim {
  /** The import namespace to pass as `wasi_snapshot_preview1`. */
  readonly imports: WebAssembly.ModuleImports
  /** Bind the instantiated instance so the shim can reach its exported memory. */
  bind(instance: WebAssembly.Instance): void
}

export function createWasiShim(): WasiShim {
  let instance: WebAssembly.Instance | null = null
  const memory = (): WebAssembly.Memory => instance!.exports.memory as WebAssembly.Memory
  const dv = (): DataView => new DataView(memory().buffer)
  const u8 = (): Uint8Array => new Uint8Array(memory().buffer)

  const imports: WebAssembly.ModuleImports = {
    environ_sizes_get(countPtr: number, sizePtr: number): number {
      const d = dv()
      d.setUint32(countPtr, 0, true)
      d.setUint32(sizePtr, 0, true)
      return WASI_ESUCCESS
    },
    environ_get(): number {
      return WASI_ESUCCESS
    },
    // EBADF ends wasi-libc's preopen scan — do not return success here.
    fd_prestat_get(): number {
      return WASI_EBADF
    },
    fd_prestat_dir_name(): number {
      return WASI_EBADF
    },
    fd_fdstat_get(_fd: number, buf: number): number {
      const d = dv()
      d.setUint8(buf, 2) // filetype: character device
      d.setUint8(buf + 1, 0)
      d.setUint16(buf + 2, 0, true)
      d.setBigUint64(buf + 8, 0xffffffffffffffffn, true) // rights_base
      d.setBigUint64(buf + 16, 0xffffffffffffffffn, true) // rights_inheriting
      return WASI_ESUCCESS
    },
    fd_filestat_get(): number {
      return WASI_EBADF
    },
    fd_close(): number {
      return WASI_ESUCCESS
    },
    fd_seek(): number {
      return WASI_ESUCCESS
    },
    fd_read(_fd: number, _iovs: number, _iovsLen: number, nreadPtr: number): number {
      dv().setUint32(nreadPtr, 0, true) // EOF
      return WASI_ESUCCESS
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwrittenPtr: number): number {
      const d = dv()
      const bytes = u8()
      let total = 0
      let text = ""
      for (let i = 0; i < iovsLen; i++) {
        const p = iovs + i * 8
        const ptr = d.getUint32(p, true)
        const len = d.getUint32(p + 4, true)
        total += len
        if (fd === 1 || fd === 2) text += new TextDecoder().decode(bytes.subarray(ptr, ptr + len))
      }
      // Surface Yoga/libc diagnostics rather than swallowing them silently.
      if (text.trim().length > 0) console.error(`[opentui.wasm fd${fd}] ${text.trimEnd()}`)
      d.setUint32(nwrittenPtr, total, true)
      return WASI_ESUCCESS
    },
    fd_pwrite(_fd: number, _iovs: number, _iovsLen: number, _offset: bigint, nwrittenPtr: number): number {
      dv().setUint32(nwrittenPtr, 0, true)
      return WASI_ESUCCESS
    },
    path_open(): number {
      return WASI_EBADF
    },
    path_create_directory(): number {
      return WASI_EBADF
    },
    clock_time_get(_id: number, _precision: bigint, timePtr: number): number {
      dv().setBigUint64(timePtr, 0n, true)
      return WASI_ESUCCESS
    },
    poll_oneoff(): number {
      return WASI_ESUCCESS
    },
    proc_exit(code: number): void {
      throw new Error(`opentui.wasm called proc_exit(${code})`)
    },
  }

  return {
    imports,
    bind(inst: WebAssembly.Instance) {
      instance = inst
    },
  }
}
