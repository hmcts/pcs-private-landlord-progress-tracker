// The QA agent's answers for a layout's `agent` rows, from answers.json in the scope's cache
// directory, written there by the agent (config/qa-readiness/agent-prompt.md):
//
//   { "1": { "answer": "Yes", "comment": "Coverage is 91.2% (pcs-api) and 88.0% (pcs-frontend).",
//            "links": [{ "text": "pcs-api on SonarCloud", "url": "https://sonarcloud.io/…" }] },
//     "sections": { "info": { "Release Type": { "text": "…", "links": [] } }, "qaSummary": "…", … } }
//
// An answer of "" leaves the row's status blank: the agent couldn't establish it, and its comment
// says what is missing. `sections` holds the rest of a template-reproducing layout (sections.ts):
// the info rows with rule `agent` and each section after the checklist. Each section is checked
// on its own, like each row. "Created by" is not the agent's: the pipeline writes the account
// name it collected into agent-input.json (collectedName).
//
// Unlike a judgement, an answer is the generator's: its cells carry the ownership marker, the
// next run's answer replaces them, and a person editing one takes it over. Each answer is checked
// on its own, and one that fails is left out, so its row keeps what the page says; why goes to
// answers-rejected.txt beside it. A file that can't be read at all (not JSON, too big, not a
// mapping) counts as no answers: every agent row keeps what the page says. The file holds
// internal detail, so it lives in the cache directory, like the evidence.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Layout, type LayoutRow, prOfRepo, type ReleaseConfig, SECTION_KINDS } from './config.ts'
import { QaError } from './errors.ts'
import type { PublishedPart, PublishedRow } from './publish.ts'
import { item, type Item, short } from './sources/common.ts'
import type { Answer, Evidence, EvidenceItem, Link, Status } from './types.ts'
import { isRec, str } from './util.ts'

export const ANSWERS_FILE = 'answers.json'
export const REJECTED_FILE = 'answers-rejected.txt'
export const AGENT_INPUT_FILE = 'agent-input.json'

/** "" is no answer: the status is left blank. */
export type AgentAnswerValue = Answer | ''

export interface AgentAnswer {
  answer: AgentAnswerValue
  comment: string
  links: Link[]
}

export type AgentAnswers = Record<string, AgentAnswer>

export const LIMITS = { file: 200_000, comment: 1500, links: 12, text: 200, url: 1000, name: 100, cell: 500, summary: 3000, risks: 10 }

const VALUES: AgentAnswerValue[] = ['Yes', 'No', 'N/A', '']
const FIELDS = ['answer', 'comment', 'links']
const HTTPS = /^https:\/\/\S+$/

export const agentRows = (layout: Layout): LayoutRow[] => layout.checklist.rows.filter((r) => r.rule === 'agent')

export const agentInfoRows = (layout: Layout): LayoutRow[] => (layout.info?.rows ?? []).filter((r) => r.rule === 'agent')

/** Whether a layout has anything for the agent to answer. */
export const hasAgentWork = (layout: Layout): boolean => agentRows(layout).length > 0 || agentInfoRows(layout).length > 0 || !!layout.sections

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
  if (typeof a.answer !== 'string' || !VALUES.includes(value as AgentAnswerValue)) errors.push(`${w}: "answer" must be Yes, No, N/A or "" (blank)`)
  const comment = str(a.comment)
  if (!comment.trim() || comment.length > LIMITS.comment) errors.push(`${w}: "comment" must be 1 to ${LIMITS.comment} characters`)
  errors.push(...linkErrors(a.links ?? [], w))
  if ((value === 'Yes' || value === 'No') && !(Array.isArray(a.links) && a.links.length)) errors.push(`${w}: a Yes or No must cite at least one link`)
  return errors
}

export const TEST_STATUSES = ['✅ Completed', 'NA', ''] as const
export const SIGN_STATUSES = ['✅ Approved', ''] as const

export interface SectionAnswers {
  info?: Record<string, { text: string; links: Link[] }>
  testingSummary?: Record<string, (typeof TEST_STATUSES)[number]>
  defectSummary?: { counts: Record<string, string>; comment: string }
  risks?: { risk: string; mitigation: string; links: Link[] }[]
  qaSummary?: string
  recommendation?: { approved: boolean; reason: string }
  signOff?: Record<string, { name: string; status: (typeof SIGN_STATUSES)[number]; links: Link[] }>
}

const SECTION_ANSWERS = ['info', ...SECTION_KINDS]

/** Text of at most `max` characters, `min` or more of them not blank. */
const textOk = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.length <= max && v.trim().length >= min
const oneLine = (v: unknown, max: number, min = 0): v is string => textOk(v, max, min) && !/[\r\n]/.test(v)

function fieldErrors(v: Record<string, unknown>, fields: string[], w: string): string[] {
  return Object.keys(v).filter((k) => !fields.includes(k)).map((k) => `${w}: unknown field "${k}"`)
}

/** A mapping with exactly the layout's entries as its keys, each checked by `each`. */
function fixedRows(v: unknown, rows: string[], w: string, each: (x: unknown, at: string) => string[]): string[] {
  if (!isRec(v)) return [`${w}: expected a mapping of ${rows.join(', ')}`]
  const keys = Object.keys(v)
  const missing = rows.filter((r) => !keys.includes(r))
  return [...keys.filter((k) => !rows.includes(k)).map((k) => `${w}: "${k}" is not one of ${rows.join(', ')}`),
    ...(missing.length ? [`${w}: missing ${missing.join(', ')}`] : []), ...keys.filter((k) => rows.includes(k)).flatMap((k) => each(v[k], `${w}.${k}`))]
}

/** What's wrong with one section's answer, if anything. */
function sectionErrors(kind: string, v: unknown, layout: Layout, w: string): string[] {
  const section = layout.sections?.find((s) => s.kind === kind)
  const rows = section?.rows ?? []
  switch (kind) {
    case 'info': {
      const keys = agentInfoRows(layout).map((r) => r.key)
      if (!isRec(v)) return [`${w}: expected a mapping of info rows to { text, links }`]
      return Object.entries(v).flatMap(([k, x]) => {
        const at = `${w}.${k}`
        if (!keys.includes(k)) return [`${at}: the layout has no agent info row ${k}`]
        if (!isRec(x)) return [`${at}: expected { text, links }`]
        return [...fieldErrors(x, ['text', 'links'], at), ...(textOk(x.text, LIMITS.comment) ? [] : [`${at}: "text" must be 1 to ${LIMITS.comment} characters`]),
          ...linkErrors(x.links ?? [], at)]
      })
    }
    case 'testingSummary':
      return fixedRows(v, rows, w, (x, at) => (TEST_STATUSES.includes(x as never) ? [] : [`${at}: must be ${TEST_STATUSES.map((t) => `"${t}"`).join(', ')}`]))
    case 'defectSummary': {
      if (!isRec(v)) return [`${w}: expected { counts, comment }`]
      return [...fieldErrors(v, ['counts', 'comment'], w),
        ...fixedRows(v.counts, rows, `${w}.counts`, (x, at) => (typeof x === 'string' && /^\d{0,5}$/.test(x) ? [] : [`${at}: must be a count, or "" if not known`])),
        ...(textOk(v.comment, LIMITS.cell) ? [] : [`${w}: "comment" must be 1 to ${LIMITS.cell} characters`])]
    }
    case 'risks': {
      if (!Array.isArray(v) || !v.length || v.length > LIMITS.risks) return [`${w}: expected a list of 1 to ${LIMITS.risks} { risk, mitigation, links }`]
      return v.flatMap((x: unknown, n: number) => {
        const at = `${w}[${n}]`
        if (!isRec(x)) return [`${at}: expected { risk, mitigation, links }`]
        return [...fieldErrors(x, ['risk', 'mitigation', 'links'], at), ...linkErrors(x.links ?? [], at),
          ...['risk', 'mitigation'].filter((k) => !textOk(x[k], LIMITS.cell, 0)).map((k) => `${at}: "${k}" must be text of at most ${LIMITS.cell} characters`)]
      })
    }
    case 'qaSummary':
      return textOk(v, LIMITS.summary) ? [] : [`${w}: must be 1 to ${LIMITS.summary} characters`]
    case 'recommendation':
      if (!isRec(v)) return [`${w}: expected { approved, reason }`]
      return [...fieldErrors(v, ['approved', 'reason'], w), ...(typeof v.approved === 'boolean' ? [] : [`${w}: "approved" must be true or false`]),
        ...(textOk(v.reason, LIMITS.comment) ? [] : [`${w}: "reason" must be 1 to ${LIMITS.comment} characters`])]
    case 'signOff':
      return fixedRows(v, rows, w, (x, at) => {
        if (!isRec(x)) return [`${at}: expected { name, status, links }`]
        return [...fieldErrors(x, ['name', 'status', 'links'], at), ...(oneLine(x.name, LIMITS.name) ? [] : [`${at}: "name" must be one line of at most ${LIMITS.name} characters`]),
          ...(SIGN_STATUSES.includes(x.status as never) ? [] : [`${at}: "status" must be ${SIGN_STATUSES.map((t) => `"${t}"`).join(' or ')}`]), ...linkErrors(x.links ?? [], at)]
      })
    default:
      return [`${w}: the layout has no such section`]
  }
}

/** A checked section answer, trimmed, with every list of links present. */
function normaliseSection(kind: string, v: unknown): unknown {
  const r = v as Record<string, any>
  switch (kind) {
    case 'info':
      return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, { text: str(x.text).trim(), links: x.links ?? [] }]))
    case 'risks':
      return (v as Record<string, any>[]).map((x) => ({ risk: str(x.risk).trim(), mitigation: str(x.mitigation).trim(), links: x.links ?? [] }))
    case 'signOff':
      return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, { name: str(x.name).trim(), status: x.status, links: x.links ?? [] }]))
    case 'defectSummary':
      return { counts: r.counts, comment: str(r.comment).trim() }
    case 'recommendation':
      return { approved: r.approved, reason: str(r.reason).trim() }
    default:
      return typeof v === 'string' ? v.trim() : v
  }
}

/** The section answers that pass, and what was wrong with the rest. */
export function validateSectionAnswers(doc: unknown, layout: Layout): { sections: SectionAnswers; errors: string[]; rejected: number } {
  if (!isRec(doc)) return { sections: {}, errors: ['answers.sections: expected a mapping'], rejected: 1 }
  const sections: Record<string, unknown> = {}
  const all: string[] = []
  let rejected = 0
  const known = layout.sections ? SECTION_ANSWERS : []
  for (const [kind, v] of Object.entries(doc)) {
    const w = `answers.sections.${kind}`
    const errors = !known.includes(kind) || (SECTION_KINDS.includes(kind as never) && !layout.sections?.some((s) => s.kind === kind))
      ? [`${w}: the layout has no such section`] : sectionErrors(kind, v, layout, w)
    if (errors.length) {
      all.push(...errors)
      rejected++
    } else {
      sections[kind] = normaliseSection(kind, v)
    }
  }
  return { sections: sections as SectionAnswers, errors: all, rejected }
}

/** The answers that pass for the layout's agent rows and sections, and what was wrong with the rest. */
export function validateAnswers(doc: unknown, layout: Layout): { answers: AgentAnswers; sections: SectionAnswers; errors: string[]; rejected: number } {
  if (!isRec(doc)) throw new QaError('answers-invalid', 'expected a mapping of row keys to { answer, comment, links }')
  const keys = new Set(agentRows(layout).map((r) => r.key))
  const answers: AgentAnswers = {}
  const all: string[] = []
  let rejected = 0
  let sections: SectionAnswers = {}
  for (const [key, a] of Object.entries(doc)) {
    if (key === 'sections') {
      const s = validateSectionAnswers(a, layout)
      sections = s.sections
      all.push(...s.errors)
      rejected += s.rejected
      continue
    }
    const errors = keys.has(key) ? validateAnswer(a, `answers.${key}`) : [`answers.${key}: the layout has no agent row ${key}`]
    if (errors.length) {
      all.push(...errors)
      rejected++
      continue
    }
    const r = a as Record<string, unknown>
    answers[key] = { answer: str(r.answer) as AgentAnswerValue, comment: str(r.comment).trim(), links: (r.links ?? []) as Link[] }
  }
  return { answers, sections, errors: all, rejected }
}

export interface LoadedAnswers {
  /** Whether answers.json was there at all. */
  found: boolean
  answers: AgentAnswers
  sections: SectionAnswers
  /** How many rows' and sections' answers were left out. */
  rejected: number
  /** Why the file couldn't be read at all, in which case no answer was taken. */
  unreadable?: QaError
}

function readJson(path: string, name: string): unknown {
  if (statSync(path).size > LIMITS.file) throw new QaError('answers-invalid', `${name} is over ${LIMITS.file} bytes`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new QaError('answers-invalid', `${name} is not valid JSON: ${(e as Error).message}`)
  }
}

/** The account name collect wrote to agent-input.json, if it could read one. */
export function collectedName(dir: string): string | null {
  const path = join(dir, AGENT_INPUT_FILE)
  if (!existsSync(path)) return null
  try {
    const doc = readJson(path, AGENT_INPUT_FILE)
    return isRec(doc) && oneLine(doc.createdBy, LIMITS.name, 1) ? doc.createdBy : null
  } catch {
    return null
  }
}

/**
 * Reads answers.json from the scope's cache directory, and writes why any answer was left out,
 * or why none could be read, to answers-rejected.txt there (removing an earlier one when none was).
 */
export function loadAnswers(dir: string, layout: Layout): LoadedAnswers {
  const path = join(dir, ANSWERS_FILE)
  const rejectedPath = join(dir, REJECTED_FILE)
  rmSync(rejectedPath, { force: true })
  if (!existsSync(path)) return { found: false, answers: {}, sections: {}, rejected: 0 }
  try {
    const { answers, sections, errors, rejected } = validateAnswers(readJson(path, ANSWERS_FILE), layout)
    if (errors.length) writeFileSync(rejectedPath, errors.join('\n') + '\n')
    return { found: true, answers, sections, rejected }
  } catch (e) {
    const unreadable = e instanceof QaError ? e : new QaError('answers-invalid', (e as Error).message)
    writeFileSync(rejectedPath, `${unreadable.message}\n`)
    return { found: true, answers: {}, sections: {}, rejected: 0, unreadable }
  }
}

function statusOf(a: AgentAnswerValue, row: LayoutRow): Status {
  if (a === '') return 'unknown'
  if (a === 'N/A') return 'pass'
  return a === (row.good ?? 'Yes') ? 'pass' : 'fail'
}

/** What the page says now, for the agent to keep wording that still holds. */
export interface Published {
  rows: Record<string, PublishedRow>
  info: Record<string, PublishedPart>
  sections: Record<string, PublishedPart>
}

/**
 * What the agent is given for a scope (agent-input.json): the scope; for each agent row its
 * question, guide, the evidence filed under it and, if the page could be read, what it says now;
 * and for a layout with sections, the agent info rows and the sections it fills in. The account
 * name is kept there too, for the pipeline's "Created by" line (collectedName).
 */
export function agentInput(cfg: ReleaseConfig, layout: Layout, ev: Evidence, published: Published | null, createdBy: string | null = null): Record<string, unknown> {
  // How each repo's service-wide commit was picked, or why none was, for the agent to mention where it matters.
  const revision = (name: string) => {
    const it = ev.items.find((i) => i.rule === 'service-revision' && i.repo === name)
    const from = str(it?.data?.from)
    return it ? { status: it.status, ...(it.sha ? { sha: it.sha } : {}), ...(from ? { from } : {}), ...(it.note ? { note: it.note } : {}) } : null
  }
  const pullRequest = (name: string, pr: number) => {
    const sha = cfg.candidates[0]?.shas[name]
    return { number: pr, repo: cfg.repos[name].github, url: `https://github.com/${cfg.repos[name].github}/pull/${String(pr)}`, ...(sha ? { commit: sha } : {}) }
  }
  const pulls = Object.keys(cfg.repos).flatMap((name) => {
    const pr = prOfRepo(cfg, name)
    return pr ? [[name, pullRequest(name, pr)] as const] : []
  })
  const repos = Object.fromEntries(Object.entries(cfg.repos).map(([name, rc]) => {
    const pull = pulls.find(([n]) => n === name)?.[1]
    const rev = revision(name)
    return [name, {
      github: rc.github, ...(rc.sonar ? { sonar: rc.sonar } : {}), ...(rc.e2e ? { e2e: rc.e2e } : {}),
      ...(pull ? { pullRequest: pull } : {}), ...(rev ? { revision: rev } : {}),
      commits: Object.fromEntries(cfg.candidates.filter((c) => c.shas[name]).map((c) => [c.name, c.shas[name]])),
    }]
  }))
  // Said once, so the agent judges the feature's PRs, not master.
  const measuredAt = pulls.length ? { measuredAt: `The evidence is from the feature's pull requests, not master: ${pulls.map(([, p]) =>
    `${p.repo}#${String(p.number)}${p.commit ? ` at ${short(p.commit)}` : ', with no commit picked'}`).join(', ')}.` } : {}
  const compact = (i: EvidenceItem) => ({ rule: i.rule, status: i.status, value: i.value, ...(i.note ? { note: i.note } : {}),
    ...(i.answer ? { answer: i.answer } : {}), ...(i.unreachable ? { unreachable: true } : {}), links: i.links,
    ...(i.sha ? { sha: i.sha } : {}), ...(i.repo ? { repo: i.repo } : {}) })
  const evidenceFor = (row: string) => ev.items.filter((i) => i.row === row && i.source !== 'agent').map(compact)
  const template = layout.sections ? {
    ...(layout.header && createdBy ? { createdBy } : {}),
    info: agentInfoRows(layout).map((r) => ({ key: r.key, ...(r.guide ? { guide: r.guide } : {}), evidence: evidenceFor(`info:${r.key}`),
      ...(published?.info[r.key] ? { published: published.info[r.key] } : {}) })),
    sections: layout.sections.map((s) => ({ kind: s.kind, heading: s.heading, ...(s.columns ? { columns: s.columns } : {}), ...(s.rows ? { rows: s.rows } : {}),
      ...(published?.sections[s.kind] ? { published: published.sections[s.kind] } : {}) })),
  } : {}
  return {
    scope: { kind: cfg.kind ?? 'release', name: cfg.release, ...(cfg.epics ? { epics: cfg.epics } : {}), ...(cfg.kind === 'feature' ? {} : { jql: cfg.jql }),
      ...(cfg.report_page ? { reportPage: cfg.report_page } : {}), ...(cfg.ria_page ? { riaPage: cfg.ria_page } : {}), ...measuredAt, repos },
    collectedAt: ev.generatedAt,
    answersFile: ANSWERS_FILE,
    pageRead: published !== null,
    ...template,
    rows: agentRows(layout).map((r) => ({
      key: r.key, question: r.question, ...(r.guide ? { guide: r.guide } : {}),
      evidence: evidenceFor(r.key),
      ...(published?.rows[r.key] ? { published: published.rows[r.key] } : {}),
    })),
  }
}

/** Each answer as the agent's evidence item for its row, and each agent info row's as one for that row. */
export function answerItems(answers: AgentAnswers, layout: Layout, now?: () => Date, sections: SectionAnswers = {}): Item[] {
  const rows = agentRows(layout).filter((r) => Object.hasOwn(answers, r.key)).map((r) => {
    const a = answers[r.key]
    return item({ source: 'agent', rule: 'agent', status: statusOf(a.answer, r), value: a.comment, links: a.links,
      answer: a.answer === '' ? undefined : a.answer, data: { row: r.key } }, now)
  })
  const info = agentInfoRows(layout).filter((r) => sections.info && Object.hasOwn(sections.info, r.key)).map((r) =>
    item({ source: 'agent', rule: 'agent', status: 'pass', value: sections.info![r.key].text, links: sections.info![r.key].links, data: { row: `info:${r.key}` } }, now))
  return [...rows, ...info]
}
