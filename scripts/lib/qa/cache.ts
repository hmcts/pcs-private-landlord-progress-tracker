// Where the QA report keeps its evidence and drafts. The evidence is internal (ticket keys,
// CVE ids, test names, build links) and this repo and its site are public, so it lives in the
// gitignored .cache/qa locally, or $RUNNER_TEMP in CI, and never anywhere the site is built from.

import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function cacheDir(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): string {
  const dir = resolve(root, env.QA_CACHE_DIR || (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, 'qa') : '.cache/qa'))
  const rel = relative(resolve(root), dir)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (inside && rel.split(/[\\/]/)[0] !== '.cache') {
    throw new Error(`QA evidence must not be written inside the repo outside .cache/ (got ${rel || '.'})`)
  }
  return dir
}

export function releaseDir(release: string, env: NodeJS.ProcessEnv = process.env, root = process.cwd()): string {
  const dir = join(cacheDir(env, root), release.replace(/[^\w.-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  return dir
}
