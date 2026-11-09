import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { NOT_PUBLIC, publicJql, publicRunner } from '../scripts/public-twg.ts'

// twg's output for `jira workitem query -o json --output-summary none`, trimmed.
const PAGE = readFileSync(new URL('./fixtures/twg-page.json', import.meta.url), 'utf8')
const ARGS = ['jira', 'workitem', 'query', '--jql', 'project = HDPI ORDER BY key', '--fields', 'summary,labels',
  '-n', '100', '-o', 'json', '--output-summary', 'none']

describe('publicJql', () => {
  test('excludes not-public issues but keeps unlabelled ones, and keeps ORDER BY last', () => {
    assert.equal(publicJql('project = HDPI AND issuetype = Epic ORDER BY key'),
      `(project = HDPI AND issuetype = Epic) AND (labels is EMPTY OR labels not in ("${NOT_PUBLIC}")) ORDER BY key`)
  })
  test('works without ORDER BY', () => {
    assert.equal(publicJql('parent in (HDPI-1,HDPI-2)'),
      `(parent in (HDPI-1,HDPI-2)) AND (labels is EMPTY OR labels not in ("${NOT_PUBLIC}"))`)
  })
})

describe('publicRunner', () => {
  test('passes twg the same arguments, with only the JQL narrowed', () => {
    const seen: string[][] = []
    publicRunner((args) => (seen.push(args), PAGE))([...ARGS, '--after', 'cursor-1'])
    const expected = [...ARGS, '--after', 'cursor-1']
    expected[4] = publicJql(ARGS[4])
    assert.deepEqual(seen, [expected])
  })
  test('drops not-public issues and keeps the rest of the output', () => {
    const out = JSON.parse(publicRunner(() => PAGE)(ARGS))
    assert.deepEqual(out.data.issues.map((i: { key: string }) => i.key), ['HDPI-1'])
    assert.deepEqual(out.pageInfo, { hasNextPage: true, nextCursor: 'cursor-2' })
  })
  test('needs a --jql argument', () => {
    assert.throws(() => publicRunner(() => PAGE)(['jira', 'workitem', 'query']), /--jql/)
  })
})
