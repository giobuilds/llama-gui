import assert from 'node:assert/strict'
import { McpServer } from '../../src/main/mcp.js'
import type { McpServerState } from '@shared/types.js'

let n = 0
const ok = (m: string): void => { n++; console.log('  ok', m) }
const waitFor = (s: McpServer, want: McpServerState['status'], ms = 90_000): Promise<McpServerState> =>
  new Promise((resolve, reject) => {
    if (s.state.status === want) return resolve(s.state)
    const timer = setTimeout(() => reject(new Error(`stuck in ${s.state.status}`)), ms)
    const on = (state: McpServerState): void => {
      if (state.status === want || state.status === 'failed') {
        clearTimeout(timer); s.off('state', on); resolve(state)
      }
    }
    s.on('state', on)
  })

console.log('talking to a real MCP server (@modelcontextprotocol/server-everything)')
const server = new McpServer({
  id: 'everything',
  name: 'Everything',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything', 'stdio'],
  enabled: true
})
void server.start()
const ready = await waitFor(server, 'ready')
assert.equal(ready.status, 'ready', ready.error ?? '')
ok(`handshake completed with ${ready.serverName ?? 'the server'}`)
console.log(`   ${ready.tools.length} tools:`, ready.tools.map((t) => t.label).slice(0, 8).join(', '))
assert.ok(ready.tools.length > 0); ok('tools discovered')
assert.ok(ready.tools.every((t) => t.name.startsWith('everything__')))
ok('tool names namespaced by server, so two servers cannot collide')
assert.ok(ready.tools.every((t) => t.parameters.type === 'object'))
ok('schemas converted to the shape the chat API accepts')

/** Whether any process in a group survives. */
function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

console.log('\ncalling one')
const echo = ready.tools.find((t) => /echo/i.test(t.label))
assert.ok(echo, 'no echo tool to try')
const result = await server.call(echo!.name, { message: 'hello from Lowerbeam' })
console.log('  ', result.summary, '->', result.content.slice(0, 70))
assert.equal(result.ok, true); ok('the call succeeded')
assert.ok(result.content.includes('hello from Lowerbeam')); ok('and returned what it was given')

console.log('\nfailures are returned, not thrown')
const bogus = await server.call('everything__no_such_tool', {})
assert.equal(bogus.ok, false); ok(`an unknown tool reports failure: ${JSON.stringify(bogus.content.slice(0, 48))}`)

console.log('\nstopping')
// Servers are spawned detached, so nothing reaps them if stop() misses: check
// the whole process group is gone, not just that the status flipped.
const group = server.pid
assert.ok(group, 'no pid to watch')
server.stop()
assert.equal(server.state.status, 'stopped'); ok('stops cleanly')
await new Promise((r) => setTimeout(r, 3000))
assert.equal(alive(group!), false); ok('and takes its process group with it')
const afterStop = await server.call(echo!.name, {})
assert.equal(afterStop.ok, false); ok('calls after stopping are refused rather than hanging')

console.log('\na command that does not exist fails with a reason')
const broken = new McpServer({
  id: 'broken', name: 'Broken', command: 'definitely-not-a-real-command-xyz', args: [], enabled: true
})
void broken.start()
const failed = await waitFor(broken, 'failed', 20_000)
assert.equal(failed.status, 'failed'); ok(`reports why: ${JSON.stringify((failed.error ?? '').slice(0, 44))}`)
broken.stop()

console.log(`\n${n} assertions passed`)
process.exit(0)
