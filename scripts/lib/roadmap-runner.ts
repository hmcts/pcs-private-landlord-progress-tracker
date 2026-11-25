// Copied from hmcts/cft-workspace apps/pcs/.claude/scripts/lib/roadmap/roadmap-runner.ts (ccba10d),
// the generator behind the /pcs:roadmap poster. Copy changes across by hand. Changed here since:
// the optional config "end", the earliest date the timeline runs to; the start date falling
// back to customfield_10269 (see twgQuery); and twgQuery's optional fields, which the QA
// readiness report's Jira reader (scripts/lib/qa/sources/jira.ts) passes; and the stories and
// tasks pages after the poster, with ticketOrder moved here from snapshot.ts.
//
// Release roadmap poster for HDPI epics: one row per epic, in rule-based swimlanes.
//
// Driven by ../../roadmap (the bash wrapper). Two subcommands:
//
//   fetch --config <lanes.json> --out <data.json>
//       Reads Jira through `twg`, read-only: the only command ever run is
//       `twg jira workitem query`. Fetches every epic in the configured project that
//       carries one of the swimlane labels, then all of those epics' child items.
//
//   build --config <lanes.json> --data <data.json> --out <roadmap.pdf> [--today YYYY-MM-DD]
//       Draws an A3 landscape PDF in the style of the Confluence Roadmap Planner: a poster
//       page with coloured swimlanes, a month/week header, a today marker, and one row per
//       epic with its status, child-item progress and a bar from Start date to Due date;
//       then as many pages as it takes listing each epic's stories and tasks (Tests left
//       out) on the same timeline.
//
// Swimlane rule: an epic goes in the first lane whose `label` it carries and, when the
// lane sets `component`, whose component name starts with that prefix. So each epic
// appears once. Withdrawn epics are left out (and listed in the footer).
//
// Dates: epic Start date (customfield_10015) to Due date. An undated epic with dated
// child items gets a dashed bar across their dates; otherwise its row says "No dates in
// Jira". A one-day epic is drawn as a milestone. An epic that ended before `start` gets
// an "Ended" note instead of a bar. The timeline runs from `start` to the end of the
// month of the latest date shown (at least 90 days).
//
// Dependency clashes: Finish-to-Start links where the successor starts before its
// predecessor ends are outlined in red, numbered, and listed in the footer.

import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { inside } from './paths.ts'
import { commandPath } from './qa/util.ts'

// ------------------------------------------------------------------ types

export interface Lane {
  title: string
  subtitle?: string
  colour: string
  label: string
  component?: string
}

export interface Config {
  title: string
  project: string
  jira_url: string
  start: string
  end?: string
  lanes: Lane[]
}

/** The subset of a Jira REST issue (as twg returns it) that the roadmap reads. */
export interface Issue {
  key: string
  summary: string
  issuetype: { name: string }
  status: { name: string; statusCategory: { key: string } }
  labels?: string[]
  components?: { name: string }[]
  parent?: { key: string } | null
  duedate?: string | null
  customfield_10015?: string | null
  customfield_10269?: string | null
  issuelinks?: IssueLink[]
}

export interface IssueLink {
  type: { name: string }
  outwardIssue?: { key: string }
  inwardIssue?: { key: string }
}

export interface EpicDates {
  start: string | null // ISO yyyy-mm-dd
  due: string | null
  derived: number // number of dated child items the dates came from (0 = the epic's own)
}

export interface Row {
  key: string
  total: number // child items, Tests excluded
  counts: { done: number; indeterminate: number; new: number }
}

export interface Model {
  title: string
  project: string
  jiraUrl: string
  start: string
  end: string
  today: string
  lanes: { title: string; subtitle: string; colour: string; rule: string; rows: Row[] }[]
  issues: Map<string, Issue>
  epics: Issue[]
  dates: Map<string, EpicDates>
  fs: [string, string][]
  clashes: [string, string][]
  withdrawn: string[]
}

export const FIELDS = 'summary,status,issuetype,parent,duedate,customfield_10015,customfield_10269,components,issuelinks,labels'

// ------------------------------------------------------------------ dates (UTC, ISO strings)

const DAY = 86_400_000
export const toDate = (iso: string): Date => new Date(`${iso.slice(0, 10)}T00:00:00Z`)
export const iso = (d: Date): string => d.toISOString().slice(0, 10)
export const addDays = (isoDate: string, n: number): string => iso(new Date(toDate(isoDate).getTime() + n * DAY))
export const daysBetween = (a: string, b: string): number => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY)
const byCodeUnit = (a: string, b: string): number => Number(a > b) - Number(a < b)

/** Last day of the month that `isoDate` falls in. */
export function endOfMonth(isoDate: string): string {
  const d = toDate(isoDate)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December']
/** "02 Nov", "02 Nov 2026", "2 Nov" … in the formats the poster uses. */
export function fmt(isoDate: string, style: 'dd Mon' | 'dd Mon yyyy' | 'd Mon' | 'd Mon yyyy' | 'Mon yyyy' | 'Month yyyy'): string {
  const d = toDate(isoDate)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mon = MONTHS[d.getUTCMonth()]
  const y = d.getUTCFullYear()
  switch (style) {
    case 'dd Mon': return `${dd} ${mon}`
    case 'dd Mon yyyy': return `${dd} ${mon} ${y}`
    case 'd Mon': return `${d.getUTCDate()} ${mon}`
    case 'd Mon yyyy': return `${d.getUTCDate()} ${mon} ${y}`
    case 'Mon yyyy': return `${mon} ${y}`
    case 'Month yyyy': return `${MONTHS_LONG[d.getUTCMonth()]} ${y}`
  }
}

// ------------------------------------------------------------------ config + model

export function loadConfig(path: string): Config {
  const cfg = JSON.parse(readFileSync(inside('config', path), 'utf8')) as Config
  for (const k of ['title', 'project', 'jira_url', 'start', 'lanes'] as const) {
    if (cfg[k] === undefined) throw new Error(`config ${path} is missing "${k}"`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.start)) throw new Error(`config "start" must be YYYY-MM-DD, got "${cfg.start}"`)
  if (cfg.end !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.end)) throw new Error(`config "end" must be YYYY-MM-DD, got "${cfg.end}"`)
  if (!Array.isArray(cfg.lanes) || cfg.lanes.length === 0) throw new Error('config needs at least one lane')
  for (const l of cfg.lanes) {
    if (!l.title || !l.label || !l.colour) throw new Error(`each lane needs title, label and colour: ${JSON.stringify(l)}`)
  }
  return cfg
}

/** Index of the first lane whose rule the issue matches, or null. */
export function laneOf(issue: Issue, lanes: Lane[]): number | null {
  const labels = issue.labels ?? []
  const names = (issue.components ?? []).map((c) => c.name)
  for (let n = 0; n < lanes.length; n++) {
    const L = lanes[n]
    if (labels.includes(L.label) && (!L.component || names.some((x) => x.startsWith(L.component!)))) return n
  }
  return null
}

const isEpic = (i: Issue) => i.issuetype.name === 'Epic'

/** Strips the "(Product Cat Ref: …)" suffixes HDPI puts in epic summaries. */
export const clean = (t: string): string => {
  const parts = t.split(/\(Product Cat Ref[^)]*\)?/)
  return parts.map((p, i) => (i < parts.length - 1 ? p.trimEnd() : p)).join('').trim()
}

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

export function buildModel(cfg: Config, all: Issue[], today: string): Model {
  const issues = new Map(all.map((i) => [i.key, i]))
  const children = new Map<string, Issue[]>()
  for (const i of all) {
    const p = i.parent?.key
    if (p) children.set(p, [...(children.get(p) ?? []), i])
  }

  const epics = all.filter((i) => isEpic(i) && i.status.name !== 'Withdrawn' && laneOf(i, cfg.lanes) !== null)
  const withdrawn = all.filter((i) => isEpic(i) && i.status.name === 'Withdrawn' && laneOf(i, cfg.lanes) !== null)
    .map((i) => i.key)

  const dates = new Map<string, EpicDates>()
  for (const e of epics) {
    let start = e.customfield_10015 ?? null
    let due = e.duedate ?? null
    let derived = 0
    if (!(start && due)) {
      const dated = (children.get(e.key) ?? []).filter((c) => c.customfield_10015 && c.duedate)
      if (dated.length) {
        start = dated.map((c) => c.customfield_10015!.slice(0, 10)).sort(byCodeUnit)[0]
        due = dated.map((c) => c.duedate!.slice(0, 10)).sort(byCodeUnit).at(-1)!
        derived = dated.length
      } else {
        start = due = null
      }
    }
    dates.set(e.key, { start: start?.slice(0, 10) ?? null, due: due?.slice(0, 10) ?? null, derived })
  }

  const lanes = cfg.lanes.map((L, n) => {
    const rows: Row[] = epics.filter((e) => laneOf(e, cfg.lanes) === n).map((e) => {
      const work = (children.get(e.key) ?? []).filter((c) => c.issuetype.name !== 'Test')
      const counts = { done: 0, indeterminate: 0, new: 0 }
      for (const c of work) {
        const k = c.status.statusCategory.key as keyof typeof counts
        if (k in counts) counts[k]++
      }
      return { key: e.key, total: work.length, counts }
    })
    const sortKey = (r: Row) => {
      const d = dates.get(r.key)!
      return [d.start === null ? 1 : 0, d.start ?? '9999', d.due ?? '9999', r.key].join('|')
    }
    rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
    const rule = L.label + (L.component ? ` + ${L.component}` : '')
    return { title: L.title, subtitle: L.subtitle ?? '', colour: L.colour, rule, rows }
  })

  const dueDates = [...dates.values()].map((d) => d.due).filter((d): d is string => !!d)
  const last = [...dueDates, cfg.end ?? addDays(cfg.start, 89)].sort(byCodeUnit).at(-1)!
  const end = endOfMonth(last)

  const fsSet = new Set<string>()
  for (const i of all) {
    for (const l of i.issuelinks ?? []) {
      if (!l.type.name.startsWith('Finish to Start')) continue
      if (l.outwardIssue) fsSet.add(`${i.key}>${l.outwardIssue.key}`)
      else if (l.inwardIssue) fsSet.add(`${l.inwardIssue.key}>${i.key}`)
    }
  }
  const fs = [...fsSet].sort(byCodeUnit).map((p) => p.split('>') as [string, string])
    .filter(([p, s]) => dates.get(p)?.start && dates.get(s)?.start)
  const clashes = fs.filter(([p, s]) => dates.get(p)!.due! >= dates.get(s)!.start!)

  return { title: cfg.title, project: cfg.project, jiraUrl: cfg.jira_url, start: cfg.start, end, today, lanes,
    issues, epics, dates, fs, clashes, withdrawn }
}

// ------------------------------------------------------------------ fetch (read-only)

/** Runs one twg command and returns stdout. Injected in tests. */
export type TwgRunner = (args: string[]) => string

export const defaultRunner: TwgRunner = (args) =>
  execFileSync(commandPath('twg'), args, { encoding: 'utf8', env: { ...process.env, TWG_AGENT_DEFAULTS: '1' }, maxBuffer: 256 * 1024 * 1024 })

const READ_ONLY = ['jira', 'workitem', 'query']

/** All issues for a JQL query, following pagination. Only ever runs `twg jira workitem query`. */
export function twgQuery(jql: string, run: TwgRunner = defaultRunner, fields = FIELDS): Issue[] {
  const out: Issue[] = []
  let cursor: string | undefined
  for (;;) {
    const args = [...READ_ONLY, '--jql', jql, '--fields', fields, '-n', '100', '-o', 'json', '--output-summary', 'none']
    if (cursor) args.push('--after', cursor)
    if (args.slice(0, 3).join(' ') !== READ_ONLY.join(' ')) throw new Error('roadmap only reads from Jira')
    let page: { data: { issues: Issue[] }; pageInfo?: { hasNextPage?: boolean; nextCursor?: string } }
    try {
      page = JSON.parse(run(args))
    } catch (e) {
      throw new Error(`twg failed for: ${jql}\n${(e as Error).message}`)
    }
    // HDPI has two fields named "Start date". Most epics use customfield_10015, but the one on
    // the HDPI screens is customfield_10269, so use it when customfield_10015 is empty.
    for (const i of page.data.issues) i.customfield_10015 = i.customfield_10015 || i.customfield_10269 || null
    out.push(...page.data.issues)
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.nextCursor) return out
    cursor = page.pageInfo.nextCursor
  }
}

export function epicJql(cfg: Config): string {
  const labels = [...new Set(cfg.lanes.map((l) => l.label))].sort(byCodeUnit).map((l) => `"${l}"`).join(', ')
  return `project = ${cfg.project} AND issuetype = Epic AND labels in (${labels}) ORDER BY key`
}

export function fetchIssues(cfg: Config, run: TwgRunner = defaultRunner): { issues: Issue[]; epics: number } {
  const epics = twgQuery(epicJql(cfg), run)
  const keys = epics.map((e) => e.key)
  const found = [...epics]
  for (let n = 0; n < keys.length; n += 50) {
    found.push(...twgQuery(`parent in (${keys.slice(n, n + 50).join(',')})`, run))
  }
  const byKey = new Map<string, Issue>()
  for (const i of found) if (!byKey.has(i.key)) byKey.set(i.key, i)
  return { issues: [...byKey.values()], epics: keys.length }
}

// ------------------------------------------------------------------ drawing

const INK = '#172b4d'
const SUB = '#5e6c84'
const GRID = '#dfe1e6'
const RED = '#de350b'
const EPIC_PURPLE = '#904ee2'
const CAT: Record<string, string> = { new: '#97a0af', indeterminate: '#0052cc', done: '#36b37e' }
const CAT_TXT: Record<string, string> = { new: '#42526e', indeterminate: '#0747a6', done: '#006644' }
const CAT_BG: Record<string, string> = { new: '#dfe1e6', indeterminate: '#deebff', done: '#e3fcef' }

/** Mixes `hex` towards white by fraction f (0 = unchanged, 1 = white). */
export function tint(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * f))
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('')
}

export interface RenderOptions {
  /** 'auto' uses Liberation Sans or Arial when installed, else Helvetica; 'builtin' always uses Helvetica. */
  fonts?: 'auto' | 'builtin'
  /** pdfkit stream compression; tests turn it off to read the text back. */
  compress?: boolean
}

const FONT_CANDIDATES: [string, string][] = [
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
]

/** Draws the model to `out` and resolves once the file is written. */
export function renderPdf(m: Model, out: string, opts: RenderOptions = {}): Promise<void> {
  // A3 landscape in points. Drawing helpers take bottom-left coordinates (y up), as the
  // layout is designed that way, and convert to pdfkit's top-left (y down).
  const W = 1190.55
  const H = 841.89
  const doc = new PDFDocument({ size: [W, H], margin: 0, compress: opts.compress ?? true,
    info: { Title: m.title, Creator: 'pcs:roadmap' } })
  const done = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(out)
    stream.on('finish', () => resolve())
    stream.on('error', reject)
    doc.pipe(stream)
  })

  let REG = 'Helvetica'
  let BOLD = 'Helvetica-Bold'
  if ((opts.fonts ?? 'auto') === 'auto') {
    const found = FONT_CANDIDATES.find(([r, b]) => existsSync(r) && existsSync(b))
    if (found) {
      doc.registerFont('Sans', found[0])
      doc.registerFont('Sans-Bold', found[1])
      REG = 'Sans'
      BOLD = 'Sans-Bold'
    }
  }

  const Y = (y: number) => H - y
  const width = (s: string, font: string, size: number) => doc.font(font).fontSize(size).widthOfString(s)
  const fit = (s: string, font: string, size: number, w: number): string => {
    if (width(s, font, size) <= w) return s
    let t = s
    while (t && width(t + '...', font, size) > w) t = t.slice(0, -1)
    return t ? t.trimEnd() + '...' : ''
  }
  const text = (s: string, x: number, y: number, font: string, size: number, colour: string,
    align: 'left' | 'center' | 'right' = 'left') => {
    doc.font(font).fontSize(size).fillColor(colour)
    const w = doc.widthOfString(s)
    const x0 = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w
    doc.text(s, x0, Y(y), { baseline: 'alphabetic', lineBreak: false })
  }
  interface Style { fill?: string; stroke?: string; lw?: number; dash?: [number, number]; fillOpacity?: number;
    strokeOpacity?: number }
  const paint = (s: Style) => {
    if (s.lw !== undefined) doc.lineWidth(s.lw)
    if (s.dash) doc.dash(s.dash[0], { space: s.dash[1] })
    if (s.fill && s.stroke) {
      doc.fillColor(s.fill, s.fillOpacity ?? 1).strokeColor(s.stroke, s.strokeOpacity ?? 1).fillAndStroke()
    } else if (s.fill) doc.fillColor(s.fill, s.fillOpacity ?? 1).fill()
    else if (s.stroke) doc.strokeColor(s.stroke, s.strokeOpacity ?? 1).stroke()
    doc.undash()
    doc.fillOpacity(1).strokeOpacity(1)
  }
  const rect = (x: number, y: number, w: number, h: number, s: Style) => { doc.rect(x, Y(y + h), w, h); paint(s) }
  const rrect = (x: number, y: number, w: number, h: number, r: number, s: Style) => {
    doc.roundedRect(x, Y(y + h), w, h, r); paint(s)
  }
  const line = (x1: number, y1: number, x2: number, y2: number, s: Style) => {
    doc.moveTo(x1, Y(y1)).lineTo(x2, Y(y2)); paint(s)
  }
  const circle = (x: number, y: number, r: number, s: Style) => { doc.circle(x, Y(y), r); paint(s) }
  const poly = (pts: [number, number][], s: Style) => {
    doc.polygon(...pts.map(([x, y]) => [x, Y(y)] as [number, number])); paint(s)
  }
  const link = (x: number, y: number, w: number, h: number, url: string) => doc.link(x, Y(y + h), w, h, url)
  const arrowhead = (x: number, y: number, size: number, colour: string, opacity = 1) =>
    poly([[x, y], [x - size, y + size * 0.6], [x - size, y - size * 0.6]], { fill: colour, fillOpacity: opacity })
  const epicIcon = (x: number, y: number, s = 9) => {
    rrect(x, y, s, s, 1.8, { fill: EPIC_PURPLE })
    poly([[x + s * 0.58, y + s * 0.88], [x + s * 0.26, y + s * 0.45], [x + s * 0.48, y + s * 0.45],
      [x + s * 0.40, y + s * 0.12], [x + s * 0.74, y + s * 0.56], [x + s * 0.52, y + s * 0.56]], { fill: '#ffffff' })
  }

  const M = 28
  const BAND_W = 38
  const LIST_W = 300
  const LIST_X = M + BAND_W
  const TL_X0 = LIST_X + LIST_W
  const TL_X1 = W - M
  const DAYS = daysBetween(m.start, m.end) + 1
  const PX = (TL_X1 - TL_X0) / DAYS
  const xOf = (d: string) => TL_X0 + daysBetween(m.start, d) * PX
  const todayTxt = fmt(m.today, 'd Mon')
  const todayLong = fmt(m.today, 'd Mon yyyy')

  // ---- title and legend
  const top = H - M
  text(m.title, M, top - 20, BOLD, 22, INK)
  text(`${m.epics.length} ${m.project} epics  ·  ${m.lanes.length} swimlanes  ·  ` +
    `${fmt(m.start, 'Mon yyyy')} – ${fmt(m.end, 'Mon yyyy')}  ·  snapshot ${todayLong}`, M, top - 36, REG, 10, SUB)

  let lx = W - M
  const ly = top - 36
  const legend: [string, string][] = [['bar', 'Epic dates (Start to Due)'], ['dash', 'Dated from child items'],
    ['none', 'No dates in Jira'], ['mile', 'Milestone (one day)'], ['arrow', 'Finish-to-start'], ['clash', 'Dependency clash']]
  for (const [kind, label] of legend.reverse()) {
    lx -= width(label, REG, 7.8)
    text(label, lx, ly, REG, 7.8, SUB)
    lx -= 22
    if (kind === 'bar') rrect(lx, ly - 1, 18, 8, 2, { fill: tint('#3b7fc4', 0.55), stroke: '#3b7fc4' })
    else if (kind === 'dash') rrect(lx, ly - 1, 18, 8, 2, { fill: tint('#3b7fc4', 0.85), stroke: '#3b7fc4', dash: [2, 1.5] })
    else if (kind === 'none') rrect(lx, ly - 1, 18, 8, 2, { stroke: '#a5adba', dash: [1, 1.5] })
    else if (kind === 'mile') poly([[lx + 9, ly + 8], [lx + 14, ly + 3], [lx + 9, ly - 2], [lx + 4, ly + 3]], { fill: INK })
    else if (kind === 'arrow') { line(lx, ly + 3, lx + 14, ly + 3, { stroke: '#42526e', lw: 1 }); arrowhead(lx + 18, ly + 3, 4, '#42526e') }
    else { circle(lx + 9, ly + 3, 4.8, { fill: RED }); text('1', lx + 9, ly + 0.9, BOLD, 6.3, '#ffffff', 'center') }
    lx -= 14
  }

  // ---- header
  const HDR_TOP = top - 58
  const MONTH_H = 18
  const WEEK_H = 14
  const hdrBottom = HDR_TOP - MONTH_H - WEEK_H

  const months: [string, string][] = []
  for (let mStart = m.start.slice(0, 8) + '01'; mStart <= m.end; mStart = addDays(endOfMonth(mStart), 1)) {
    months.push([mStart < m.start ? m.start : mStart, endOfMonth(mStart) > m.end ? m.end : endOfMonth(mStart)])
  }
  const weeks: string[] = []
  const dow = (toDate(m.start).getUTCDay() + 6) % 7 // Monday = 0
  for (let wk = addDays(m.start, -dow); wk <= m.end; wk = addDays(wk, 7)) weeks.push(wk)

  const header = (left: string, right: string) => {
    rect(M, hdrBottom, BAND_W + LIST_W, MONTH_H + WEEK_H, { fill: '#f4f5f7', stroke: GRID, lw: 1 })
    text(left, LIST_X + 6, hdrBottom + 11, BOLD, 9, INK)
    text(right, TL_X0 - 8, hdrBottom + 11, BOLD, 9, INK, 'right')
    months.forEach(([a, b], idx) => {
      const x0 = xOf(a)
      const x1 = xOf(b) + PX
      rect(x0, HDR_TOP - MONTH_H, x1 - x0, MONTH_H, { fill: idx % 2 === 0 ? '#f4f5f7' : '#ffffff', stroke: GRID, lw: 1 })
      const label = x1 - x0 > 90 ? fmt(a, 'Month yyyy') : x1 - x0 > 45 ? fmt(a, 'Mon yyyy') : ''
      if (label) text(label, (x0 + x1) / 2, HDR_TOP - MONTH_H + 5.5, BOLD, 10, INK, 'center')
    })
    for (const wk of weeks) {
      const x0 = xOf(wk < m.start ? m.start : wk)
      rect(x0, hdrBottom, Math.min(7 * PX, TL_X1 - x0), WEEK_H, { fill: '#ffffff', stroke: GRID, lw: 1 })
      if (7 * PX > 22) text(fmt(wk, 'd Mon'), x0 + 2.5, hdrBottom + 4, REG, 6.8, SUB)
    }
  }
  const shadeMonths = (gridBottom: number) => months.forEach(([a, b], idx) => {
    if (idx % 2 === 0) rect(xOf(a), gridBottom, xOf(b) + PX - xOf(a), hdrBottom - gridBottom, { fill: '#fafbfc' })
  })
  const weekLines = (gridBottom: number) => {
    for (const wk of weeks) if (wk > m.start) line(xOf(wk), gridBottom, xOf(wk), hdrBottom, { stroke: '#ffffff', lw: 0.8 })
  }
  const todayLine = (gridBottom: number) => {
    if (m.today < m.start || m.today > m.end) return
    const tx = xOf(m.today) + PX / 2
    line(tx, gridBottom, tx, HDR_TOP + 2, { stroke: RED, lw: 1.1 })
    const label = `Today ${todayTxt}`
    const w = width(label, BOLD, 7) + 8
    rrect(tx - w / 2, HDR_TOP + 2, w, 11, 2, { fill: RED })
    text(label, tx, HDR_TOP + 5.2, BOLD, 7, '#ffffff', 'center')
  }
  /** The coloured swimlane band, its title rotated to read bottom to top. */
  const laneBand = (L: { title: string; subtitle: string; colour: string }, top: number, bot: number) => {
    rrect(M, bot, BAND_W - 3, top - bot, 3, { fill: L.colour })
    const cx = M + (BAND_W - 3) / 2 + 3.5
    const cy = (top + bot) / 2
    const room = top - bot - 8
    let fs = 11
    while (fs > 7 && width(L.title, BOLD, fs) > room) fs -= 0.5
    let ss = 7.5
    while (ss > 5.5 && width(L.subtitle, REG, ss) > room) ss -= 0.25
    doc.save()
    doc.rotate(-90, { origin: [cx, Y(cy)] })
    text(fit(L.title, BOLD, fs, room), cx, cy - 2, BOLD, fs, '#ffffff', 'center')
    text(fit(L.subtitle, REG, ss, room), cx, cy - 2 - 10, REG, ss, '#ffffff', 'center')
    doc.restore()
  }
  const statusPill = (status: string, category: string, right: number, ymid: number): number => {
    const cat = category in CAT ? category : 'new'
    const st = status.toUpperCase()
    const sw = width(st, BOLD, 5.8) + 6
    rrect(right - sw, ymid - 3.6, sw, 7.4, 1.5, { fill: CAT_BG[cat] })
    text(st, right - sw + 3, ymid - 1.7, BOLD, 5.8, CAT_TXT[cat])
    return right - sw
  }

  header('Epic', 'Child items done')

  // ---- swimlane geometry
  const LANE_GAP = 5
  const FOOTER_H = 92
  const EMPTY_H = 22
  const nRows = m.lanes.reduce((n, L) => n + Math.max(1, L.rows.length), 0)
  const ROW_H = Math.min(24.5, (hdrBottom - 4 - (m.lanes.length - 1) * LANE_GAP - (M + 6 + FOOTER_H + 8)) / nRows)
  let cur = hdrBottom - 4
  const geo = m.lanes.map((L) => {
    const t = cur
    const b = cur - (L.rows.length ? L.rows.length * ROW_H : Math.min(EMPTY_H, ROW_H))
    const rows = L.rows.map((r, i) => ({ ...r, ytop: t - i * ROW_H, ymid: t - i * ROW_H - ROW_H / 2 }))
    cur = b - LANE_GAP
    return { ...L, top: t, bot: b, rows }
  })
  const gridBottom = cur + LANE_GAP

  shadeMonths(gridBottom)

  for (const L of geo) {
    laneBand(L, L.top, L.bot)
    L.rows.forEach((r, i) => rect(LIST_X, r.ytop - ROW_H, TL_X1 - LIST_X, ROW_H, { fill: tint(L.colour, i % 2 === 0 ? 0.94 : 0.88) }))
    if (!L.rows.length) {
      rect(LIST_X, L.bot, TL_X1 - LIST_X, L.top - L.bot, { fill: tint(L.colour, 0.92) })
      text("No epics match this swimlane's rule.", LIST_X + 6, L.bot + (L.top - L.bot) / 2 - 3, REG, 8, SUB)
    }
    line(TL_X0, L.bot, TL_X0, L.top, { stroke: GRID, lw: 0.6 })
  }

  weekLines(gridBottom)
  todayLine(gridBottom)

  // ---- rows
  const badges = new Map<string, number[]>()
  m.clashes.forEach((pair, n) => pair.forEach((k) => badges.set(k, [...(badges.get(k) ?? []), n + 1])))
  const placed = new Map<string, { x0: number; x1: number; ymid: number; lane: number }[]>()
  const browse = (k: string) => `${m.jiraUrl}/browse/${k}`

  geo.forEach((L, laneIdx) => {
    for (const r of L.rows) {
      const e = m.issues.get(r.key)!
      const { ytop, ymid } = r
      epicIcon(LIST_X + 5, ymid - 4.5)
      text(r.key, LIST_X + 18, ymid - 2.7, BOLD, 7.6, INK)
      const kw = width(r.key, BOLD, 7.6)
      const pw = 46
      const px = TL_X0 - 8 - pw
      let ptxt = '–'
      if (r.total) {
        let sx = px
        for (const cat of ['done', 'indeterminate', 'new'] as const) {
          const part = (pw * r.counts[cat]) / r.total
          if (part) { rect(sx, ymid - 2, part, 4, { fill: CAT[cat] }); sx += part }
        }
        ptxt = `${r.counts.done}/${r.total}`
      } else {
        rect(px, ymid - 2, pw, 4, { stroke: '#c1c7d0', lw: 0.6 })
      }
      text(ptxt, px - 4, ymid - 2.5, REG, 7, SUB, 'right')
      const sx0 = statusPill(e.status.name, e.status.statusCategory.key, px - 4 - width('00/000', REG, 7) - 6, ymid)
      text(fit(clean(e.summary), REG, 7.6, sx0 - (LIST_X + 22 + kw) - 4), LIST_X + 22 + kw, ymid - 2.7, REG, 7.6, INK)
      link(LIST_X, ytop - ROW_H, TL_X0 - LIST_X, ROW_H, browse(r.key))

      const d = m.dates.get(r.key)!
      const bh = Math.min(13, ROW_H - 5)
      if (d.start && d.due && d.start === d.due && !d.derived && d.start >= m.start && d.start <= m.end) {
        const mx = xOf(d.start) + PX / 2
        const rr = bh / 2 + 1.5
        poly([[mx, ymid + rr], [mx + rr, ymid], [mx, ymid - rr], [mx - rr, ymid]], { fill: L.colour })
        text(fmt(d.start, 'dd Mon yyyy'), mx + rr + 3, ymid - 2.3, REG, 6.6, INK)
        placed.set(r.key, [...(placed.get(r.key) ?? []), { x0: mx - rr, x1: mx + rr, ymid, lane: laneIdx }])
      } else if (d.start && d.due && d.due < m.start) {
        const x0 = TL_X0 + 6
        const t = `Ended ${fmt(d.due, 'dd Mon yyyy')} (ran from ${fmt(d.start, 'dd Mon')})` + (d.derived ? ' (from child items)' : '')
        const tw = width(t, REG, 6.6) + 10
        rrect(x0, ymid - bh / 2, tw, bh, 2.5, { fill: tint(L.colour, 0.85), stroke: L.colour, lw: 0.7 })
        text(t, x0 + 5, ymid - 2.3, REG, 6.6, INK)
      } else if (d.start && d.due) {
        const x0 = xOf(d.start < m.start ? m.start : d.start)
        const x1 = xOf(d.due > m.end ? m.end : d.due) + PX
        rrect(x0, ymid - bh / 2, x1 - x0, bh, 2.5,
          { fill: tint(L.colour, d.derived ? 0.82 : 0.55), stroke: L.colour, lw: 0.9, dash: d.derived ? [2.5, 1.5] : undefined })
        if (badges.has(r.key)) rrect(x0 - 1, ymid - bh / 2 - 1, x1 - x0 + 2, bh + 2, 3, { stroke: RED, lw: 1.4 })
        let label = `${fmt(d.start, 'dd Mon')} – ${fmt(d.due, 'dd Mon')}`
        if (d.start < m.start) label = `from ${fmt(d.start, 'dd Mon yyyy')} – ${fmt(d.due, 'dd Mon')}`
        if (d.derived) label += ' (from child items)'
        const lw = width(label, REG, 6.6)
        const myBadges = badges.get(r.key) ?? []
        const badgeW = 11 * myBadges.length
        const inside = lw + 8 + badgeW <= x1 - x0
        if (inside) text(label, x0 + 4, ymid - 2.3, REG, 6.6, INK)
        else text(label, x1 + 3 + badgeW, ymid - 2.3, REG, 6.6, SUB)
        let bx = inside ? x1 - 2 : x1 + 9
        for (const n of [...myBadges].sort((a, b) => a - b)) {
          circle(bx - 4, ymid, 4.4, { fill: RED })
          text(String(n), bx - 4, ymid - 2, BOLD, 6, '#ffffff', 'center')
          bx += inside ? -10 : 10
        }
        placed.set(r.key, [...(placed.get(r.key) ?? []), { x0, x1, ymid, lane: laneIdx }])
        link(x0, ymid - bh / 2, x1 - x0, bh, browse(r.key))
      } else {
        const x0 = TL_X0 + 6
        rrect(x0, ymid - bh / 2, 84, bh, 2.5, { stroke: '#a5adba', lw: 0.7, dash: [1, 1.5] })
        text('No dates in Jira', x0 + 5, ymid - 2.3, REG, 6.6, SUB)
      }
    }
  })

  // Finish-to-start arrows within a swimlane; clashes are shown as badges instead.
  const clashKeys = new Set(m.clashes.map(([p, s]) => `${p}>${s}`))
  for (const [p, s] of m.fs) {
    if (clashKeys.has(`${p}>${s}`)) continue
    for (const a of placed.get(p) ?? []) {
      for (const b of placed.get(s) ?? []) {
        if (a.lane !== b.lane) continue
        const bend = Math.max(10, Math.abs(b.x0 - a.x1) * 0.5)
        doc.moveTo(a.x1, Y(a.ymid)).bezierCurveTo(a.x1 + bend, Y(a.ymid), b.x0 - bend, Y(b.ymid), b.x0, Y(b.ymid))
        paint({ stroke: '#42526e', strokeOpacity: 0.6, lw: 0.8 })
        arrowhead(b.x0, b.ymid, 4, '#42526e', 0.85)
      }
    }
  }

  // ---- footer panels
  const PANEL_TOP = gridBottom - 8
  const PANEL_BOT = M + 6
  const gap = 10
  const pw1 = (W - 2 * M - gap) * 0.58
  const pw2 = W - 2 * M - gap - pw1
  for (const [x, w] of [[M, pw1], [M + pw1 + gap, pw2]] as const) {
    rrect(x, PANEL_BOT, w, PANEL_TOP - PANEL_BOT, 4, { fill: '#f4f5f7', stroke: GRID, lw: 1 })
  }
  let yy = PANEL_TOP - 13
  text(`Dependency clashes (${m.clashes.length}): the later epic is planned to start before the earlier one ends`,
    M + 8, yy, BOLD, 9, INK)
  yy -= 11
  m.clashes.forEach(([p, s], n) => {
    if (yy < PANEL_BOT + 4) return
    const t = `(${n + 1}) ${p} ${clean(m.issues.get(p)!.summary)} must finish before ${s} ${clean(m.issues.get(s)!.summary)}` +
      `: ends ${fmt(m.dates.get(p)!.due!, 'dd Mon yyyy')}, successor starts ${fmt(m.dates.get(s)!.start!, 'dd Mon yyyy')}`
    text(fit(t, REG, 7.2, pw1 - 16), M + 8, yy, REG, 7.2, '#bf2600')
    yy -= 9.4
  })

  const x2 = M + pw1 + gap
  yy = PANEL_TOP - 13
  text('How to read this', x2 + 8, yy, BOLD, 9, INK)
  yy -= 11
  const undated = m.epics.filter((e) => !m.dates.get(e.key)!.start).length
  const rules = m.lanes.map((L) => `${L.title} = ${L.rule}`).join('; ')
  const notes = [
    `Swimlanes: ${rules}.`,
    `Source: ${m.project} epics with those labels, then all their child items. Each epic appears once.`,
    '"Child items done" counts all the epic\'s child items (with or without the label), tests excluded.',
    `Withdrawn epics left out: ${m.withdrawn.join(', ') || 'none'}. ${undated} epics have no dates and no dated child items.`,
    `Earlier dates are clipped at ${fmt(m.start, 'dd Mon yyyy')}. Rows link to the Jira epic. Generated ${todayLong}.`,
  ]
  for (const t of notes) {
    text(fit(t, REG, 6.9, pw2 - 16), x2 + 8, yy, REG, 6.9, SUB)
    yy -= 8.8
  }

  // ---- stories and tasks: one row per epic, then one per child item, over as many pages as it takes
  const kids = new Map<string, Issue[]>()
  for (const i of m.issues.values()) {
    const p = i.parent?.key
    if (p && i.issuetype.name !== 'Test') kids.set(p, [...(kids.get(p) ?? []), i])
  }
  type Entry = { lane: number } & ({ kind: 'epic'; row: Row; continued?: boolean } | { kind: 'item'; issue: Issue } | { kind: 'none' })
  const entries: Entry[] = []
  m.lanes.forEach((L, lane) => {
    for (const row of L.rows) {
      entries.push({ kind: 'epic', lane, row })
      const items = (kids.get(row.key) ?? []).sort((a, b) =>
        ticketOrder({ key: a.key, summary: clean(a.summary) }, { key: b.key, summary: clean(b.summary) }))
      if (items.length) for (const issue of items) entries.push({ kind: 'item', lane, issue })
      else entries.push({ kind: 'none', lane })
    }
  })

  const R = 15.5
  const ROWS_TOP = hdrBottom - 4
  const ROWS_BOT = M + 16
  const perPage = Math.floor((ROWS_TOP - ROWS_BOT) / R)
  const pages: Entry[][] = []
  for (let n = 0; n < entries.length;) {
    // A page that opens partway through an epic repeats the epic's row first.
    const from = entries[n].kind === 'epic' ? null : entries.slice(0, n).findLast((e) => e.kind === 'epic')
    const lead: Entry[] = from && from.kind === 'epic' ? [{ ...from, continued: true }] : []
    let take = Math.min(perPage - lead.length, entries.length - n)
    // Keep an epic's heading row with its first item.
    if (take > 1 && n + take < entries.length && entries[n + take - 1].kind === 'epic') take--
    pages.push([...lead, ...entries.slice(n, n + take)])
    n += take
  }

  const typeIcon = (type: string, x: number, y: number, s = 8) => {
    const colour = type === 'Story' ? '#63ba3c' : type === 'Task' ? '#4bade8' : type === 'Bug' ? '#e5493a' : '#8993a4'
    rrect(x, y, s, s, 1.6, { fill: colour })
    if (type === 'Story') {
      poly([[x + s * 0.3, y + s * 0.8], [x + s * 0.7, y + s * 0.8], [x + s * 0.7, y + s * 0.18],
        [x + s * 0.5, y + s * 0.36], [x + s * 0.3, y + s * 0.18]], { fill: '#ffffff' })
    } else if (type === 'Task') {
      doc.moveTo(x + s * 0.24, Y(y + s * 0.5)).lineTo(x + s * 0.43, Y(y + s * 0.3)).lineTo(x + s * 0.76, Y(y + s * 0.72))
      paint({ stroke: '#ffffff', lw: 1.2 })
    } else if (type === 'Bug') circle(x + s / 2, y + s / 2, s * 0.24, { fill: '#ffffff' })
    else rect(x + s * 0.32, y + s * 0.32, s * 0.36, s * 0.36, { fill: '#ffffff' })
  }
  /** A bar from start to due on the timeline, or a note when it can't be drawn there. */
  const span = (start: string | null, due: string | null, ymid: number, bh: number, fill: string, stroke: string,
    dashed: boolean, url: string) => {
    if (!(start && due)) {
      rrect(TL_X0 + 6, ymid - bh / 2, 84, bh, 2.5, { stroke: '#a5adba', lw: 0.7, dash: [1, 1.5] })
      text('No dates in Jira', TL_X0 + 11, ymid - 2.3, REG, 6.6, SUB)
    } else if (due < m.start) {
      text(`Ended ${fmt(due, 'dd Mon yyyy')} (ran from ${fmt(start, 'dd Mon')})`, TL_X0 + 6, ymid - 2.3, REG, 6.6, SUB)
    } else if (start > m.end) {
      text(`Starts ${fmt(start, 'dd Mon yyyy')}`, TL_X1 - 4, ymid - 2.3, REG, 6.6, SUB, 'right')
    } else if (start === due) {
      const mx = xOf(start) + PX / 2
      const rr = bh / 2 + 1
      poly([[mx, ymid + rr], [mx + rr, ymid], [mx, ymid - rr], [mx - rr, ymid]], { fill: stroke })
      text(fmt(start, 'dd Mon yyyy'), mx + rr + 3, ymid - 2.3, REG, 6.6, INK)
      link(mx - rr, ymid - rr, 2 * rr, 2 * rr, url)
    } else {
      const x0 = xOf(start < m.start ? m.start : start)
      const x1 = xOf(due > m.end ? m.end : due) + PX
      rrect(x0, ymid - bh / 2, x1 - x0, bh, 2.5, { fill, stroke, lw: 0.8, dash: dashed ? [2.5, 1.5] : undefined })
      let label = `${fmt(start, 'dd Mon')} – ${fmt(due, 'dd Mon')}`
      if (start < m.start) label = `from ${fmt(start, 'dd Mon yyyy')} – ${fmt(due, 'dd Mon')}`
      const lw = width(label, REG, 6.6)
      if (lw + 8 <= x1 - x0) text(label, x0 + 4, ymid - 2.3, REG, 6.6, INK)
      else if (x1 + 3 + lw <= TL_X1) text(label, x1 + 3, ymid - 2.3, REG, 6.6, SUB)
      else text(label, x0 - 3, ymid - 2.3, REG, 6.6, SUB, 'right')
      link(x0, ymid - bh / 2, x1 - x0, bh, url)
    }
  }

  const itemCount = entries.filter((e) => e.kind === 'item').length
  pages.forEach((page, p) => {
    doc.addPage({ size: [W, H], margin: 0 })
    text(`${m.title}: stories and tasks`, M, top - 20, BOLD, 22, INK)
    text(`${itemCount} child items in ${m.epics.length} ${m.project} epics, tests excluded  ·  ` +
      `snapshot ${todayLong}  ·  page ${p + 2} of ${pages.length + 1}`, M, top - 36, REG, 10, SUB)
    let kx = W - M
    const key: [string, (x: number) => void][] = [
      ['Story', (x) => typeIcon('Story', x, ly - 1.5)], ['Task', (x) => typeIcon('Task', x, ly - 1.5)],
      ['Bug', (x) => typeIcon('Bug', x, ly - 1.5)], ['Other type', (x) => typeIcon('', x, ly - 1.5)],
      ['Done', (x) => rrect(x - 6, ly - 1, 14, 8, 2, { fill: tint(CAT.done, 0.6), stroke: CAT.done })],
      ['In progress', (x) => rrect(x - 6, ly - 1, 14, 8, 2, { fill: tint(CAT.indeterminate, 0.6), stroke: CAT.indeterminate })],
      ['Not started', (x) => rrect(x - 6, ly - 1, 14, 8, 2, { fill: tint(CAT.new, 0.6), stroke: CAT.new })],
    ]
    for (const [label, draw] of key.reverse()) {
      kx -= width(label, REG, 7.8)
      text(label, kx, ly, REG, 7.8, SUB)
      kx -= 12
      draw(kx)
      kx -= 12
    }
    header('Epic, then its stories and tasks', 'Status')

    const rows = page.map((e, i) => ({ ...e, ytop: ROWS_TOP - i * R, ymid: ROWS_TOP - i * R - R / 2 }))
    const gridBottom = ROWS_TOP - rows.length * R
    shadeMonths(gridBottom)
    rows.forEach((r, i) => {
      const colour = m.lanes[r.lane].colour
      rect(LIST_X, r.ytop - R, TL_X1 - LIST_X, R, { fill: tint(colour, r.kind === 'epic' ? 0.8 : i % 2 === 0 ? 0.95 : 0.91) })
    })
    for (let i = 0; i < rows.length;) {
      let j = i
      while (j + 1 < rows.length && rows[j + 1].lane === rows[i].lane) j++
      laneBand(m.lanes[rows[i].lane], rows[i].ytop - (i ? 1.5 : 0), rows[j].ytop - R + (j < rows.length - 1 ? 1.5 : 0))
      i = j + 1
    }
    line(TL_X0, gridBottom, TL_X0, ROWS_TOP, { stroke: GRID, lw: 0.6 })
    weekLines(gridBottom)
    todayLine(gridBottom)

    for (const r of rows) {
      const { ytop, ymid } = r
      const bh = Math.min(11, R - 4.5)
      if (r.kind === 'epic') {
        const e = m.issues.get(r.row.key)!
        epicIcon(LIST_X + 5, ymid - 4.5)
        text(r.row.key, LIST_X + 18, ymid - 2.7, BOLD, 7.6, INK)
        const kw = width(r.row.key, BOLD, 7.6)
        const progress = r.row.total ? `${r.row.counts.done}/${r.row.total} done` : 'no child items'
        text(progress, TL_X0 - 8, ymid - 2.5, REG, 7, SUB, 'right')
        const sx0 = statusPill(e.status.name, e.status.statusCategory.key, TL_X0 - 14 - width(progress, REG, 7), ymid)
        const more = r.continued ? ' (continued)' : ''
        const tx = LIST_X + 22 + kw
        const title = fit(clean(e.summary), BOLD, 7.6, sx0 - tx - 4 - width(more, REG, 7.6))
        text(title, tx, ymid - 2.7, BOLD, 7.6, INK)
        if (more) text(more, tx + width(title, BOLD, 7.6), ymid - 2.7, REG, 7.6, SUB)
        link(LIST_X, ytop - R, TL_X0 - LIST_X, R, browse(r.row.key))
        const d = m.dates.get(r.row.key)!
        const colour = m.lanes[r.lane].colour
        span(d.start, d.due, ymid, bh, tint(colour, d.derived ? 0.82 : 0.55), colour, d.derived > 0, browse(r.row.key))
      } else if (r.kind === 'item') {
        const c = r.issue
        const ix = LIST_X + 16
        typeIcon(c.issuetype.name, ix, ymid - 4)
        text(c.key, ix + 12, ymid - 2.6, BOLD, 7.2, INK)
        const kw = width(c.key, BOLD, 7.2)
        const sx0 = statusPill(c.status.name, c.status.statusCategory.key, TL_X0 - 8, ymid)
        text(fit(clean(c.summary), REG, 7.2, sx0 - (ix + 16 + kw) - 4), ix + 16 + kw, ymid - 2.6, REG, 7.2, INK)
        link(LIST_X, ytop - R, TL_X0 - LIST_X, R, browse(c.key))
        const cat = c.status.statusCategory.key in CAT ? c.status.statusCategory.key : 'new'
        span(c.customfield_10015?.slice(0, 10) ?? null, c.duedate?.slice(0, 10) ?? null, ymid, bh,
          tint(CAT[cat], 0.6), CAT[cat], false, browse(c.key))
      } else {
        text('No stories or tasks in Jira yet.', LIST_X + 16, ymid - 2.6, REG, 7.2, SUB)
      }
    }

    text('Rows and bars link to Jira. Child bars run from the ticket\'s Start date to its Due date and are coloured ' +
      'by status; epic bars are as on page 1. Items are in the order of the number their title starts with.',
    M, M + 4, REG, 6.9, SUB)
  })

  doc.end()
  return done
}

// ------------------------------------------------------------------ CLI

export function parseArgs(argv: string[]): { cmd: 'fetch' | 'build'; opts: Record<string, string> } {
  const [cmd, ...rest] = argv
  if (cmd !== 'fetch' && cmd !== 'build') throw new Error(`unknown subcommand "${cmd ?? ''}": use fetch or build`)
  const opts: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--') || rest[i + 1] === undefined) throw new Error(`expected --option value, got "${a}"`)
    opts[a.slice(2)] = rest[++i]
  }
  const need = cmd === 'fetch' ? ['config', 'out'] : ['config', 'data', 'out']
  for (const k of need) if (!opts[k]) throw new Error(`${cmd} needs --${k}`)
  if (opts.today && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) throw new Error(`--today must be YYYY-MM-DD, got "${opts.today}"`)
  return { cmd, opts }
}

export async function main(argv: string[], run: TwgRunner = defaultRunner): Promise<void> {
  const { cmd, opts } = parseArgs(argv)
  const cfg = loadConfig(opts.config)
  if (cmd === 'fetch') {
    const { issues, epics } = fetchIssues(cfg, run)
    writeFileSync(opts.out, JSON.stringify(issues))
    process.stderr.write(`fetched ${epics} epics and ${issues.length - epics} child items\n`)
    return
  }
  const today = opts.today ?? iso(new Date())
  const model = buildModel(cfg, JSON.parse(readFileSync(opts.data, 'utf8')) as Issue[], today)
  await renderPdf(model, opts.out, { fonts: process.env.ROADMAP_FONTS === 'builtin' ? 'builtin' : 'auto' })
  const undated = model.epics.filter((e) => !model.dates.get(e.key)!.start).length
  process.stderr.write(`${model.epics.length} epics in ${model.lanes.length} swimlanes, ${undated} undated, ` +
    `${model.clashes.length} dependency clashes, ${fmt(model.start, 'dd Mon yyyy')} to ${fmt(model.end, 'dd Mon yyyy')}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: Error) => {
    process.stderr.write(`roadmap: ${e.message}\n`)
    process.exit(1)
  })
}
