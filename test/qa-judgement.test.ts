import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileUnderRows } from '../scripts/lib/qa/collect.ts'
import { activeReleases, loadLayout } from '../scripts/lib/qa/config.ts'
import { cellsOf, parse, rowsOf, tableAfterHeading, textOf } from '../scripts/lib/qa/html.ts'
import { type Judgements, loadJudgements, validateJudgements } from '../scripts/lib/qa/judgement.ts'
import { merge } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from '../scripts/lib/qa/render.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { CFG, fact, NOW, withIds } from './qa-helpers.ts'

const layout = loadLayout('pcs')
const cfg = { ...CFG, human_rows: {} }
const dir = mkdtempSync(join(tmpdir(), 'qa-judgement-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const ev: Evidence = { release: 'TEST', generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, [
  fact({ rule: 'sonar-coverage', status: 'pass', value: '96.0%', repo: 'pcs-api', candidate: 'V2' }),
]) }
const results = evaluate(cfg, layout, ev)

const JUDGED: Judgements = {
  '5': { status: 'N/A', comment: 'No browser-specific changes in this release.' },
  '16': { status: 'Yes', comment: 'Manual regression on V2 passed.\n\nRe-run after the fix.', links: [{ text: 'HDPI-8908', url: 'https://hmcts.atlassian.net/browse/HDPI-8908' }] },
}

const checklist = (html: string) => rowsOf(tableAfterHeading(parse(html), /^QA Readiness Checklist$/)!)
const row = (html: string, key: string) => checklist(html).find((tr) => textOf(cellsOf(tr)[0]) === key)!
const cell = (html: string, key: string, n: number) => {
  const td = cellsOf(row(html, key))[n]
  return { text: textOf(td), html: html.slice(td.start, td.end) }
}
const page = () => withIds(renderPage(cfg, layout, results))

describe('judgement files', () => {
  test('take rows a person answers, with Yes, No or N/A and a comment', () => {
    assert.deepEqual(validateJudgements(JUDGED, results.checklist), [])
    const errors = validateJudgements({
      '1': { status: 'Yes', comment: 'x' },
      '99': { status: 'Yes', comment: 'x' },
      '9': { status: 'To confirm', comment: '' },
      '13': { status: 'No', comment: 'x', links: [{ text: 'a', url: 'http://insecure' }], extra: 1 },
    }, results.checklist)
    assert.ok(errors.some((e) => /row 1 is answered from evidence/.test(e)))
    assert.ok(errors.some((e) => /no row 99/.test(e)))
    assert.ok(errors.some((e) => /9: "status" must be Yes, No or N\/A/.test(e)))
    assert.ok(errors.some((e) => /9: "comment" is required/.test(e)))
    assert.ok(errors.some((e) => /13: "links"/.test(e)))
    assert.ok(errors.some((e) => /13: unknown field "extra"/.test(e)))
  })

  test('must not be in the repo outside .cache/', () => {
    assert.throws(() => loadJudgements('config/qa-readiness/judgement.yaml', results.checklist), /outside the repo or under \.cache/)
    const file = join(dir, 'judgement.yaml')
    writeFileSync(file, "'16': { status: 'Yes', comment: Passed. }\n")
    assert.equal(loadJudgements(file, results.checklist)['16'].status, 'Yes')
  })
})

describe('publishing a judgement', () => {
  const m = merge(page(), layout, genRows(layout, results, JUDGED))
  const action = (key: string, c: string) => m.changes.find((x) => x.key === key && x.cell === c)?.action

  test('writes the status and comment without the ownership marker', () => {
    const rows = genRows(layout, results, JUDGED)
    const r16 = rows.find((r) => r.table === 'checklist' && r.key === '16')!
    assert.ok(r16.cells.filter((c) => c.judged).every((c) => !c.html.includes('qa-auto-')))
    assert.deepEqual([action('16', 'status'), action('16', 'comments'), action('5', 'status')], ['judgement', 'judgement', 'judgement'])
    assert.equal(cell(m.html, '16', 2).text, 'Yes')
    assert.equal(cell(m.html, '16', 3).text, 'Manual regression on V2 passed. Re-run after the fix. HDPI-8908')
    assert.doesNotMatch(cell(m.html, '16', 2).html + cell(m.html, '16', 3).html, /qa-auto-/)
    assert.match(cell(m.html, '1', 2).html, /qa-auto-1-status-/)
  })

  test('a later run without the judgement leaves those cells alone', () => {
    const next = merge(m.html, layout, genRows(layout, results))
    const kept = next.changes.filter((x) => (x.key === '16' || x.key === '5') && x.table === 'checklist').map((x) => x.action)
    assert.deepEqual(kept, ['keep-human', 'keep-human', 'keep-human', 'keep-human'])
    assert.equal(cell(next.html, '16', 3).text, 'Manual regression on V2 passed. Re-run after the fix. HDPI-8908')
    assert.equal(next.edits.length, 0)
  })

  test('never overwrites a cell a person wrote, nor half-fills that row', () => {
    let html = page()
    const s = cellsOf(row(html, '16'))[2]
    html = html.slice(0, s.start) + '<td data-local-id="bbbbbbbbbbb1"><p>Passed, see the test report</p></td>' + html.slice(s.end)
    const r = merge(html, layout, genRows(layout, results, JUDGED))
    const a = (c: string) => r.changes.find((x) => x.key === '16' && x.cell === c)!
    assert.equal(a('status').action, 'keep-human')
    assert.deepEqual([a('comments').action, a('comments').why], ['skipped', 'a person has written the rest of this row'])
    assert.equal(cell(r.html, '16', 2).text, 'Passed, see the test report')
    assert.match(cell(r.html, '16', 3).html, /qa-auto-16-comments-/)
    assert.equal(r.changes.find((x) => x.key === '5' && x.cell === 'status')!.action, 'judgement')
  })

  test('a generator cell a person has since edited is kept too', () => {
    let html = page()
    const c = cellsOf(row(html, '16'))[3]
    const p = c.children.find((x) => x.type === 'el')!
    html = html.slice(0, p.end - 4) + ' Checked.' + html.slice(p.end - 4)
    const r = merge(html, layout, genRows(layout, results, JUDGED))
    assert.equal(r.changes.find((x) => x.key === '16' && x.cell === 'comments')!.action, 'keep-edited')
    assert.equal(r.changes.find((x) => x.key === '16' && x.cell === 'status')!.action, 'skipped')
  })

  test('a missing row is added with the judgement in it', () => {
    let html = page()
    const tr = row(html, '16')
    html = html.slice(0, tr.start) + html.slice(tr.end)
    const r = merge(html, layout, genRows(layout, results, JUDGED))
    assert.equal(r.changes.find((x) => x.key === '16')!.action, 'add-row')
    assert.equal(cell(r.html, '16', 2).text, 'Yes')
    const added = row(r.html, '16')
    assert.doesNotMatch(r.html.slice(added.start, added.end), /qa-auto-/)
  })
})

describe('active releases', () => {
  test('are the configs with active: true and a report_page', () => {
    const cfgDir = join(dir, 'configs')
    mkdirSync(cfgDir)
    const files: Record<string, string> = {
      'A.yaml': "release: A\nactive: true\nreport_page: '1'\n",
      'B.yaml': 'release: B\nactive: true\n',
      'C.yaml': "release: C\nactive: false\nreport_page: '2'\n",
      'D.yaml': 'release: [D\n',
    }
    for (const [f, text] of Object.entries(files)) writeFileSync(join(cfgDir, f), text)
    assert.deepEqual(activeReleases(cfgDir), [join(cfgDir, 'A.yaml'), join(cfgDir, 'D.yaml')])
    assert.deepEqual(activeReleases(join(dir, 'missing')), [])
  })
})
