import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore, conversationSchema } from '../../src/main/conversations.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const dir = await mkdtemp(join(tmpdir(), 'chat-tools-'))
const store = new ConversationStore(dir)

// Which tools a chat may call used to live only in renderer memory, so it was
// lost on every reload and every restart. It belongs to the conversation.
console.log('a conversation carries its tools')
const fresh = await store.create()
assert.deepEqual(fresh.tools, []); ok('a new chat starts with none enabled')

const withTools = await store.save({ ...fresh, tools: ['web_search'] })
assert.deepEqual(withTools.tools, ['web_search']); ok('switching one on is saved')

const reopened = await store.get(fresh.id)
assert.deepEqual(reopened?.tools, ['web_search']); ok('and is still there when the chat is reopened')

const onDisk = JSON.parse(await readFile(join(dir, `${fresh.id}.json`), 'utf8'))
assert.deepEqual(onDisk.tools, ['web_search']); ok('because it is written to the file, not held in memory')

const off = await store.save({ ...withTools, tools: [] })
assert.deepEqual(off.tools, []); ok('switching it off is saved too')

console.log('\na new chat inherits what the last one used')
const inheriting = await store.create('', ['web_search', 'fetch_page'])
assert.deepEqual(inheriting.tools, ['web_search', 'fetch_page']); ok('so the choice is not made twice')

console.log('\nconversations written before this existed still load')
const legacy = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'From an older version',
  createdAt: 1, updatedAt: 2,
  systemPrompt: '', messages: [],
  settings: { temperature: 0.7, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: 1024 }
}
await writeFile(join(dir, `${legacy.id}.json`), JSON.stringify(legacy))
const upgraded = await store.get(legacy.id)
assert.deepEqual(upgraded?.tools, []); ok('a file with no tools field reads as none enabled')

console.log('\nthe field is validated like everything else that crosses IPC')
assert.throws(() => conversationSchema.parse({ ...legacy, tools: 'web_search' }))
ok('a string where a list belongs is refused')
assert.throws(() => conversationSchema.parse({ ...legacy, tools: [{ name: 'x' }] }))
ok('so is a list of anything but names')

await rm(dir, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
