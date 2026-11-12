// QA readiness report configuration: config/qa-readiness/<name>.yaml, and the layouts it
// names in config/qa-readiness/layouts/. Both are committed to a public repo, so they hold only
// what may be published: repo names, SHAs, Sonar keys, Jira keys, page ids, Jenkins job names,
// E2E tags and spec paths.
//
// A config is scoped to a release or to a feature:
//
//   release: R1.3A     the release's candidate commits (candidates) and its tickets (jql)
//   feature: <name>    one or more epics; each repo's service-wide rows are read at the latest
//                      finished build of its default branch (or a pinned commit), and the
//                      feature's E2E rows from a Jenkins build, usually a PR's (repos.*.e2e)
//
// A feature is loaded as a release-shaped config: `release` holds its name, `jql` its epics'
// child tickets, and `candidates` is empty until collection resolves each repo's commit
// (scopeFeature in collect.ts).

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadYaml } from '../data.ts'
import { RELEASE_NAME } from './cache.ts'
import { QaError } from './errors.ts'
import { JIRA_KEY, jiraKey, PAGE_ID } from './twg.ts'
import { isRec, nonEmpty, type Rec, SEGMENT, SHA, str } from './util.ts'

export const CONFIG_DIR = 'config/qa-readiness'
export const LAYOUT_DIR = join(CONFIG_DIR, 'layouts')

export interface RepoConfig {
  github: string // owner/name
  sonar?: string
  cosmos_product?: string
  cosmos_component?: string
  builder?: 'gradle' | 'yarn' // which security check its Jenkins build runs: dependency-check or yarn audit
  test_paths?: string // regex over repo-relative paths; the default suits Gradle and Node layouts
  /** Features only: the commit for service-wide rows, a branch (its latest finished Jenkins build) or a full SHA. */
  commit?: string
  /** Features only: where the feature's E2E tests ran, and which of them are the feature's. */
  e2e?: E2eConfig
}

export interface E2eConfig {
  jenkins: { job: string; branch: string; build?: 'last-completed' | number }
  /** Playwright tags in the test titles, such as @privateLandlord. */
  tags?: string[]
  /** Repo-relative spec files or directories. */
  paths?: string[]
}

export type ScopeKind = 'release' | 'feature'

export interface Candidate {
  name: string
  shas: Record<string, string>
}

export interface ReleaseConfig {
  kind?: ScopeKind // set when loaded; absent means release
  /** The release's name, or the feature's. */
  release: string
  epics?: string[]
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
  'perf-signoff', 'perf-required', 'security-signoff', 'human', 'e2e-feature', 'ignored-tests-feature', 'stories-done',
] as const

export const INFO_RULES = ['release', 'dashboards', 'outstanding-bugs', 'repos', 'revisions', 'human',
  'feature', 'epics', 'service-revision', 'e2e-build', 'generated'] as const

/** Rules only a feature config can answer. */
export const FEATURE_RULES = new Set(['e2e-feature', 'ignored-tests-feature', 'feature', 'epics', 'service-revision', 'e2e-build'])
/** Rules only a release config can answer. */
export const RELEASE_RULES = new Set(['release', 'revisions'])

const ROW_FIELDS = ['key', 'match', 'rule', 'question', 'good']


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

/** A top-level field's check: when it applies (undefined is skipped unless `required`), and what's wrong otherwise. */
interface FieldRule {
  key: string
  required?: boolean
  ok: (v: unknown) => boolean
  message: string
}

const NAME_MESSAGE = 'may have only letters, digits, dots, dashes and underscores'

const COMMON_RULES: FieldRule[] = [
  { key: 'layout', required: true, ok: nonEmpty, message: 'is required' },
  { key: 'active', required: true, ok: (v) => typeof v === 'boolean', message: 'must be true or false' },
  ...['report_page', 'ria_page'].map((key) => ({ key, ok: (v: unknown) => PAGE_ID.test(str(v)), message: 'must be a Confluence page id' })),
  { key: 'coverage_threshold', ok: (v) => typeof v === 'number' && v >= 0 && v <= 100, message: 'must be a percentage' },
  { key: 'test_complete_pattern', ok: (v) => isRegex(v, 'i'), message: 'is not a valid regular expression' },
  { key: 'bug_types', ok: (v) => Array.isArray(v) && v.length > 0 && v.every(nonEmpty), message: 'must be a list of issue type names' },
]

const RELEASE_FIELDS: FieldRule[] = [
  ...['release', 'jql'].map((key) => ({ key, required: true, ok: nonEmpty, message: 'is required' })),
  { key: 'release', ok: (v) => !nonEmpty(v) || RELEASE_NAME.test(v), message: NAME_MESSAGE },
  ...COMMON_RULES,
]

const FEATURE_FIELDS: FieldRule[] = [
  { key: 'feature', required: true, ok: (v) => nonEmpty(v) && RELEASE_NAME.test(v) && !v.includes('..'), message: `is required, and ${NAME_MESSAGE}` },
  { key: 'epics', required: true, ok: (v) => Array.isArray(v) && v.length > 0 && v.every((k) => JIRA_KEY.test(str(k))), message: 'must be a list of Jira epic keys' },
  { key: 'jql', ok: () => false, message: "is not used by a feature: its Jira scope is its epics' child tickets" },
  { key: 'candidates', ok: () => false, message: "is not used by a feature: each repo's commit is its `commit`" },
  ...COMMON_RULES,
]

const REPO_RULES: FieldRule[] = [
  { key: 'github', required: true, ok: (v) => /^[\w.-]+\/[\w.-]+$/.test(str(v)), message: 'must look like owner/name' },
  { key: 'builder', ok: (v) => v === 'gradle' || v === 'yarn', message: 'must be gradle or yarn' },
  { key: 'test_paths', ok: (v) => isRegex(v), message: 'is not a valid regular expression' },
]

function checkFields(doc: Rec, rules: FieldRule[], where: string): string[] {
  return rules.filter((r) => (r.required || doc[r.key] !== undefined) && !r.ok(doc[r.key])).map((r) => `${where}: "${r.key}" ${r.message}`)
}

const BRANCH = /^[A-Za-z0-9][\w./-]*$/
const TAG = /^@[\w-]+$/
const shaOrBranch = (v: unknown) => typeof v === 'string' && (SHA.test(v) || (BRANCH.test(v) && !v.includes('..')))
const segments = (v: unknown) => typeof v === 'string' && v.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')
const repoPath = (v: unknown) => typeof v === 'string' && !v.startsWith('/') && segments(v.endsWith('/') ? v.slice(0, -1) : v)
const isList = (v: unknown, ok: (x: unknown) => boolean) => Array.isArray(v) && v.length > 0 && v.every(ok)

function validateE2e(e2e: unknown, w: string): string[] {
  if (!isRec(e2e)) return [`${w}: expected { jenkins, tags or paths }`]
  const errors: string[] = []
  for (const k of Object.keys(e2e)) if (!['jenkins', 'tags', 'paths'].includes(k)) errors.push(`${w}: unknown field "${k}"`)
  const j = e2e.jenkins
  if (isRec(j)) {
    for (const k of Object.keys(j)) if (!['job', 'branch', 'build'].includes(k)) errors.push(`${w}.jenkins: unknown field "${k}"`)
    if (!segments(j.job)) errors.push(`${w}.jenkins: "job" must be a Jenkins folder path such as HMCTS_j_to_z/pcs-api`)
    if (!segments(j.branch)) errors.push(`${w}.jenkins: "branch" must be a branch such as PR-1234, master or feature/x`)
    if (j.build !== undefined && j.build !== 'last-completed' && !(Number.isSafeInteger(j.build) && Number(j.build) > 0)) {
      errors.push(`${w}.jenkins: "build" must be last-completed or a build number`)
    }
  } else {
    errors.push(`${w}.jenkins: expected { job, branch, build }`)
  }
  if (e2e.tags === undefined && e2e.paths === undefined) errors.push(`${w}: set "tags", "paths" or both, to pick the feature's tests`)
  if (e2e.tags !== undefined && !isList(e2e.tags, (t) => TAG.test(str(t)))) errors.push(`${w}: "tags" must be a list of tags such as '@enforcement'`)
  if (e2e.paths !== undefined && !isList(e2e.paths, repoPath)) errors.push(`${w}: "paths" must be a list of repo-relative files or directories`)
  return errors
}

function validateRepos(repos: Rec, name: string, kind: ScopeKind): string[] {
  return Object.entries(repos).flatMap(([r, v]) => {
    const w = `${name}.repos.${r}`
    if (!isRec(v)) return [`${w}: expected a mapping`]
    const pair = (v.cosmos_product === undefined) !== (v.cosmos_component === undefined)
    const errors = [...checkFields(v, REPO_RULES, w), ...(pair ? [`${w}: set both "cosmos_product" and "cosmos_component", or neither`] : [])]
    if (kind === 'release') {
      for (const k of ['commit', 'e2e']) if (v[k] !== undefined) errors.push(`${w}: "${k}" is for feature configs; a release's commits are its candidates`)
      return errors
    }
    if (v.commit !== undefined && !shaOrBranch(v.commit)) errors.push(`${w}: "commit" must be a branch name or a full 40-character commit SHA`)
    if (v.e2e !== undefined) errors.push(...validateE2e(v.e2e, `${w}.e2e`))
    return errors
  })
}

/** Rows of the layout this kind of config can't answer. */
function validateLayoutFor(kind: ScopeKind, layout: Layout | undefined, name: string): string[] {
  if (!layout) return []
  const other = kind === 'release' ? FEATURE_RULES : RELEASE_RULES
  return [...(layout.info?.rows ?? []), ...layout.checklist.rows].filter((r) => other.has(r.rule))
    .map((r) => `${name}: layout row ${r.key} uses rule ${r.rule}, which a ${kind} config can't answer`)
}

function validateCandidates(candidates: unknown, repos: Rec, name: string): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [`${name}: "candidates" needs at least one candidate`]
  const errors: string[] = []
  const names = new Set<string>()
  candidates.forEach((c: unknown, n: number) => {
    const w = `${name}.candidates[${n}]`
    if (!isRec(c) || !nonEmpty(c.name)) return errors.push(`${w}: "name" is required`)
    if (names.has(c.name)) errors.push(`${name}: duplicate candidate ${c.name}`)
    names.add(c.name)
    if (!isRec(c.shas) || Object.keys(c.shas).length === 0) return errors.push(`${w}: "shas" needs a commit for at least one repo`)
    for (const [r, sha] of Object.entries(c.shas)) {
      if (!(r in repos)) errors.push(`${w}: "${r}" is not one of the repos`)
      if (!SHA.test(str(sha))) errors.push(`${w}: ${r} must be a full 40-character commit SHA`)
    }
  })
  return errors
}

function validateHumanRows(rows: unknown, name: string, layout?: Layout): string[] {
  if (rows === undefined) return []
  if (!isRec(rows)) return [`${name}: "human_rows" must map row keys to Jira keys`]
  const keys = new Set(layout?.checklist.rows.map((r) => r.key))
  return Object.entries(rows).flatMap(([row, v]) => {
    const list = Array.isArray(v) ? v : [v]
    return [
      ...(!list.length || !list.every((k) => JIRA_KEY.test(str(k))) ? [`${name}.human_rows.${row}: must be a Jira key or a list of them`] : []),
      ...(layout && !keys.has(row) ? [`${name}.human_rows.${row}: the layout has no row ${row}`] : []),
    ]
  })
}

function validateDashboards(dashboards: unknown, name: string): string[] {
  if (dashboards === undefined) return []
  if (!Array.isArray(dashboards)) return [`${name}: "dashboards" must be a list`]
  return dashboards.flatMap((d: unknown, n: number) => (isRec(d) && nonEmpty(d.label) && /^https:\/\/\S+$/.test(str(d.url))
    ? [] : [`${name}.dashboards[${n}]: needs a "label" and an https "url"`]))
}

/** A config file's kind: feature when it names one, else release. */
export const kindOf = (doc: Rec): ScopeKind => (doc.feature === undefined ? 'release' : 'feature')

/** The name the config's file must have: its release or its feature. */
export const nameOf = (doc: Rec): string => str(kindOf(doc) === 'feature' ? doc.feature : doc.release)

/** Checks a release or feature config file, as written (before it is loaded). */
export function validateRelease(doc: unknown, name = 'release', layout?: Layout): string[] {
  if (!isRec(doc)) return [`${name}: expected a mapping`]
  const kind = kindOf(doc)
  const repos = isRec(doc.repos) ? doc.repos : {}
  return [
    ...(kind === 'feature' && doc.release !== undefined ? [`${name}: set "release" or "feature", not both`] : []),
    ...checkFields(doc, kind === 'feature' ? FEATURE_FIELDS : RELEASE_FIELDS, name),
    ...(Object.keys(repos).length === 0 ? [`${name}: "repos" needs at least one repo`] : []),
    ...validateRepos(repos, name, kind),
    ...(kind === 'release' ? validateCandidates(doc.candidates, repos, name) : []),
    ...validateHumanRows(doc.human_rows, name, layout),
    ...validateDashboards(doc.dashboards, name),
    ...validateLayoutFor(kind, layout, name),
  ]
}

/** `parent in (…)`: an epic's child items, read as the roadmap reads them (scripts/lib/roadmap-runner.ts). */
export const epicsJql = (epics: string[]): string => `parent in (${epics.map(jiraKey).join(', ')})`

/** A checked config as the stages take it. A feature's commits are resolved when its evidence is collected. */
function normalise(doc: Rec): ReleaseConfig {
  if (kindOf(doc) === 'release') return { ...doc, kind: 'release' } as unknown as ReleaseConfig
  const { feature, ...rest } = doc
  const epics = (doc.epics as string[]).map(jiraKey)
  return { ...rest, kind: 'feature', release: str(feature), epics, jql: epicsJql(epics), candidates: [] } as unknown as ReleaseConfig
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
  return { cfg: normalise(doc), layout: layout! }
}

export const releasePath = (release: string): string => join(CONFIG_DIR, `${release}.yaml`)

/** Release and feature files with `active: true` and a report_page. A file that can't be read is listed, to fail when loaded. */
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
    if (isRec(doc) && nonEmpty(nameOf(doc)) && basename(f, '.yaml') !== nameOf(doc)) {
      errors.push(`${path}: the file name must be the ${kindOf(doc)} name (${nameOf(doc)}.yaml)`)
    }
  }
  return errors
}
