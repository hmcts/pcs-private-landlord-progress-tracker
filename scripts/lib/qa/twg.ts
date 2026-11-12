// twg for the QA report: the roadmap's runner, with stderr captured rather than passed through,
// since twg's notices can name the page or query it read and this runs in a public log. The
// readers use the asynchronous one, so their calls overlap; publishing uses the synchronous one.
//
// Ids and keys go to twg as arguments, so every caller passes them through pageId or jiraKey
// first: digits only, or an issue key, never anything twg could read as an option.

import { execFileSync } from 'node:child_process'
import type { TwgRunner } from '../roadmap-runner.ts'
import { QaError } from './errors.ts'
import { commandPath, runCommand } from './util.ts'

export const PAGE_ID = /^\d+$/
export const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/** A page id rebuilt from its number, so what reaches twg is always the digits of a positive integer. */
export function pageId(id: unknown): string {
  const s = typeof id === 'number' ? String(id) : id
  const n = typeof s === 'string' && PAGE_ID.test(s) ? Number(s) : Number.NaN
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== s) throw new QaError('bad-argument', 'a Confluence page id must be digits only')
  return String(n)
}

/** A Jira key rebuilt from its project and number. */
export function jiraKey(key: unknown): string {
  const m = typeof key === 'string' ? /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(key) : null
  const n = m ? Number(m[2]) : Number.NaN
  if (!m || !Number.isSafeInteger(n) || n <= 0 || String(n) !== m[2]) throw new QaError('bad-argument', 'a Jira key must look like HDPI-123')
  return `${m[1]}-${n}`
}

/** A twg runner that may answer later. A synchronous TwgRunner is one too, which suits tests. */
export type AsyncTwgRunner = (args: string[]) => string | Promise<string>

const options = () => ({ encoding: 'utf8' as const, env: { ...process.env, TWG_AGENT_DEFAULTS: '1' }, maxBuffer: 256 * 1024 * 1024 })

export const quietRunnerAsync: AsyncTwgRunner = (args) => runCommand('twg', args, options())

export const quietRunner: TwgRunner = (args) => execFileSync(commandPath('twg'), args, { ...options(), stdio: ['ignore', 'pipe', 'pipe'] })
