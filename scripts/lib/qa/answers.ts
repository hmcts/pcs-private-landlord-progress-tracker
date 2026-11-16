// The QA agent's answers for a layout's `agent` rows, from answers.json in the scope's cache
// directory, written there by the agent (config/qa-readiness/agent-prompt.md):
//
//   { "1": { "answer": "Yes", "comment": "Coverage is 91.2% (pcs-api) and 88.0% (pcs-frontend).",
//            "links": [{ "text": "pcs-api on SonarCloud", "url": "https://sonarcloud.io/…" }] } }
//
// Unlike a judgement, an answer is the generator's: its cells carry the ownership marker, the
// next run's answer replaces them, and a person editing one takes it over. Each answer is checked
// on its own, and one that fails is left out, so its row keeps what the page says; why goes to
// answers-rejected.txt beside it. The file holds internal detail, so it lives in the cache
// directory, like the evidence.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Layout, LayoutRow, ReleaseConfig } from './config.ts'
import { QaError } from './errors.ts'
import type { PublishedRow } from './publish.ts'
import { item, type Item } from './sources/common.ts'
import type { Answer, Evidence, EvidenceItem, Link, Status } from './types.ts'
import { isRec, str } from './util.ts'

export const ANSWERS_FILE = 'answers.json'
export const REJECTED_FILE = 'answers-rejected.txt'
export const AGENT_INPUT_FILE = 'agent-input.json'

export type AgentAnswerValue = Answer | 'To confirm'

export interface AgentAnswer {
  answer: AgentAnswerValue
  comment: string
  links: Link[]
}

export type AgentAnswers = Record<string, AgentAnswer>

export const LIMITS = { file: 200_000, comment: 1500, links: 12, text: 200, url: 1000 }

const VALUES: AgentAnswerValue[] = ['Yes', 'No', 'N/A', 'To confirm']
const FIELDS = ['answer', 'comment', 'links']
const HTTPS = /^https:\/\/\S+$/

export const agentRows = (layout: Layout): LayoutRow[] => layout.checklist.rows.filter((r) => r.rule === 'agent')

function linkErrors(links: unknown, w: string): string[] {
  if (!Array.isArray(links)) return [`${w}: "links" must be a list of { text, url }`]
  if (links.length > LIMITS.links) return [`${w}: at most ${LIMITS.links} links`]
  return links.flatMap((l, n) => {
    const at = `${w}.links[${n}]`
    if (!isRec(l) || Object.keys(l).some((k) => k !== 'text' && k !== 'url')) return [`${at}: expected { text, url }`]
    const text = str(l.text)
    const url = str(l.url)
    return [
      ...(text.trim() && text.length <= LIMITS.text ? [] : [`${at}: "text" must be 1 to ${LIMITS.text} characters`]),
      ...(url.length <= LIMITS.url && HTTPS.test(url) ? [] : [`${at}: "url" must be an https URL of at most ${LIMITS.url} characters`]),
    ]
  })
}

/** What's wrong with one row's answer, if anything. */
export function validateAnswer(a: unknown, w: string): string[] {
  if (!isRec(a)) return [`${w}: expected { answer, comment, links }`]
  const errors = Object.keys(a).filter((k) => !FIELDS.includes(k)).map((k) => `${w}: unknown field "${k}"`)
  const value = str(a.answer)
  if (!VALUES.includes(value as AgentAnswerValue)) errors.push(`${w}: "answer" must be Yes, No, N/A or To confirm`)
  const comment = str(a.comment)
  if (!comment.trim() || comment.length > LIMITS.comment) errors.push(`${w}: "comment" must be 1 to ${LIMITS.comment} characters`)
  errors.push(...linkErrors(a.links ?? [], w))
  if ((value === 'Yes' || value === 'No') && !(Array.isArray(a.links) && a.links.length)) errors.push(`${w}: a Yes or No must cite at least one link`)
  return errors
}

/** The answers that pass for the layout's agent rows, and what was wrong with the rest. */
export function validateAnswers(doc: unknown, layout: Layout): { answers: AgentAnswers; errors: string[]; rejected: number } {
  if (!isRec(doc)) throw new QaError('answers-invalid', 'expected a mapping of row keys to { answer, comment, links }')
  const keys = new Set(agentRows(layout).map((r) => r.key))
  const answers: AgentAnswers = {}
  const all: string[] = []
  let rejected = 0
  for (const [key, a] of Object.entries(doc)) {
    const errors = keys.has(key) ? validateAnswer(a, `answers.${key}`) : [`answers.${key}: the layout has no agent row ${key}`]
    if (errors.length) {
      all.push(...errors)
      rejected++
      continue
    }
    const r = a as Record<string, unknown>
    answers[key] = { answer: str(r.answer) as AgentAnswerValue, comment: str(r.comment).trim(), links: (r.links ?? []) as Link[] }
  }
  return { answers, errors: all, rejected }
}

export interface LoadedAnswers {
  /** Whether answers.json was there at all. */
  found: boolean
  answers: AgentAnswers
  /** How many rows' answers were left out. */
  rejected: number
}

/**
 * Reads answers.json from the scope's cache directory, and writes why any answer was left out
 * to answers-rejected.txt there (removing an earlier one when none was).
 */
export function loadAnswers(dir: string, layout: Layout): LoadedAnswers {
  const path = join(dir, ANSWERS_FILE)
  const rejectedPath = join(dir, REJECTED_FILE)
  rmSync(rejectedPath, { force: true })
  if (!existsSync(path)) return { found: false, answers: {}, rejected: 0 }
  const raw = readFileSync(path, 'utf8')
  if (raw.length > LIMITS.file) throw new QaError('answers-invalid', `answers.json is over ${LIMITS.file} characters`)
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new QaError('answers-invalid', `answers.json is not valid JSON: ${(e as Error).message}`)
  }
  const { answers, errors, rejected } = validateAnswers(doc, layout)
  if (errors.length) writeFileSync(rejectedPath, errors.join('\n') + '\n')
  return { found: true, answers, rejected }
}

function statusOf(a: AgentAnswerValue, row: LayoutRow): Status {
  if (a === 'To confirm') return 'unknown'
  if (a === 'N/A') return 'pass'
  return a === (row.good ?? 'Yes') ? 'pass' : 'fail'
}

/**
 * What the agent is given for a scope (agent-input.json): the scope, and for each agent row its
 * question, guide, the evidence filed under it and, if the page could be read, what it says now.
 */
export function agentInput(cfg: ReleaseConfig, layout: Layout, ev: Evidence, published: Record<string, PublishedRow> | null): Record<string, unknown> {
  const repos = Object.fromEntries(Object.entries(cfg.repos).map(([name, rc]) => [name, {
    github: rc.github, ...(rc.sonar ? { sonar: rc.sonar } : {}), ...(rc.e2e ? { e2e: rc.e2e } : {}),
    commits: Object.fromEntries(cfg.candidates.filter((c) => c.shas[name]).map((c) => [c.name, c.shas[name]])),
  }]))
  const compact = (i: EvidenceItem) => ({ rule: i.rule, status: i.status, value: i.value, ...(i.note ? { note: i.note } : {}),
    ...(i.answer ? { answer: i.answer } : {}), ...(i.unreachable ? { unreachable: true } : {}), links: i.links,
    ...(i.sha ? { sha: i.sha } : {}), ...(i.repo ? { repo: i.repo } : {}) })
  return {
    scope: { kind: cfg.kind ?? 'release', name: cfg.release, ...(cfg.epics ? { epics: cfg.epics } : {}), ...(cfg.kind === 'feature' ? {} : { jql: cfg.jql }),
      ...(cfg.report_page ? { reportPage: cfg.report_page } : {}), ...(cfg.ria_page ? { riaPage: cfg.ria_page } : {}), repos },
    collectedAt: ev.generatedAt,
    answersFile: ANSWERS_FILE,
    pageRead: published !== null,
    rows: agentRows(layout).map((r) => ({
      key: r.key, question: r.question, ...(r.guide ? { guide: r.guide } : {}),
      evidence: ev.items.filter((i) => i.row === r.key && i.source !== 'agent').map(compact),
      ...(published?.[r.key] ? { published: published[r.key] } : {}),
    })),
  }
}

/** Each answer as the agent's evidence item for its row. */
export function answerItems(answers: AgentAnswers, layout: Layout, now?: () => Date): Item[] {
  return agentRows(layout).filter((r) => Object.hasOwn(answers, r.key)).map((r) => {
    const a = answers[r.key]
    return item({ source: 'agent', rule: 'agent', status: statusOf(a.answer, r), value: a.comment, links: a.links,
      answer: a.answer === 'To confirm' ? undefined : a.answer, data: { row: r.key } }, now)
  })
}
