// QA readiness report configuration: config/qa-readiness/<release>.yaml, and the layouts it
// names in config/qa-readiness/layouts/. Both are committed to a public repo, so they hold only
// what may be published: repo names, SHAs, Sonar keys, Jira keys and page ids.

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadYaml } from '../data.ts'
import { RELEASE_NAME } from './cache.ts'
import { QaError } from './errors.ts'
import { JIRA_KEY, PAGE_ID } from './twg.ts'
import { isRec, nonEmpty, type Rec, str } from './util.ts'

export const CONFIG_DIR = 'config/qa-readiness'
export const LAYOUT_DIR = join(CONFIG_DIR, 'layouts')

export interface RepoConfig {
  github: string // owner/name
  sonar?: string
  cosmos_product?: string
  cosmos_component?: string
  builder?: 'gradle' | 'yarn' // which security check its Jenkins build runs: dependency-check or yarn audit
  test_paths?: string // regex over repo-relative paths; the default suits Gradle and Node layouts
}

export interface Candidate {
  name: string
  shas: Record<string, string>
}

export interface ReleaseConfig {
  release: string
  active: boolean
  layout: string
  report_page?: string
  ria_page?: string
  jql: string
  candidates: Candidate[]
  repos: Record<string, RepoConfig>
  human_rows?: Record<string, string | string[]>
  dashboards?: { label: string; url: string }[]
  bug_types?: string[]
  coverage_threshold?: number
  test_complete_pattern?: string
}

export interface LayoutRow {
  key: string
  match?: string // regex for the first cell of a page's row, when its wording varies ("GIT Revision for 1.3A")
  rule: string
  question?: string
  good?: 'Yes' | 'No'
}

export interface LayoutTable {
  heading: string
  columns: string[]
  widths?: number[]
  rows: LayoutRow[]
}

export interface Layout {
  title: string
  intro?: string[]
  info?: LayoutTable
  checklist: LayoutTable
}

/** Checklist rules the collectors can answer; `human` takes its answer from human_rows. */
export const CHECKLIST_RULES = [
  'sonar-coverage', 'sonar-quality-gate', 'sonar-security', 'integration-contract', 'functional',
  'deployed-aat', 'yarn-audit', 'dependency-check', 'ignored-tests', 'test-complete', 'high-defects',
  'perf-signoff', 'perf-required', 'security-signoff', 'human',
] as const

export const INFO_RULES = ['release', 'dashboards', 'outstanding-bugs', 'repos', 'revisions', 'human'] as const

const ROW_FIELDS = ['key', 'match', 'rule', 'question', 'good']

const SHA = /^[0-9a-f]{40}$/

/** Whether `v` is a string that compiles as a regular expression. */
function isRegex(v: unknown, flags?: string): boolean {
  if (typeof v !== 'string') return false
  try {
    new RegExp(v, flags)
    return true
  } catch {
    return false
  }
}

export function validateLayout(doc: unknown, name = 'layout'): string[] {
  const errors: string[] = []
  if (!isRec(doc)) return [`${name}: expected a mapping`]
  if (!nonEmpty(doc.title)) errors.push(`${name}: "title" is required`)
  const table = (t: unknown, where: string, rules: readonly string[], needQuestion: boolean) => {
    if (!isRec(t)) return errors.push(`${where}: expected a mapping`)
    if (!nonEmpty(t.heading)) errors.push(`${where}: "heading" is required`)
    if (!Array.isArray(t.columns) || t.columns.length < 2) errors.push(`${where}: "columns" needs at least two names`)
    if (t.widths !== undefined && (!Array.isArray(t.widths) || t.widths.length !== (t.columns as unknown[])?.length)) {
      errors.push(`${where}: "widths" must have one number per column`)
    }
    if (!Array.isArray(t.rows) || t.rows.length === 0) return errors.push(`${where}: "rows" needs at least one row`)
    const seen = new Set<string>()
    t.rows.forEach((r: unknown, n: number) => {
      const w = `${where}.rows[${n}]`
      if (!isRec(r)) return errors.push(`${w}: expected a mapping`)
      for (const k of Object.keys(r)) if (!ROW_FIELDS.includes(k)) errors.push(`${w}: unknown field "${k}" (quote values that contain a comma)`)
      if (!nonEmpty(r.key)) errors.push(`${w}: "key" is required`)
      else if (seen.has(str(r.key))) errors.push(`${where}: duplicate row key ${r.key}`)
      seen.add(str(r.key))
      if (!rules.includes(str(r.rule))) errors.push(`${w}: "rule" must be one of ${rules.join(', ')}`)
      if (needQuestion && !nonEmpty(r.question)) errors.push(`${w}: "question" is required`)
      if (r.good !== undefined && r.good !== 'Yes' && r.good !== 'No') errors.push(`${w}: "good" must be Yes or No`)
      if (r.match !== undefined && !isRegex(r.match, 'i')) errors.push(`${w}: "match" is not a valid regular expression`)
    })
  }
  if (doc.info !== undefined) table(doc.info, `${name}.info`, INFO_RULES, false)
  table(doc.checklist, `${name}.checklist`, CHECKLIST_RULES, true)
  return errors
}

export function validateRelease(doc: unknown, name = 'release', layout?: Layout): string[] {
  const errors: string[] = []
  if (!isRec(doc)) return [`${name}: expected a mapping`]
  for (const k of ['release', 'layout', 'jql']) if (!nonEmpty(doc[k])) errors.push(`${name}: "${k}" is required`)
  if (nonEmpty(doc.release) && !RELEASE_NAME.test(doc.release)) errors.push(`${name}: "release" may have only letters, digits, dots, dashes and underscores`)
  if (typeof doc.active !== 'boolean') errors.push(`${name}: "active" must be true or false`)
  for (const k of ['report_page', 'ria_page']) {
    if (doc[k] !== undefined && !PAGE_ID.test(str(doc[k]))) errors.push(`${name}: "${k}" must be a Confluence page id`)
  }
  if (doc.coverage_threshold !== undefined && !(typeof doc.coverage_threshold === 'number' && doc.coverage_threshold >= 0 && doc.coverage_threshold <= 100)) {
    errors.push(`${name}: "coverage_threshold" must be a percentage`)
  }
  if (doc.test_complete_pattern !== undefined && !isRegex(doc.test_complete_pattern, 'i')) {
    errors.push(`${name}: "test_complete_pattern" is not a valid regular expression`)
  }
  if (doc.bug_types !== undefined && !(Array.isArray(doc.bug_types) && doc.bug_types.length && doc.bug_types.every(nonEmpty))) {
    errors.push(`${name}: "bug_types" must be a list of issue type names`)
  }

  const repos = isRec(doc.repos) ? doc.repos : {}
  if (!isRec(doc.repos) || Object.keys(repos).length === 0) errors.push(`${name}: "repos" needs at least one repo`)
  for (const [r, v] of Object.entries(repos)) {
    const w = `${name}.repos.${r}`
    if (!isRec(v)) {
      errors.push(`${w}: expected a mapping`)
      continue
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(str(v.github ?? ''))) errors.push(`${w}: "github" must look like owner/name`)
    if ((v.cosmos_product === undefined) !== (v.cosmos_component === undefined)) {
      errors.push(`${w}: set both "cosmos_product" and "cosmos_component", or neither`)
    }
    if (v.builder !== undefined && v.builder !== 'gradle' && v.builder !== 'yarn') errors.push(`${w}: "builder" must be gradle or yarn`)
    if (v.test_paths !== undefined && !isRegex(v.test_paths)) errors.push(`${w}: "test_paths" is not a valid regular expression`)
  }

  if (!Array.isArray(doc.candidates) || doc.candidates.length === 0) errors.push(`${name}: "candidates" needs at least one candidate`)
  const names = new Set<string>()
  for (const [n, c] of (Array.isArray(doc.candidates) ? doc.candidates : []).entries()) {
    const w = `${name}.candidates[${n}]`
    if (!isRec(c) || !nonEmpty(c.name)) {
      errors.push(`${w}: "name" is required`)
      continue
    }
    if (names.has(str(c.name))) errors.push(`${name}: duplicate candidate ${c.name}`)
    names.add(str(c.name))
    if (!isRec(c.shas) || Object.keys(c.shas).length === 0) {
      errors.push(`${w}: "shas" needs a commit for at least one repo`)
      continue
    }
    for (const [r, sha] of Object.entries(c.shas)) {
      if (!(r in repos)) errors.push(`${w}: "${r}" is not one of the repos`)
      if (!SHA.test(str(sha))) errors.push(`${w}: ${r} must be a full 40-character commit SHA`)
    }
  }

  if (doc.human_rows !== undefined) {
    if (!isRec(doc.human_rows)) errors.push(`${name}: "human_rows" must map row keys to Jira keys`)
    else {
      const keys = new Set(layout?.checklist.rows.map((r) => r.key))
      for (const [row, v] of Object.entries(doc.human_rows)) {
        const list = Array.isArray(v) ? v : [v]
        if (!list.length || !list.every((k) => JIRA_KEY.test(str(k)))) errors.push(`${name}.human_rows.${row}: must be a Jira key or a list of them`)
        if (layout && !keys.has(row)) errors.push(`${name}.human_rows.${row}: the layout has no row ${row}`)
      }
    }
  }

  if (doc.dashboards !== undefined) {
    if (!Array.isArray(doc.dashboards)) errors.push(`${name}: "dashboards" must be a list`)
    else doc.dashboards.forEach((d: unknown, n: number) => {
      if (!isRec(d) || !nonEmpty(d.label) || !/^https:\/\/\S+$/.test(str(d.url ?? ''))) {
        errors.push(`${name}.dashboards[${n}]: needs a "label" and an https "url"`)
      }
    })
  }
  return errors
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new QaError('config-invalid', `no file ${path}`)
  try {
    return loadYaml(path)
  } catch (e) {
    throw new QaError('config-invalid', `${path} is not valid YAML: ${(e as Error).message}`)
  }
}

export function loadLayout(name: string): Layout {
  if (!/^[\w-]+$/.test(name)) throw new QaError('config-invalid', 'a layout name has letters, digits, dashes and underscores only')
  const path = join(LAYOUT_DIR, `${name}.yaml`)
  const doc = readYaml(path)
  const errors = validateLayout(doc, path)
  if (errors.length) throw new QaError('config-invalid', errors.join('\n'))
  return doc as Layout
}

export function loadRelease(path: string): { cfg: ReleaseConfig; layout: Layout } {
  const doc = readYaml(path) as Rec
  const layout = nonEmpty(doc?.layout) ? loadLayout(str(doc.layout)) : undefined
  const errors = validateRelease(doc, path, layout)
  if (errors.length) throw new QaError('config-invalid', errors.join('\n'))
  return { cfg: doc as unknown as ReleaseConfig, layout: layout! }
}

export const releasePath = (release: string): string => join(CONFIG_DIR, `${release}.yaml`)

/** Release files with `active: true` and a report_page. A file that can't be read is listed, to fail when loaded. */
export function activeReleases(dir = CONFIG_DIR): string[] {
  return (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort() : []).map((f) => join(dir, f)).filter((path) => {
    try {
      const doc = loadYaml(path) as Rec
      return doc?.active === true && doc.report_page !== undefined
    } catch {
      return true
    }
  })
}

/** Validates every layout and release file; used by npm run validate and the tests. */
export function validateAll(dir = CONFIG_DIR): string[] {
  const errors: string[] = []
  const layouts = new Map<string, Layout>()
  const layoutDir = join(dir, 'layouts')
  for (const f of existsSync(layoutDir) ? readdirSync(layoutDir).filter((f) => f.endsWith('.yaml')) : []) {
    const doc = loadYaml(join(layoutDir, f))
    const e = validateLayout(doc, join(layoutDir, f))
    errors.push(...e)
    if (!e.length) layouts.set(basename(f, '.yaml'), doc as Layout)
  }
  for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : []) {
    const path = join(dir, f)
    const doc = loadYaml(path) as Rec
    const layout = layouts.get(str(doc?.layout))
    if (isRec(doc) && nonEmpty(doc.layout) && !layout) errors.push(`${path}: no valid layout "${doc.layout}"`)
    errors.push(...validateRelease(doc, path, layout))
    if (isRec(doc) && nonEmpty(doc.release) && basename(f, '.yaml') !== doc.release) {
      errors.push(`${path}: the file name must be the release name (${doc.release}.yaml)`)
    }
  }
  return errors
}
