// Merges a freshly rendered report into the Confluence page, and writes it back through twg.
//
// Only cells carrying this generator's marker, with text that still matches its hash, are
// replaced (see render.ts). Every other cell is a person's and is kept as it is. A judgement
// (judgement.ts) replaces cells on the same terms, but unmarked, so it becomes a person's once
// written. A cell of a row whose source couldn't be read, or that the agent didn't answer
// (render.ts, `keep`), is left as the page has it. An answered agent row whose question on the
// page differs from the layout's has its question rewritten with its status and comment
// (render.ts, `sync`), and only when both of those are written too. Rows the page lacks are added after the row
// before them in the layout. Rows the page has out of the layout's order are moved, as few as
// it takes to put the table in order, whoever wrote them: a move keeps a row's content, local
// ids and comments. A row no layout row matches any more is removed when the generator
// wrote it whole and nobody has touched it since: its key cell as render writes it, and every
// other cell marked and unedited. Any other such row is a person's and stays. The change goes to
// Confluence as targeted edits (replaceNode / insertNodeAfter / deleteNode / moveNode on local
// ids), so the rest of the page, mentions, images and macros included, is never re-sent. Updates
// carry the snapshot token from the read; on a stale token the page is read again and the
// merge redone, once.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Layout, LayoutTable, ReleaseConfig } from './config.ts'
import { blocksOf, cellsOf, type El, esc, find, fingerprint, headingAndTable, isHeading, type Node, parse, rowsOf, shortHash, splice, tableAfterHeading, textOf } from './html.ts'
import { cellText, type CellName, type GenCell, type GenRow, headCell, type HeadCell, headingHtml, LEVELS, MARKER, markerRow, markers, plainCell, rowHtml, tableHtml, titleOf } from './render.ts'
import { type GenPart, partMarker, partText } from './sections.ts'
import type { TwgRunner } from '../roadmap-runner.ts'
import type { Published } from './answers.ts'
import { QaError } from './errors.ts'
import { pageId } from './twg.ts'
import { str } from './util.ts'

export type Edit =
  | { name: 'replaceNode' | 'insertNodeAfter' | 'insertNodeBefore' | 'appendNodeToEnd'; localId?: string; value: string }
  | { name: 'deleteNode'; localId: string; value?: undefined }
  | { name: 'moveNode'; arguments: { localId: string; targetLocalId: string; position: number }; localId?: undefined; value?: undefined }

export type Action = 'update' | 'judgement' | 'unchanged' | 'keep-human' | 'keep-edited' | 'keep-unreachable' | 'add-row' | 'add-table' | 'remove-row'
  | 'keep-retired-human' | 'keep-retired-edited' | 'skipped' | 'move-row' | 'add-part'

export interface CellChange {
  /** `part`: the header, intro or a section (sections.ts); its key is the section's heading. */
  table: 'info' | 'checklist' | 'part'
  key: string
  cell: CellName | null
  action: Action
  before?: string
  after?: string
  why?: string
}

export interface MergeResult {
  html: string
  edits: Edit[]
  changes: CellChange[]
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')


/** Attributes to keep when a cell is replaced: its local id, width, colour and the like. */
function attrsOf(el: El): string {
  return Object.entries(el.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
}

const newId = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 12)

/** A generator cell of a row on the page, and what stops it being replaced, if anything. */
interface Cell {
  gen: GenCell
  td?: El
  base: { table: 'info' | 'checklist'; key: string; cell: CellName }
  held?: CellChange
  before?: string
}

/** What a merge has decided so far. */
interface Merging {
  page: string
  edits: Edit[]
  changes: CellChange[]
  splices: { start: number; end: number; text: string }[]
}

type TableName = 'info' | 'checklist'

type Owner = { owner: 'person' } | { owner: 'edited' } | { owner: 'generator'; hash: string }

/**
 * Whose a page cell is: a person's if it has no marker of ours for this row and cell, edited if
 * its text no longer matches the marker's hash, else the generator's, written with that hash.
 */
function ownerOf(page: string, table: TableName, key: string, name: CellName, td: El): Owner {
  const re = new RegExp(`^qa-auto-${escRe(markerRow(table, key))}-${name}-`)
  const marker = markers(td).find((m) => re.test(m))
  if (!marker) return { owner: 'person' }
  const hash = MARKER.exec(marker)?.[3]
  return hash && hash === shortHash(cellText(page.slice(td.start, td.end))) ? { owner: 'generator', hash } : { owner: 'edited' }
}

/** Whether a page cell holds nothing: no text, link, mention, image or macro. */
const emptyCell = (page: string, td: El) => !cellText(page.slice(td.start, td.end))

/** A generator cell against the page's cell, and what stops it being replaced, if anything. */
function cellOf(page: string, table: TableName, key: string, gen: GenCell, td: El | undefined, n: number): Cell {
  const base = { table, key, cell: gen.name! }
  if (!td) return { gen, base, held: { ...base, action: 'skipped', why: `the row has no column ${n + 1}` } }
  const before = textOf(td)
  const o = ownerOf(page, table, key, gen.name!, td)
  let held: CellChange | undefined
  if (o.owner === 'person' && !(gen.claimEmpty && emptyCell(page, td))) held = { ...base, action: 'keep-human', before }
  else if (o.owner === 'edited') held = { ...base, action: 'keep-edited', before }
  else if (o.owner === 'generator' && o.hash === gen.hash) held = { ...base, action: 'unchanged' }
  else if (gen.keep) held = { ...base, action: 'keep-unreachable', before }
  else if (!td.attrs['data-local-id']) held = { ...base, action: 'skipped', why: 'the cell has no local id' }
  return { gen, td, base, held, before }
}

/** Replaces a page cell's content with a generated cell's, keeping the page cell's attributes. */
function replaceTd(m: Merging, td: El, gen: GenCell): string {
  const inner = gen.html.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '')
  const html = `<${td.tag}${attrsOf(td)}>${inner}</${td.tag}>`
  m.edits.push({ name: 'replaceNode', localId: td.attrs['data-local-id'], value: html })
  m.splices.push({ start: td.start, end: td.end, text: html })
  return textOf(parse(html))
}

function replaceCell(m: Merging, c: Cell): void {
  const after = replaceTd(m, c.td!, c.gen)
  m.changes.push({ ...c.base, action: c.gen.judged ? 'judgement' : 'update', before: c.before, after })
}

/** Whether a page cell reads as a generated cell would: the comparison a `sync` cell is rewritten on. */
export const sameText = (td: El, gen: GenCell): boolean => textOf(td) === textOf(parse(gen.html))

function mergeRow(m: Merging, table: TableName, r: GenRow, tr: El): void {
  const tds = cellsOf(tr)
  const stale = r.cells.flatMap((gen, n) => (gen.sync && tds[n] && !sameText(tds[n], gen) ? [{ gen, td: tds[n] }] : []))
  const cells = r.cells.flatMap((gen, n) => (gen.name ? [cellOf(m.page, table, r.key, gen, tds[n], n)] : []))
  // A row's status and comment are replaced together or not at all, so a person's answer is
  // never left beside a comment that disagrees with it. A judgement also waits for a row it
  // can write whole.
  const personal = (c: Cell) => c.held?.action === 'keep-human' || c.held?.action === 'keep-edited'
  const blocked = cells.some(personal) || cells.some((c) => c.gen.judged && c.held)
  // A changed question is written only with the answer to it: unless the status and comment
  // are both written now, or already say exactly that answer, the row stays as it is, old
  // question beside old answer.
  if (stale.length && (blocked || cells.some((c) => c.held && c.held.action !== 'unchanged') || stale.some((s) => !s.td.attrs['data-local-id']))) {
    const why = 'the question differs, and the row can\'t be written whole'
    for (const c of cells) m.changes.push(c.held ?? { ...c.base, action: 'skipped', why })
    m.changes.push(...stale.map((): CellChange => ({ table, key: r.key, cell: null, action: 'skipped', why })))
    return
  }
  for (const c of cells) {
    if (c.held) m.changes.push(c.gen.judged && !c.held.why ? { ...c.held, why: 'the judgement was not written' } : c.held)
    else if (blocked) m.changes.push({ ...c.base, action: 'skipped', why: 'a person has written the rest of this row' })
    else replaceCell(m, c)
  }
  for (const s of stale) m.changes.push({ table, key: r.key, cell: null, action: 'update', why: 'the question', before: textOf(s.td), after: replaceTd(m, s.td, s.gen) })
}

/** Finds a layout row's row in a page's table: by the text of its first cell, else by its `match`. */
function rowFinder(trs: El[], spec: LayoutTable): (key: string) => El | undefined {
  const firsts = trs.map((tr) => ({ tr, text: cellsOf(tr)[0] ? textOf(cellsOf(tr)[0]) : '' }))
  const matches = new Map(spec.rows.flatMap((x) => (x.match === undefined ? [] : [[x.key, new RegExp(x.match, 'i')] as const])))
  return (key) => {
    const match = matches.get(key)
    return (firsts.find((f) => f.text === key) ?? (match ? firsts.find((f) => match.test(f.text)) : undefined))?.tr
  }
}

const blank = (n: Node) => n.type === 'text' && !n.text.trim()

/** Whether a key cell is as render writes it: one paragraph of plain text, with no marks, links or macros. */
function plainKey(td: El): boolean {
  const [p, ...more] = td.children.filter((c) => !blank(c))
  return !more.length && p?.type === 'el' && p.tag === 'p' && p.children.length > 0 && p.children.every((c) => c.type === 'text')
}

/** Whether a page cell is the generator's, unedited, for the row with this key. */
function generated(page: string, table: TableName, key: string, td: El): boolean {
  const re = new RegExp(`^qa-auto-${escRe(markerRow(table, key))}-(status|comments|details)-`)
  const name = markers(td).map((x) => re.exec(x)?.[1]).find(Boolean) as CellName | undefined
  return !!name && ownerOf(page, table, key, name, td).owner === 'generator'
}

/**
 * Removes the page's rows that no layout row was matched to (duplicates of a layout row
 * included), if the generator wrote them whole and nobody has touched them since. Header rows
 * (all `th`, or reading as the layout's columns, as a hand-written table's `td` header does) and
 * every row with a person's cell stay.
 */
function retireRows(m: Merging, table: TableName, spec: LayoutTable, trs: El[], matched: Set<El>): void {
  const header = (cells: El[]) => cells.every((c) => c.tag === 'th') || cells.map(textOf).join('|') === spec.columns.join('|')
  for (const tr of trs) {
    const cells = cellsOf(tr)
    if (matched.has(tr) || !cells.length || header(cells)) continue
    const [first, ...rest] = cells
    const key = textOf(first)
    const id = tr.attrs['data-local-id']
    if (!rest.length || !plainKey(first) || !rest.every((td) => generated(m.page, table, key, td))) {
      const marked = rest.some((td) => markers(td).some((x) => MARKER.test(x)))
      m.changes.push({ table, key, cell: null, action: marked ? 'keep-retired-edited' : 'keep-retired-human' })
    } else if (id) {
      m.edits.push({ name: 'deleteNode', localId: id })
      m.splices.push({ start: tr.start, end: tr.end, text: '' })
      m.changes.push({ table, key, cell: null, action: 'remove-row', before: textOf(tr) })
    } else {
      m.changes.push({ table, key, cell: null, action: 'skipped', why: 'not in the layout, but the row has no local id to remove it by' })
    }
  }
}

/** Indexes of a longest strictly increasing run (not necessarily contiguous) of `xs`. */
export function increasing(xs: number[]): Set<number> {
  const tails: number[] = []
  const prev = xs.map(() => -1)
  xs.forEach((x, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[tails[mid]] < x) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  })
  const out = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) out.add(i)
  return out
}

/** The page's table for a layout table: under its heading, or under a heading the layout had before. */
function findTable(root: El, spec: LayoutTable): { table: El; heading: El; former: boolean } | null {
  const now = headingAndTable(root, new RegExp(`^${escRe(spec.heading)}$`, 'i'))
  if (now?.table) return { table: now.table, heading: now.heading, former: false }
  for (const old of spec.formerly ?? []) {
    const was = headingAndTable(root, new RegExp(`^${escRe(old)}$`, 'i'))
    if (was?.table && fingerprint(was.heading) === old) return { table: was.table, heading: was.heading, former: true }
  }
  return null
}

/** Rewrites a heading the generator wrote before as the layout's, keeping its local id. */
function renameHeading(m: Merging, table: TableName, h: El, text: string): void {
  const id = h.attrs['data-local-id']
  if (!id) {
    m.changes.push({ table, key: text, cell: null, action: 'skipped', why: 'the old heading has no local id' })
    return
  }
  const html = `<h${LEVELS[table]}${attrsOf(h)}>${esc(text)}</h${LEVELS[table]}>`
  m.edits.push({ name: 'replaceNode', localId: id, value: html })
  m.splices.push({ start: h.start, end: h.end, text: html })
  m.changes.push({ table, key: text, cell: null, action: 'update', why: 'the heading', before: textOf(h), after: text })
}

/**
 * Rewrites a header row of `th` cells as `td`, as the template heads its checklist, when it
 * reads exactly as the layout's columns (as render wrote it). Each cell keeps its attributes.
 */
function recellHeader(m: Merging, table: TableName, spec: LayoutTable, tr: El): void {
  const cells = cellsOf(tr)
  if (!cells.length || !cells.every((c) => c.tag === 'th') || cells.map((c) => fingerprint(c)).join('|') !== spec.columns.join('|')) return
  const id = tr.attrs['data-local-id']
  if (!id) {
    m.changes.push({ table, key: 'header row', cell: null, action: 'skipped', why: 'it has no local id' })
    return
  }
  const inner = (c: El) => m.page.slice(c.start, c.end).replace(/^<th[^>]*>/, '').replace(/<\/th>$/, '')
  const html = `<tr${attrsOf(tr)}>${cells.map((c) => `<td${attrsOf(c)}>${inner(c)}</td>`).join('')}</tr>`
  m.edits.push({ name: 'replaceNode', localId: id, value: html })
  m.splices.push({ start: tr.start, end: tr.end, text: html })
  m.changes.push({ table, key: 'header row', cell: null, action: 'update', why: 'its cells, as the template has them', before: textOf(tr), after: textOf(parse(html)) })
}

/** Merges one table's rows into the page's table; returns false when the page has no such table. */
function mergeTable(m: Merging, root: El, table: TableName, spec: LayoutTable, mine: GenRow[], cell: HeadCell = 'th'): boolean {
  const found = findTable(root, spec)
  if (!found) return false
  if (found.former) renameHeading(m, table, found.heading, spec.heading)
  const trs = rowsOf(found.table)
  if (cell === 'td' && trs.length) recellHeader(m, table, spec, trs[0])
  const rowFor = rowFinder(trs, spec)
  const matched = new Set<El>()
  let after: { id?: string; end: number } | null = trs.length ? { id: trs[0].attrs['data-local-id'], end: trs[0].end } : null
  const inserts = new Map<number, string[]>()
  const place = (html: string) => inserts.set(after!.end, [...(inserts.get(after!.end) ?? []), html])
  const insert = (r: GenRow) => {
    const id = newId(`${table}:${r.key}`)
    const html = rowHtml(r).replace(/^<tr>/, `<tr data-local-id="${id}">`)
    m.edits.push({ name: 'insertNodeAfter', localId: after!.id!, value: html })
    place(html)
    after = { id, end: after!.end }
    m.changes.push({ table, key: r.key, cell: null, action: 'add-row', after: textOf(parse(html)) })
  }
  // Moves a row after `after`, with its cells merged as they are where it stands. twg's moveNode
  // puts the node straight after its target; it requires a numeric position, but goes by the target.
  const move = (r: GenRow, tr: El, id: string) => {
    m.edits.push({ name: 'moveNode', arguments: { localId: id, targetLocalId: after!.id!, position: 0 } })
    m.changes.push({ table, key: r.key, cell: null, action: 'move-row' })
    const from = m.splices.length
    mergeRow(m, table, r, tr)
    const within = m.splices.splice(from).map((x) => ({ ...x, start: x.start - tr.start, end: x.end - tr.start }))
    m.splices.push({ start: tr.start, end: tr.end, text: '' })
    place(splice(m.page.slice(tr.start, tr.end), within))
    after = { id, end: after!.end }
  }
  const onPage: (El | undefined)[] = []
  for (const r of mine) {
    const tr = rowFor(r.key)
    onPage.push(tr && !onPage.includes(tr) ? tr : undefined)
  }
  // The rows that stay where they are: as many of those found as are already in the layout's order.
  const located = mine.flatMap((_, n) => (onPage[n] ? [n] : []))
  const staying = new Set([...increasing(located.map((n) => trs.indexOf(onPage[n]!)))].map((i) => located[i]))
  mine.forEach((r, n) => {
    const tr = onPage[n]
    const id = tr?.attrs['data-local-id']
    if (tr) matched.add(tr)
    if (tr && staying.has(n)) {
      after = { id, end: tr.end }
      mergeRow(m, table, r, tr)
    } else if (tr && id && after?.id) {
      move(r, tr, id)
    } else if (tr) {
      m.changes.push({ table, key: r.key, cell: null, action: 'skipped', why: id ? 'out of order, but no row before it has a local id to move it after' : 'out of order, but it has no local id to move it by' })
      mergeRow(m, table, r, tr)
    } else if (!after?.id) {
      m.changes.push({ table, key: r.key, cell: null, action: 'skipped', why: 'no row with a local id to add it after' })
    } else {
      insert(r)
    }
  })
  // Before the inserts: a removed row can start where a row is inserted, and splice applies
  // ranges with the same start in the order given, so the removal must not take the insert with it.
  retireRows(m, table, spec, trs, matched)
  for (const [at, html] of inserts) m.splices.push({ start: at, end: at, text: html.join('') })
  return true
}

export function merge(page: string, layout: Layout, rows: GenRow[], parts: GenPart[] = []): MergeResult {
  const root = parse(page)
  const m: Merging = { page, edits: [], changes: [], splices: [] }
  const appended: string[] = []
  const tables: [TableName, LayoutTable | undefined][] = [['info', layout.info], ['checklist', layout.checklist]]
  for (const [name, spec] of tables) {
    if (!spec) continue
    const mine = rows.filter((r) => r.table === name)
    if (mergeTable(m, root, name, spec, mine, headCell(layout, name))) continue
    const html = tableHtml(spec, mine, LEVELS[name], headCell(layout, name))
    m.edits.push({ name: 'appendNodeToEnd', value: html })
    appended.push(html)
    for (const r of mine) m.changes.push({ table: name, key: r.key, cell: null, action: 'add-table' })
  }
  if (parts.length) appended.push(...mergeParts(m, root, layout, parts))
  const html = splice(page, m.splices) + (appended.length ? `\n${appended.join('\n')}` : '')
  return { html, edits: m.edits, changes: m.changes }
}

// ------------------------------------------------------------------ parts

type PartOwner = { owner: 'generator'; hash: string; nodes: El[] } | { owner: 'edited' | 'person' | 'empty' | 'legacy' } | { owner: 'mixed'; legacy: El[] }

/**
 * Whose a part on the page is: the generator's if its marker's hash matches its text, edited if
 * not, empty if there is nothing in it. In the intro (the part with `legacy`) a person's
 * paragraphs may stand beside the generator's: its blocks from the marker on, as many as match the
 * hash, are the generator's, and the rest are the person's. An unmarked intro is the generator's
 * too (legacy) when each of its blocks is a paragraph reading exactly as one the generator wrote,
 * or empty; if only some are, those alone are (mixed). Anything else is a person's.
 */
function partOwner(part: Pick<GenPart, 'part' | 'legacy'>, nodes: El[]): PartOwner {
  const mine = (n: El) => markers(n).map(partMarker).find((x) => x?.part === part.part)
  const at = nodes.findIndex((n) => mine(n))
  const text = partText(nodes)
  if (at >= 0) {
    const hash = mine(nodes[at])!.hash
    const runs = part.legacy ? nodes.slice(at).map((_, n) => nodes.slice(at, at + n + 1)) : [nodes]
    const own = runs.find((r) => shortHash(partText(r)) === hash)
    return own ? { owner: 'generator', hash, nodes: own } : { owner: 'edited' }
  }
  if (!text) return { owner: 'empty' }
  const legacy = part.legacy ?? []
  const old = nodes.filter((n) => n.tag === 'p' && legacy.includes(fingerprint(n)))
  if (!old.length) return { owner: 'person' }
  return old.length === nodes.filter((n) => partText([n])).length ? { owner: 'legacy' } : { owner: 'mixed', legacy: old }
}

/** Where a part's new blocks go: after a block, or before the page's first heading (the header). */
interface Place {
  id?: string
  at: number
  before?: boolean
}

interface PartMerge {
  m: Merging
  inserts: Map<number, string[]>
}

/** The part's blocks with local ids, so each can be inserted after the one before it. */
function partBlocks(html: string, seed: string): string[] {
  return blocksOf(parse(html)).map((b, n) => html.slice(b.start, b.end).replace(/^<([a-z][a-z0-9]*)/, `<$1 data-local-id="${newId(`${seed}:${n}`)}"`))
}

/** Inserts blocks at a place, each after the one before; returns where the next would go. */
function insertBlocks(pm: PartMerge, place: Place, blocks: string[]): Place {
  let p = place
  for (const b of blocks) {
    const id = /data-local-id="([0-9a-f]{12})"/.exec(b)![1]
    if (p.id) pm.m.edits.push({ name: p.before ? 'insertNodeBefore' : 'insertNodeAfter', localId: p.id, value: b })
    else pm.m.edits.push({ name: 'appendNodeToEnd', value: b })
    pm.inserts.set(p.at, [...(pm.inserts.get(p.at) ?? []), b])
    p = { id, at: p.at }
  }
  return p
}

/** Removes a part's blocks from the page; false (and nothing removed) if one has no local id. */
function removeBlocks(pm: PartMerge, nodes: El[]): boolean {
  if (nodes.some((n) => !n.attrs['data-local-id'])) return false
  for (const n of nodes) {
    pm.m.edits.push({ name: 'deleteNode', localId: n.attrs['data-local-id'] })
    pm.m.splices.push({ start: n.start, end: n.end, text: '' })
  }
  return true
}

const partKey = (p: GenPart) => p.heading?.text ?? p.part

/** The page's date in a header the generator wrote, if it has one. */
const headerDate = (nodes: El[]): string | null => /Last Updated:\s*(\d{2}\/\d{2}\/\d{4})/.exec(nodes.map(textOf).join(' '))?.[1] ?? null

/**
 * Merges a part found on the page (its blocks `nodes`, new blocks going at `place`); returns
 * where a block after it would go, if it was rewritten.
 */
function mergePart(pm: PartMerge, part: GenPart, nodes: El[], place: Place, dateOnly = false): Place | null {
  const base = { table: 'part' as const, key: partKey(part), cell: null }
  const o = partOwner(part, nodes)
  const before = nodes.map(textOf).join(' ')
  // Replaces the generator's blocks `old` with the part's.
  const write = (old: El[], why?: string): Place | null => {
    if (!place.id) {
      pm.m.changes.push({ ...base, action: 'skipped', why: 'no block with a local id to write it beside' })
      return null
    }
    if (!removeBlocks(pm, old)) {
      pm.m.changes.push({ ...base, action: 'skipped', why: 'a block of it has no local id' })
      return null
    }
    pm.m.changes.push({ ...base, action: 'update', before: old.map(textOf).join(' '), after: textOf(parse(part.html)), ...(why ? { why } : {}) })
    return insertBlocks(pm, place, partBlocks(part.html, `part:${part.part}`))
  }
  if (o.owner === 'person') pm.m.changes.push({ ...base, action: 'keep-human', before })
  else if (o.owner === 'edited') pm.m.changes.push({ ...base, action: 'keep-edited', before })
  else if (o.owner === 'mixed') return write(o.legacy, 'a person wrote the rest, which stays')
  else if (o.owner === 'generator' && (o.hash === part.hash || dateOnly)) {
    pm.m.changes.push({ ...base, action: 'unchanged', ...(dateOnly && o.hash !== part.hash ? { why: 'only the date would change' } : {}) })
  } else if (o.owner === 'generator' && part.keep) pm.m.changes.push({ ...base, action: 'keep-unreachable', before })
  else return write(o.owner === 'generator' ? o.nodes : nodes)
  return null
}

/** A part's blocks on the page: the top-level elements after `from` up to the next heading. */
function regionAfter(blocks: El[], from: number): El[] {
  const out: El[] = []
  for (const b of blocks.slice(from + 1)) {
    if (isHeading(b)) break
    out.push(b)
  }
  return out
}

/** A section on the page: where its heading is among the page's blocks, and its blocks; null if the page lacks it. */
function findSection(blocks: El[], heading: string): { at: number; nodes: El[] } | null {
  const at = blocks.findIndex((b) => isHeading(b) && textOf(b).toLowerCase() === heading.toLowerCase())
  return at < 0 ? null : { at, nodes: regionAfter(blocks, at) }
}

const placeAfter = (e: El): Place => ({ id: e.attrs['data-local-id'], at: e.end })

/**
 * Merges the header, intro and sections into the page; returns the HTML of any appended to its
 * end. A section the page lacks is added, heading and all, after the part before it, or the
 * checklist. The header is merged last: a run that would change nothing but its date leaves it.
 */
function mergeParts(m: Merging, root: El, layout: Layout, parts: GenPart[]): string[] {
  const pm: PartMerge = { m, inserts: new Map() }
  const blocks = blocksOf(root)
  const first = blocks.findIndex(isHeading)
  const intro = parts.find((p) => p.part === 'intro')
  if (intro && first >= 0) mergePart(pm, intro, regionAfter(blocks, first), placeAfter(blocks[first]))
  const checklist = headingAndTable(root, new RegExp(`^${escRe(layout.checklist.heading)}$`, 'i'))
  const top = checklist ? blocks.indexOf(checklist.heading) : -1
  let place: Place = top >= 0 ? placeAfter([checklist!.heading, ...regionAfter(blocks, top)].at(-1)!) : { at: m.page.length }
  const appended: string[] = []
  for (const part of parts.filter((p) => p.heading)) {
    const found = findSection(blocks, part.heading!.text)
    if (found) {
      const h = blocks[found.at]
      place = mergePart(pm, part, found.nodes, placeAfter(h)) ?? placeAfter([h, ...found.nodes].at(-1)!)
      continue
    }
    const html = [headingHtml(part.heading!), ...partBlocks(part.html, `part:${part.part}`)]
    const headed = [html[0].replace(/^<h(\d)/, `<h$1 data-local-id="${newId(`part:${part.part}:heading`)}"`), ...html.slice(1)]
    if (place.id) place = insertBlocks(pm, place, headed)
    else {
      for (const b of headed) m.edits.push({ name: 'appendNodeToEnd', value: b })
      appended.push(...headed)
    }
    m.changes.push({ table: 'part', key: partKey(part), cell: null, action: 'add-part', after: textOf(parse(part.html)) })
  }
  const header = parts.find((p) => p.part === 'header')
  if (header && first >= 0) {
    const nodes = blocks.slice(0, first)
    const old = headerDate(nodes)
    const o = partOwner(header, nodes)
    const dateOnly = !m.edits.length && o.owner === 'generator' && !!old && header.withDate?.(old).hash === o.hash
    mergePart(pm, header, nodes, { id: blocks[first].attrs['data-local-id'], at: blocks[first].start, before: true }, dateOnly)
  }
  // After the removals: one can start where blocks are inserted (see mergeTable).
  for (const [at, html] of pm.inserts) m.splices.push({ start: at, end: at, text: html.join('') })
  return appended
}

export interface PublishedRow {
  status: string
  comment: string
  links: string[]
  /** A person has written the row, so no answer will replace it. */
  byPerson?: true
}

/**
 * The layout's agent rows as a page has them, so the agent can keep wording that still holds.
 * A row whose question on the page is another one is left out.
 */
export function publishedRows(page: string, layout: Layout): Record<string, PublishedRow> {
  const spec = layout.checklist
  const el = tableAfterHeading(parse(page), new RegExp(`^${escRe(spec.heading)}$`, 'i'))
  if (!el) return {}
  const rowFor = rowFinder(rowsOf(el), spec)
  const out: Record<string, PublishedRow> = {}
  for (const r of spec.rows.filter((x) => x.rule === 'agent')) {
    const tr = rowFor(r.key)
    const [, question, status, comment] = tr ? cellsOf(tr) : []
    if (!comment || !sameText(question, plainCell(r.question ?? r.key))) continue
    const owned = (name: CellName, td: El) => ownerOf(page, 'checklist', r.key, name, td).owner === 'generator'
    const links = find(comment, (e) => e.tag === 'a').map((a) => str(a.attrs.href)).filter((u) => u.startsWith('https://'))
    out[r.key] = { status: textOf(status), comment: textOf(comment), links, ...(owned('status', status) && owned('comments', comment) ? {} : { byPerson: true as const }) }
  }
  return out
}

export interface PublishedPart {
  text: string
  links: string[]
  /** A person has written it, so no answer will replace it. */
  byPerson?: true
}

const httpsLinks = (nodes: El[]) => nodes.flatMap((n) => find(n, (e) => e.tag === 'a')).map((a) => str(a.attrs.href)).filter((u) => u.startsWith('https://'))

/** The agent info rows and sections as a page has them, for the agent to keep wording that still holds. */
export function publishedParts(page: string, layout: Layout): { info: Record<string, PublishedPart>; sections: Record<string, PublishedPart> } {
  const root = parse(page)
  const info: Record<string, PublishedPart> = {}
  const table = layout.info ? findTable(root, layout.info) : null
  if (layout.info && table) {
    const rowFor = rowFinder(rowsOf(table.table), layout.info)
    for (const r of layout.info.rows.filter((x) => x.rule === 'agent')) {
      const td = rowFor(r.key) ? cellsOf(rowFor(r.key)!)[1] : undefined
      if (!td || emptyCell(page, td)) continue
      const mine = ownerOf(page, 'info', r.key, 'details', td).owner === 'generator'
      info[r.key] = { text: textOf(td), links: httpsLinks([td]), ...(mine ? {} : { byPerson: true as const }) }
    }
  }
  const sections: Record<string, PublishedPart> = {}
  const blocks = blocksOf(root)
  for (const s of layout.sections ?? []) {
    const found = findSection(blocks, s.heading)
    const text = found?.nodes.map(textOf).join(' ')
    if (!found || !text) continue
    const mine = partOwner({ part: s.kind.toLowerCase() }, found.nodes).owner === 'generator'
    sections[s.kind] = { text, links: httpsLinks(found.nodes), ...(mine ? {} : { byPerson: true as const }) }
  }
  return { info, sections }
}

/** What the page says now, for the agent: its agent rows, agent info rows and sections. */
export const published = (page: string, layout: Layout): Published => ({ rows: publishedRows(page, layout), ...publishedParts(page, layout) })

export interface Counts {
  /** Cells, and parts (the header, intro and sections) rewritten. */
  change: number
  judged: number
  unchanged: number
  human: number
  added: number
  /** Rows the layout no longer has, that the generator wrote and nobody has edited. */
  removed: number
  /** Rows moved to where the layout has them. */
  moved: number
  /** Sections the page lacked, added. */
  sections: number
  /** Rows the layout no longer has, kept because a person wrote or edited them. */
  retiredKept: number
  skipped: number
  /** Kept as published, because their source couldn't be read. */
  kept: number
}

export function count(changes: CellChange[]): Counts {
  const c = { change: 0, judged: 0, unchanged: 0, human: 0, added: 0, removed: 0, moved: 0, sections: 0, retiredKept: 0, skipped: 0, kept: 0 }
  for (const x of changes) {
    if (x.action === 'update') c.change++
    else if (x.action === 'judgement') c.judged++
    else if (x.action === 'unchanged') c.unchanged++
    else if (x.action === 'keep-human' || x.action === 'keep-edited') c.human++
    else if (x.action === 'add-row' || x.action === 'add-table') c.added++
    else if (x.action === 'add-part') c.sections++
    else if (x.action === 'remove-row') c.removed++
    else if (x.action === 'move-row') c.moved++
    else if (x.action === 'keep-retired-human' || x.action === 'keep-retired-edited') c.retiredKept++
    else if (x.action === 'keep-unreachable') c.kept++
    else c.skipped++
  }
  return c
}

const WHAT: Record<Action, string> = {
  update: 'would change', judgement: 'would take the judgement, unmarked', unchanged: 'unchanged', 'keep-human': 'kept: written by a person (no marker)',
  'keep-edited': 'kept: edited by a person since it was generated', 'keep-unreachable': 'kept as published: its source could not be read, or the agent gave no answer', 'add-row': 'row would be added',
  'add-table': 'table would be added', 'remove-row': 'row would be removed: no longer in the layout',
  'keep-retired-human': 'kept: not in the layout, and a person wrote it', 'keep-retired-edited': 'kept: not in the layout, and a person edited it', skipped: 'skipped',
  'move-row': 'row would be moved to where the layout has it', 'add-part': 'section would be added',
}

export function diffSummary(title: string, changes: CellChange[]): string {
  const c = count(changes)
  const retired = c.retiredKept ? `${c.retiredKept} rows not in the layout kept as people wrote them, ` : ''
  const moved = `${c.moved ? `${c.moved} rows would be moved, ` : ''}${c.sections ? `${c.sections} sections would be added, ` : ''}`
  const out = [title, `${c.change} cells would change, ${c.judged} would take a judgement, ${c.added} rows would be added, ${c.removed} rows would be removed, ${moved}${retired}${c.human} cells kept as people wrote them, ` +
    `${c.kept} kept as published because a source could not be read or the agent gave no answer, ${c.unchanged} unchanged, ${c.skipped} skipped`, '']
  for (const x of changes) {
    if (x.action === 'unchanged') continue
    out.push(`${x.table} ${x.key}${x.cell ? ` ${x.cell}` : ''}: ${WHAT[x.action]}${x.why ? ` (${x.why})` : ''}`)
    if (x.action === 'update' || x.action === 'judgement') out.push(`  - ${x.before}`, `  + ${x.after}`)
    if (x.action === 'add-row' || x.action === 'add-part') out.push(`  + ${x.after}`)
    if (x.action === 'remove-row') out.push(`  - ${x.before}`)
  }
  return out.join('\n') + '\n'
}

// ------------------------------------------------------------------ twg

export interface Page {
  id: string
  html: string
  token: string
  spaceId?: string
  title?: string
}

/** Runs twg and parses its JSON, including the JSON twg prints when it exits non-zero. */
export function twgJson(run: TwgRunner, args: string[]): { ok: boolean; out: Record<string, any> } {
  try {
    return { ok: true, out: JSON.parse(run(args)) }
  } catch (e) {
    const raw = (e as { stdout?: unknown }).stdout
    const stdout = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : ''
    try {
      return { ok: false, out: JSON.parse(stdout) }
    } catch {
      throw new QaError('twg', `twg ${args.slice(0, 3).join(' ')} failed: ${(e as Error).message}`)
    }
  }
}

export function getPage(run: TwgRunner, id: string, draft: boolean): Page {
  const args = ['confluence', 'content', 'get', pageId(id), '--detail', 'full', '--format', 'html', ...(draft ? ['--draft'] : []), '-o', 'json', '--output-summary', 'none']
  const { ok, out } = twgJson(run, args)
  const d = out.data
  if (!ok || !d?.snapshotToken || typeof d.body?.value !== 'string') throw new QaError('page-read', `could not read page ${id}${draft ? ' (draft)' : ''}`)
  return { id, html: d.body.value, token: d.snapshotToken, spaceId: d.spaceId, title: d.title }
}

export const VERSION_MESSAGE = 'Generated by the qa-report pipeline'

const isStale = (out: Record<string, any>) => /stale|conflict/i.test(JSON.stringify([out.data?.reason, out.error?.code, out.error?.reason, out.error?.message]))

export interface PublishResult {
  counts: Counts
  published: boolean
  retried: boolean
  validated?: boolean
  /** The draft holds edits someone hasn't published yet, so nothing was merged or sent. */
  unpublishedEdits?: boolean
}

/**
 * Draft and published bodies of the same version differ only in their local ids, and in the
 * `_parentId` the editor adds to each macro's parameters in the draft.
 */
export const sameBody = (a: string, b: string): boolean => {
  const strip = (h: string) => h.replace(/\sdata-local-id="[^"]*"/g, '')
    .replace(/,&quot;_parentId&quot;:\{&quot;value&quot;:&quot;\d+&quot;\}/g, '')
    .replace(/&quot;_parentId&quot;:\{&quot;value&quot;:&quot;\d+&quot;\},?/g, '')
  return strip(a) === strip(b)
}

/**
 * Dry run (the default) reads the published page, merges, and writes merged.html, edits.json
 * and diff.txt to `dir`. `publish` and `validate` read the draft as well, since classic pages
 * are edited through it, and merge the draft, so validating checks exactly what a publish would
 * send. If the draft differs from the published page, someone has edits in progress there, and
 * publishing ours would publish theirs, so the page is left alone. `validate` has twg check the
 * edits without writing; `publish` updates with the draft's snapshot token.
 */
export function publishToPage(run: TwgRunner, pageArg: string, layout: Layout, rows: GenRow[], dir: string,
  opts: { publish?: boolean; validate?: boolean } = {}, parts: GenPart[] = []): PublishResult {
  const id = pageId(pageArg)
  const viaDraft = !!(opts.publish || opts.validate)
  const attempt = () => {
    const live = getPage(run, id, false)
    const page = viaDraft ? getPage(run, id, true) : live
    if (viaDraft && !sameBody(live.html, page.html)) return { page, m: null }
    const m = merge(page.html, layout, rows, parts)
    writeFileSync(join(dir, 'page.html'), page.html)
    writeFileSync(join(dir, 'merged.html'), m.html)
    writeFileSync(join(dir, 'edits.json'), JSON.stringify(m.edits, null, 2) + '\n')
    writeFileSync(join(dir, 'diff.txt'), diffSummary(`Page ${id}, snapshot ${page.token}`, m.changes))
    return { page, m }
  }
  const held = (retried: boolean): PublishResult => ({ counts: count([]), published: false, retried, unpublishedEdits: true })
  let { page, m } = attempt()
  if (!m) return held(false)
  const update = (dry: boolean) => twgJson(run, ['confluence', 'content', 'update', id, '--snapshot-token', page.token,
    '--edits-file', join(dir, 'edits.json'), '--ack-body-formats', '--version-message', VERSION_MESSAGE, '-y',
    ...(dry ? ['--dry-run'] : []), '-o', 'json', '--output-summary', 'none'])

  if (!opts.publish) {
    if (!opts.validate || !m.edits.length) return { counts: count(m.changes), published: false, retried: false }
    const { ok, out } = update(true)
    return { counts: count(m.changes), published: false, retried: false, validated: ok && out.data?.ok !== false }
  }
  if (!m.edits.length) return { counts: count(m.changes), published: false, retried: false }
  let res = update(false)
  let retried = false
  if (!res.ok && isStale(res.out)) {
    retried = true
    const again = attempt()
    if (!again.m) return held(true)
    page = again.page
    m = again.m
    if (!m.edits.length) return { counts: count(m.changes), published: false, retried }
    res = update(false)
  }
  if (!res.ok || res.out.data?.ok === false) throw new QaError('page-update', `twg could not update page ${id}${retried ? ' after re-reading it' : ''}`)
  return { counts: count(m.changes), published: true, retried }
}

export function createPage(run: TwgRunner, parentId: string, title: string, html: string, dir: string, publish: boolean): string | null {
  const file = join(dir, 'new-page.html')
  writeFileSync(file, html)
  if (!publish) return null
  const parent = getPage(run, parentId, false)
  const space = str(parent.spaceId)
  const { ok, out } = twgJson(run, ['confluence', 'content', 'create', '--content-type', 'page', '--parent-id', pageId(parentId),
    ...(/^\d+$/.test(space) ? ['--space-id', space] : []), '--title', title, '--body-file', file, '--format', 'html',
    '--ack-body-formats', '-y', '-o', 'json', '--output-summary', 'none'])
  const id = out.data?.id ?? out.data?.content?.id
  if (!ok || !/^\d+$/.test(str(id))) throw new QaError('page-create', `twg could not create the page under ${parentId}`)
  return str(id)
}

export function releaseTitle(cfg: ReleaseConfig, layout: Layout): string {
  return titleOf(cfg, layout)
}
