import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildModel, renderPdf, type Config, type Issue } from '../scripts/lib/roadmap-runner.ts'

const tmp = mkdtempSync(join(tmpdir(), 'roadmap-render-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

const CFG: Config = {
  title: 'Test roadmap',
  project: 'HDPI',
  jira_url: 'https://jira.example',
  start: '2026-11-30',
  end: '2027-03-31',
  lanes: [{ title: 'Private Landlord', colour: '#1d70b8', label: 'PrivateLandlord' }],
}

const newStatus = { name: 'New', statusCategory: { key: 'new' } }
const issue = (key: string, p: Partial<Issue> = {}): Issue => ({
  key, summary: p.summary ?? key, issuetype: p.issuetype ?? { name: 'Story' }, status: p.status ?? newStatus,
  labels: p.labels ?? [], components: [], parent: p.parent ?? null, duedate: p.duedate ?? null,
  customfield_10015: p.customfield_10015 ?? null, issuelinks: [],
})
const epic = (key: string, p: Partial<Issue> = {}) =>
  issue(key, { issuetype: { name: 'Epic' }, labels: ['PrivateLandlord'], customfield_10015: '2026-12-01', duedate: '2027-01-29', ...p })

/** Text drawn with the built-in fonts in an uncompressed PDF, as one string. */
function pdfText(path: string): string {
  const raw = readFileSync(path, 'latin1')
  return [...raw.matchAll(/<([0-9a-f]+)> /g)].map((x) => Buffer.from(x[1], 'hex').toString('latin1')).join('') +
    [...raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((x) => x[1]).join('')
}
const pages = (path: string) => (readFileSync(path, 'latin1').match(/\/Type \/Page\b/g) ?? []).length

describe('renderPdf stories and tasks pages', () => {
  test('lists each epic\'s child items after the poster, in title order, without Tests', async () => {
    const issues = [
      epic('HDPI-1', { summary: 'Make a claim' }),
      epic('HDPI-2', { summary: 'Respond to a claim' }),
      issue('HDPI-12', { parent: { key: 'HDPI-1' }, summary: '2. Property address', customfield_10015: '2026-12-02', duedate: '2026-12-03' }),
      issue('HDPI-11', { parent: { key: 'HDPI-1' }, summary: '1. Start page', customfield_10015: '2026-12-01', duedate: '2026-12-01' }),
      issue('HDPI-13', { parent: { key: 'HDPI-1' }, summary: 'Claim form template (Product Cat Ref: X)', issuetype: { name: 'Task' } }),
      issue('HDPI-14', { parent: { key: 'HDPI-1' }, summary: 'Regression pack', issuetype: { name: 'Test' } }),
    ]
    const out = join(tmp, 'small.pdf')
    await renderPdf(buildModel(CFG, issues, '2026-11-25'), out, { fonts: 'builtin', compress: false })
    assert.equal(pages(out), 2)
    const t = pdfText(out)
    for (const s of ['Test roadmap: stories and tasks', '3 child items in 2 HDPI epics', 'page 2 of 2', '0/3 done',
      'HDPI-11', '1. Start page', '01 Dec 2026', '02 Dec', '03 Dec', 'Claim form template', 'No dates in Jira',
      'no child items', 'No stories or tasks in Jira yet.']) {
      assert.ok(t.includes(s), `missing "${s}"`)
    }
    assert.ok(t.indexOf('1. Start page') < t.indexOf('2. Property address'))
    assert.ok(!t.includes('Regression pack'), 'Tests are left out')
    assert.ok(!t.includes('Product Cat Ref'), 'summaries are cleaned')
    assert.match(readFileSync(out, 'latin1'), /\/URI \(https:\/\/jira\.example\/browse\/HDPI-13\)/)
  })

  test('runs onto more pages and repeats the epic row where its items continue', async () => {
    const items = Array.from({ length: 60 }, (_, n) =>
      issue(`HDPI-${100 + n}`, { parent: { key: 'HDPI-1' }, summary: `${n + 1}. Page ${n + 1}` }))
    const out = join(tmp, 'long.pdf')
    await renderPdf(buildModel(CFG, [epic('HDPI-1'), ...items], '2026-11-25'), out, { fonts: 'builtin', compress: false })
    assert.equal(pages(out), 3)
    const t = pdfText(out)
    assert.ok(t.includes('page 3 of 3'))
    assert.ok(t.includes(' (continued)'))
    assert.ok(t.includes('60. Page 60'))
  })

  test('adds no pages when there are no epics', async () => {
    const out = join(tmp, 'empty.pdf')
    await renderPdf(buildModel(CFG, [], '2026-11-25'), out, { fonts: 'builtin', compress: false })
    assert.equal(pages(out), 1)
  })
})
