// Merges a freshly rendered report into the Confluence page, and writes it back through twg.
//
// Only cells carrying this generator's marker, with text that still matches its hash, are
// replaced (see render.ts). Every other cell is a person's and is kept as it is. A judgement
// (judgement.ts) replaces cells on the same terms, but unmarked, so it becomes a person's once
// written. Rows the page lacks are added after the row before them in the layout. The change
// goes to Confluence as targeted edits (replaceNode / insertNodeAfter on the cells' local ids),
// so the rest of the page, mentions, images and macros included, is never re-sent. Updates
// carry the snapshot token from the read; on a stale token the page is read again and the
// merge redone, once.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Layout, LayoutTable, ReleaseConfig } from './config.ts'
import { cellsOf, type El, esc, find, parse, rowsOf, shortHash, splice, tableAfterHeading, textOf } from './html.ts'
import { cellText, type CellName, type GenCell, type GenRow, MARKER, markerRow, rowHtml, tableHtml } from './render.ts'
import type { TwgRunner } from '../roadmap-runner.ts'

export interface Edit {
  name: 'replaceNode' | 'insertNodeAfter' | 'appendNodeToEnd'
  localId?: string
  value: string
}

export type Action = 'update' | 'judgement' | 'unchanged' | 'keep-human' | 'keep-edited' | 'add-row' | 'add-table' | 'skipped'

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

function markers(td: El): string[] {
  return find(td, (e) => e.attrs['data-extension-key'] === 'anchor').map((e) => {
    try {
      return String(JSON.parse(e.attrs['data-parameters'] ?? '{}').macroParams?.['']?.value ?? '')
    } catch {
      return ''
    }
  })
}

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

export function merge(page: string, layout: Layout, rows: GenRow[]): MergeResult {
  const root = parse(page)
  const edits: Edit[] = []
  const changes: CellChange[] = []
  const splices: { start: number; end: number; text: string }[] = []
  const appended: string[] = []

  const tables: [('info' | 'checklist'), LayoutTable | undefined][] = [['info', layout.info], ['checklist', layout.checklist]]
  for (const [name, spec] of tables) {
    if (!spec) continue
    const mine = rows.filter((r) => r.table === name)
    const table = tableAfterHeading(root, new RegExp(`^${escRe(spec.heading)}$`, 'i'))
    if (!table) {
      const html = tableHtml(spec, mine, name === 'checklist' ? 1 : 2)
      edits.push({ name: 'appendNodeToEnd', value: html })
      appended.push(html)
      for (const r of mine) changes.push({ table: name, key: r.key, cell: null, action: 'add-table' })
      continue
    }

    const trs = rowsOf(table)
    const firsts = trs.map((tr) => ({ tr, text: cellsOf(tr)[0] ? textOf(cellsOf(tr)[0]) : '' }))
    const rowFor = (key: string) => {
      const match = spec.rows.find((x) => x.key === key)?.match
      return (firsts.find((f) => f.text === key) ?? (match ? firsts.find((f) => new RegExp(match, 'i').test(f.text)) : undefined))?.tr
    }
    let after: { id?: string; end: number } | null = trs.length ? { id: trs[0].attrs['data-local-id'], end: trs[0].end } : null
    const inserts = new Map<number, string[]>()

    for (const r of mine) {
      const tr = rowFor(r.key)
      if (!tr) {
        if (!after?.id) {
          changes.push({ table: name, key: r.key, cell: null, action: 'skipped', why: 'no row with a local id to add it after' })
          continue
        }
        const id = newId(`${name}:${r.key}`)
        const html = rowHtml(r).replace(/^<tr>/, `<tr data-local-id="${id}">`)
        edits.push({ name: 'insertNodeAfter', localId: after.id, value: html })
        inserts.set(after.end, [...(inserts.get(after.end) ?? []), html])
        after = { id, end: after.end }
        changes.push({ table: name, key: r.key, cell: null, action: 'add-row', after: textOf(parse(html)) })
        continue
      }
      after = { id: tr.attrs['data-local-id'], end: tr.end }
      const tds = cellsOf(tr)
      const cells = r.cells.flatMap((gen, n): Cell[] => {
        if (!gen.name) return []
        const td = tds[n]
        const base = { table: name, key: r.key, cell: gen.name }
        if (!td) return [{ gen, base, held: { ...base, action: 'skipped', why: `the row has no column ${n + 1}` } }]
        const before = textOf(td)
        const re = new RegExp(`^qa-auto-${escRe(markerRow(name, r.key))}-${gen.name}-`)
        const marker = markers(td).find((m) => re.test(m))
        const hash = marker ? MARKER.exec(marker)?.[3] : undefined
        const held: CellChange | undefined = !marker ? { ...base, action: 'keep-human', before }
          : hash !== shortHash(cellText(page.slice(td.start, td.end))) ? { ...base, action: 'keep-edited', before }
            : hash === gen.hash ? { ...base, action: 'unchanged' }
              : !td.attrs['data-local-id'] ? { ...base, action: 'skipped', why: 'the cell has no local id' }
                : undefined
        return [{ gen, td, base, held, before }]
      })
      // A judgement's status and comment go in together or not at all, so a person's answer is
      // never left beside a comment that disagrees with it.
      const blocked = cells.some((c) => c.gen.judged && c.held)
      for (const c of cells) {
        if (c.held) changes.push(c.gen.judged && !c.held.why ? { ...c.held, why: 'the judgement was not written' } : c.held)
        else if (c.gen.judged && blocked) changes.push({ ...c.base, action: 'skipped', why: 'a person has written the rest of this row' })
        else {
          const td = c.td!
          const inner = c.gen.html.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '')
          const html = `<${td.tag}${attrsOf(td)}>${inner}</${td.tag}>`
          edits.push({ name: 'replaceNode', localId: td.attrs['data-local-id'], value: html })
          splices.push({ start: td.start, end: td.end, text: html })
          changes.push({ ...c.base, action: c.gen.judged ? 'judgement' : 'update', before: c.before, after: textOf(parse(html)) })
        }
      }
    }
    for (const [at, html] of inserts) splices.push({ start: at, end: at, text: html.join('') })
  }
  const html = splice(page, splices) + (appended.length ? `\n${appended.join('\n')}` : '')
  return { html, edits, changes }
}

export interface Counts {
  change: number
  judged: number
  unchanged: number
  human: number
  added: number
  skipped: number
}

export function count(changes: CellChange[]): Counts {
  const c = { change: 0, judged: 0, unchanged: 0, human: 0, added: 0, skipped: 0 }
  for (const x of changes) {
    if (x.action === 'update') c.change++
    else if (x.action === 'judgement') c.judged++
    else if (x.action === 'unchanged') c.unchanged++
    else if (x.action === 'keep-human' || x.action === 'keep-edited') c.human++
    else if (x.action === 'add-row' || x.action === 'add-table') c.added++
    else c.skipped++
  }
  return c
}

const WHAT: Record<Action, string> = {
  update: 'would change', judgement: 'would take the judgement, unmarked', unchanged: 'unchanged', 'keep-human': 'kept: written by a person (no marker)',
  'keep-edited': 'kept: edited by a person since it was generated', 'add-row': 'row would be added',
  'add-table': 'table would be added', skipped: 'skipped',
}

export function diffSummary(title: string, changes: CellChange[]): string {
  const c = count(changes)
  const out = [title, `${c.change} cells would change, ${c.judged} would take a judgement, ${c.added} rows would be added, ${c.human} cells kept as people wrote them, ` +
    `${c.unchanged} unchanged, ${c.skipped} skipped`, '']
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
    const stdout = String((e as { stdout?: unknown }).stdout ?? '')
    try {
      return { ok: false, out: JSON.parse(stdout) }
    } catch {
      throw new Error(`twg ${args.slice(0, 3).join(' ')} failed`)
    }
  }
}

export function getPage(run: TwgRunner, id: string, draft: boolean): Page {
  const args = ['confluence', 'content', 'get', id, '--detail', 'full', '--format', 'html', ...(draft ? ['--draft'] : []), '-o', 'json', '--output-summary', 'none']
  const { ok, out } = twgJson(run, args)
  const d = out.data
  if (!ok || !d?.snapshotToken || typeof d.body?.value !== 'string') throw new Error(`could not read page ${id}`)
  return { id, html: d.body.value, token: d.snapshotToken, spaceId: d.spaceId, title: d.title }
}

export const VERSION_MESSAGE = 'Generated by the qa-report pipeline'

const isStale = (out: Record<string, any>) => /stale|conflict/i.test(JSON.stringify([out.data?.reason, out.error?.code, out.error?.reason, out.error?.message]))

export interface PublishResult {
  counts: Counts
  published: boolean
  retried: boolean
  validated?: boolean
}

/**
 * Dry run (the default) reads the published page, merges, and writes merged.html, edits.json
 * and diff.txt to `dir`. With `validate`, twg also checks the edits without writing. With
 * `publish`, it reads the draft (classic pages are edited through their draft), merges, and
 * updates with the draft's snapshot token.
 */
export function publishToPage(run: TwgRunner, pageId: string, layout: Layout, rows: GenRow[], dir: string,
  opts: { publish?: boolean; validate?: boolean } = {}): PublishResult {
  const attempt = () => {
    const page = getPage(run, pageId, !!opts.publish)
    const m = merge(page.html, layout, rows)
    writeFileSync(join(dir, 'page.html'), page.html)
    writeFileSync(join(dir, 'merged.html'), m.html)
    writeFileSync(join(dir, 'edits.json'), JSON.stringify(m.edits, null, 2) + '\n')
    writeFileSync(join(dir, 'diff.txt'), diffSummary(`Page ${pageId}, snapshot ${page.token}`, m.changes))
    return { page, m }
  }
  let { page, m } = attempt()
  const counts = () => count(m.changes)
  const update = (dry: boolean) => twgJson(run, ['confluence', 'content', 'update', pageId, '--snapshot-token', page.token,
    '--edits-file', join(dir, 'edits.json'), '--ack-body-formats', '--version-message', VERSION_MESSAGE, '-y',
    ...(dry ? ['--dry-run'] : []), '-o', 'json', '--output-summary', 'none'])

  if (!opts.publish) {
    if (!opts.validate || !m.edits.length) return { counts: counts(), published: false, retried: false }
    const { ok, out } = update(true)
    return { counts: counts(), published: false, retried: false, validated: ok && out.data?.ok !== false }
  }
  if (!m.edits.length) return { counts: counts(), published: false, retried: false }
  let res = update(false)
  let retried = false
  if (!res.ok && isStale(res.out)) {
    retried = true
    const again = attempt()
    page = again.page
    m = again.m
    if (!m.edits.length) return { counts: counts(), published: false, retried }
    res = update(false)
  }
  if (!res.ok || res.out.data?.ok === false) throw new Error(`twg could not update page ${pageId}${retried ? ' after re-reading it' : ''}`)
  return { counts: counts(), published: true, retried }
}

export function createPage(run: TwgRunner, parentId: string, title: string, html: string, dir: string, publish: boolean): string | null {
  const file = join(dir, 'new-page.html')
  writeFileSync(file, html)
  if (!publish) return null
  const parent = getPage(run, parentId, false)
  const { ok, out } = twgJson(run, ['confluence', 'content', 'create', '--content-type', 'page', '--parent-id', parentId,
    ...(parent.spaceId ? ['--space-id', String(parent.spaceId)] : []), '--title', title, '--body-file', file, '--format', 'html',
    '--ack-body-formats', '-y', '-o', 'json', '--output-summary', 'none'])
  const id = out.data?.id ?? out.data?.content?.id
  if (!ok || !id) throw new Error(`twg could not create the page under ${parentId}`)
  return String(id)
}

export function releaseTitle(cfg: ReleaseConfig, layout: Layout): string {
  return layout.title.replace('{release}', cfg.release)
}
