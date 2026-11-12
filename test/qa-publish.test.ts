import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadLayout } from '../scripts/lib/qa/config.ts'
import { cellsOf, parse, rowsOf, tableAfterHeading, textOf } from '../scripts/lib/qa/html.ts'
import { createPage, merge, publishToPage, VERSION_MESSAGE } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from '../scripts/lib/qa/render.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { CFG, fact, fakeTwg, NOW, withIds } from './qa-helpers.ts'
import { fileUnderRows } from '../scripts/lib/qa/collect.ts'

const layout = loadLayout('pcs')
const cfg = { ...CFG, human_rows: {} }
const dir = mkdtempSync(join(tmpdir(), 'qa-publish-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function evidence(coverage: string, bugs: string): Evidence {
  const items = [
    fact({ rule: 'sonar-coverage', status: 'pass', value: coverage, repo: 'pcs-api', sha: CFG.candidates[1].shas['pcs-api'], candidate: 'V2' }),
    fact({ rule: 'high-defects', status: 'pass', value: 'no Critical or High bugs open' }),
    fact({ rule: 'outstanding-bugs', status: 'pass', value: bugs }),
    fact({ rule: 'test-complete', status: 'pass', value: 'all 3' }),
  ]
  return { release: 'TEST', generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) }
}

const rowsFor = (ev: Evidence) => genRows(layout, evaluate(cfg, layout, ev))

/** Yesterday's generated page, after people have worked on it. */
function editedPage(): string {
  let html = withIds(renderPage(cfg, layout, evaluate(cfg, layout, evidence('95.0%', 'Critical – 0, High – 0, Medium – 2, Low – 0'))))
  const root = parse(html)
  const checklist = rowsOf(tableAfterHeading(root, /^QA Readiness Checklist$/)!)
  const row = (k: string) => checklist.find((tr) => textOf(cellsOf(tr)[0]) === k)!
  const edits: { start: number; end: number; text: string }[] = []
  // Row 1's status: rewritten in the editor, which took the marker with it.
  const s1 = cellsOf(row('1'))[2]
  edits.push({ start: s1.start, end: s1.end, text: '<td data-local-id="aaaaaaaaaaa1" data-colwidth="60"><p data-local-id="aaaaaaaaaaa2">Yes, see screenshot</p></td>' })
  // Row 20's comments: a person added a sentence but left the marker in place.
  const c20 = cellsOf(row('20'))[3]
  const p = c20.children.find((c) => c.type === 'el')!
  edits.push({ start: p.end - 4, end: p.end - 4, text: ' Checked by QA too.' })
  // Row 3 deleted.
  edits.push({ start: row('3').start, end: row('3').end, text: '' })
  for (const e of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, e.start) + e.text + html.slice(e.end)
  return html
}

describe('merge', () => {
  const page = editedPage()
  const m = merge(page, layout, rowsFor(evidence('96.1%', 'Critical – 0, High – 0, Medium – 1, Low – 0')))
  const action = (table: string, key: string, cell: string | null) => m.changes.find((c) => c.table === table && c.key === key && c.cell === cell)?.action

  test('replaces generator cells whose evidence changed, keeping their local id and width', () => {
    assert.equal(action('info', 'Outstanding Bugs', 'details'), 'update')
    const e = m.edits.find((x) => x.name === 'replaceNode' && x.value.includes('Medium – 1'))!
    assert.match(e.value, new RegExp(`^<td data-local-id="${e.localId}" data-colwidth="1133">`))
    assert.doesNotMatch(m.html, /Medium – 2/)
  })

  test('leaves a row alone once a person has written either of its cells', () => {
    const c = m.changes.find((x) => x.table === 'checklist' && x.key === '1' && x.cell === 'comments')!
    assert.deepEqual([c.action, c.why], ['skipped', 'a person has written the rest of this row'])
    assert.match(m.html, /95\.0%/)
    assert.doesNotMatch(m.html, /96\.1%/)
  })

  test('keeps cells a person wrote, and generator cells a person has since edited', () => {
    assert.equal(action('checklist', '1', 'status'), 'keep-human')
    assert.equal(action('checklist', '20', 'comments'), 'keep-edited')
    assert.match(m.html, /Yes, see screenshot/)
    assert.match(m.html, /Checked by QA too\./)
    assert.equal(action('info', 'Release Type', 'details'), undefined)
  })

  test('leaves unchanged cells alone', () => {
    assert.equal(action('checklist', '2', 'status'), 'unchanged')
    assert.equal(m.edits.filter((e) => e.name === 'replaceNode').length, 1)
  })

  test('adds a missing row after the row before it', () => {
    assert.equal(action('checklist', '3', null), 'add-row')
    const ins = m.edits.find((e) => e.name === 'insertNodeAfter')!
    const root = parse(page)
    const row2 = rowsOf(tableAfterHeading(root, /^QA Readiness Checklist$/)!).find((tr) => textOf(cellsOf(tr)[0]) === '2')!
    assert.equal(ins.localId, row2.attrs['data-local-id'])
    const keys = rowsOf(tableAfterHeading(parse(m.html), /^QA Readiness Checklist$/)!).map((tr) => textOf(cellsOf(tr)[0]))
    assert.deepEqual(keys.slice(0, 5), ['No', '1', '2', '3', '4'])
  })

  test('adds a missing table at the end', () => {
    const r = merge('<h1 data-local-id="000000000001">Notes</h1><p data-local-id="000000000002">Hello</p>', layout, rowsFor(evidence('96.1%', 'x')))
    assert.deepEqual(r.edits.map((e) => e.name), ['appendNodeToEnd', 'appendNodeToEnd'])
    assert.match(r.html, /^<h1 data-local-id="000000000001">Notes<\/h1><p data-local-id="000000000002">Hello<\/p>/)
  })

  test('a heading whose table was deleted gets a new table, never the next heading\'s', () => {
    const page = withIds(renderPage(cfg, layout, evaluate(cfg, layout, evidence('95.0%', 'x'))))
    const info = tableAfterHeading(parse(page), /^Release Information$/)!
    const r = merge(page.slice(0, info.start) + page.slice(info.end), layout, rowsFor(evidence('95.0%', 'x')))
    assert.ok(r.changes.filter((c) => c.table === 'info').every((c) => c.action === 'add-table'))
    assert.ok(r.changes.filter((c) => c.table === 'checklist').every((c) => c.action !== 'add-table'))
    assert.equal(tableAfterHeading(parse('<h2>A</h2><p>x</p><h2>B</h2><table></table>'), /^A$/), null)
  })
})

describe('ownership', () => {
  const ev = evidence('95.0%', 'x')
  const page = withIds(renderPage(cfg, layout, evaluate(cfg, layout, ev)))
  const cellOf = (html: string, table: RegExp, key: string, n: number) =>
    cellsOf(rowsOf(tableAfterHeading(parse(html), table)!).find((tr) => textOf(cellsOf(tr)[0]) === key)!)[n]
  const actionOf = (html: string, table: 'info' | 'checklist', key: string, cell: string) =>
    merge(html, layout, rowsFor(ev)).changes.find((c) => c.table === table && c.key === key && c.cell === cell)!.action
  const swap = (html: string, td: { start: number; end: number }, f: (s: string) => string) =>
    html.slice(0, td.start) + f(html.slice(td.start, td.end)) + html.slice(td.end)

  test('a link changed, with its text left alone, is a person\'s edit', () => {
    const td = cellOf(page, /^Release Information$/, 'GIT', 1)
    const edited = swap(page, td, (s) => s.replace('https://github.com/hmcts/pcs-api"', 'https://github.com/hmcts/pcs-api/tree/release"'))
    assert.equal(actionOf(page, 'info', 'GIT', 'details'), 'unchanged')
    assert.equal(actionOf(edited, 'info', 'GIT', 'details'), 'keep-edited')
  })

  test('a macro added is a person\'s edit', () => {
    const td = cellOf(page, /^QA Readiness Checklist$/, '2', 3)
    const lozenge = '<span data-type="inline-extension" data-extension-key="status" data-parameters="{&quot;macroParams&quot;:{&quot;title&quot;:{&quot;value&quot;:&quot;OK&quot;}}}"></span>'
    assert.equal(actionOf(swap(page, td, (s) => s.replace(/<\/p><\/td>$/, `${lozenge}</p></td>`)), 'checklist', '2', 'comments'), 'keep-edited')
  })

  test('local ids and macro metadata Confluence adds are not edits', () => {
    const td = cellOf(page, /^QA Readiness Checklist$/, '2', 3)
    const touched = swap(page, td, (s) => s.replace(/(<p[^>]*) data-local-id="[^"]*"/g, '$1 data-local-id="fffffffffff1"')
      .replace('{&quot;macroParams&quot;', '{&quot;macroMetadata&quot;:{&quot;macroId&quot;:{&quot;value&quot;:&quot;x1&quot;}},&quot;macroParams&quot;'))
    assert.ok(touched.includes('macroMetadata') && touched.includes('fffffffffff1'))
    assert.equal(actionOf(touched, 'checklist', '2', 'comments'), 'unchanged')
  })
})

describe('publishToPage', () => {
  const page = editedPage()
  const rows = rowsFor(evidence('96.1%', 'Critical – 0, High – 0, Medium – 1, Low – 0'))
  const get = (token: string) => ({ data: { id: '42', snapshotToken: token, spaceId: '7', body: { format: 'html', value: page } } })
  const stale = () => Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ data: { ok: false, reason: 'snapshot_stale' } }) })

  test('a dry run reads the published page, writes the merge and diff, and never updates', () => {
    const run = fakeTwg(() => get('v:1'))
    const res = publishToPage(run, '42', layout, rows, dir)
    assert.equal(res.published, false)
    assert.equal(run.calls.length, 1)
    assert.ok(!run.calls[0].includes('--draft'))
    assert.equal(res.counts.change, 1)
    assert.match(readFileSync(join(dir, 'diff.txt'), 'utf8'), /1 cells would change, 0 would take a judgement, 1 rows would be added/)
    assert.equal(JSON.parse(readFileSync(join(dir, 'edits.json'), 'utf8')).length, 2)
  })

  // The draft of an unchanged page carries the same content under different local ids.
  const draft = page.replace(/data-local-id="0/g, 'data-local-id="d')
  const pages = (body: (draft: boolean) => string, token: (draft: boolean) => string, update: () => unknown = () => ({ data: { ok: true } })) =>
    fakeTwg((a) => {
      if (a[2] === 'update') return update()
      const d = a.includes('--draft')
      return { data: { id: '42', snapshotToken: token(d), spaceId: '7', body: { format: 'html', value: body(d) } } }
    })

  test('--validate merges the draft and checks the edits with its token, without writing', () => {
    const run = pages((d) => (d ? draft : page), (d) => (d ? 'draft:3' : 'v:1'), () => ({ data: { ok: true, reason: 'dry_run_validated' } }))
    const res = publishToPage(run, '42', layout, rows, dir, { validate: true })
    assert.equal(res.validated, true)
    assert.deepEqual(run.calls.map((a) => [a[2], a.includes('--draft'), a.includes('--dry-run')]), [['get', false, false], ['get', true, false], ['update', false, true]])
    const up = run.calls[2]
    assert.equal(up[up.indexOf('--snapshot-token') + 1], 'draft:3')
    const edits = JSON.parse(readFileSync(join(dir, 'edits.json'), 'utf8')) as { localId?: string }[]
    assert.ok(edits.every((e) => !e.localId || e.localId.startsWith('d') || e.localId.startsWith('a')))
  })

  test('publishing edits the draft with its snapshot token and an edit message', () => {
    const run = pages((d) => (d ? draft : page), (d) => (d ? 'draft:5' : 'v:1'))
    const res = publishToPage(run, '42', layout, rows, dir, { publish: true })
    assert.deepEqual([res.published, res.retried, res.unpublishedEdits], [true, false, undefined])
    const up = run.calls[2]
    assert.equal(up[up.indexOf('--snapshot-token') + 1], 'draft:5')
    assert.equal(up[up.indexOf('--version-message') + 1], VERSION_MESSAGE)
    assert.ok(up.includes('--edits-file') && !up.includes('--dry-run'))
  })

  test('a draft with unpublished edits is left alone, by publish and validate alike', () => {
    for (const opts of [{ publish: true }, { validate: true }]) {
      const run = pages((d) => (d ? draft.replace('Yes, see screenshot', 'Yes, see the new screenshot') : page), (d) => (d ? 'draft:6' : 'v:1'))
      const res = publishToPage(run, '42', layout, rows, dir, opts)
      assert.deepEqual([res.published, res.unpublishedEdits, res.validated], [false, true, undefined])
      assert.equal(run.calls.filter((a) => a[2] === 'update').length, 0)
    }
  })

  test('a version conflict re-reads the page, re-merges and retries once', () => {
    let reads = 0
    let updates = 0
    const run = pages((d) => (d ? draft : page), (d) => (d ? `draft:${++reads}` : 'v:1'), () => (++updates === 1 ? stale() : { data: { ok: true } }))
    const res = publishToPage(run, '42', layout, rows, dir, { publish: true })
    assert.deepEqual([res.published, res.retried], [true, true])
    const ups = run.calls.filter((a) => a[2] === 'update')
    assert.deepEqual(ups.map((a) => a[a.indexOf('--snapshot-token') + 1]), ['draft:1', 'draft:2'])
  })

  test('a second conflict gives up', () => {
    const run = fakeTwg((a) => (a[2] === 'update' ? stale() : get('draft:1')))
    assert.throws(() => publishToPage(run, '42', layout, rows, dir, { publish: true }), /could not update page 42 after re-reading it/)
    assert.equal(run.calls.filter((a) => a[2] === 'update').length, 2)
  })

  test('creating a page is a dry run unless published, and creates a classic page under the parent', () => {
    const none = fakeTwg(() => new Error('should not be called'))
    assert.equal(createPage(none, '9', 'T', '<p>x</p>', dir, false), null)
    assert.equal(none.calls.length, 0)
    const run = fakeTwg((a) => (a[2] === 'create' ? { data: { id: '77' } } : get('v:1')))
    assert.equal(createPage(run, '9', 'T', '<p>x</p>', dir, true), '77')
    const c = run.calls[1]
    assert.deepEqual([c[c.indexOf('--content-type') + 1], c[c.indexOf('--parent-id') + 1], c[c.indexOf('--space-id') + 1]], ['page', '9', '7'])
  })
})
