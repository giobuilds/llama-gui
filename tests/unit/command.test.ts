import assert from 'node:assert/strict'
import { splitCommand, slug } from '@shared/command.js'
import { mcpServersSchema } from '@shared/schema.js'

let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('  ok', name) }

console.log('splitCommand')
t('splits on whitespace', () => {
  assert.deepEqual(splitCommand('npx -y @modelcontextprotocol/server-everything'), [
    'npx', '-y', '@modelcontextprotocol/server-everything'
  ])
})
t('keeps a quoted path with spaces as one argument', () => {
  assert.deepEqual(splitCommand('npx server-filesystem "/home/me/My Notes"'), [
    'npx', 'server-filesystem', '/home/me/My Notes'
  ])
})
t('accepts single quotes too', () => {
  assert.deepEqual(splitCommand("cmd '/a b/c'"), ['cmd', '/a b/c'])
})
t('collapses runs of spaces', () => {
  assert.deepEqual(splitCommand('  cmd   arg  '), ['cmd', 'arg'])
})
t('an empty line yields no argv', () => {
  assert.deepEqual(splitCommand('   '), [])
})

console.log('slug')
t('lower-cases and hyphenates', () => {
  assert.equal(slug('My Notes'), 'my-notes')
})
t('drops punctuation the model might retokenise', () => {
  assert.equal(slug('files (local)!'), 'files-local')
})
t('never ends in a hyphen, even when the length cap cuts one', () => {
  const long = slug('aaaaaaaaaaaaaaaaaaaaaaa bbb')
  assert.ok(!long.endsWith('-'), long)
  assert.ok(long.length <= 24)
})
t('a name with nothing usable in it produces no id', () => {
  assert.equal(slug('***'), '')
})

// Tool names are routed by their `id__` prefix, so an id containing the
// separator would make routing ambiguous.
console.log('ids stay routable')
t('slugs never contain the tool-name separator', () => {
  for (const name of ['a__b', 'x _ _ y', 'Under__Score']) {
    assert.ok(!slug(name).includes('__'), name + ' -> ' + slug(name))
  }
})

console.log('mcpServersSchema')
t('accepts a well-formed server', () => {
  const parsed = mcpServersSchema.parse([
    { id: 'notes', name: 'Notes', command: 'npx', args: ['-y', 'pkg'], enabled: true }
  ])
  assert.equal(parsed[0]!.command, 'npx')
})
t('rejects a server with no command', () => {
  assert.throws(() =>
    mcpServersSchema.parse([{ id: 'notes', name: 'Notes', command: '', args: [], enabled: true }])
  )
})

console.log(`\n${pass} assertions passed`)
