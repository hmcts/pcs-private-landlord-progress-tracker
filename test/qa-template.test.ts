// A layout that reproduces the R1.3A template: the release's output it leaves alone, and how
// publish moves rows, retires what the generator wrote before, and merges the header, intro and
// sections.

import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { answerItems, validateAnswers, type SectionAnswers } from '../scripts/lib/qa/answers.ts'
import { fileUnderRows, SERVICE_WIDE } from '../scripts/lib/qa/collect.ts'
import { type Layout, loadRelease, type ReleaseConfig, validateLayout } from '../scripts/lib/qa/config.ts'
import { blocksOf, cellsOf, isHeading, parse, rowsOf, tableAfterHeading, textOf } from '../scripts/lib/qa/html.ts'
import { type CellChange, count, diffSummary, increasing, merge, type MergeResult, publishedParts } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, type GenRow, ownedCell, plainCell, renderPage, rowHtml, tableHtml } from '../scripts/lib/qa/render.ts'
import { genParts, ukDate } from '../scripts/lib/qa/sections.ts'
import { jiraReader, TICKET_LINKS } from '../scripts/lib/qa/sources/jira.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { fakeTwg, jqlOf, NOW, SHA, withIds } from './qa-helpers.ts'

describe('the release report', () => {
  // Written by master's code before the template layout: the same evidence must render and
  // merge exactly as it did.
  const golden = JSON.parse(readFileSync('test/fixtures/qa-release-golden.json', 'utf8'))
  const { cfg, layout } = loadRelease('config/qa-readiness/R1.3A.yaml')
  const ev: Evidence = golden.evidence

  test('renders as it did', () => {
    assert.equal(renderPage(cfg, layout, evaluate(cfg, layout, ev)), golden.report)
    assert.equal(renderPage(cfg, layout, evaluate(cfg, layout, { ...ev, items: [] })), golden.page)
  })

  test('merges into its page as it did', () => {
    const m = merge(withIds(golden.page), layout, genRows(layout, evaluate(cfg, layout, ev)))
    assert.deepEqual(JSON.parse(JSON.stringify({ merged: m.html, edits: m.edits, changes: m.changes })),
      { merged: golden.merged, edits: golden.edits, changes: golden.changes })
  })
})

const { cfg: loaded, layout } = loadRelease('config/qa-readiness/private-landlord-make-a-claim.yaml')
const cfg: ReleaseConfig = { ...loaded, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe2 } }] }
const link = { text: 'HDPI-1', url: 'https://hmcts.atlassian.net/browse/HDPI-1' }
const SECTIONS = {
  info: { 'Release Type': { text: 'Technical Release', links: [] } },
  testingSummary: Object.fromEntries(layout.sections![0].rows!.map((r) => [r, ''])),
  defectSummary: { counts: { Critical: '0', High: '0', Medium: '1', Low: '0' }, comment: 'No outstanding defects prevent this release from progressing to Production.' },
  risks: [{ risk: 'None', mitigation: '', links: [] }],
  qaSummary: 'Unit and integration testing are complete.',
  recommendation: { approved: false, reason: 'The E2E tests have not passed.' },
}
const NAME = 'Test Person'
const DAY = new Date('2026-11-17T09:00:00Z')

function answered(sections: Record<string, unknown> = SECTIONS): { rows: GenRow[]; sections: SectionAnswers } {
  const v = validateAnswers({ '1': { answer: 'Yes', comment: 'Coverage 96%.', links: [link] }, sections }, layout)
  assert.deepEqual(v.errors, [])
  const ev: Evidence = { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates,
    items: fileUnderRows(layout, answerItems(v.answers, layout, NOW, v.sections)) }
  return { rows: genRows(layout, evaluate(cfg, layout, ev)), sections: v.sections }
}

const parts = (sections: SectionAnswers, name: string | null = NAME, date = DAY) => genParts(layout, sections, date, name)

const LEGACY = [
  '<p>This readiness checklist covers one feature, using the questions of the release QA readiness report.</p>',
  '<p>Where applicable, supporting evidence has been provided. Any items marked as N/A include an explanation.</p>',
  '<p><em>Cells written by the qa-report pipeline are regenerated each time it runs. Edit a cell to take it over: the pipeline then leaves it alone.</em></p>',
]

/** A page as the generator wrote it before the template layout, shaped like page 382468869. */
function oldPage(rows: GenRow[], intro = LEGACY): string {
  const info = (key: string) => rows.find((r) => r.table === 'info' && r.key === key)!
  const gone = (key: string, text: string): GenRow => ({ table: 'info', key, cells: [plainCell(key), ownedCell('info', key, 'details', [{ text, links: [] }])] })
  const infoRows = [gone('Feature', cfg.release), info('Release Type'), gone('Epics', 'HDPI-10019'), info('Outstanding Bugs'), info('GIT'), info('GIT Revision'),
    info('Test Environments'), info('External Dependencies'), info('External Risks')]
  return withIds([`<h1>QA Readiness Report – ${cfg.release}</h1>`, ...intro,
    tableHtml({ heading: 'Feature Information', columns: ['Item', 'Details'] }, infoRows, 2),
    tableHtml(layout.checklist, rows.filter((r) => r.table === 'checklist'), 1, 'th')].join('\n'))
}

const keysOf = (html: string, heading: RegExp) => rowsOf(tableAfterHeading(parse(html), heading)!).map((tr) => textOf(cellsOf(tr)[0]))
const changesOf = (m: MergeResult, table: CellChange['table'], key: string) => m.changes.filter((c) => c.table === table && c.key === key).map((c) => c.action)
const INFO = ['Item', ...layout.info!.rows.map((r) => r.key)]

describe('a page the generator wrote before the template layout', () => {
  const { rows, sections } = answered()
  const page = oldPage(rows)
  const m = merge(page, layout, rows, parts(sections))

  test('its heading is renamed, keeping its local id, and its retired rows go', () => {
    const h = blocksOf(parse(page)).find((b) => textOf(b) === 'Feature Information')!
    assert.deepEqual(m.edits.find((e) => e.localId === h.attrs['data-local-id']), { name: 'replaceNode', localId: h.attrs['data-local-id'], value: `<h2 data-local-id="${h.attrs['data-local-id']}">Release Information</h2>` })
    assert.deepEqual(changesOf(m, 'info', 'Feature'), ['remove-row'])
    assert.deepEqual(changesOf(m, 'info', 'Epics'), ['remove-row'])
    assert.deepEqual(keysOf(m.html, /^Release Information$/), INFO)
  })

  test('rows out of order are moved, as few as it takes, by moveNode', () => {
    const moved = m.changes.filter((c) => c.action === 'move-row').map((c) => c.key)
    assert.equal(moved.length, 3)
    const moves = m.edits.filter((e) => e.name === 'moveNode')
    assert.equal(moves.length, 3)
    const ids = rowsOf(tableAfterHeading(parse(page), /^Feature Information$/)!).map((tr) => tr.attrs['data-local-id'])
    for (const e of moves) {
      assert.ok(e.name === 'moveNode' && ids.includes(e.arguments.localId) && e.arguments.position === 0)
      assert.ok(!m.edits.some((x) => x.name === 'deleteNode' && x.localId === e.arguments.localId), 'a moved row is never deleted')
    }
    assert.equal(count(m.changes).moved, 3)
    assert.match(diffSummary('t', m.changes), /3 rows would be moved, /)
  })

  test('the checklist header row is recelled as td, keeping its attributes', () => {
    const tr = rowsOf(tableAfterHeading(parse(page), /^QA Readiness Checklist$/)!)[0]
    const e = m.edits.find((x) => x.localId === tr.attrs['data-local-id'])!
    assert.equal(e.name, 'replaceNode')
    assert.match(String(e.value), /^<tr data-local-id="[0-9a-f]+"><td data-local-id="[0-9a-f]+" data-colwidth="49"><p data-local-id="[0-9a-f]+">No<\/p><\/td>/)
    assert.ok(!String(e.value).includes('<th'))
  })

  test('the old note and intro make way for the template intro, and the header is added above the title', () => {
    const blocks = blocksOf(parse(m.html))
    const title = blocks.findIndex(isHeading)
    assert.deepEqual(blocks.slice(0, title).map(textOf), [`Created by: ${NAME} Last Updated: ${ukDate(DAY)}`])
    assert.deepEqual(blocks.slice(title + 1, title + 3).map(textOf), layout.intro)
    assert.ok(isHeading(blocks[title + 3]))
    assert.doesNotMatch(m.html, /Cells written by the qa-report pipeline|covers one feature/)
    assert.deepEqual(changesOf(m, 'part', 'intro'), ['update'])
    assert.deepEqual(changesOf(m, 'part', 'header'), ['update'])
  })

  test('the sections are added after the checklist, in order', () => {
    assert.deepEqual(m.changes.filter((c) => c.action === 'add-part').map((c) => c.key), layout.sections!.map((s) => s.heading))
    const headings = blocksOf(parse(m.html)).filter(isHeading).map(textOf)
    assert.deepEqual(headings.slice(-(layout.sections!.length + 1)), ['QA Readiness Checklist', ...layout.sections!.map((s) => s.heading)])
  })

  test('merging the result again changes nothing', () => {
    const again = merge(m.html, layout, rows, parts(sections))
    assert.deepEqual(again.edits, [])
    assert.deepEqual(again.changes.filter((c) => c.action !== 'unchanged' && c.action !== 'keep-unreachable'), [])
  })
})

describe('moving rows', () => {
  const { rows, sections } = answered()
  const fresh = withIds(renderPage(cfg, layout, evaluate(cfg, layout, { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }), {}, parts(sections)))
  const info = tableAfterHeading(parse(fresh), /^Release Information$/)!
  const trs = rowsOf(info)
  const byKey = (k: string) => trs.find((tr) => textOf(cellsOf(tr)[0]) === k)!
  /** The page with one info row taken out and put back after another. */
  const shifted = (key: string, afterKey: string, edit = (s: string) => s) => {
    const tr = byKey(key)
    const html = edit(fresh.slice(tr.start, tr.end))
    const without = fresh.slice(0, tr.start) + fresh.slice(tr.end)
    const at = without.indexOf(fresh.slice(byKey(afterKey).start, byKey(afterKey).end)) + byKey(afterKey).end - byKey(afterKey).start
    return without.slice(0, at) + html + without.slice(at)
  }

  test('one row out of place is the only one moved, not every row after it', () => {
    const m = merge(shifted('GIT Revision', 'Release'), layout, rows, parts(sections))
    assert.deepEqual(m.changes.filter((c) => c.action === 'move-row').map((c) => c.key), ['GIT Revision'])
    assert.deepEqual(m.edits.filter((e) => e.name === 'moveNode'), [{ name: 'moveNode',
      arguments: { localId: byKey('GIT Revision').attrs['data-local-id'], targetLocalId: byKey('GIT').attrs['data-local-id'], position: 0 } }])
    assert.deepEqual(keysOf(m.html, /^Release Information$/), INFO)
  })

  test('a row a person wrote is moved as it is, its content, local ids and comments kept', () => {
    const comment = '<span data-type="inline-comment-marker" data-ref="abc">Checked by hand</span>'
    const page = shifted('External Risks', 'Release', (s) => s.replace(/(<td data-local-id="[0-9a-f]+" data-colwidth="1133"><p data-local-id="[0-9a-f]+">)<span[^>]*><\/span>/, `$1${comment}`))
    const m = merge(page, layout, rows, parts(sections))
    assert.deepEqual(changesOf(m, 'info', 'External Risks'), ['move-row', 'keep-human'])
    const tr = byKey('External Risks')
    assert.ok(!m.edits.some((e) => e.localId === tr.attrs['data-local-id'] || (e.name === 'replaceNode' && e.value.includes('Checked by hand'))))
    assert.ok(m.html.includes(comment))
    assert.deepEqual(keysOf(m.html, /^Release Information$/), INFO)
  })

  test('a generator row that is moved still has its cells merged, inside the row', () => {
    const m = merge(shifted('Release Type', 'GIT Revision'), layout, rows, parts(sections))
    assert.deepEqual(changesOf(m, 'info', 'Release Type'), ['move-row', 'update'])
    const type = rowsOf(tableAfterHeading(parse(m.html), /^Release Information$/)!)[2]
    assert.deepEqual(cellsOf(type).map(textOf), ['Release Type', 'Technical Release'])
  })

  test('a row with no local id stays where it is', () => {
    const tr = byKey('GIT Revision')
    const page = shifted('GIT Revision', 'Release', (s) => s.replace(`<tr data-local-id="${tr.attrs['data-local-id']}"`, '<tr'))
    const m = merge(page, layout, rows, parts(sections))
    assert.deepEqual(changesOf(m, 'info', 'GIT Revision')[0], 'skipped')
    assert.ok(!m.edits.some((e) => e.name === 'moveNode'))
  })

  test('the rows that stay are a longest run already in order', () => {
    assert.deepEqual([...increasing([0, 5, 1, 2, 3])].sort(), [0, 2, 3, 4])
    assert.equal(increasing([1, 4, 5, 6, 7, 8, 9, 2, 3]).size, 7)
    assert.deepEqual([...increasing([])], [])
  })
})

describe('the header', () => {
  const { rows, sections } = answered()
  const page = withIds(renderPage(cfg, layout, evaluate(cfg, layout, { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }), {}, parts(sections)))
  const first = merge(page, layout, rows, parts(sections))
  const settled = merge(first.html, layout, rows, parts(sections)).edits.length ? null : first.html

  test('is left alone when only its date would change', () => {
    assert.ok(settled)
    const m = merge(settled, layout, rows, parts(sections, NAME, new Date('2026-11-18T09:00:00Z')))
    assert.deepEqual(m.edits, [])
    assert.deepEqual(m.changes.find((c) => c.key === 'header'), { table: 'part', key: 'header', cell: null, action: 'unchanged', why: 'only the date would change' })
  })

  test('takes the new date when anything else changes', () => {
    const later = answered({ ...SECTIONS, qaSummary: 'Everything is complete.' })
    const m = merge(settled!, layout, later.rows, parts(later.sections, NAME, new Date('2026-11-18T09:00:00Z')))
    assert.deepEqual(changesOf(m, 'part', 'header'), ['update'])
    assert.match(m.html, /Last Updated:<\/strong> 18\/11\/2026/)
  })

  test('with no name collected, is not written at all, and the page keeps its own', () => {
    assert.ok(!parts(sections, null).some((p) => p.part === 'header'))
    assert.doesNotMatch(renderPage(cfg, layout, evaluate(cfg, layout, { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }), {}, parts(sections, null)), /Created by/)
    const m = merge(settled!, layout, rows, parts(sections, null))
    assert.deepEqual(changesOf(m, 'part', 'header'), [])
    assert.match(m.html, new RegExp(`Created by:</strong> ${NAME}`))
  })
})

describe('the intro', () => {
  const { rows, sections } = answered()
  const introOf = (html: string) => {
    const blocks = blocksOf(parse(html))
    const title = blocks.findIndex(isHeading)
    const next = blocks.findIndex((b, n) => n > title && isHeading(b))
    return blocks.slice(title + 1, next)
  }

  test('paragraphs the generator wrote before, all of them, are replaced', () => {
    const m = merge(oldPage(rows, LEGACY.slice(0, 2)), layout, rows, parts(sections))
    assert.deepEqual(introOf(m.html).map(textOf), layout.intro)
    assert.deepEqual(changesOf(m, 'part', 'intro'), ['update'])
  })

  test("beside a person's paragraph: the old ones go, the template's is written and owned, and the person's is never touched", () => {
    const mine = '<p>Read with the release plan.</p>'
    const page = oldPage(rows, [LEGACY[0], mine, LEGACY[2]])
    const theirs = introOf(page).find((b) => textOf(b) === 'Read with the release plan.')!
    const m = merge(page, layout, rows, parts(sections))
    assert.deepEqual(introOf(m.html).map(textOf), [...layout.intro!, 'Read with the release plan.'])
    assert.ok(!m.edits.some((e) => e.localId === theirs.attrs['data-local-id']))
    assert.ok(m.html.includes(page.slice(theirs.start, theirs.end)))
    assert.match(m.html, /qa-auto-part-intro-[0-9a-f]{8}/)
    assert.deepEqual(m.changes.find((c) => c.key === 'intro')?.why, 'a person wrote the rest, which stays')

    const again = merge(m.html, layout, rows, parts(sections))
    assert.deepEqual(changesOf(again, 'part', 'intro'), ['unchanged'], "the template's intro is the generator's from then on")
    assert.deepEqual(again.edits, [])
  })

  test('a layout with no intro has no intro part, and reports no change for it', () => {
    const bare: Layout = { ...layout, intro: undefined }
    assert.ok(!genParts(bare, sections, DAY, NAME).some((p) => p.part === 'intro'))
    const page = withIds(renderPage(cfg, bare, evaluate(cfg, bare, { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }), {}, genParts(bare, sections, DAY, NAME)))
    const m = merge(page, bare, rows, genParts(bare, sections, DAY, NAME))
    assert.deepEqual(changesOf(m, 'part', 'intro'), [])
  })
})

describe('sections', () => {
  const { rows, sections } = answered()
  const page = withIds(renderPage(cfg, layout, evaluate(cfg, layout, { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }), {}, parts(sections)))
  const qa = (html: string) => blocksOf(parse(html)).find((b) => textOf(b) === SECTIONS.qaSummary)!
  const later = answered({ ...SECTIONS, qaSummary: 'Everything is complete.' })

  test('one the generator wrote is rewritten when its answer changes', () => {
    const m = merge(page, layout, later.rows, parts(later.sections))
    assert.deepEqual(changesOf(m, 'part', 'QA Summary'), ['update'])
    assert.match(m.html, /Everything is complete\./)
  })

  test('one a person edited is theirs: kept, and reported as theirs to the agent', () => {
    const p = qa(page)
    const edited = page.slice(0, p.start) + page.slice(p.start, p.end).replace(SECTIONS.qaSummary, 'Signed off in the meeting.') + page.slice(p.end)
    const m = merge(edited, layout, later.rows, parts(later.sections))
    assert.deepEqual(changesOf(m, 'part', 'QA Summary'), ['keep-edited'])
    assert.doesNotMatch(m.html, /Everything is complete\./)
    assert.equal(publishedParts(edited, layout).sections.qaSummary.byPerson, true)
    assert.equal(publishedParts(page, layout).sections.qaSummary.byPerson, undefined)
  })

  test('one a person wrote, with no marker, is kept', () => {
    const p = qa(page)
    const theirs = page.slice(0, p.start) + `<p data-local-id="0000000000ff">Signed off in the meeting.</p>` + page.slice(p.end)
    const m = merge(theirs, layout, later.rows, parts(later.sections))
    assert.deepEqual(changesOf(m, 'part', 'QA Summary'), ['keep-human'])
    assert.equal(publishedParts(theirs, layout).sections.qaSummary.byPerson, true)
  })
})

describe('the layout and the answers agree', () => {
  test('an agent info row needs a layout with sections, where its answer goes', () => {
    const doc = (extra: Record<string, unknown>) => ({ title: 't', checklist: { heading: 'h', columns: ['No', 'Q'], rows: [{ key: '1', rule: 'agent', question: 'q' }] },
      info: { heading: 'i', columns: ['Item', 'Details'], rows: [{ key: 'Release Type', rule: 'agent' }] }, ...extra })
    assert.match(validateLayout(doc({})).join('\n'), /info\.rows\[0\]: rule agent is only for a layout with "sections"/)
    assert.deepEqual(validateLayout(doc({ sections: [{ kind: 'qaSummary', heading: 'QA Summary', level: 1 }] })), [])
  })

  test('"Created by" is not an answer', () => {
    const v = validateAnswers({ sections: { createdBy: NAME } }, layout)
    assert.match(v.errors.join('\n'), /answers\.sections\.createdBy: the layout has no such section/)
  })
})

describe('the Jira Tickets row', () => {
  const ticket = (n: number) => ({ key: `HDPI-${n}`, issuetype: { name: n % 2 ? 'Story' : 'Spike' }, status: { name: 'Closed', statusCategory: { key: 'done' } }, comment: { total: 0, comments: [] } })

  test(`links the first ${TICKET_LINKS} tickets, then the search for the rest`, async () => {
    const run = fakeTwg((args) => ({ data: { issues: jqlOf(args).includes('statusCategory') ? [] : Array.from({ length: 20 }, (_, n) => ticket(n + 1)) } }))
    const items = await jiraReader(cfg, run, NOW)()
    const links = items.find((i) => i.rule === 'epic-tickets')!.links
    assert.equal(links.length, TICKET_LINKS + 1)
    assert.deepEqual(links[0], { text: 'HDPI-1', url: 'https://hmcts.atlassian.net/browse/HDPI-1' })
    assert.deepEqual(links.at(-1), { text: 'and 5 more', url: `https://hmcts.atlassian.net/issues/?jql=${encodeURIComponent(cfg.jql)}` })
    assert.equal(items.find((i) => i.rule === 'stories-done')!.value, '10 of 10 stories, tasks and bugs are done')
  })

  test('with no more than that, has no search link', async () => {
    const run = fakeTwg((args) => ({ data: { issues: jqlOf(args).includes('statusCategory') ? [] : [ticket(1), ticket(2)] } }))
    const links = (await jiraReader(cfg, run, NOW)()).find((i) => i.rule === 'epic-tickets')!.links
    assert.deepEqual(links.map((l) => l.text), ['HDPI-1', 'HDPI-2'])
  })

  test('a Jira failure leaves it unknown and unreachable', async () => {
    const items = await jiraReader(cfg, fakeTwg(() => new Error('twg exited 1')), NOW)()
    const t = items.find((i) => i.rule === 'epic-tickets')!
    assert.deepEqual([t.status, t.unreachable], ['unknown', true])
  })
})
