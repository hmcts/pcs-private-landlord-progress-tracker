// Helpers shared by the QA report: shape checks for the YAML and JSON its config, judgement and
// evidence readers take before they're checked, and finding the commands it runs.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { QaError } from './errors.ts'

export type Rec = Record<string, unknown>

export const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

export const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** A string or number as text; anything else (an object, a list) as ''. */
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

const resolved = new Map<string, string>()

/**
 * A command's absolute path: the first executable file of that name in PATH's directories, as
 * a shell would find it, looked up once per run. Absolute and relative PATH entries are taken
 * as they are, so the result is the same file execFileSync would have run.
 */
export function commandPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const hit = resolved.get(name)
  if (hit) return hit
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (!d) continue
    const full = resolve(d, name)
    try {
      accessSync(full, constants.X_OK)
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    resolved.set(name, full)
    return full
  }
  throw new QaError('command-missing', `${name} is not on PATH`)
}
