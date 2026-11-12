import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { adfText, band, jiraReader } from '../scripts/lib/qa/sources/jira.ts'
import { CFG, fakeTwg, jqlOf, NOW } from './qa-helpers.ts'

const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const status = (name: string, key = 'done') => ({ name, statusCategory: { key } })
const page = (issues: unknown[], next?: string) => ({ data: { issues }, pageInfo: { hasNextPage: !!next, nextCursor: next } })

function jira(over: { bugs?: unknown[]; failWork?: boolean } = {}) {
  return fakeTwg((args) => {
    if (args[2] === 'comment') return { data: [{ body: adf('chatter') }, { body: adf('Retested on AAT and it is working') }], pageInfo: { hasNextPage: false } }
    const jql = jqlOf(args)
    if (jql.includes('statusCategory != Done')) {
      const bugs = over.bugs ?? [{ key: 'HDPI-1', priority: { name: '3-Medium' } }, { key: 'HDPI-2', priority: { name: '4-Low' } }]
      return args.includes('--after') ? page(bugs.slice(1)) : page(bugs.slice(0, 1), 'c2')
    }
    if (jql.includes('issuetype in (Story, Task, Bug)')) {
      if (over.failWork) return new Error('twg exited 1')
      return page([
        { key: 'HDPI-10', status: status('Closed'), comment: { total: 1, comments: [{ body: adf('Functional testing is completed on AAT') }] } },
        { key: 'HDPI-11', status: status('Closed'), comment: { total: 1, comments: [{ body: adf('Merged') }] } },
        { key: 'HDPI-12', status: status('Closed'), comment: { total: 25, comments: [{ body: adf('PR raised') }] } },
        { key: 'HDPI-13', status: status('Withdrawn'), comment: { total: 0, comments: [] } },
      ])
    }
    if (jql.startsWith('key in')) return page([{ key: 'HDPI-8908', status: status('Closed') }, { key: 'HDPI-8670', status: status('In Progress', 'indeterminate') }])
    throw new Error(`unexpected ${jql}`)
  })
}

describe('Jira', () => {
  test('priority bands', () => {
    assert.deepEqual(['1-Highest', '2-High', '3-Medium', '4-Low', '5-Lowest', 'Critical', undefined].map(band),
      ['Critical', 'High', 'Medium', 'Low', 'Low', 'Critical', 'Medium'])
    assert.equal(adfText(adf('Test Summary')), 'Test Summary')
  })

  test('counts outstanding bugs by priority across pages', async () => {
    const items = await jiraReader(CFG, jira(), NOW)()
    const bugs = items.find((i) => i.rule === 'outstanding-bugs')!
    assert.equal(bugs.value, 'Critical – 0, High – 0, Medium – 1, Low – 1')
    assert.equal(items.find((i) => i.rule === 'high-defects')!.status, 'pass')
  })

  test('open Critical or High bugs fail', async () => {
    const items = await jiraReader(CFG, jira({ bugs: [{ key: 'HDPI-3', priority: { name: '2-High' } }] }), NOW)()
    const high = items.find((i) => i.rule === 'high-defects')!
    assert.equal(high.status, 'fail')
    assert.ok(high.links.some((l) => l.text === 'HDPI-3'))
  })

  test('test complete comments: reads long threads, skips withdrawn tickets and lists what is missing', async () => {
    const run = jira()
    const tc = (await jiraReader(CFG, run, NOW)()).find((i) => i.rule === 'test-complete')!
    assert.equal(tc.status, 'fail')
    assert.equal(tc.value, '2 of 3 stories, tasks and bugs have a test complete comment')
    assert.deepEqual(tc.data!.missing, ['HDPI-11'])
    assert.deepEqual(run.calls.filter((a) => a[2] === 'comment').map((a) => a[a.indexOf('--issue-id') + 1]), ['HDPI-12'])
  })

  test('human rows follow their tickets', async () => {
    const items = (await jiraReader(CFG, jira(), NOW)()).filter((i) => i.rule === 'human')
    assert.deepEqual(items.map((i) => [i.data!.row, i.status, i.value]), [
      ['16', 'pass', 'HDPI-8908: Closed'],
      ['17', 'unknown', 'HDPI-8670: In Progress, HDPI-8671: not found'],
    ])
  })

  test('only reads, and a failing query leaves just its rows unknown', async () => {
    const run = jira({ failWork: true })
    const items = await jiraReader(CFG, run, NOW)()
    assert.equal(items.find((i) => i.rule === 'test-complete')!.status, 'unknown')
    assert.equal(items.find((i) => i.rule === 'outstanding-bugs')!.status, 'pass')
    assert.ok(run.calls.every((a) => a.slice(0, 3).join(' ') === 'jira workitem query' || a.slice(0, 4).join(' ') === 'jira workitem comment query'))
  })
})
