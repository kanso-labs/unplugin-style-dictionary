import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { vitePluginStyleDictionary } from '../src/index.ts'

describe('vitePluginStyleDictionary', () => {
  const tempDir = path.resolve('temp-test-tokens')
  const configFile = path.join(tempDir, 'sd.config.json')
  const tokenFile = path.join(tempDir, 'tokens.json')
  const outputFile = path.join(tempDir, 'vars.css')

  beforeEach(() => {
    // Setup mock directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // Write token file
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        color: {
          primary: {
            value: '#0070f3',
          },
        },
      }),
    )

    // Write Style Dictionary config file
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        platforms: {
          css: {
            buildPath: tempDir.replace(/\\/g, '/') + '/',
            files: [
              {
                destination: 'vars.css',
                format: 'css/variables',
              },
            ],
            transformGroup: 'css',
          },
        },
        source: [tokenFile.replace(/\\/g, '/')],
      }),
    )
  })

  afterEach(() => {
    // Cleanup files
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile)
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile)
    if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile)
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('compiles design tokens during buildStart', async () => {
    const plugin = vitePluginStyleDictionary({
      config: configFile,
      silent: true,
    })

    // Simulate configResolved hook
    if (plugin.configResolved) {
      await (
        plugin.configResolved as (
          config: Record<string, unknown>,
        ) => Promise<void> | void
      )({ root: process.cwd() })
    }

    // Simulate buildStart hook
    if (plugin.buildStart) {
      await (plugin.buildStart as () => Promise<void> | void)()
    }

    // Verify output file was created and contains the correct CSS variable
    expect(fs.existsSync(outputFile)).toBe(true)
    const content = fs.readFileSync(outputFile, 'utf-8')
    expect(content).toContain('--color-primary: #0070f3;')
  })
})
