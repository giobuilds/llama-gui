import { Marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

/**
 * Renders assistant output as markdown.
 *
 * Model output is untrusted text being turned into HTML, so the result is
 * sanitised before it reaches the DOM. Without this, a model could emit a
 * script tag or an event-handler attribute and have it run inside the app.
 */

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && hljs.getLanguage(lang) ? lang : null
      const body = language
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text)
      // The label and copy affordance live in the markup so a code block is
      // useful without extra wiring in React.
      return (
        `<div class="code-block" data-code="${encodeURIComponent(text)}">` +
        `<div class="code-head"><span>${language ?? 'text'}</span>` +
        `<button type="button" class="code-copy">Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      )
    }
  }
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false })
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-code'],
    // Links open externally via the window-open handler; anything else that
    // could execute is stripped by the default profile.
    FORBID_TAGS: ['style', 'form', 'input'],
    FORBID_ATTR: ['style']
  })
}
