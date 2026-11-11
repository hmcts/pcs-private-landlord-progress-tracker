// Runs the real generator's buildModel.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, type Config, type Issue } from '../scripts/lib/roadmap-runner.ts'
import { toSnapshot } from '../scripts/lib/snapshot.ts'

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
    issue('HDPI-11', { parent: { key: 'HDPI-1' }, status: DONE, summary: 'child summary must not be published' }),
    issue('HDPI-12', { parent: { key: 'HDPI-1' } }),
    issue('HDPI-13', { parent: { key: 'HDPI-1' }, issuetype: { name: 'Test' } }),
  ]
}

describe('toSnapshot', () => {
  const s = toSnapshot(CFG, buildModel(CFG, backlog(), '2026-11-20'), new Date('2026-11-20T06:01:02Z'))

  test('keeps only public-safe epic fields', () => {
    const [r] = s.lanes[0].rows
    assert.deepEqual(Object.keys(r).sort(),
      ['category', 'clashes', 'counts', 'derived', 'due', 'key', 'start', 'status', 'summary', 'total', 'url'])
    assert.equal(r.summary, 'Register')
    assert.equal(r.url, 'https://jira.example/browse/HDPI-1')
    assert.ok(!JSON.stringify(s).includes('child summary'))
    assert.ok(!JSON.stringify(s).includes('other team'))
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

describe('timeline end', () => {
  test('runs to the configured end, or a later due date', () => {
    assert.equal(buildModel({ ...CFG, end: '2027-03-31' }, backlog(), '2026-11-20').end, '2027-03-31')
    assert.equal(buildModel({ ...CFG, end: '2026-12-15' }, backlog(), '2026-11-20').end, '2027-01-31')
    assert.equal(buildModel(CFG, [], '2026-11-20').end, '2027-01-31')
  })
})
