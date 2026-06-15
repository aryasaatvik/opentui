// Runtime-agnostic asset loader for the tree-sitter parser worker. In a native runtime (Bun/Node)
// it reads bundled assets off disk and caches downloads; in a browser it fetches URLs (no fs, no
// disk cache). Node modules are imported lazily so a browser bundle never statically pulls in `fs`.

export interface DownloadResult {
  content?: Uint8Array
  filePath?: string
  error?: string
}

interface NodeApis {
  fs: typeof import("node:fs/promises")
  path: typeof import("node:path")
  fileURLToPath: (url: string | URL) => string
}

let _nodeApis: NodeApis | null | undefined

// Resolve Node's fs/path/url lazily; returns null in runtimes without them (browser).
async function nodeApis(): Promise<NodeApis | null> {
  if (_nodeApis !== undefined) return _nodeApis
  try {
    const [fs, path, url] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:url"),
    ])
    _nodeApis = { fs, path, fileURLToPath: url.fileURLToPath }
  } catch {
    _nodeApis = null
  }
  return _nodeApis
}

export class DownloadUtils {
  private static hashUrl(url: string): string {
    let hash = 0
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * Load a bundled asset (file:// URL or path) off disk, or download/fetch an http(s) URL. On native
   * runtimes http downloads are cached to disk; in a browser there is no cache and local paths are
   * unsupported (assets are always http(s) URLs there).
   */
  static async downloadOrLoad(
    source: string,
    cacheDir: string,
    cacheSubdir: string,
    fileExtension: string,
    useHashForCache: boolean = true,
    filetype?: string,
  ): Promise<DownloadResult> {
    const node = await nodeApis()

    // Bundled assets resolve to file:// URLs in native runtimes (new URL(rel, import.meta.url)).
    if (source.startsWith("file://")) {
      if (!node) return { error: `Cannot read file:// URL without fs: ${source}` }
      source = node.fileURLToPath(source)
    }

    const isUrl = source.startsWith("http://") || source.startsWith("https://")

    if (isUrl) {
      let cacheFile: string | undefined
      if (node) {
        const cacheFileName = useHashForCache
          ? filetype
            ? `${filetype}-${this.hashUrl(source)}${fileExtension}`
            : `${this.hashUrl(source)}${fileExtension}`
          : node.path.basename(source)
        cacheFile = node.path.join(cacheDir, cacheSubdir, cacheFileName)
        await node.fs.mkdir(node.path.dirname(cacheFile), { recursive: true })
        try {
          const cached = await node.fs.readFile(cacheFile)
          if (cached.byteLength > 0) return { content: cached, filePath: cacheFile }
        } catch {
          // cache miss — fetch below
        }
      }

      try {
        const response = await fetch(source)
        if (!response.ok) {
          return { error: `Failed to fetch from ${source}: ${response.statusText}` }
        }
        const content = new Uint8Array(await response.arrayBuffer())
        if (node && cacheFile) {
          try {
            await node.fs.writeFile(cacheFile, content)
          } catch {
            // caching is best-effort
          }
        }
        return { content, filePath: cacheFile }
      } catch (error) {
        return { error: `Error downloading from ${source}: ${error}` }
      }
    }

    // Local filesystem path (native only).
    if (!node) return { error: `Cannot read local path without fs: ${source}` }
    try {
      const content = await node.fs.readFile(source)
      return { content, filePath: source }
    } catch (error) {
      return { error: `Error loading from local path ${source}: ${error}` }
    }
  }

  /**
   * Download/copy a file to a specific target path (native build tooling only).
   */
  static async downloadToPath(source: string, targetPath: string): Promise<DownloadResult> {
    const node = await nodeApis()
    if (!node) return { error: "downloadToPath requires a filesystem" }
    const isUrl = source.startsWith("http://") || source.startsWith("https://")

    await node.fs.mkdir(node.path.dirname(targetPath), { recursive: true })

    if (isUrl) {
      try {
        const response = await fetch(source)
        if (!response.ok) {
          return { error: `Failed to fetch from ${source}: ${response.statusText}` }
        }
        const content = new Uint8Array(await response.arrayBuffer())
        await node.fs.writeFile(targetPath, content)
        return { content, filePath: targetPath }
      } catch (error) {
        return { error: `Error downloading from ${source}: ${error}` }
      }
    }

    try {
      const content = await node.fs.readFile(source)
      await node.fs.writeFile(targetPath, content)
      return { content: new Uint8Array(content), filePath: targetPath }
    } catch (error) {
      return { error: `Error copying from local path ${source}: ${error}` }
    }
  }

  /**
   * Fetch multiple highlight queries and concatenate them
   */
  static async fetchHighlightQueries(sources: string[], cacheDir: string, filetype: string): Promise<string> {
    const queryPromises = sources.map((source) => this.fetchHighlightQuery(source, cacheDir, filetype))
    const queryResults = await Promise.all(queryPromises)

    const validQueries = queryResults.filter((query) => query.trim().length > 0)
    return validQueries.join("\n")
  }

  private static async fetchHighlightQuery(source: string, cacheDir: string, filetype: string): Promise<string> {
    const result = await this.downloadOrLoad(source, cacheDir, "queries", ".scm", true, filetype)

    if (result.error) {
      console.error(`Error fetching highlight query from ${source}:`, result.error)
      return ""
    }

    if (result.content) {
      return new TextDecoder().decode(result.content)
    }

    return ""
  }
}
