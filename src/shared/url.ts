/**
 * What counts as a page worth opening.
 *
 * Both sides of the app ask this and must agree: the renderer decides whether a
 * click is a link to hand over, and the main process decides whether to load
 * it. A disagreement there is how a `javascript:` or `file:` URL would find its
 * way into a pane meant only for the web.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The host alone, for showing which site a page came from. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
