import assert from 'node:assert/strict'
import {
  searchWeb, fetchPage, extractReadableText, SearchRateLimited, DEFAULT_LIMITS
} from '../../src/main/web.js'

let n = 0
const ok = (m: string): void => { n++; console.log('  ok', m) }
const approxTokens = (s: string): number => Math.ceil(s.length / 4)

/**
 * The engine rate-limits, which is a real condition and not a fault in this
 * code. Search-dependent checks are skipped when it refuses rather than
 * reported as failures; everything not needing the network still runs.
 */
console.log('search returns usable results without an API key')
let results: Awaited<ReturnType<typeof searchWeb>> = []
let searchAvailable = true
try {
  results = await searchWeb('llama.cpp github repository')
} catch (err) {
  if (err instanceof SearchRateLimited) {
    searchAvailable = false
    console.log('   skipped: the search engine is currently rate limiting')
  } else {
    throw err
  }
}
if (searchAvailable) {
results.slice(0, 3).forEach((r) => console.log(`   ${r.title.slice(0, 54)}\n     ${r.url.slice(0, 68)}`))
assert.ok(results.length > 0, 'no results'); ok(`${results.length} results`)
assert.ok(results.every((r) => /^https?:\/\//.test(r.url))); ok('every result has a real address')
assert.ok(!results.some((r) => r.url.includes('duckduckgo.com/l/')))
ok('redirect wrappers unwrapped to the destination')
assert.ok(results.some((r) => /github/i.test(r.url))); ok('results are relevant to the query')
assert.ok(results.length <= DEFAULT_LIMITS.maxResults); ok('capped to the result limit')

const searchTokens = approxTokens(JSON.stringify(results))
console.log(`   whole result set: ~${searchTokens} tokens`)
assert.ok(searchTokens < 900, `search result set too large: ${searchTokens}`)
ok('a whole search costs well under a thousand tokens')
}

if (searchAvailable) {
console.log('\nrepeat queries are served from cache')
const t0 = Date.now()
const again = await searchWeb('llama.cpp github repository')
const elapsed = Date.now() - t0
console.log(`   second identical search took ${elapsed}ms`)
assert.deepEqual(again.map((r) => r.url), results.map((r) => r.url))
ok('same results')
assert.ok(elapsed < 200, `${elapsed}ms — that looks like a real request`)
ok('served without another request, so it costs neither time nor a rate-limit slot')
}

console.log('\nfetching a page returns text, not markup')
const page = await fetchPage('https://news.ycombinator.com')
console.log(`   ${page.title} — ${page.bytes} bytes of HTML in, ${page.text.length} chars out`)
assert.ok(!/<script|<div|<\/a>/i.test(page.text)); ok('no markup survives in the text')
assert.ok(page.text.length * 6 < page.bytes); ok(`reduced to a fraction of the source`)
console.log(`   ~${approxTokens(page.text)} tokens, against ~${approxTokens('x'.repeat(page.bytes))} for the raw page`)
assert.ok(approxTokens(page.text) < 2500); ok('a fetched page fits comfortably in a conversation')

console.log('\nlimits are enforced')
const tight = await fetchPage('https://news.ycombinator.com', { ...DEFAULT_LIMITS, pageChars: 500 })
assert.ok(tight.truncated); ok('a page over budget is marked truncated')
assert.ok(tight.text.includes('[cut here')); ok('and says so in the text the model sees')
assert.ok(tight.text.length < 600); ok('the budget is actually applied')

console.log('\nnon-pages are refused rather than dumped into context')
await assert.rejects(() => fetchPage('ftp://example.com/file'), /http and https/)
ok('non-http schemes refused')
await assert.rejects(
  () => fetchPage('https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-256M-Instruct-Q8_0.gguf'),
  /cannot be read as a page|HTTP/
)
ok('a binary download is refused, not read as text')

console.log('\nextraction keeps prose and drops chrome')
const sample = `<html><head><title>T</title><style>.x{}</style></head><body>
<nav>Home About Contact Login Register</nav>
<script>tracking()</script>
<article><h1>The Heading</h1><p>First paragraph of real content here.</p>
<ul><li>point one</li><li>point two</li></ul></article>
<footer>Copyright 2026 All rights reserved</footer></body></html>`
const text = extractReadableText(sample)
console.log('   ' + text.replace(/\n/g, ' / '))
assert.ok(text.includes('First paragraph of real content')); ok('body text kept')
assert.ok(text.includes('point one')); ok('list items kept, with bullets')
assert.ok(!text.includes('tracking')); ok('scripts dropped')
assert.ok(!text.includes('Login')); ok('navigation dropped')
assert.ok(!text.includes('All rights reserved')); ok('footer dropped')

console.log(`\n${n} assertions passed`)
process.exit(0)
