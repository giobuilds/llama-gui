import assert from 'node:assert/strict'
import { isWebUrl, hostOf } from '@shared/url.js'

let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('  ok', name) }

// This predicate is the gate between a link the model produced and something
// that gets loaded, so what it refuses matters more than what it accepts.
console.log('isWebUrl')
t('accepts http and https', () => {
  assert.equal(isWebUrl('http://example.com/a'), true)
  assert.equal(isWebUrl('https://example.com/a?b=c#d'), true)
})
t('refuses javascript:', () => {
  assert.equal(isWebUrl('javascript:alert(1)'), false)
  assert.equal(isWebUrl('JavaScript:alert(1)'), false)
})
t('refuses file: and other local schemes', () => {
  assert.equal(isWebUrl('file:///etc/passwd'), false)
  assert.equal(isWebUrl('chrome://settings'), false)
  assert.equal(isWebUrl('devtools://devtools/bundled/inspector.html'), false)
})
t('refuses data: and blob:', () => {
  assert.equal(isWebUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isWebUrl('blob:https://example.com/uuid'), false)
})
t('refuses anything unparseable, including a relative path', () => {
  assert.equal(isWebUrl('/models/x.gguf'), false)
  assert.equal(isWebUrl(''), false)
  assert.equal(isWebUrl('not a url at all'), false)
})

console.log('hostOf')
t('gives the host', () => {
  assert.equal(hostOf('https://time.now/utc?x=1'), 'time.now')
})
t('keeps the port, which distinguishes a local service', () => {
  assert.equal(hostOf('http://127.0.0.1:8888/search'), '127.0.0.1:8888')
})
t('falls back to the input rather than throwing', () => {
  assert.equal(hostOf('nonsense'), 'nonsense')
})

console.log(`\n${pass} assertions passed`)
