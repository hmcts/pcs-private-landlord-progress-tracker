// Where the QA report keeps its evidence and drafts. The evidence is internal (ticket keys,
// CVE ids, test names, build links) and this repo and its site are public, so it lives in the
// gitignored .cache/qa locally, or $RUNNER_TEMP in CI, and never anywhere the site is built from.

import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { QaError } from './errors.ts'

export function cacheDir(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): string {
  const dir = resolve(root, env.QA_CACHE_DIR || (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, 'qa') : '.cache/qa'))
  const rel = relative(resolve(root), dir)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (inside && rel.split(/[\\/]/)[0] !== '.cache') {
    throw new QaError('bad-path', `QA evidence must not be written inside the repo outside .cache/ (got ${rel || '.'})`)
  }
  return dir
}

export function releaseDir(release: string, env: NodeJS.ProcessEnv = process.env, root = process.cwd()): string {
  const dir = join(cacheDir(env, root), release.replace(/[^\w.-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  return dir
}

const inside = (path: string, base: string) => {
  const rel = relative(base, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** `path` resolved, if it lies inside one of `bases`; a QaError otherwise. */
export function within(path: string, bases: string[], root = process.cwd()): string {
  const full = resolve(root, path)
  if (!bases.some((b) => inside(full, resolve(root, b)))) throw new QaError('bad-path', `${path} is not inside ${bases.join(' or ')}`)
  return full
}

export const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function releaseName(name: string): string {
  if (!RELEASE_NAME.test(name) || name.includes('..')) throw new QaError('bad-argument', 'a release name has letters, digits, dots, dashes and underscores only')
  return name
}
