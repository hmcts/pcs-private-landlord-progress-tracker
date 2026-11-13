// Merges a freshly rendered report into the Confluence page, and writes it back through twg.
//
// Only cells carrying this generator's marker, with text that still matches its hash, are
// replaced (see render.ts). Every other cell is a person's and is kept as it is. A judgement
// (judgement.ts) replaces cells on the same terms, but unmarked, so it becomes a person's once
// written. A cell of a row whose source couldn't be read (render.ts, `keep`) is left as the page
// has it. Rows the page lacks are added after the row before them in the layout. The change
// goes to Confluence as targeted edits (replaceNode / insertNodeAfter on the cells' local ids),
// so the rest of the page, mentions, images and macros included, is never re-sent. Updates
// carry the snapshot token from the read; on a stale token the page is read again and the
// merge redone, once.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Layout, LayoutTable, ReleaseConfig } from './config.ts'
import { cellsOf, type El, esc, parse, rowsOf, shortHash, splice, tableAfterHeading, textOf } from './html.ts'
import { cellText, type CellName, type GenCell, type GenRow, MARKER, markerRow, markers, rowHtml, tableHtml, titleOf } from './render.ts'
import type { TwgRunner } from '../roadmap-runner.ts'
import { QaError } from './errors.ts'
import { pageId } from './twg.ts'
import { str } from './util.ts'

export interface Edit {
  name: 'replaceNode' | 'insertNodeAfter' | 'appendNodeToEnd'
  localId?: string
  value: string
}

export type Action = 'update' | 'judgement' | 'unchanged' | 'keep-human' | 'keep-edited' | 'keep-unreachable' | 'add-row' | 'add-table' | 'skipped'

export interface CellChange {
  table: 'info' | 'checklist'
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

/** A generator cell against the page's cell, and what stops it being replaced, if anything. */
function cellOf(page: string, table: TableName, key: string, gen: GenCell, td: El | undefined, n: number): Cell {
  const base = { table, key, cell: gen.name! }
  if (!td) return { gen, base, held: { ...base, action: 'skipped', why: `the row has no column ${n + 1}` } }
  const before = textOf(td)
  const re = new RegExp(`^qa-auto-${escRe(markerRow(table, key))}-${gen.name}-`)
  const marker = markers(td).find((m) => re.test(m))
  const hash = marker ? MARKER.exec(marker)?.[3] : undefined
  let held: CellChange | undefined
  if (!marker) held = { ...base, action: 'keep-human', before }
  else if (hash !== shortHash(cellText(page.slice(td.start, td.end)))) held = { ...base, action: 'keep-edited', before }
  else if (hash === gen.hash) held = { ...base, action: 'unchanged' }
  else if (gen.keep) held = { ...base, action: 'keep-unreachable', before }
  else if (!td.attrs['data-local-id']) held = { ...base, action: 'skipped', why: 'the cell has no local id' }
  return { gen, td, base, held, before }
}

function replaceCell(m: Merging, c: Cell): void {
  const td = c.td!
  const inner = c.gen.html.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '')
  const html = `<${td.tag}${attrsOf(td)}>${inner}</${td.tag}>`
  m.edits.push({ name: 'replaceNode', localId: td.attrs['data-local-id'], value: html })
  m.splices.push({ start: td.start, end: td.end, text: html })
  m.changes.push({ ...c.base, action: c.gen.judged ? 'judgement' : 'update', before: c.before, after: textOf(parse(html)) })
}

function mergeRow(m: Merging, table: TableName, r: GenRow, tr: El): void {
  const tds = cellsOf(tr)
  const cells = r.cells.flatMap((gen, n) => (gen.name ? [cellOf(m.page, table, r.key, gen, tds[n], n)] : []))
  // A row's status and comment are replaced together or not at all, so a person's answer is
  // never left beside a comment that disagrees with it. A judgement also waits for a row it
  // can write whole.
  const personal = (c: Cell) => c.held?.action === 'keep-human' || c.held?.action === 'keep-edited'
  const blocked = cells.some(personal) || cells.some((c) => c.gen.judged && c.held)
  for (const c of cells) {
    if (c.held) m.changes.push(c.gen.judged && !c.held.why ? { ...c.held, why: 'the judgement was not written' } : c.held)
    else if (blocked) m.changes.push({ ...c.base, action: 'skipped', why: 'a person has written the rest of this row' })
    else replaceCell(m, c)
  }
}

/** Merges one table's rows into the page's table; returns false when the page has no such table. */
function mergeTable(m: Merging, root: El, table: TableName, spec: LayoutTable, mine: GenRow[]): boolean {
  const el = tableAfterHeading(root, new RegExp(`^${escRe(spec.heading)}$`, 'i'))
  if (!el) return false
  const trs = rowsOf(el)
  const firsts = trs.map((tr) => ({ tr, text: cellsOf(tr)[0] ? textOf(cellsOf(tr)[0]) : '' }))
  const rowFor = (key: string) => {
    const match = spec.rows.find((x) => x.key === key)?.match
    return (firsts.find((f) => f.text === key) ?? (match ? firsts.find((f) => new RegExp(match, 'i').test(f.text)) : undefined))?.tr
  }
  let after: { id?: string; end: number } | null = trs.length ? { id: trs[0].attrs['data-local-id'], end: trs[0].end } : null
  const inserts = new Map<number, string[]>()
  for (const r of mine) {
    const tr = rowFor(r.key)
    if (tr) {
      after = { id: tr.attrs['data-local-id'], end: tr.end }
      mergeRow(m, table, r, tr)
    } else if (!after?.id) {
      m.changes.push({ table, key: r.key, cell: null, action: 'skipped', why: 'no row with a local id to add it after' })
    } else {
      const id = newId(`${table}:${r.key}`)
      const html = rowHtml(r).replace(/^<tr>/, `<tr data-local-id="${id}">`)
      m.edits.push({ name: 'insertNodeAfter', localId: after.id, value: html })
      inserts.set(after.end, [...(inserts.get(after.end) ?? []), html])
      after = { id, end: after.end }
      m.changes.push({ table, key: r.key, cell: null, action: 'add-row', after: textOf(parse(html)) })
    }
  }
  for (const [at, html] of inserts) m.splices.push({ start: at, end: at, text: html.join('') })
  return true
}

export function merge(page: string, layout: Layout, rows: GenRow[]): MergeResult {
  const root = parse(page)
  const m: Merging = { page, edits: [], changes: [], splices: [] }
  const appended: string[] = []
  const tables: [TableName, LayoutTable | undefined][] = [['info', layout.info], ['checklist', layout.checklist]]
  for (const [name, spec] of tables) {
    if (!spec) continue
    const mine = rows.filter((r) => r.table === name)
    if (mergeTable(m, root, name, spec, mine)) continue
    const html = tableHtml(spec, mine, name === 'checklist' ? 1 : 2)
    m.edits.push({ name: 'appendNodeToEnd', value: html })
    appended.push(html)
    for (const r of mine) m.changes.push({ table: name, key: r.key, cell: null, action: 'add-table' })
  }
  const html = splice(page, m.splices) + (appended.length ? `\n${appended.join('\n')}` : '')
  return { html, edits: m.edits, changes: m.changes }
}

export interface Counts {
  change: number
  judged: number
  unchanged: number
  human: number
  added: number
  skipped: number
  /** Kept as published, because their source couldn't be read. */
  kept: number
}

export function count(changes: CellChange[]): Counts {
  const c = { change: 0, judged: 0, unchanged: 0, human: 0, added: 0, skipped: 0, kept: 0 }
  for (const x of changes) {
    if (x.action === 'update') c.change++
    else if (x.action === 'judgement') c.judged++
    else if (x.action === 'unchanged') c.unchanged++
    else if (x.action === 'keep-human' || x.action === 'keep-edited') c.human++
    else if (x.action === 'add-row' || x.action === 'add-table') c.added++
    else if (x.action === 'keep-unreachable') c.kept++
    else c.skipped++
  }
  return c
}

const WHAT: Record<Action, string> = {
  update: 'would change', judgement: 'would take the judgement, unmarked', unchanged: 'unchanged', 'keep-human': 'kept: written by a person (no marker)',
  'keep-edited': 'kept: edited by a person since it was generated', 'keep-unreachable': 'kept as published: its source could not be read', 'add-row': 'row would be added',
  'add-table': 'table would be added', skipped: 'skipped',
}

export function diffSummary(title: string, changes: CellChange[]): string {
  const c = count(changes)
  const out = [title, `${c.change} cells would change, ${c.judged} would take a judgement, ${c.added} rows would be added, ${c.human} cells kept as people wrote them, ` +
    `${c.kept} kept as published because a source could not be read, ${c.unchanged} unchanged, ${c.skipped} skipped`, '']
  for (const x of changes) {
    if (x.action === 'unchanged') continue
    out.push(`${x.table} ${x.key}${x.cell ? ` ${x.cell}` : ''}: ${WHAT[x.action]}${x.why ? ` (${x.why})` : ''}`)
    if (x.action === 'update' || x.action === 'judgement') out.push(`  - ${x.before}`, `  + ${x.after}`)
    if (x.action === 'add-row') out.push(`  + ${x.after}`)
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
  opts: { publish?: boolean; validate?: boolean } = {}): PublishResult {
  const id = pageId(pageArg)
  const viaDraft = !!(opts.publish || opts.validate)
  const attempt = () => {
    const live = getPage(run, id, false)
    const page = viaDraft ? getPage(run, id, true) : live
    if (viaDraft && !sameBody(live.html, page.html)) return { page, m: null }
    const m = merge(page.html, layout, rows)
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
