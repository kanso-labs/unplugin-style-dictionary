import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { paint } from './colour.js'

// The size-and-gzip table's lines, in a function of its own so that the
// compile `try` in `runBuilds` can stop before it. Everything here is
// presentation over files Style Dictionary has already finished writing, so a
// throw from it is a reporting bug and nothing more.
//
// It returns the lines rather than printing them, because where they go is
// the instance's to decide: a host's `info` channel where one exists, stdout
// otherwise. `colour` says whether to paint them, which only stdout ever asks
// for — a host renders its own output.
export function sizeTable(
  { colour, root }: { colour: boolean; root: string },
  generatedFiles: Set<string>,
): string[] {
  const fileInfos: Array<{
    coloredPath: string
    gzipSizeStr: string
    relativeDisplayPath: string
    sizeStr: string
  }> = []

  for (const filePath of generatedFiles) {
    if (fs.existsSync(filePath)) {
      const displayPath = path.relative(root, filePath).replace(/\\/g, '/')
      const dir = path.dirname(displayPath)
      const base = path.basename(displayPath)
      const coloredPath =
        dir === '.'
          ? paint('32', base, colour)
          : paint('90', `${dir}/`, colour) + paint('32', base, colour)

      try {
        const stats = fs.statSync(filePath)
        const bytes = stats.size
        const sizeStr = `${(bytes / 1024).toFixed(2)} kB`

        const content = fs.readFileSync(filePath)
        const gzipBytes = zlib.gzipSync(content).length
        const gzipSizeStr = `${(gzipBytes / 1024).toFixed(2)} kB`

        fileInfos.push({
          coloredPath,
          gzipSizeStr,
          relativeDisplayPath: displayPath,
          sizeStr,
        })
      } catch {
        // One unreadable destination costs its row rather than the table.
        // Deliberately narrower than the caller's `catch`: it covers the
        // three filesystem and gzip calls above and not the arithmetic
        // below, so a padding bug is reported rather than quietly printing
        // short.
      }
    }
  }

  const lines: string[] = []

  if (fileInfos.length > 0) {
    const longestPathLength = Math.max(
      ...fileInfos.map((f) => f.relativeDisplayPath.length),
      0,
    )
    const longestSizeLength = Math.max(
      ...fileInfos.map((f) => f.sizeStr.length),
      0,
    )

    for (const info of fileInfos) {
      const pathPadding = ' '.repeat(
        Math.max(2, longestPathLength - info.relativeDisplayPath.length + 2),
      )
      const sizePadded = info.sizeStr.padStart(longestSizeLength)
      lines.push(
        info.coloredPath +
          pathPadding +
          paint('90', `${sizePadded} │ gzip: ${info.gzipSizeStr}`, colour),
      )
    }
  }

  return lines
}
