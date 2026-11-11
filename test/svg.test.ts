import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { EpicRow, ItemRow, Snapshot } from '../scripts/lib/snapshot.ts'
import { burnupSvg, esc, fmtDate, roadmapSvg } from '../scripts/lib/svg.ts'

function row(key: string, p: Partial<EpicRow> = {}): EpicRow {
  return { key, url: `https://jira.example/browse/${key}`, summary: `${key} summary`, status: 'New', category: 'new',
    start: null, due: null, derived: 0, total: 0, counts: { done: 0, indeterminate: 0, new: 0 }, clashes: [], ...p }
}
function item(key: string, p: Partial<ItemRow> = {}): ItemRow {
  return { key, url: `https://jira.example/browse/${key}`, summary: `${key} title`, status: 'New', category: 'new',
    start: '2026-11-02', due: '2026-11-30', forecast: false, ...p }
}
function snap(rows: EpicRow[]): Snapshot {
  return { date: '2026-11-20', generatedAt: '2026-11-20T06:00:00Z', title: 'Roadmap <test>', project: 'HDPI',
    jiraUrl: 'https://jira.example', start: '2026-11-02', end: '2027-01-31',
    lanes: [{ title: 'Private Landlord', subtitle: '', colour: '#1d70b8', rule: 'PrivateLandlord', rows }],
    clashes: [], withdrawn: [], dependencies: [],
    totals: { epics: rows.length, epicsDone: 0, items: 0, itemsDone: 0, undated: rows.filter((r) => !r.start).length } }
}

describe('roadmapSvg', () => {
  test('draws a bar, a milestone and an undated row', () => {
    const svg = roadmapSvg(snap([
      row('HDPI-1', { start: '2026-11-09', due: '2026-12-18', total: 4, counts: { done: 2, indeterminate: 1, new: 1 } }),
      row('HDPI-2', { start: '2027-01-15', due: '2027-01-15' }),
      row('HDPI-3'),
    ]), '2026-11-20')
    assert.match(svg, /^<svg [^>]*role="img"/)
    assert.match(svg, /<path d="M[^"]+Z"/) // milestone diamond
    assert.match(svg, /No dates in Jira/)
    assert.match(svg, /2 of 4 items done/)
    assert.match(svg, />Today</)
  })
  test('escapes text from Jira', () => {
    const svg = roadmapSvg(snap([row('HDPI-1', { summary: 'A & B <script>' })]), '2026-11-20')
    assert.ok(svg.includes('A &amp; B &lt;script&gt;'))
    assert.ok(svg.includes('Roadmap &lt;test&gt;'))
  })
  test('outlines clashes in red and numbers them', () => {
    const svg = roadmapSvg(snap([row('HDPI-1', { start: '2026-11-09', due: '2026-12-18', clashes: [1] })]), '2026-11-20')
    assert.match(svg, /stroke="#d4351c"/)
    assert.match(svg, /⚠1/)
  })
  test('draws a row per ticket under its epic, forecasts dashed', () => {
    const svg = roadmapSvg(snap([row('HDPI-1', { items: [
      item('HDPI-11', { summary: '1. A very long ticket title that will not fit in the label column', category: 'done' }),
      item('HDPI-12', { start: '2026-12-01', due: '2027-01-31', forecast: true }),
    ] })]), '2026-11-20')
    assert.ok(svg.indexOf('>HDPI-1<') < svg.indexOf('>HDPI-11<'))
    assert.ok(svg.indexOf('>HDPI-11<') < svg.indexOf('>HDPI-12<'))
    assert.match(svg, /1\. A very long ticket title that will…/)
    assert.equal((svg.match(/<rect [^>]*stroke-dasharray="4 3"[^>]*><title>/g) ?? []).length, 1)
    assert.match(svg, /<title>HDPI-12 HDPI-12 title · New · Forecast 1 Dec 2026 to 31 Jan 2027<\/title>/)
    assert.match(svg, /Forecast: no dates in Jira yet/)
    assert.match(svg, /2 tickets from/)
  })
  test('renders an old snapshot with no tickets', () => {
    const svg = roadmapSvg(snap([row('HDPI-1', { start: '2026-11-09', due: '2026-12-18' })]), '2026-11-20')
    assert.match(svg, />HDPI-1</)
    assert.doesNotMatch(svg, /Forecast/)
    assert.match(svg, /viewBox="0 0 960 114"/) // header, lane and one epic row only
  })
  test('leaves out the today marker outside the timeline', () => {
    assert.doesNotMatch(roadmapSvg(snap([row('HDPI-1')]), '2027-06-01'), />Today</)
  })
})

describe('burnupSvg', () => {
  test('draws scope and done lines with a summary', () => {
    const svg = burnupSvg([
      { date: '2026-11-09', items: 10, itemsDone: 0 },
      { date: '2026-11-20', items: 12, itemsDone: 5 },
    ])
    assert.equal((svg.match(/<path /g) ?? []).length, 2)
    assert.match(svg, /5 of 12 child items were done/)
  })
})

test('fmtDate and esc', () => {
  assert.equal(fmtDate('2026-11-02'), '2 Nov 2026')
  assert.equal(esc('"<&>'), '&quot;&lt;&amp;&gt;')
})
