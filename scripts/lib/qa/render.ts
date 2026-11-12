// Evidence + layout → the report, in the HTML twg writes Confluence pages in.
//
// Every cell the generator writes starts with an anchor macro named
//   qa-auto-<row>-<cell>-<hash>
// where <hash> is a hash of the cell's text as generated. HTML comments and data-* attributes
// don't survive Confluence's conversion to ADF (twg rejects unknown data-* attributes outright),
// but an anchor macro does, and renders as nothing. When someone rewrites the cell in the editor,
// either the anchor goes with the old text, or the text no longer matches the hash: both mark
// the cell as theirs, and publish leaves it alone from then on.

import type { Layout, LayoutRow, ReleaseConfig } from './config.ts'
import { type El, esc, find, fingerprint, type Node, parse, shortHash } from './html.ts'
import type { Judgement, Judgements } from './judgement.ts'
import { short } from './sources/common.ts'
import type { Answer, Evidence, EvidenceItem, Link, Status } from './types.ts'

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
  answer: Answer | 'To confirm' | null
  needsJudgement: boolean
  lines: Line[]
}

const RANK: Record<Status, number> = { pass: 0, unknown: 1, fail: 2 }
const worst = (s: Status[]): Status => s.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass')

/**
 * Items for the same repo and candidate are alternatives (Cosmos, then GitHub): the ones that
 * could tell count, and an unknown counts only when nothing could. The row's status comes from
 * each repo's latest candidate, the one being released (a candidate may list only the repos
 * that changed); earlier candidates are listed.
 */
function groups(items: EvidenceItem[]): EvidenceItem[][] {
  const by = new Map<string, EvidenceItem[]>()
  for (const i of items) {
    const k = `${i.candidate ?? ''}|${i.repo ?? ''}`
    by.set(k, [...(by.get(k) ?? []), i])
  }
  return [...by.values()].map((g) => (g.some((i) => i.status !== 'unknown') ? g.filter((i) => i.status !== 'unknown') : g))
}

function lineFor(i: EvidenceItem, many: boolean): Line {
  const who = [many ? i.candidate : undefined, i.repo ? `${i.repo}${i.sha ? ` ${short(i.sha)}` : ''}` : undefined].filter(Boolean).join(' — ')
  const said = i.status === 'unknown' && i.value === 'not checked' && i.note ? `not checked: ${i.note}` : `${i.value}${i.note ? ` (${i.note})` : ''}`
  return { text: `${who ? `${who}: ` : ''}${said}.`.replace(/\.\.$/, '.'), links: i.links }
}

export function evaluateRow(row: LayoutRow, table: 'info' | 'checklist', cfg: ReleaseConfig, ev: Evidence): RowResult {
  const id = table === 'info' ? `info:${row.key}` : row.key
  const items = ev.items.filter((i) => i.row === id)
  const latest = (repo?: string) => cfg.candidates.findLast((c) => !repo || repo in c.shas)?.name
  const many = cfg.candidates.length > 1
  const gs = groups(items)
  const current = gs.filter((g) => !g[0].candidate || g[0].candidate === latest(g[0].repo)).flat()
  const status: Status = current.length ? worst(current.map((i) => i.status)) : 'unknown'

  let answer: RowResult['answer'] = null
  if (table === 'checklist') {
    const good = row.good ?? 'Yes'
    const given = current.map((i) => i.answer).filter((a): a is Answer => !!a)
    if (status === 'unknown') answer = 'To confirm'
    else if (given.includes('Yes')) answer = 'Yes'
    else if (given.length && given.every((a) => a === 'N/A')) answer = 'N/A'
    else if (given.includes('No')) answer = 'No'
    else answer = status === 'pass' ? good : good === 'Yes' ? 'No' : 'Yes'
  }

  const order = [...cfg.candidates.map((c) => c.name), undefined]
  const lines = gs.flat().sort((a, b) => order.indexOf(a.candidate) - order.indexOf(b.candidate)).map((i) => lineFor(i, many))
  const needsJudgement = row.rule === 'human'
  if (needsJudgement && table === 'checklist') {
    if (!items.length) lines.unshift({ text: 'Needs a person to confirm: nothing records this automatically.', links: [] })
    else if (status !== 'pass') lines.unshift({ text: 'Needs a person to confirm.', links: [] })
  } else if (!items.length) {
    lines.push({ text: 'No evidence was collected for this row.', links: [] })
  }
  return { table, key: row.key, label: row.question ?? row.key, rule: row.rule, status, answer, needsJudgement, lines }
}

/** The info table's rows that come from the config rather than evidence. */
function infoLines(row: LayoutRow, cfg: ReleaseConfig): Line[] | null {
  switch (row.rule) {
    case 'release':
      return [{ text: cfg.release, links: [] }]
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

export function evaluate(cfg: ReleaseConfig, layout: Layout, ev: Evidence): Results {
  const info = (layout.info?.rows ?? []).map((r) => {
    const res = evaluateRow(r, 'info', cfg, ev)
    const fixed = infoLines(r, cfg)
    if (fixed) return { ...res, status: 'pass' as Status, lines: fixed }
    if (r.rule === 'outstanding-bugs') {
      const it = ev.items.find((i) => i.row === `info:${r.key}` && i.status !== 'unknown')
      return { ...res, lines: it ? [{ text: it.value, links: it.links }] : [{ text: 'To confirm: Jira could not be read.', links: [] }] }
    }
    return { ...res, lines: [] }
  })
  return { info, checklist: layout.checklist.rows.map((r) => evaluateRow(r, 'checklist', cfg, ev)) }
}

// ------------------------------------------------------------------ HTML

export type CellName = 'status' | 'comments' | 'details'

export interface GenCell {
  name: CellName | null // null: not the generator's, written only when a row is added
  html: string
  hash: string | null
  /** A person's judgement: written unmarked, and only over a cell the generator still owns. */
  judged?: boolean
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
const para = (l: Line) => {
  const links = l.links.map((k) => `<a href="${esc(k.url)}">${esc(k.text)}</a>`).join(' · ')
  return `<p>${esc(l.text)}${l.text && links ? ' ' : ''}${links}</p>`
}

/** The name of an anchor macro, or null for any other element. */
export function anchorName(e: El): string | null {
  if (e.attrs['data-extension-key'] !== 'anchor') return null
  try {
    return String(JSON.parse(e.attrs['data-parameters'] ?? '{}').macroParams?.['']?.value ?? '')
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

const plainCell = (text: string, w?: number): GenCell => ({ name: null, html: `<td${width(w)}><p>${esc(text)}</p></td>`, hash: null })

const judgedCell = (name: CellName, lines: Line[], w?: number): GenCell =>
  ({ name, html: `<td${width(w)}>${lines.map(para).join('')}</td>`, hash: null, judged: true })

function judgedCells(j: Judgement, cw: number[]): GenCell[] {
  const comment: Line[] = j.comment.trim().split(/\n\s*\n/).map((text) => ({ text: text.replace(/\s+/g, ' '), links: [] }))
  if (j.links?.length) comment.push({ text: '', links: j.links })
  return [judgedCell('status', [{ text: j.status, links: [] }], cw[2]), judgedCell('comments', comment, cw[3])]
}

export function genRows(layout: Layout, res: Results, judgements: Judgements = {}): GenRow[] {
  const out: GenRow[] = []
  const iw = layout.info?.widths ?? []
  for (const r of res.info) {
    const owned = r.rule !== 'human'
    out.push({ table: 'info', key: r.key, cells: [plainCell(r.key, iw[0]),
      owned ? ownedCell('info', r.key, 'details', r.lines, iw[1]) : plainCell('', iw[1])] })
  }
  const cw = layout.checklist.widths ?? []
  for (const r of res.checklist) {
    const j = judgements[r.key]
    out.push({ table: 'checklist', key: r.key, cells: [plainCell(r.key, cw[0]), plainCell(r.label, cw[1]),
      ...(j ? judgedCells(j, cw) : [ownedCell('checklist', r.key, 'status', [{ text: r.answer ?? 'To confirm', links: [] }], cw[2]),
        ownedCell('checklist', r.key, 'comments', r.lines, cw[3])])] })
  }
  return out
}

export const rowHtml = (r: GenRow): string => `<tr>${r.cells.map((c) => c.html).join('')}</tr>`

export function tableHtml(t: { heading: string; columns: string[]; widths?: number[] }, rows: GenRow[], level = 2): string {
  const head = `<tr>${t.columns.map((c, n) => `<th${width(t.widths?.[n])}><p>${esc(c)}</p></th>`).join('')}</tr>`
  return `<h${level}>${esc(t.heading)}</h${level}><table data-layout="center"><thead>${head}</thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
}

export function renderPage(cfg: ReleaseConfig, layout: Layout, res: Results, judgements: Judgements = {}): string {
  const rows = genRows(layout, res, judgements)
  const parts = [
    `<h1>${esc(layout.title.replace('{release}', cfg.release))}</h1>`,
    ...(layout.intro ?? []).map((p) => `<p>${esc(p)}</p>`),
    '<p><em>Cells written by the qa-report pipeline are regenerated each time it runs. Edit a cell to take it over: the pipeline then leaves it alone.</em></p>',
  ]
  if (layout.info) parts.push(tableHtml(layout.info, rows.filter((r) => r.table === 'info')))
  parts.push(tableHtml(layout.checklist, rows.filter((r) => r.table === 'checklist'), 1))
  return parts.join('\n')
}
