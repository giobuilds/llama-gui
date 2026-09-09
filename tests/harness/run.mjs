#!/usr/bin/env node
/**
 * Bundles and runs the Stage 0 harness, the same way tests/run.mjs bundles a
 * suite: esbuild, the @shared alias, Electron stubbed so the agent modules
 * load under plain node. Arguments pass straight through.
 *
 *   node tests/harness/run.mjs --models qwen25vl-3b --runs 1
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const out = join(here, '..', '.build', 'harness.mjs')

await mkdir(dirname(out), { recursive: true })
await build({
  entryPoints: [join(here, 'run.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  alias: {
    '@shared': join(repo, 'src/shared'),
    electron: join(here, '..', 'stubs/electron.ts')
  },
  logLevel: 'silent'
})

const child = spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit', cwd: repo })
child.on('exit', (code) => process.exit(code ?? 1))
