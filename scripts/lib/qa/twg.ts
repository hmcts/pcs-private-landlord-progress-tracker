// twg for the QA report: the roadmap's runner, with stderr captured rather than passed through,
// since twg's notices can name the page or query it read and this runs in a public log.
//
// Ids and keys go to twg as arguments, so every caller passes them through pageId or jiraKey
// first: digits only, or an issue key, never anything twg could read as an option.

import { execFileSync } from 'node:child_process'
import type { TwgRunner } from '../roadmap-runner.ts'
import { QaError } from './errors.ts'

export const PAGE_ID = /^\d+$/
export const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/

export function pageId(id: unknown): string {
  const s = typeof id === 'number' ? String(id) : id
  if (typeof s !== 'string' || !PAGE_ID.test(s)) throw new QaError('bad-argument', 'a Confluence page id must be digits only')
  return s
}

export function jiraKey(key: unknown): string {
  if (typeof key !== 'string' || !JIRA_KEY.test(key)) throw new QaError('bad-argument', 'a Jira key must look like HDPI-123')
  return key
}

export const quietRunner: TwgRunner = (args) =>
  execFileSync('twg', args, { encoding: 'utf8', env: { ...process.env, TWG_AGENT_DEFAULTS: '1' }, maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] })
