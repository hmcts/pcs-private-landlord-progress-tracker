// Values that reach twg as arguments, or that come back from third parties, are checked before
// they're used; and repeated reads within a run are made once.

import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decode } from '../scripts/lib/qa/html.ts'
import { createPage, getPage } from '../scripts/lib/qa/publish.ts'
import { commentThread } from '../scripts/lib/qa/sources/jira.ts'
import { githubReader } from '../scripts/lib/qa/sources/github.ts'
import { sonarReader } from '../scripts/lib/qa/sources/sonar.ts'
import { jiraKey, pageId } from '../scripts/lib/qa/twg.ts'
import { CFG, fakeTwg, NOW, SHA, tarball } from './qa-helpers.ts'

describe('ids and keys passed to twg', () => {
  test('a page id is digits only, and a Jira key an issue key', () => {
    assert.equal(pageId('311427238'), '311427238')
    assert.equal(pageId(42), '42')
    for (const bad of ['-x', '--draft', '12 34', '12;3', '', undefined, { id: 1 }]) assert.throws(() => pageId(bad), /bad-argument|page id/)
    assert.equal(jiraKey('HDPI-8908'), 'HDPI-8908')
    for (const bad of ['--jql', 'HDPI-', 'hdpi-1', 'HDPI-1 OR x', 7]) assert.throws(() => jiraKey(bad), /Jira key/)
  })

  test('twg is never run with an id that could be read as an option', () => {
    const run = fakeTwg(() => ({}))
    assert.throws(() => getPage(run, '--format', false))
    assert.throws(() => createPage(run, '-y', 'T', '<p>x</p>', tmpdir(), true))
    assert.throws(() => commentThread('--first', run))
    assert.equal(run.calls.length, 0)
  })
})

describe('decode', () => {
  test('leaves numeric entities that are not characters as written', () => {
    assert.equal(decode('&#x41;&#66;'), 'AB')
    assert.equal(decode('a&#x110000;b&#1114112;c'), 'a&#x110000;b&#1114112;c')
    assert.equal(decode('&#xD800;&#57343;'), '&#xD800;&#57343;')
    assert.equal(decode('&#99999999999999999999;'), '&#99999999999999999999;')
  })
})

describe('repeated reads', () => {
  // V1 and V2 share the frontend commit, as when a repo doesn't change between candidates.
  const cfg = { ...CFG, candidates: [CFG.candidates[0], { name: 'V2', shas: { 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe1 } }] }

  test('SonarCloud history is read once per project', async () => {
    const urls: string[] = []
    await sonarReader(cfg, async (url) => {
      urls.push(url)
      return url.includes('project_analyses') ? { paging: { total: 1, pageSize: 500 }, analyses: [] } : {}
    }, NOW)()
    assert.equal(urls.filter((u) => u.includes('project_analyses')).length, 2)
  })

  test('GitHub check runs and source are read once per repo and commit', async () => {
    const api: string[] = []
    const tars: string[] = []
    await githubReader(cfg, async (path) => {
      api.push(path)
      return { total_count: 0, check_runs: [] }
    }, async (repo, sha) => {
      tars.push(`${repo}@${sha}`)
      return tarball({})
    }, NOW)()
    assert.equal(api.length, 3)
    assert.deepEqual(tars.sort(), [`hmcts/pcs-api@${SHA.api1}`, `hmcts/pcs-api@${SHA.api2}`, `hmcts/pcs-frontend@${SHA.fe1}`].sort())
  })
})
