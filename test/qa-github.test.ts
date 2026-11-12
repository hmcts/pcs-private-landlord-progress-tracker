import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { checkItems, githubReader, scanTarball } from '../scripts/lib/qa/sources/github.ts'
import { HttpError } from '../scripts/lib/qa/sources/common.ts'
import { CFG, NOW, SHA, tarball } from './qa-helpers.ts'

const run = (id: number, name: string, conclusion: string | null, status = 'completed') =>
  ({ id, name, status, conclusion, details_url: `https://build.example/${id}` })

describe('check runs', () => {
  test('map to rules, and the newest re-run of a check counts', () => {
    const items = checkItems('pcs-api', SHA.api2, CFG.candidates[1], [
      run(1, 'Tests / Functional Test - aat', 'failure'), run(2, 'Tests / Functional Test - aat', 'success'),
      run(3, 'Tests / Smoke Test - AKS aat', 'success'), run(4, 'Integration tests', 'success'),
      run(5, 'Tests / Pact Consumer Verification', 'success'), run(6, 'stale', 'success'),
    ], NOW)
    assert.deepEqual(items.map((i) => [i.rule, i.status]), [['integration-contract', 'pass'], ['functional', 'pass'], ['deployed-aat', 'pass']])
    assert.equal(items[0].value, 'Integration tests: success; Tests / Pact Consumer Verification: success')
  })

  test('a failed check fails the rule, an unfinished one leaves it unknown, and none is unknown', () => {
    const items = checkItems('pcs-frontend', SHA.fe2, CFG.candidates[1],
      [run(1, 'Jenkins - nightly', 'failure'), run(2, 'Tests / Smoke Test - AKS aat', null, 'in_progress')], NOW)
    assert.deepEqual(items.map((i) => [i.rule, i.status]), [['integration-contract', 'unknown'], ['functional', 'fail'], ['deployed-aat', 'unknown']])
  })
})

describe('ignored tests scan', () => {
  const deep = `src/functionalTest/java/uk/gov/hmcts/reform/pcs/functional/tests/${'very/'.repeat(12)}PaymentTests.java`
  const files = {
    'src/test/java/a/AppTest.java': 'import org.junit.jupiter.api.Disabled;\n// @Disabled was here\n@Disabled("flaky")\nclass AppTest {}\n',
    [deep]: '  @Ignore\n  void legacy() {}\n',
    'src/e2eTest/tests/claim.spec.ts': "test.skip('a claim', async () => {})\ntest.describe.skip('group', () => {})\ntest.fixme('later')\n" +
      'test(\'flag\', async () => { test.skip(!flagOn, "flag off") })\nxit(\'old\', () => {})\nit.todo(\'soon\')\n',
    'src/test/features/claim.feature': '@ignore\nScenario: x\n',
    'src/main/java/a/Service.java': '@Disabled\nclass NotATest {}\n',
    'README.md': 'test.skip(',
  }

  test('finds each kind in test sources only, and tells conditional skips apart', () => {
    const { files: n, findings } = scanTarball(tarball(files))
    assert.equal(n, 4)
    assert.deepEqual(findings.map((f) => `${f.kind}${f.conditional ? '?' : ''} ${f.path.split('/').pop()}:${f.line}`), [
      '@Disabled AppTest.java:3',
      '@Ignore PaymentTests.java:1',
      'skip claim.spec.ts:1', 'skip claim.spec.ts:2', 'fixme claim.spec.ts:3', 'skip? claim.spec.ts:4', 'xit claim.spec.ts:5', 'todo claim.spec.ts:6',
      '@ignore tag claim.feature:1',
    ])
    assert.equal(findings[1].path, deep)
  })

  test('the reader reports counts and links pinned to the commit', async () => {
    const cfg = { ...CFG, candidates: [{ name: 'V2', shas: { 'pcs-api': SHA.api2 } }] }
    const seen: string[] = []
    const items = await githubReader(cfg, async () => ({ total_count: 0, check_runs: [] }),
      async (repo, sha) => (seen.push(`${repo}@${sha}`), tarball(files)), NOW)()
    const ignored = items.find((i) => i.rule === 'ignored-tests')!
    assert.deepEqual(seen, [`hmcts/pcs-api@${SHA.api2}`])
    assert.equal(ignored.status, 'fail')
    assert.equal(ignored.answer, 'Yes')
    assert.match(ignored.value, /^8 ignored or pending .* in 4 files, and 1 skipped at run time by a condition$/)
    assert.ok(ignored.links.every((l) => l.url.startsWith(`https://github.com/hmcts/pcs-api/blob/${SHA.api2}/`)))
  })

  test('unreadable source or checks give unknown rows', async () => {
    const cfg = { ...CFG, candidates: [{ name: 'V2', shas: { 'pcs-api': SHA.api2 } }] }
    const items = await githubReader(cfg, async () => { throw new HttpError(403, 'HTTP 403') }, async () => { throw new Error('socket hang up') }, NOW)()
    assert.equal(items.length, 4)
    assert.ok(items.every((i) => i.status === 'unknown'))
    assert.match(items.at(-1)!.note!, /could not be read: socket hang up/)
  })
})
