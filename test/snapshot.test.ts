// Runs the real generator's buildModel.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, type Config, type Issue } from '../scripts/lib/roadmap-runner.ts'
import { itemRows, toSnapshot } from '../scripts/lib/snapshot.ts'

const CFG: Config = {
  title: 'Test roadmap', project: 'HDPI', jira_url: 'https://jira.example/', start: '2026-11-02',
  lanes: [{ title: 'Private Landlord', colour: '#1d70b8', label: 'PrivateLandlord' }],
}
const NEW = { name: 'New', statusCategory: { key: 'new' } }
const DONE = { name: 'Done', statusCategory: { key: 'done' } }
const FS = 'Finish to Start (FS) Dependency'

function issue(key: string, p: Partial<Issue> & Record<string, unknown> = {}): Issue {
  return { key, summary: `${key} summary`, issuetype: { name: 'Story' }, status: NEW, labels: [], components: [],
    parent: null, duedate: null, customfield_10015: null, issuelinks: [], ...p } as Issue
}
const epic = (key: string, p: Partial<Issue> & Record<string, unknown> = {}) =>
  issue(key, { issuetype: { name: 'Epic' }, labels: ['PrivateLandlord'], ...p })

function backlog(): Issue[] {
  return [
    epic('HDPI-1', { summary: 'Register (Product Cat Ref: X-1)', customfield_10015: '2026-11-09', duedate: '2026-12-18',
      issuelinks: [
        { type: { name: FS, outward: 'finishes before' }, outwardIssue: { key: 'HDPI-2' } },
        { type: { name: 'Blocks', inward: 'is blocked by' },
          inwardIssue: { key: 'RDCC-7', fields: { summary: 'other team', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } } },
      ] as unknown as Issue['issuelinks'] }),
    epic('HDPI-2', { customfield_10015: '2026-12-01', duedate: '2027-01-29' }), // starts before HDPI-1 ends
    epic('HDPI-3'), // undated
    issue('HDPI-11', { parent: { key: 'HDPI-1' }, status: DONE, summary: '2. Child ticket title (Product Cat Ref: X-2)' }),
    issue('HDPI-12', { parent: { key: 'HDPI-1' }, summary: '1. First ticket', description: 'never published',
      assignee: { displayName: 'A Person' } }),
    issue('HDPI-13', { parent: { key: 'HDPI-1' }, issuetype: { name: 'Test' } }),
  ]
}

describe('toSnapshot', () => {
  const s = toSnapshot(CFG, buildModel(CFG, backlog(), '2026-11-20'), new Date('2026-11-20T06:01:02Z'))

  test('keeps only public-safe epic fields', () => {
    const [r] = s.lanes[0].rows
    assert.deepEqual(Object.keys(r).sort(),
      ['category', 'clashes', 'counts', 'derived', 'due', 'items', 'key', 'start', 'status', 'summary', 'total', 'url'])
    assert.equal(r.summary, 'Register')
    assert.equal(r.url, 'https://jira.example/browse/HDPI-1')
    assert.ok(JSON.stringify(s).includes('Child ticket title'))
    assert.ok(!JSON.stringify(s).includes('other team'))
    assert.ok(!JSON.stringify(s).includes('never published'))
    assert.ok(!JSON.stringify(s).includes('A Person'))
  })

  test('keeps only public-safe ticket fields, leaving out Tests', () => {
    const items = s.lanes[0].rows.find((x) => x.key === 'HDPI-1')!.items!
    assert.deepEqual(items.map((i) => i.key), ['HDPI-12', 'HDPI-11'])
    assert.deepEqual(Object.keys(items[0]).sort(),
      ['category', 'due', 'forecast', 'key', 'start', 'status', 'summary', 'url'])
    assert.deepEqual(items[1], { key: 'HDPI-11', url: 'https://jira.example/browse/HDPI-11', summary: '2. Child ticket title',
      status: 'Done', category: 'done', start: '2026-12-17', due: '2027-01-31', forecast: true })
    assert.deepEqual(s.lanes[0].rows.find((x) => x.key === 'HDPI-3')!.items, [])
  })

  test('counts child items, leaving out Tests', () => {
    const r = s.lanes[0].rows.find((x) => x.key === 'HDPI-1')!
    assert.equal(r.total, 2)
    assert.equal(r.counts.done, 1)
    assert.deepEqual(s.totals, { epics: 3, epicsDone: 0, items: 2, itemsDone: 1, undated: 1 })
  })

  test('numbers dependency clashes and marks both epics', () => {
    assert.deepEqual(s.clashes, [{ n: 1, before: 'HDPI-1', after: 'HDPI-2', beforeDue: '2026-12-18', afterStart: '2026-12-01' }])
    assert.deepEqual(s.lanes[0].rows.filter((r) => r.clashes.length).map((r) => r.key).sort(), ['HDPI-1', 'HDPI-2'])
  })

  test('lists links to other Jira projects only', () => {
    assert.deepEqual(s.dependencies, [{ epic: 'HDPI-1', relation: 'is blocked by', linked: 'RDCC-7',
      linkedUrl: 'https://jira.example/browse/RDCC-7', linkedStatus: 'In Review', linkedCategory: 'indeterminate' }])
  })

  test('dates the snapshot', () => {
    assert.equal(s.date, '2026-11-20')
    assert.equal(s.generatedAt, '2026-11-20T06:01:02.000Z')
  })

  test('copes with no epics at all', () => {
    const empty = toSnapshot(CFG, buildModel(CFG, [], '2026-11-20'), new Date('2026-11-20T06:00:00Z'))
    assert.deepEqual(empty.totals, { epics: 0, epicsDone: 0, items: 0, itemsDone: 0, undated: 0 })
    assert.deepEqual(empty.lanes[0].rows, [])
  })
})

describe('itemRows', () => {
  const browse = (k: string) => `https://jira.example/browse/${k}`
  const child = (key: string, summary: string, p: Partial<Issue> & Record<string, unknown> = {}) =>
    issue(key, { parent: { key: 'HDPI-1' }, summary, ...p })

  test('orders by the leading number, then unnumbered tickets by key', () => {
    const rows = itemRows([
      child('HDPI-30', 'Unnumbered B'), child('HDPI-4', '10. Ten'), child('HDPI-20', '2. Two'),
      child('HDPI-9', 'Unnumbered A'), child('HDPI-5', '1. One'),
    ], '2026-11-02', '2027-03-31', browse)
    assert.deepEqual(rows.map((r) => r.key), ['HDPI-5', 'HDPI-20', 'HDPI-4', 'HDPI-9', 'HDPI-30'])
  })

  test('spreads undated tickets end to end, the last one ending on the window end', () => {
    // 150 days from 2 Nov 2026 to 31 Mar 2027, over 4 tickets: 37 days each, the last gets 39.
    const rows = itemRows(['1', '2', '3', '4'].map((n) => child(`HDPI-${n}`, `${n}. Ticket`)),
      '2026-11-02', '2027-03-31', browse)
    assert.deepEqual(rows.map((r) => [r.start, r.due]), [
      ['2026-11-02', '2026-12-08'], ['2026-12-09', '2027-01-14'], ['2027-01-15', '2027-02-20'], ['2027-02-21', '2027-03-31'],
    ])
    assert.ok(rows.every((r) => r.forecast))
    for (let i = 1; i < rows.length; i++) {
      assert.equal(Date.parse(rows[i].start) - Date.parse(rows[i - 1].due), 86_400_000)
    }
  })

  test('keeps Jira dates and leaves those tickets out of the forecast', () => {
    const rows = itemRows([
      child('HDPI-1', '1. Dated', { customfield_10015: '2026-11-16T00:00:00.000+0000', duedate: '2026-11-27' }),
      child('HDPI-2', '2. Start only', { customfield_10015: '2026-11-16' }),
      child('HDPI-3', '3. Undated'),
    ], '2026-11-02', '2027-03-31', browse)
    assert.deepEqual(rows[0], { key: 'HDPI-1', url: browse('HDPI-1'), summary: '1. Dated', status: 'New', category: 'new',
      start: '2026-11-16', due: '2026-11-27', forecast: false })
    assert.deepEqual(rows.slice(1).map((r) => [r.key, r.start, r.due, r.forecast]),
      [['HDPI-2', '2026-11-02', '2027-01-15', true], ['HDPI-3', '2027-01-16', '2027-03-31', true]])
  })

  test('leaves out Tests', () => {
    const rows = itemRows([child('HDPI-1', '1. Story'), child('HDPI-2', '2. Test', { issuetype: { name: 'Test' } })],
      '2026-11-02', '2027-03-31', browse)
    assert.deepEqual(rows.map((r) => r.key), ['HDPI-1'])
    assert.equal(rows[0].due, '2027-03-31')
  })
})

describe('timeline end', () => {
  test('runs to the configured end, or a later due date', () => {
    assert.equal(buildModel({ ...CFG, end: '2027-03-31' }, backlog(), '2026-11-20').end, '2027-03-31')
    assert.equal(buildModel({ ...CFG, end: '2026-12-15' }, backlog(), '2026-11-20').end, '2027-01-31')
    assert.equal(buildModel(CFG, [], '2026-11-20').end, '2027-01-31')
  })
})
