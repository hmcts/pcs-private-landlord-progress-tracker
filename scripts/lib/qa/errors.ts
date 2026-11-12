// Failures the CLI may name in a public log. A QaError's code picks a fixed message to print;
// its detail, which can quote Jira, Confluence or the config, goes only to errors.log in the
// cache directory.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PUBLIC = {
  'bad-argument': 'a command-line argument is not valid',
  'bad-path': 'a file given is outside the directory it must be in (config/qa-readiness or the cache directory)',
  'config-invalid': 'the release or feature config is not valid: run npm run validate for details',
  'config-mismatch': '--release or --feature does not match what its config is for',
  'not-active': 'the release or feature is not active: set active: true in its config to publish',
  'evidence-invalid': 'the evidence file is not valid: see errors.log in the cache directory',
  'evidence-mismatch': 'the evidence file is for another release or feature, or other commits',
  'judgement-invalid': 'the judgement file is not valid: see errors.log in the cache directory',
  'page-read': 'twg could not read the Confluence page',
  'page-update': 'twg could not update the Confluence page',
  'page-create': 'twg could not create the Confluence page',
  'command-missing': 'a command the report needs (twg or gh) is not installed or not on PATH',
  twg: 'twg failed',
  unexpected: 'an unexpected error: see errors.log in the cache directory',
} as const

export type Code = keyof typeof PUBLIC

export class QaError extends Error {
  code: Code
  constructor(code: Code, detail?: string) {
    super(detail ?? PUBLIC[code])
    this.code = code
  }
}

export const publicMessage = (e: unknown): string => PUBLIC[e instanceof QaError ? e.code : 'unexpected']

/** Appends the whole error to errors.log in `dir`. Never throws: it runs on the way out. */
export function logError(dir: string, release: string, e: unknown, now = new Date()): void {
  try {
    mkdirSync(dir, { recursive: true })
    const code = e instanceof QaError ? e.code : 'unexpected'
    const detail = e instanceof Error ? e.stack ?? e.message : JSON.stringify(e)
    appendFileSync(join(dir, 'errors.log'), `${now.toISOString()} ${release} ${code}\n${detail}\n\n`)
  } catch {
    // Nothing more can be done without printing the error.
  }
}
