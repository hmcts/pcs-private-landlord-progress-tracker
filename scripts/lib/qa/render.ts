// Evidence + layout → the report, in the HTML twg writes Confluence pages in.
//
// Every cell the generator writes starts with an anchor macro named
//   qa-auto-<row>-<cell>-<hash>
// where <hash> is a hash of the cell's text as generated. HTML comments and data-* attributes
// don't survive Confluence's conversion to ADF (twg rejects unknown data-* attributes outright),
// but an anchor macro does, and renders as nothing. When someone rewrites the cell in the editor,
// either the anchor goes with the old text, or the text no longer matches the hash: both mark
// the cell as theirs, and publish leaves it alone from then on.
//
// A row that is unknown only because a source couldn't be read (items marked unreachable) is
// marked `keep`: publishing leaves its cells as the page has them, so a run that can't reach a
// source (locally, Cosmos usually refuses access) never undoes one that could.
//
// A release's row that can't be answered says "To confirm". An agent row, and any row of a
// feature, leaves its status blank instead, and its comment says what is missing. A layout with
// sections reproduces the whole template (sections.ts), so its page carries nothing the template
// doesn't: no note about the cells.

import type { Layout, LayoutRow, ReleaseConfig } from './config.ts'
import { type El, esc, find, fingerprint, type Node, parse, shortHash } from './html.ts'
import type { Judgement, Judgements } from './judgement.ts'
import { day, short } from './sources/common.ts'
import { browse } from './sources/jira.ts'
import type { Answer, Evidence, EvidenceItem, Link, Status } from './types.ts'
import type { GenPart } from './sections.ts'
import { str } from './util.ts'

export interface Line {
  text: string
  links: Link[]
}

export interface RowResult {
  table: 'info' | 'checklist'
  key: string
  label: string
  rule: string
  status: Status
  /** Null leaves the status blank. */
  answer: Answer | 'To confirm' | null
  needsJudgement: boolean
  lines: Line[]
  /** Unknown only for want of a source that couldn't be read: publish keeps the page's cells. */
  keep: boolean
}

const RANK: Record<Status, number> = { pass: 0, unknown: 1, fail: 2 }
const worst = (s: Status[]): Status => s.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass')

/**
 * Items answering the same rule for the same repo and candidate are alternatives (Cosmos, then
 * GitHub): the ones that could tell count, and an unknown counts only when nothing could. A row
 * that also has a human_rows ticket answers a second rule, and both must pass: a done ticket
 * never hides a mechanical check that couldn't be made. The row's status comes from
 * each repo's latest candidate, the one being released (a candidate may list only the repos
 * that changed); earlier candidates are listed.
 */
function groups(items: EvidenceItem[]): EvidenceItem[][] {
  const by = new Map<string, EvidenceItem[]>()
  for (const i of items) {
    const k = `${i.candidate ?? ''}|${i.repo ?? ''}|${i.rule}`
    by.set(k, [...(by.get(k) ?? []), i])
  }
  return [...by.values()].map((g) => (g.some((i) => i.status !== 'unknown') ? g.filter((i) => i.status !== 'unknown') : g))
}

function lineFor(i: EvidenceItem, many: boolean): Line {
  const who = [many ? i.candidate : undefined, i.repo ? `${i.repo}${i.sha ? ` ${short(i.sha)}` : ''}` : undefined].filter(Boolean).join(' — ')
  const said = i.status === 'unknown' && i.value === 'not checked' && i.note ? `not checked: ${i.note}` : `${i.value}${i.note ? ` (${i.note})` : ''}`
  return { text: `${who ? `${who}: ` : ''}${said}.`.replace(/\.\.$/, '.'), links: i.links }
}

/** A comment as paragraphs: blank lines split it, other whitespace is one space. */
export const paragraphs = (comment: string): Line[] => comment.trim().split(/\n[ \t\r]*\n/)
  .map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).map((text) => ({ text, links: [] }))

/**
 * An `agent` row is decided by the agent's answer alone; the mechanical evidence filed under it
 * was the agent's to weigh. With no answer the row keeps what the page says, and a row the page
 * lacks is added with that evidence.
 */
function agentRow(row: LayoutRow, items: EvidenceItem[], evidence: Line[]): RowResult {
  const base = { table: 'checklist' as const, key: row.key, label: row.question ?? row.key, rule: row.rule, needsJudgement: false }
  const given = items.find((i) => i.source === 'agent' && i.rule === 'agent')
  if (!given) {
    return { ...base, status: 'unknown', answer: null, keep: true, lines: [{ text: 'No answer has been given for this row yet.', links: [] }, ...evidence] }
  }
  const lines = paragraphs(given.value)
  if (given.links.length) lines.push({ text: '', links: given.links })
  return { ...base, status: given.status, answer: given.answer ?? null, keep: false, lines }
}

export function evaluateRow(row: LayoutRow, table: 'info' | 'checklist', cfg: ReleaseConfig, ev: Evidence): RowResult {
  const id = table === 'info' ? `info:${row.key}` : row.key
  const items = ev.items.filter((i) => i.row === id)
  const latest = (repo?: string) => cfg.candidates.findLast((c) => !repo || repo in c.shas)?.name
  // A feature's one candidate is still named, so its rows say they are service-wide.
  const many = cfg.candidates.length > 1 || cfg.kind === 'feature'
  const gs = groups(items)
  const currentGroups = gs.filter((g) => !g[0].candidate || g[0].candidate === latest(g[0].repo))
  const current = currentGroups.flat()
  const status: Status = current.length ? worst(current.map((i) => i.status)) : 'unknown'
  // A group still unknown could have been answered by any of its alternatives; if one of them
  // couldn't be read, the group is unknown for want of it.
  const unknownGroups = currentGroups.filter((g) => g.every((i) => i.status === 'unknown'))
  const keep = status === 'unknown' && unknownGroups.length > 0 && unknownGroups.every((g) => g.some((i) => i.unreachable))

  let answer: RowResult['answer'] = null
  if (table === 'checklist') {
    const good = row.good ?? 'Yes'
    const given = current.map((i) => i.answer).filter((a): a is Answer => !!a)
    if (status === 'unknown') answer = cfg.kind === 'feature' ? null : 'To confirm'
    else if (given.includes('Yes')) answer = 'Yes'
    else if (given.length && given.every((a) => a === 'N/A')) answer = 'N/A'
    else if (given.includes('No')) answer = 'No'
    else answer = status === 'pass' ? good : good === 'Yes' ? 'No' : 'Yes'
  }

  const order = [...cfg.candidates.map((c) => c.name), undefined]
  const lines = gs.flat().sort((a, b) => order.indexOf(a.candidate) - order.indexOf(b.candidate)).map((i) => lineFor(i, many))
  if (table === 'checklist' && row.rule === 'agent') return agentRow(row, items, lines)
  const needsJudgement = row.rule === 'human'
  if (needsJudgement && table === 'checklist') {
    if (!items.length) lines.unshift({ text: 'Needs a person to confirm: nothing records this automatically.', links: [] })
    else if (status !== 'pass') lines.unshift({ text: 'Needs a person to confirm.', links: [] })
  } else if (!items.length) {
    lines.push({ text: 'No evidence was collected for this row.', links: [] })
  }
  return { table, key: row.key, label: row.question ?? row.key, rule: row.rule, status, answer, needsJudgement, lines, keep }
}

/** The info table's rows that come from the config rather than evidence. */
function infoLines(row: LayoutRow, cfg: ReleaseConfig, ev: Evidence): Line[] | null {
  switch (row.rule) {
    case 'release':
    case 'feature':
      return [{ text: cfg.release, links: [] }]
    case 'epics':
      return [{ text: '', links: (cfg.epics ?? []).map(browse) }]
    case 'epic-tickets': {
      const it = ev.items.find((i) => i.row === `info:${row.key}` && i.status !== 'unknown')
      return it ? [{ text: '', links: it.links }] : null
    }
    case 'generated':
      return [{ text: day(ev.generatedAt), links: [] }]
    case 'dashboards':
      return (cfg.dashboards ?? []).map((d) => ({ text: '', links: [{ text: d.label, url: d.url }] }))
    case 'repos':
      return Object.entries(cfg.repos).map(([r, v]) => ({ text: `${r} →`, links: [{ text: `github.com/${v.github}`, url: `https://github.com/${v.github}` }] }))
    case 'revisions':
      return cfg.candidates.map((c) => ({ text: `${c.name}:`, links: Object.entries(c.shas).map(([r, sha]) =>
        ({ text: `${r} = ${short(sha)}`, url: `https://github.com/${cfg.repos[r].github}/commit/${sha}` })) }))
    default:
      return null
  }
}

export interface Results {
  info: RowResult[]
  checklist: RowResult[]
}

/** Info rows that list each item's value as it is: one line per repo. */
const LISTED: Record<string, string> = {
  'service-revision': 'the commit could not be picked.',
  'e2e-build': 'no E2E build was read.',
}

/** What an info cell says when its source couldn't tell: a release's says "To confirm", a feature's just why. */
const missing = (cfg: ReleaseConfig, why: string): string => (cfg.kind === 'feature' ? `${why[0].toUpperCase()}${why.slice(1)}` : `To confirm: ${why}`)

/** An agent info row: the agent's text, or, with none, what the page says (or nothing, for a row it lacks). */
function agentInfo(res: RowResult, ev: Evidence): RowResult {
  const given = ev.items.find((i) => i.row === `info:${res.key}` && i.source === 'agent' && i.rule === 'agent')
  if (!given) return { ...res, status: 'unknown', keep: true, lines: [] }
  const lines = paragraphs(given.value)
  if (given.links.length) lines.push({ text: '', links: given.links })
  return { ...res, status: 'pass', keep: false, lines }
}

export function evaluate(cfg: ReleaseConfig, layout: Layout, ev: Evidence): Results {
  const info = (layout.info?.rows ?? []).map((r) => {
    const res = evaluateRow(r, 'info', cfg, ev)
    if (r.rule === 'agent') return agentInfo(res, ev)
    const fixed = infoLines(r, cfg, ev)
    if (fixed) return { ...res, status: 'pass' as Status, lines: fixed, keep: false }
    if (r.rule === 'outstanding-bugs') {
      const it = ev.items.find((i) => i.row === `info:${r.key}` && i.status !== 'unknown')
      return { ...res, lines: it ? [{ text: it.value, links: it.links }] : [{ text: missing(cfg, 'Jira could not be read.'), links: [] }] }
    }
    if (r.rule in LISTED) {
      const its = ev.items.filter((i) => i.row === `info:${r.key}`)
      // One repo's source being unreachable keeps the whole cell, not just that repo's line.
      const keep = its.some((i) => i.unreachable)
      const unknown = (i: EvidenceItem) => (cfg.kind === 'feature' ? `${i.repo ? `${i.repo}: ` : ''}${i.note ?? 'not known'}.`
        : `${i.repo ? `${i.repo}: ` : ''}to confirm${i.note ? ` (${i.note})` : ''}.`)
      // A picked revision is its link alone, "<repo> = <sha7>", as the template writes it.
      const line = (i: EvidenceItem): Line => ({ links: i.links, text: i.status === 'unknown' ? unknown(i) : r.rule === 'service-revision' ? '' : `${i.value}.` })
      return { ...res, keep, lines: its.length ? its.map(line) : [{ text: missing(cfg, LISTED[r.rule]), links: [] }] }
    }
    return { ...res, lines: [] }
  })
  const checklist = layout.checklist.rows.map((r) => evaluateRow(r, 'checklist', cfg, ev))
  // The run date is not the date of every cell: say which kept what an earlier run wrote.
  const kept = [...info.filter((r) => r.keep).map((r) => r.key), ...checklist.filter((r) => r.keep).map((r) => `row ${r.key}`)]
  const generated = info.find((r) => r.rule === 'generated')
  if (generated && kept.length) {
    generated.lines.push({ text: `Kept from an earlier run, as a source could not be read: ${kept.join(', ')}.`, links: [] })
  }
  return { info, checklist }
}

// ------------------------------------------------------------------ HTML

export type CellName = 'status' | 'comments' | 'details'

export interface GenCell {
  name: CellName | null // null: not the generator's, written only when a row is added
  html: string
  hash: string | null
  /** A person's judgement: written unmarked, and only over a cell the generator still owns. */
  judged?: boolean
  /** The row's source couldn't be read: the page's cell, if the generator still owns it, stays as it is. */
  keep?: boolean
  /**
   * A cell with no marker (an answered agent row's question) that is rewritten when the page's
   * text differs, only in a merge that also writes the row's status and comment. An unanswered
   * row has none, so its old question stays beside its old answer.
   */
  sync?: boolean
  /**
   * An agent row's cell: one on the page with no marker and nothing in it (as a row the generator
   * once left for a person reads) holds nothing to lose, so it is written as if the generator's.
   */
  claimEmpty?: boolean
}

export interface GenRow {
  table: 'info' | 'checklist'
  key: string
  cells: GenCell[]
}

export const MARKER = /^qa-auto-(.+)-(status|comments|details)-([0-9a-f]{8})$/
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export const markerRow = (table: 'info' | 'checklist', key: string): string => (table === 'info' ? `info-${slug(key)}` : slug(key))

export function anchor(name: string): string {
  const params = JSON.stringify({ macroParams: { '': { value: name } } })
  return `<span data-type="inline-extension" data-extension-key="anchor" data-extension-type="com.atlassian.confluence.macro.core" data-parameters="${esc(params)}"></span>`
}

const width = (w?: number) => (w ? ` data-colwidth="${w}"` : '')
export const para = (l: Line): string => {
  const links = l.links.map((k) => `<a href="${esc(k.url)}">${esc(k.text)}</a>`).join(' · ')
  return `<p>${esc(l.text)}${l.text && links ? ' ' : ''}${links}</p>`
}

/** The name of an anchor macro, or null for any other element. */
export function anchorName(e: El): string | null {
  if (e.attrs['data-extension-key'] !== 'anchor') return null
  try {
    return str(JSON.parse(e.attrs['data-parameters'] ?? '{}').macroParams?.['']?.value)
  } catch {
    return ''
  }
}

export const markers = (n: Node): string[] => find(n, (e) => anchorName(e) !== null).map((e) => anchorName(e)!)

/** What the ownership hash covers (see fingerprint in html.ts), leaving out the marker itself. */
export const cellText = (tdHtml: string): string => fingerprint(parse(tdHtml), (e) => MARKER.test(anchorName(e) ?? ''))

export function ownedCell(table: 'info' | 'checklist', key: string, name: CellName, lines: Line[], w?: number): GenCell {
  const body = (lines.length ? lines : [{ text: '', links: [] }]).map(para).join('')
  const hash = shortHash(cellText(`<td>${body}</td>`))
  const marked = body.replace(/^<p>/, `<p>${anchor(`qa-auto-${markerRow(table, key)}-${name}-${hash}`)}`)
  return { name, html: `<td${width(w)}>${marked}</td>`, hash }
}

export const plainCell = (text: string, w?: number): GenCell => ({ name: null, html: `<td${width(w)}><p>${esc(text)}</p></td>`, hash: null })

const judgedCell = (name: CellName, lines: Line[], w?: number): GenCell =>
  ({ name, html: `<td${width(w)}>${lines.map(para).join('')}</td>`, hash: null, judged: true })

function judgedCells(j: Judgement, cw: number[]): GenCell[] {
  const comment = paragraphs(j.comment)
  if (j.links?.length) comment.push({ text: '', links: j.links })
  return [judgedCell('status', [{ text: j.status, links: [] }], cw[2]), judgedCell('comments', comment, cw[3])]
}

export function genRows(layout: Layout, res: Results, judgements: Judgements = {}): GenRow[] {
  const out: GenRow[] = []
  const iw = layout.info?.widths ?? []
  const kept = (c: GenCell, r: RowResult): GenCell => {
    const k = r.keep ? { ...c, keep: true } : c
    return r.rule === 'agent' ? { ...k, claimEmpty: true } : k
  }
  for (const r of res.info) {
    const owned = r.rule !== 'human'
    out.push({ table: 'info', key: r.key, cells: [plainCell(r.key, iw[0]),
      owned ? kept(ownedCell('info', r.key, 'details', r.lines, iw[1]), r) : plainCell('', iw[1])] })
  }
  const cw = layout.checklist.widths ?? []
  for (const r of res.checklist) {
    const j = judgements[r.key]
    const question = plainCell(r.label, cw[1])
    out.push({ table: 'checklist', key: r.key, cells: [plainCell(r.key, cw[0]), r.rule === 'agent' && !r.keep ? { ...question, sync: true } : question,
      ...(j ? judgedCells(j, cw) : [kept(ownedCell('checklist', r.key, 'status', [{ text: r.answer ?? '', links: [] }], cw[2]), r),
        kept(ownedCell('checklist', r.key, 'comments', r.lines, cw[3]), r)])] })
  }
  return out
}

export const rowHtml = (r: GenRow): string => `<tr>${r.cells.map((c) => c.html).join('')}</tr>`

/** The cells of a table's header row: `th`, or `td` as the template's checklist has them. */
export type HeadCell = 'th' | 'td'

/** The header row of a table as render writes it. */
export const headRow = (t: { columns: string[]; widths?: number[] }, cell: HeadCell = 'th'): string =>
  `<tr>${t.columns.map((c, n) => `<${cell}${width(t.widths?.[n])}><p>${esc(c)}</p></${cell}>`).join('')}</tr>`

export function tableHtml(t: { heading: string; columns: string[]; widths?: number[] }, rows: GenRow[], level = 2, cell: HeadCell = 'th'): string {
  const body = rows.map(rowHtml).join('')
  const table = cell === 'th' ? `<thead>${headRow(t)}</thead><tbody>${body}</tbody>` : `<tbody>${headRow(t, cell)}${body}</tbody>`
  return `<h${level}>${esc(t.heading)}</h${level}><table data-layout="center">${table}</table>`
}

/** How a layout's table heads its columns: a layout with sections heads the checklist's as the template does. */
export const headCell = (layout: Layout, table: 'info' | 'checklist'): HeadCell => (layout.sections && table === 'checklist' ? 'td' : 'th')

/** The checklist's heading level, and the info table's: as the template has them. */
export const LEVELS = { info: 2, checklist: 1 } as const

export function renderPage(cfg: ReleaseConfig, layout: Layout, res: Results, judgements: Judgements = {}, parts: GenPart[] = []): string {
  const rows = genRows(layout, res, judgements)
  const tables = [...(layout.info ? [tableHtml(layout.info, rows.filter((r) => r.table === 'info'), LEVELS.info)] : []),
    tableHtml(layout.checklist, rows.filter((r) => r.table === 'checklist'), LEVELS.checklist, headCell(layout, 'checklist'))]
  if (layout.sections) return renderParts(cfg, layout, parts, tables)
  const page = [
    `<h1>${esc(titleOf(cfg, layout))}</h1>`,
    ...(layout.intro ?? []).map((p) => `<p>${esc(p)}</p>`),
    '<p><em>Cells written by the qa-report pipeline are regenerated each time it runs. Edit a cell to take it over: the pipeline then leaves it alone.</em></p>',
  ]
  return [...page, ...tables].join('\n')
}

export const headingHtml = (h: { text: string; level: number }): string => `<h${h.level}>${esc(h.text)}</h${h.level}>`

/** A whole page for a layout with sections, as the template lays it out. */
export function renderParts(cfg: ReleaseConfig, layout: Layout, parts: GenPart[], tables: string[]): string {
  const byPart = (p: string) => parts.find((x) => x.part === p)
  const sections = parts.filter((p) => p.heading).flatMap((p) => [headingHtml(p.heading!), p.html])
  return [byPart('header')?.html, `<h1>${esc(titleOf(cfg, layout))}</h1>`, byPart('intro')?.html, ...tables, ...sections]
    .filter((x): x is string => !!x).join('\n')
}

/** The layout's title for this release or feature. */
export const titleOf = (cfg: ReleaseConfig, layout: Layout): string => layout.title.replace('{release}', cfg.release).replace('{feature}', cfg.release)
