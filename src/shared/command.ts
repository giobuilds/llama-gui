/**
 * Turning a typed command line into the argv the main process spawns.
 *
 * Kept out of the component that collects it so the parsing can be tested on
 * its own — a mis-split path is the difference between a server that starts and
 * one that fails with a message about a directory that does not exist.
 */

/** Split on whitespace, honouring quotes, so a path with a space stays one argument. */
export function splitCommand(line: string): string[] {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part
  )
}

/**
 * A short identifier derived from a name.
 *
 * MCP tool names are prefixed with this, and the prefix is how a call is routed
 * back to the server that offered it, so it has to survive a round trip through
 * the model unchanged: lower case, no spaces, nothing a tokeniser will alter.
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
}
