import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Resolves `path` and throws unless it lies inside the repo's `dir`, so a CLI argument can't reach elsewhere. */
export function inside(dir: string, path: string): string {
  const base = resolve(REPO_ROOT, dir)
  const full = resolve(path)
  if (!full.startsWith(base + sep)) throw new Error(`${path} is outside ${dir}/`)
  return full
}
