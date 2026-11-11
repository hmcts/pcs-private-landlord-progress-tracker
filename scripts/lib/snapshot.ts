// A daily snapshot: the public-safe subset of the roadmap model, committed to data/snapshots/.
//
// The site is built only from snapshots, never from raw Jira, so this is the one place that
// decides what reaches the public: epic key, summary, status, dates and child-item counts; each
// child ticket's key, summary (title), status and dates; and for links to other Jira projects
// only the linked key, its status and the link wording. Descriptions, comments, assignees and
// every other field are never kept.

import { addDays, clean, daysBetween, type Config, type Issue, type Model } from './roadmap-runner.ts'

export interface ItemRow {
  key: string
  url: string
  summary: string
  status: string
  category: string // new | indeterminate | done
  start: string
  due: string
  forecast: boolean // not dated in Jira, so placed by spreading the undated tickets across the window
}

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
  items?: ItemRow[] // child tickets, excluding Tests; absent from snapshots taken before tickets were published
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

const leadingNumber = (summary: string): number | null => {
  const m = /^\s*(\d+)/.exec(summary)
  return m ? Number(m[1]) : null
}

/** By the leading number in the summary ("12. Grounds…"), then unnumbered tickets by key. */
export function ticketOrder(a: { key: string; summary: string }, b: { key: string; summary: string }): number {
  const na = leadingNumber(a.summary)
  const nb = leadingNumber(b.summary)
  if (na !== null && nb !== null && na !== nb) return na - nb
  if ((na === null) !== (nb === null)) return na === null ? 1 : -1
  return a.key.localeCompare(b.key, 'en', { numeric: true })
}

/**
 * One epic's child tickets in ticketOrder, leaving out Tests. Tickets with both a Jira start and
 * due date keep them. The rest are laid end to end across start..end, each getting the same whole
 * number of days, and the last one runs to `end`.
 */
export function itemRows(children: Issue[], start: string, end: string, browse: (key: string) => string): ItemRow[] {
  const work = children.filter((c) => c.issuetype.name !== 'Test')
    .map((c) => ({ issue: c, key: c.key, summary: clean(c.summary) }))
    .sort(ticketOrder)
  const undated = work.filter((w) => !(w.issue.customfield_10015 && w.issue.duedate))
  const share = Math.max(1, Math.floor((daysBetween(start, end) + 1) / Math.max(1, undated.length)))
  const forecast = new Map(undated.map((w, i) => {
    const from = addDays(start, i * share)
    const to = i === undated.length - 1 ? [end, from].sort().at(-1)! : addDays(from, share - 1)
    return [w.key, { start: from, due: to }]
  }))
  return work.map(({ issue: c, key, summary }) => {
    const f = forecast.get(key)
    return {
      key, url: browse(key), summary, status: c.status.name, category: c.status.statusCategory.key,
      start: f ? f.start : c.customfield_10015!.slice(0, 10),
      due: f ? f.due : c.duedate!.slice(0, 10),
      forecast: !!f,
    }
  })
}

export function toSnapshot(cfg: Config, m: Model, generatedAt: Date): Snapshot {
  const browse = (key: string) => `${m.jiraUrl.replace(/\/$/, '')}/browse/${key}`
  const clashes = m.clashes.map(([before, after], i) => ({
    n: i + 1, before, after, beforeDue: m.dates.get(before)!.due!, afterStart: m.dates.get(after)!.start!,
  }))
  const clashNumbers = (key: string) => clashes.filter((c) => c.before === key || c.after === key).map((c) => c.n)

  const children = new Map<string, Issue[]>()
  for (const i of m.issues.values()) {
    const p = i.parent?.key
    if (p) children.set(p, [...(children.get(p) ?? []), i])
  }

  const lanes = m.lanes.map((L) => ({
    ...L,
    rows: L.rows.map((r): EpicRow => {
      const e = m.issues.get(r.key)!
      const d = m.dates.get(r.key)!
      return {
        key: r.key, url: browse(r.key), summary: clean(e.summary), status: e.status.name,
        category: e.status.statusCategory.key, start: d.start, due: d.due, derived: d.derived,
        total: r.total, counts: r.counts, clashes: clashNumbers(r.key),
        items: itemRows(children.get(r.key) ?? [], m.start, m.end, browse),
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
