import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ToolDefinition } from '@shared/types.js'
import type { AgentToolResult } from '@shared/coding.js'
import { Grant } from './grant.js'

/**
 * The three tools a read-only run gets: list, search, read.
 *
 * Each is bounded on purpose. A model that can ask for a whole file will, and
 * a 4,000-line file is the context window gone in one call. Full output is
 * never the model's to have; it gets an excerpt and can ask for the next one.
 *
 * Every path goes through the grant. A refusal is reported as a refusal — the
 * model is told it asked for something outside the project — and recorded as
 * one, because how often a model reaches outside is a measurement.
 */

const LIST_MAX = 200
const SEARCH_MAX_HITS = 30
const SEARCH_MAX_FILES = 5000
const SEARCH_MAX_FILE_BYTES = 512 * 1024
const SEARCH_EXCERPT_CHARS = 200
const READ_MAX_LINES = 200
const READ_MAX_BYTES = 16 * 1024

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    label: 'List files',
    description:
      'List the entries in a directory of the project. Start at "." and narrow ' +
      'from there. Returns at most 200 entries.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory, relative to the project root. Defaults to ".".' }
      }
    }
  },
  {
    name: 'search',
    label: 'Search',
    description:
      'Find lines containing a phrase anywhere in the project (case-insensitive, ' +
      'not a regex). Returns up to 30 hits as path:line with a short excerpt. ' +
      'Use it to locate code before reading a file.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to look for.' },
        path: { type: 'string', description: 'Restrict to this directory. Defaults to the whole project.' }
      },
      required: ['query']
    }
  },
  {
    name: 'read',
    label: 'Read a file',
    description:
      'Read part of a file: at most 200 lines or 16 KB per call. Give a start ' +
      'line to read further into a long file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File, relative to the project root.' },
        start: { type: 'integer', description: '1-based first line. Defaults to 1.' },
        end: { type: 'integer', description: '1-based last line. At most 200 lines after start.' }
      },
      required: ['path']
    }
  }
]

export async function runAgentTool(
  grant: Grant,
  name: string,
  args: Record<string, unknown>
): Promise<AgentToolResult> {
  switch (name) {
    case 'list_files':
      return listFiles(grant, str(args.path) || '.')
    case 'search':
      return search(grant, str(args.query), str(args.path) || '.')
    case 'read':
      return read(grant, str(args.path), int(args.start), int(args.end))
    default:
      // Unknown tools fail closed: nothing is guessed at.
      return { ok: false, content: `There is no tool called ${name}.` }
  }
}

async function listFiles(grant: Grant, dir: string): Promise<AgentToolResult> {
  const resolved = await grant.resolve(dir)
  if (!resolved.ok) return refusal(resolved)
  let entries
  try {
    entries = await readdir(resolved.path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, content: `Could not list ${dir}: ${(err as Error).message}` }
  }
  const visible = entries.filter((e) => Grant.visible(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  const lines = visible.slice(0, LIST_MAX).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  const more = visible.length > LIST_MAX ? `\n… and ${visible.length - LIST_MAX} more` : ''
  return { ok: true, content: `${resolved.relative}:\n${lines.join('\n')}${more}` }
}

async function search(grant: Grant, query: string, dir: string): Promise<AgentToolResult> {
  if (!query.trim()) return { ok: false, content: 'Give something to search for.' }
  const resolved = await grant.resolve(dir)
  if (!resolved.ok) return refusal(resolved)

  const needle = query.toLowerCase()
  const hits: string[] = []
  let scanned = 0

  const walk = async (abs: string): Promise<void> => {
    if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) return
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!Grant.visible(e.name)) continue
      const child = join(abs, e.name)
      if (e.isDirectory()) {
        await walk(child)
      } else if (e.isFile()) {
        scanned += 1
        await scanFile(child)
      }
      if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) return
    }
  }

  const scanFile = async (abs: string): Promise<void> => {
    let info
    try {
      info = await stat(abs)
    } catch {
      return
    }
    if (info.size > SEARCH_MAX_FILE_BYTES) return
    const text = await readText(abs)
    if (text === null) return
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_HITS; i++) {
      const line = lines[i]!
      if (!line.toLowerCase().includes(needle)) continue
      const rel = relative(grant.realRoot, abs).split(sep).join('/')
      hits.push(`${rel}:${i + 1}: ${excerpt(line)}`)
    }
  }

  await walk(resolved.path)
  if (hits.length === 0) return { ok: true, content: `No lines contain "${query}".` }
  const capped = hits.length >= SEARCH_MAX_HITS ? `\n(first ${SEARCH_MAX_HITS} hits; narrow the search for more)` : ''
  return { ok: true, content: hits.join('\n') + capped }
}

async function read(
  grant: Grant,
  path: string,
  start: number | null,
  end: number | null
): Promise<AgentToolResult> {
  if (!path) return { ok: false, content: 'Give a path to read.' }
  const resolved = await grant.resolve(path)
  if (!resolved.ok) return refusal(resolved)
  const text = await readText(resolved.path)
  if (text === null) return { ok: false, content: `${resolved.relative} is not a text file.` }

  const lines = text.split('\n')
  const first = Math.max(1, start ?? 1)
  const last = Math.min(lines.length, end ?? first + READ_MAX_LINES - 1, first + READ_MAX_LINES - 1)
  if (first > lines.length) {
    return { ok: false, content: `${resolved.relative} has only ${lines.length} lines.` }
  }

  // Number the lines, so what the model cites can be checked against the file.
  const width = String(last).length
  const out: string[] = []
  let bytes = 0
  let shown = first - 1
  for (let i = first - 1; i < last; i++) {
    const line = `${String(i + 1).padStart(width)}| ${lines[i]}`
    bytes += line.length + 1
    if (bytes > READ_MAX_BYTES) break
    out.push(line)
    shown = i + 1
  }
  const tail =
    shown < lines.length ? `\n(lines ${shown + 1}–${lines.length} not shown; read from ${shown + 1} for more)` : ''
  return { ok: true, content: `${resolved.relative} (${lines.length} lines)\n${out.join('\n')}${tail}` }
}

function refusal(r: { denied: boolean; reason: string }): AgentToolResult {
  return { ok: false, denied: r.denied, content: r.reason }
}

/** Text, or null for anything that looks binary. */
async function readText(abs: string): Promise<string | null> {
  let handle
  try {
    handle = await open(abs, 'r')
    const probe = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    if (probe.subarray(0, bytesRead).includes(0)) return null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > SEARCH_EXCERPT_CHARS ? trimmed.slice(0, SEARCH_EXCERPT_CHARS) + '…' : trimmed
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null
}
