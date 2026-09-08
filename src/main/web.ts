/**
 * Web access for the model.
 *
 * The governing constraint is context, not bandwidth. Measured on this machine,
 * one page of raw HTML is about 14,000 tokens — roughly 43% of a conversation's
 * whole context — while the same page extracted to text is about 1,300, and its
 * search snippet about 380. So the model is never shown a page: it is shown
 * text, and only when a snippet was not enough.
 *
 * Everything here runs in the main process. The renderer's CSP allows loopback
 * only, which is deliberate, and fetching arbitrary sites from the page that
 * renders model output would be the wrong place for it regardless.
 */

/** A budget in characters, converted to tokens at roughly four characters each. */
export interface WebLimits {
  /** Results returned by a search. */
  maxResults: number
  /** Characters of snippet kept per result. */
  snippetChars: number
  /** Characters of extracted text returned by a page fetch. */
  pageChars: number
  /** Bytes downloaded before giving up, so a huge page cannot stall a reply. */
  maxDownloadBytes: number
  timeoutMs: number
}

export const DEFAULT_LIMITS: WebLimits = {
  maxResults: 5,
  snippetChars: 240,
  pageChars: 6000,
  maxDownloadBytes: 3_000_000,
  timeoutMs: 20_000
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface PageResult {
  url: string
  title: string
  text: string
  /** True when the page was longer than the budget and was cut. */
  truncated: boolean
  bytes: number
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'"
  }
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+|#x?\w+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole)
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Search without an API key, so the feature works out of the box.
 *
 * DuckDuckGo's HTML endpoint is scraped rather than called as an API, which
 * means its markup can change; a failure here returns nothing rather than
 * throwing, so the model is told the search found nothing instead of the reply
 * failing outright.
 */
export class SearchRateLimited extends Error {
  constructor() {
    super('The search engine is rate limiting requests. Wait a few seconds before searching again.')
    this.name = 'SearchRateLimited'
  }
}

/** Identical queries within this window are answered from memory. */
const CACHE_TTL_MS = 10 * 60_000
/** DuckDuckGo starts refusing after roughly two rapid requests. */
const MIN_GAP_MS = 1500

const cache = new Map<string, { at: number; results: SearchResult[] }>()
let lastRequestAt = 0

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Search through a SearXNG instance instead of the default engine.
 *
 * SearXNG aggregates other engines and, on an instance you run yourself,
 * imposes no rate limit — which is the default's real weakness. Most public
 * instances disable this JSON API precisely because it is easy to abuse, so
 * this is worth configuring only if you host one.
 */
export async function searchSearxng(
  instanceUrl: string,
  query: string,
  limits = DEFAULT_LIMITS
): Promise<SearchResult[]> {
  const base = instanceUrl.replace(/\/+$/, '')
  const url = base + '/search?' + new URLSearchParams({ q: query, format: 'json' }).toString()
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(limits.timeoutMs)
  })
  if (!res.ok) throw new Error('The SearXNG instance returned HTTP ' + res.status + '.')

  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    // An instance with the JSON API switched off answers with its search page,
    // which is a configuration problem worth naming rather than a parse error.
    throw new Error('That instance did not return JSON. Enable the json format in its settings.')
  }

  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return (body.results ?? [])
    .filter((r) => typeof r.url === 'string' && /^https?:/i.test(r.url))
    .slice(0, limits.maxResults)
    .map((r) => ({
      title: (r.title ?? '').slice(0, 160),
      url: r.url!,
      snippet: (r.content ?? '').slice(0, limits.snippetChars)
    }))
}

export async function searchWeb(query: string, limits = DEFAULT_LIMITS): Promise<SearchResult[]> {
  const key = query.trim().toLowerCase()
  const hit = cache.get(key)
  // A repeated query costs nothing and, more usefully, does not spend one of
  // the few requests the engine will accept.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results

  // One retry after a pause: the limit is short-lived, and a model that has to
  // rephrase a perfectly good query wastes a whole round doing it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const since = Date.now() - lastRequestAt
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since)
    if (attempt > 0) await delay(2500)
    lastRequestAt = Date.now()

    const results = await searchOnce(query, limits)
    if (results !== null) {
      cache.set(key, { at: Date.now(), results })
      return results
    }
  }
  // Being rate limited is not the same as finding nothing, and saying so lets
  // the model stop rather than rephrase a query that was never the problem.
  throw new SearchRateLimited()
}

/** Returns null when the engine refused, as opposed to an empty result set. */
async function searchOnce(query: string, limits: WebLimits): Promise<SearchResult[] | null> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(limits.timeoutMs)
  })
  if (!res.ok) return null
  const html = await res.text()
  // The refusal page is a short document mentioning an anomaly, with no results.
  if (/anomaly|unusual traffic|captcha/i.test(html) && !html.includes('result__a')) return null

  const results: SearchResult[] = []
  const blocks = html.split(/class="result results_links/).slice(1)
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
    const url = unwrapRedirect(decodeEntities(link[1]!))
    if (!/^https?:\/\//i.test(url)) continue
    results.push({
      title: stripTags(link[2]!).slice(0, 160),
      url,
      snippet: snippet ? stripTags(snippet[1]!).slice(0, limits.snippetChars) : ''
    })
    if (results.length >= limits.maxResults) break
  }
  return results
}

/** DuckDuckGo wraps results in a redirect; the real address is in uddg. */
function unwrapRedirect(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/)
  if (match) return decodeURIComponent(match[1]!)
  return href.startsWith('//') ? `https:${href}` : href
}

/**
 * Fetch one page and reduce it to readable text.
 *
 * Content-bearing elements are preferred when the page marks them, because
 * navigation, headers and footers are most of a modern page's markup and none
 * of its meaning. What is returned is capped, and says so when it was cut —
 * silently truncating leaves the model reasoning about half a document without
 * knowing it.
 */
export async function fetchPage(url: string, limits = DEFAULT_LIMITS): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https addresses can be fetched.')

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9' },
    signal: AbortSignal.timeout(limits.timeoutMs),
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`)

  const type = res.headers.get('content-type') ?? ''
  if (!/text\/html|text\/plain|application\/(xhtml|json)/i.test(type)) {
    throw new Error(`That address is ${type.split(';')[0] || 'not text'}, which cannot be read as a page.`)
  }

  const raw = await readCapped(res, limits.maxDownloadBytes)
  const text = /text\/plain|application\/json/i.test(type) ? raw : extractReadableText(raw)
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const truncated = text.length > limits.pageChars

  return {
    url: res.url || url,
    title: title ? stripTags(title[1]!).slice(0, 160) : url,
    text: truncated ? `${text.slice(0, limits.pageChars)}\n\n[cut here — the page continues]` : text,
    truncated,
    bytes: raw.length
  }
}

/** Stop reading once the cap is passed, so one huge page cannot stall a reply. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    out += decoder.decode(value, { stream: true })
    if (total >= maxBytes) {
      await reader.cancel()
      break
    }
  }
  return out
}

export function extractReadableText(html: string): string {
  let working = html
    // Anything that is not prose, in rough order of how much of a page it is.
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  // If the page marks its content, trust it and drop the rest of the chrome.
  const main = working.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)
  if (main && stripTags(main[2]!).length > 400) working = main[2]!

  return (
    working
      // Block boundaries become newlines so the text keeps its shape.
      .replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((line) => decodeEntities(line).replace(/[ \t ]+/g, ' ').trim())
      .filter((line, i, all) => line.length > 0 && !(line === all[i - 1]))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
