// A daily snapshot: the public-safe subset of the roadmap model, committed to data/snapshots/.
//
// The site is built only from snapshots, never from raw Jira, so this is the one place that
// decides what reaches the public: epic key, summary, status, dates and child-item counts, and
// for links to other Jira projects only the linked key, its status and the link wording.
// Child item summaries, descriptions and comments are never kept.

import { clean, type Config, type Model } from './roadmap-runner.ts'

export interface EpicRow {
  key: string
  url: string
  summary: string
  status: string
  category: string // new | indeterminate | done
  start: string | null
  due: string | null
  derived: number // dated child items the dates came from (0 = the epic's own dates)
  total: number
  counts: { done: number; indeterminate: number; new: number }
  clashes: number[] // clash numbers this epic takes part in
}

export interface Dependency {
  epic: string
  relation: string // e.g. "is blocked by"
  linked: string
  linkedUrl: string
  linkedStatus: string
  linkedCategory: string
}

export interface Snapshot {
  date: string
  generatedAt: string
  title: string
  project: string
  jiraUrl: string
  start: string
  end: string
  lanes: { title: string; subtitle: string; colour: string; rule: string; rows: EpicRow[] }[]
  clashes: { n: number; before: string; after: string; beforeDue: string; afterStart: string }[]
  withdrawn: string[]
  dependencies: Dependency[]
  totals: { epics: number; epicsDone: number; items: number; itemsDone: number; undated: number }
}

/** The link fields twg passes through (the generator's Issue type only declares keys). */
interface LinkedIssue { key: string; fields?: { status?: { name: string; statusCategory: { key: string } } } }
interface TwgLink { type: { name: string; inward?: string; outward?: string }; outwardIssue?: LinkedIssue; inwardIssue?: LinkedIssue }

const projectOf = (key: string) => key.split('-')[0]

export function toSnapshot(cfg: Config, m: Model, generatedAt: Date): Snapshot {
  const browse = (key: string) => `${m.jiraUrl.replace(/\/$/, '')}/browse/${key}`
  const clashes = m.clashes.map(([before, after], i) => ({
    n: i + 1, before, after, beforeDue: m.dates.get(before)!.due!, afterStart: m.dates.get(after)!.start!,
  }))
  const clashNumbers = (key: string) => clashes.filter((c) => c.before === key || c.after === key).map((c) => c.n)

  const lanes = m.lanes.map((L) => ({
    ...L,
    rows: L.rows.map((r): EpicRow => {
      const e = m.issues.get(r.key)!
      const d = m.dates.get(r.key)!
      return {
        key: r.key, url: browse(r.key), summary: clean(e.summary), status: e.status.name,
        category: e.status.statusCategory.key, start: d.start, due: d.due, derived: d.derived,
        total: r.total, counts: r.counts, clashes: clashNumbers(r.key),
      }
    }),
  }))

  const dependencies: Dependency[] = []
  for (const e of m.epics) {
    for (const l of (e.issuelinks ?? []) as TwgLink[]) {
      const other = l.outwardIssue ?? l.inwardIssue
      if (!other || projectOf(other.key) === cfg.project) continue
      const relation = (l.outwardIssue ? l.type.outward : l.type.inward) ?? l.type.name
      dependencies.push({
        epic: e.key, relation, linked: other.key, linkedUrl: browse(other.key),
        linkedStatus: other.fields?.status?.name ?? 'Unknown',
        linkedCategory: other.fields?.status?.statusCategory.key ?? 'new',
      })
    }
  }

  const rows = lanes.flatMap((L) => L.rows)
  return {
    date: generatedAt.toISOString().slice(0, 10),
    generatedAt: generatedAt.toISOString(),
    title: m.title, project: m.project, jiraUrl: m.jiraUrl, start: m.start, end: m.end,
    lanes, clashes, withdrawn: m.withdrawn, dependencies,
    totals: {
      epics: rows.length,
      epicsDone: rows.filter((r) => r.category === 'done').length,
      items: rows.reduce((n, r) => n + r.total, 0),
      itemsDone: rows.reduce((n, r) => n + r.counts.done, 0),
      undated: rows.filter((r) => !r.start).length,
    },
  }
}
