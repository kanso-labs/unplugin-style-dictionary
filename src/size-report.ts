import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { paint } from './colour.js'

// The size-and-gzip table, in a function of its own so that the compile
// `try` in `runBuilds` can stop before it. Everything here is presentation
// over files Style Dictionary has already finished writing, so a throw from
// it is a reporting bug and nothing more.
//
// `root` and whether stdout takes colour belong to the plugin instance, so
// they are handed in rather than held.
export function reportSizes(
  { root, stdoutColour }: { root: string; stdoutColour: boolean },
  generatedFiles: Set<string>,
): void {
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
      // The table goes to stdout, so it follows stdout's decision — which
      // is not always stderr's, since the two are redirected separately.
      const coloredPath =
        dir === '.'
          ? paint('32', base, stdoutColour)
          : paint('90', `${dir}/`, stdoutColour) +
            paint('32', base, stdoutColour)

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
      console.log(
        info.coloredPath +
          pathPadding +
          paint(
            '90',
            `${sizePadded} │ gzip: ${info.gzipSizeStr}`,
            stdoutColour,
          ),
      )
    }
  }
}
