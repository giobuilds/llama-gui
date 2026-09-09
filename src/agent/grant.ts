import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The one project a run may see.
 *
 * Every path a tool receives comes from the model, and the model has read the
 * project — including anything in it that tells the model where else to look.
 * So a path is never trusted by its spelling. It is resolved to what it really
 * names, symlinks included, and only then compared with the root.
 *
 * A prefix comparison on the string alone is not a filesystem boundary:
 * `../`, a symlink out, and a root that is itself a symlink all pass one.
 */
export class Grant {
  private constructor(
    /** The root as the caller gave it. */
    readonly root: string,
    /** The root with every symlink resolved, which is what paths are checked against. */
    readonly realRoot: string
  ) {}

  static async open(root: string): Promise<Grant> {
    return new Grant(resolve(root), await realpath(root))
  }

  /**
   * Resolve a path the model supplied to one that is provably inside the
   * grant, or say why not. Relative paths are taken from the root; absolute
   * ones are allowed only if they land inside it anyway.
   */
  async resolve(requested: string): Promise<Resolved> {
    const candidate = isAbsolute(requested) ? requested : resolve(this.root, requested)

    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      // Not existing is not the same as forbidden, and saying which helps the
      // model correct a typo instead of trying elsewhere.
      return { ok: false, denied: false, reason: `No such path: ${requested}` }
    }

    const rel = relative(this.realRoot, real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, denied: true, reason: `Outside the project: ${requested}` }
    }

    // Repository control files and dependency trees are outside the normal
    // grant even though they sit inside the tree: nothing a task needs is in
    // them, and a great deal that a task should not touch is.
    const first = rel.split(sep)[0]
    if (first && EXCLUDED.has(first)) {
      return { ok: false, denied: true, reason: `Not part of the grant: ${first}/` }
    }

    return { ok: true, path: real, relative: rel || '.' }
  }

  /** Whether a directory entry should be walked or listed at all. */
  static visible(name: string): boolean {
    return !EXCLUDED.has(name)
  }
}

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'out', '.build'])

export type Resolved =
  | { ok: true; path: string; relative: string }
  | { ok: false; denied: boolean; reason: string }
