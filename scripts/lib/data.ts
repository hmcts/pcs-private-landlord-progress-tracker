// The hand-edited data files (src/_data/*.yaml): loading and validation.
//
// YAML is read with the JSON schema so dates stay strings ("2026-11-09"), not Date objects.
// Validation runs before every build (npm run build) and in the tests, so a bad PR fails CI
// instead of publishing a broken page.

import { readFileSync } from 'node:fs'
import { JSON_SCHEMA, load } from 'js-yaml'

export const loadYaml = (path: string): unknown => load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA })

const RAGS = ['red', 'amber', 'green']
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const RAID_TYPES = { R: 'risk', A: 'assumption', I: 'issue', D: 'dependency' } as const

export interface RaidEntry {
  id: string // R-001, A-001, I-001, D-001
  type: (typeof RAID_TYPES)[keyof typeof RAID_TYPES]
  title: string
  description?: string
  owner: string
  rag: 'red' | 'amber' | 'green'
  status: 'open' | 'closed'
  raised: string
  review?: string // required while open
  mitigation?: string
}

export interface DependencyEntry {
  id: string // DEP-001
  team: string
  need: string
  why?: string
  jira?: string
  needed_by?: string
  owner: string
  status: 'not-started' | 'in-progress' | 'blocked' | 'done'
  rag: 'red' | 'amber' | 'green'
}

export const NFR_CATEGORIES = {
  performance: 'PERF', accessibility: 'A11Y', security: 'SEC', reliability: 'REL',
  data: 'DAT', support: 'SUP', quality: 'QA', engineering: 'ENG',
} as const

export interface NfrStandard {
  id: string
  title: string
  url: string
  note?: string
}

export interface NfrEntry {
  id: string // PERF-01, QA-01, ...
  category: keyof typeof NFR_CATEGORIES
  requirement: string
  target?: string
  ref?: string // the requirement's ID in the source
  source: string // a standard's id
  url?: string
}

export interface Nfrs {
  standards: NfrStandard[]
  nfrs: NfrEntry[]
}

export interface Overview {
  rag: 'red' | 'amber' | 'green'
  headline: string
  updated: string
  milestones: { date: string; title: string; status?: string }[]
}

type Rec = Record<string, unknown>
const str = (o: Rec, k: string) => typeof o[k] === 'string' && (o[k] as string).trim() !== ''

function check(errors: string[], where: string, o: Rec, required: string[], dates: string[], enums: Record<string, string[]>) {
  for (const k of required) if (!str(o, k)) errors.push(`${where}: "${k}" is required`)
  for (const k of dates) if (o[k] !== undefined && !DATE.test(String(o[k]))) errors.push(`${where}: "${k}" must be YYYY-MM-DD`)
  for (const [k, allowed] of Object.entries(enums)) {
    if (o[k] !== undefined && !allowed.includes(String(o[k]))) errors.push(`${where}: "${k}" must be one of ${allowed.join(', ')}`)
  }
}

function list(errors: string[], name: string, doc: unknown): Rec[] {
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) {
    errors.push(`${name}: expected a list`)
    return []
  }
  return doc as Rec[]
}

function uniqueIds(errors: string[], name: string, items: Rec[]) {
  const seen = new Set<string>()
  for (const i of items) {
    const id = String(i.id)
    if (seen.has(id)) errors.push(`${name}: duplicate id ${id}`)
    seen.add(id)
  }
}

export function validateRaid(doc: unknown): string[] {
  const errors: string[] = []
  const items = list(errors, 'raid', doc)
  items.forEach((o, n) => {
    const where = `raid[${n}] ${o.id ?? ''}`.trim()
    check(errors, where, o, ['id', 'type', 'title', 'owner', 'rag', 'status', 'raised'], ['raised', 'review'],
      { type: Object.values(RAID_TYPES), rag: RAGS, status: ['open', 'closed'] })
    const prefix = /^([RAID])-\d{3,}$/.exec(String(o.id ?? ''))
    if (!prefix) errors.push(`${where}: "id" must look like R-001, A-001, I-001 or D-001`)
    else if (RAID_TYPES[prefix[1] as keyof typeof RAID_TYPES] !== o.type) errors.push(`${where}: id prefix doesn't match type "${o.type}"`)
    if (o.status === 'open' && !str(o, 'review')) errors.push(`${where}: open entries need a "review" date`)
  })
  uniqueIds(errors, 'raid', items)
  return errors
}

export function validateDependencies(doc: unknown): string[] {
  const errors: string[] = []
  const items = list(errors, 'dependencies', doc)
  items.forEach((o, n) => {
    const where = `dependencies[${n}] ${o.id ?? ''}`.trim()
    check(errors, where, o, ['id', 'team', 'need', 'owner', 'status', 'rag'], ['needed_by'],
      { rag: RAGS, status: ['not-started', 'in-progress', 'blocked', 'done'] })
    if (!/^DEP-\d{3,}$/.test(String(o.id ?? ''))) errors.push(`${where}: "id" must look like DEP-001`)
    if (o.jira !== undefined && !/^[A-Z][A-Z0-9]+-\d+$/.test(String(o.jira))) errors.push(`${where}: "jira" must be an issue key`)
  })
  uniqueIds(errors, 'dependencies', items)
  return errors
}

const URL = /^https:\/\/\S+$/

export function validateNfrs(doc: unknown): string[] {
  const errors: string[] = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['nfrs: expected a mapping']
  const o = doc as Rec
  const standards = list(errors, 'nfrs.standards', o.standards)
  standards.forEach((s, n) => {
    const where = `nfrs.standards[${n}] ${s.id ?? ''}`.trim()
    check(errors, where, s, ['id', 'title', 'url'], [], {})
    if (str(s, 'url') && !URL.test(String(s.url))) errors.push(`${where}: "url" must be an https link`)
  })
  uniqueIds(errors, 'nfrs.standards', standards)
  const known = new Set(standards.map((s) => String(s.id)))
  const items = list(errors, 'nfrs.nfrs', o.nfrs)
  items.forEach((i, n) => {
    const where = `nfrs.nfrs[${n}] ${i.id ?? ''}`.trim()
    check(errors, where, i, ['id', 'category', 'requirement', 'source'], [], { category: Object.keys(NFR_CATEGORIES) })
    const prefix = NFR_CATEGORIES[i.category as keyof typeof NFR_CATEGORIES]
    if (prefix && !new RegExp(`^${prefix}-\\d{2,}$`).test(String(i.id ?? ''))) {
      errors.push(`${where}: "id" must look like ${prefix}-01 for category "${i.category}"`)
    }
    if (str(i, 'source') && !known.has(String(i.source))) errors.push(`${where}: "source" must be one of the standards' ids`)
    if (i.url !== undefined && !URL.test(String(i.url))) errors.push(`${where}: "url" must be an https link`)
  })
  uniqueIds(errors, 'nfrs.nfrs', items)
  return errors
}

export function validateOverview(doc: unknown): string[] {
  const errors: string[] = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['overview: expected a mapping']
  const o = doc as Rec
  check(errors, 'overview', o, ['rag', 'headline', 'updated'], ['updated'], { rag: RAGS })
  list(errors, 'overview.milestones', o.milestones).forEach((m, n) =>
    check(errors, `overview.milestones[${n}]`, m, ['date', 'title'], ['date'], {}))
  return errors
}
