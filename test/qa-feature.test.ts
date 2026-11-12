// Feature-scoped reports: the config, picking each repo's service-wide commit, the Jenkins E2E
// reader, Jira by epics, and rows whose source couldn't be read keeping what the page says.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceFor, fileUnderRows, readers, scopeFeature, serviceRules, SERVICE_WIDE } from '../scripts/lib/qa/collect.ts'
import { loadLayout, loadRelease, type ReleaseConfig, validateAll, validateRelease } from '../scripts/lib/qa/config.ts'
import { merge } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from '../scripts/lib/qa/render.ts'
import { HttpError, type Item } from '../scripts/lib/qa/sources/common.ts'
import { latestFinished, scanTarball } from '../scripts/lib/qa/sources/github.ts'
import { buildRef, defaultJenkins, E2E_RULES, featureCases, hasTag, jenkinsReader, jobPath, outcome, readJenkins, revisionOf,
  repoPathOf, specScope, underPath, Unreachable } from '../scripts/lib/qa/sources/jenkins.ts'
import { jiraReader } from '../scripts/lib/qa/sources/jira.ts'
import { riaReader } from '../scripts/lib/qa/sources/ria.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { fact, fakeTwg, jqlOf, NOW, SHA, tarball, withIds } from './qa-helpers.ts'

const PATH = 'config/qa-readiness/private-landlord-make-a-claim.yaml'
const { cfg: loaded, layout } = loadRelease(PATH)
const E2E_SHA = '3d0d6bb55bafc801c36fdc697a82a9421a8f9b2a'
const LIB_SHA = '0123456789abcdef0123456789abcdef01234567'
const cfg: ReleaseConfig = { ...loaded, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe2 } }] }

const FEATURE_DOC = {
  feature: 'F1', active: false, layout: 'pcs-feature', epics: ['HDPI-1'],
  repos: { 'pcs-api': { github: 'hmcts/pcs-api', commit: 'master', e2e: { jenkins: { job: 'HMCTS_j_to_z/pcs-api', branch: 'PR-1' }, tags: ['@x'] } } },
}

describe('feature config', () => {
  test('the committed feature config is valid, and loads as a feature scoped by its epics', () => {
    assert.deepEqual(validateAll(), [])
    assert.equal(loaded.kind, 'feature')
    assert.equal(loaded.release, 'private-landlord-make-a-claim')
    assert.equal(loaded.active, false)
    assert.equal(loaded.jql, 'parent in (HDPI-10019)')
    assert.deepEqual(loaded.candidates, [])
  })

  test('a release config loads as before', () => {
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    assert.equal(r.kind, 'release')
    assert.equal(r.release, 'R1.3A')
  })

  test('accepts a valid feature', () => {
    assert.deepEqual(validateRelease(FEATURE_DOC, 'f', loadLayout('pcs-feature')), [])
  })

  test('refuses what a feature has no use for, and bad E2E settings', () => {
    const errors = validateRelease({ ...FEATURE_DOC, release: 'R1', jql: 'x', candidates: [], epics: ['nope'],
      repos: { r: { github: 'hmcts/r', commit: 'feature/../x', e2e: { jenkins: { job: 'a/../b', branch: 'PR 1', build: 'latest' }, tags: ['enforcement'], paths: ['../etc'] } } } },
    'f', loadLayout('pcs-feature')).join('\n')
    for (const m of [/set "release" or "feature", not both/, /"jql" is not used by a feature/, /"candidates" is not used by a feature/,
      /"epics" must be a list of Jira epic keys/, /"commit" must be a branch name or a full/, /"job" must be a Jenkins folder path/,
      /"branch" must be a branch such as/, /"build" must be last-completed or a build number/, /"tags" must be a list of tags/, /"paths" must be a list of repo-relative/]) {
      assert.match(errors, m)
    }
    assert.match(validateRelease({ ...FEATURE_DOC, repos: { r: { github: 'hmcts/r', e2e: { jenkins: { job: 'a', branch: 'b' } } } } }, 'f').join('\n'), /set "tags", "paths" or both/)
  })

  test('a release takes no feature settings, and neither takes the other\'s layout', () => {
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    const doc = { ...r, kind: undefined, repos: { ...r.repos, 'pcs-api': { ...r.repos['pcs-api'], commit: 'master' } } }
    assert.match(validateRelease(doc, 'r').join('\n'), /"commit" is for feature configs/)
    assert.match(validateRelease({ ...r, kind: undefined }, 'r', layout).join('\n'), /uses rule feature, which a release config can't answer/)
    assert.match(validateRelease(FEATURE_DOC, 'f', loadLayout('pcs')).join('\n'), /uses rule revisions, which a feature config can't answer/)
  })
})

describe('the service-wide commit', () => {
  const sha = (n: number) => n.toString(16).padStart(40, 'a')
  const api = (statuses: Record<string, string | null>, fail = false) => async (path: string) => {
    if (fail) throw Object.assign(new Error('boom'), { status: 502 })
    if (path === 'repos/hmcts/pcs-api') return { default_branch: 'main' }
    if (path.includes('/commits?')) return [1, 2, 3].map((n) => ({ sha: sha(n), commit: { committer: { date: '2026-11-1' + n + 'T09:00:00Z' } } }))
    const n = Object.keys(statuses).find((k) => path.includes(sha(Number(k))))!
    const state = statuses[n]
    return { statuses: state ? [{ context: 'continuous-integration/jenkins/branch', state }, { context: 'other', state: 'success' }] : [] }
  }

  test('is the newest commit whose Jenkins build has finished, passed or failed', async () => {
    assert.equal((await latestFinished(api({ 1: 'pending', 2: null, 3: 'failure' }), 'hmcts/pcs-api', 'master'))?.sha, sha(3))
    assert.equal(await latestFinished(api({ 1: 'pending', 2: null, 3: 'pending' }), 'hmcts/pcs-api', 'master'), null)
  })

  test('becomes the one service-wide candidate; a pinned SHA is used as it is', async () => {
    const c = { ...loaded, repos: { 'pcs-api': { ...loaded.repos['pcs-api'], commit: undefined }, 'pcs-frontend': { ...loaded.repos['pcs-frontend'], commit: SHA.fe1 } } }
    const calls: string[] = []
    const res = await scopeFeature(c, async (p) => {
      calls.push(p)
      return api({ 1: 'success', 2: 'success', 3: 'success' })(p)
    }, NOW)
    assert.deepEqual(res.cfg.candidates, [{ name: SERVICE_WIDE, shas: { 'pcs-api': sha(1), 'pcs-frontend': SHA.fe1 } }])
    assert.ok(calls.some((p) => p.includes('commits?sha=main')), 'the default branch, when commit is unset')
    assert.ok(res.items.every((i) => i.rule === 'service-revision' && i.status === 'pass'))
  })

  test('when GitHub can\'t be read, every service-wide rule of the repo is unknown and unreachable', async () => {
    const res = await scopeFeature(loaded, api({}, true), NOW)
    assert.deepEqual(res.cfg.candidates[0].shas, {})
    for (const [repo, rc] of Object.entries(loaded.repos)) {
      for (const rule of [...serviceRules(rc), 'service-revision']) {
        assert.ok(res.items.some((i) => i.repo === repo && i.rule === rule && i.status === 'unknown' && i.unreachable && !i.candidate), `${repo} ${rule}`)
      }
    }
  })

  test('when no commit has a finished build, the rules are unknown but not unreachable', async () => {
    const res = await scopeFeature(loaded, api({ 1: 'pending', 2: 'pending', 3: 'pending' }), NOW)
    assert.ok(res.items.every((i) => i.status === 'unknown' && !i.unreachable))
  })

  test('re-reading evidence takes its commits, unless they contradict a pinned one', () => {
    const doc = { release: loaded.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: [] }
    assert.deepEqual(evidenceFor(doc, loaded).candidates, cfg.candidates)
    const pinned = { ...loaded, repos: { ...loaded.repos, 'pcs-api': { ...loaded.repos['pcs-api'], commit: SHA.api1 } } }
    assert.throws(() => evidenceFor(doc, pinned), /other commits than the config's/)
    assert.throws(() => evidenceFor({ ...doc, release: 'other' }, loaded), /evidence is for other/)
  })
})

// A Jenkins test report shaped as pcs-frontend's PR builds publish it; the names are made up.
const pl = (name: string, over: Record<string, unknown> = {}) =>
  ({ className: 'e2eTest/privateLandlordMakeAClaim.spec.ts', name: `Feature journey @privateLandlord › ${name}`, status: 'PASSED', skipped: false, flakyFailures: [], ...over })
const REPORT = { suites: [
  { cases: [{ className: 'setup/auth.setup.ts', name: 'tokens', status: 'PASSED' }, { className: 'smokeTest/x.spec.ts', name: 'smoke @sanity', status: 'FAILED' }] },
  { cases: [pl('a'), pl('b', { stdout: 'log\n[[ATTACHMENT|../test-results/pl-b-chrome-retry1/trace.zip]]\n' }), pl('c', { status: 'FAILED', errorDetails: 'secret-failure-detail' }),
    pl('d', { status: 'SKIPPED', skipped: true }), { className: 'e2eTest/other.spec.ts', name: 'Other @privateLandlordWales › z', status: 'FAILED' }] },
] }
const BUILD = { number: 13, result: 'SUCCESS', building: false, url: 'https://build.example/job/x/13/', actions: [
  { _class: 'hudson.plugins.git.util.BuildData', lastBuiltRevision: { SHA1: LIB_SHA }, remoteUrls: ['https://github.com/hmcts/cnp-jenkins-library.git'] },
  { _class: 'hudson.plugins.git.util.BuildData', lastBuiltRevision: { SHA1: E2E_SHA }, remoteUrls: ['https://github.com/hmcts/pcs-frontend.git'] },
  {}] }

function jenkins(over: { build?: unknown; report?: unknown; fail?: Error } = {}) {
  const calls: string[] = []
  const get = async (path: string) => {
    calls.push(path)
    if (over.fail) throw over.fail
    if (path.includes('/testReport/')) {
      if (over.report instanceof Error) throw over.report
      return over.report ?? REPORT
    }
    if (over.build instanceof Error) throw over.build
    return over.build ?? BUILD
  }
  return Object.assign(get, { calls })
}

const SPECS = tarball({
  'src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts': "test.describe('j @privateLandlord', () => {\n  test.skip('later', () => {})\n})\n",
  'src/test/ui/e2eTest/tagged.spec.ts': "test('t @privateLandlord', () => {})\n",
  'src/test/ui/e2eTest/unrelated.spec.ts': "test.skip('not the feature', () => {})\n",
}, 'hmcts-pcs-frontend-3d0d6bb')

const read = (get: ReturnType<typeof jenkins>, tar: (repo: string, sha: string) => Promise<Buffer> = async () => SPECS) => jenkinsReader(cfg, get, tar, NOW)()
const byRule = (items: Item[], rule: string) => items.find((i) => i.rule === rule)!

describe('Jenkins E2E reader', () => {
  test('counts the feature\'s cases by tag or path: passed, failed, flaky (passed on a retry) and skipped', async () => {
    const get = jenkins()
    const items = await read(get)
    const e2e = byRule(items, 'e2e-feature')
    assert.equal(e2e.status, 'fail')
    assert.equal(e2e.value, "4 of the feature's tests: 1 passed, 1 failed, 1 flaky, 1 skipped")
    assert.equal(e2e.sha, E2E_SHA)
    assert.equal(e2e.repo, 'pcs-frontend')
    assert.equal(e2e.candidate, undefined)
    assert.deepEqual(get.calls, ['/job/HMCTS_j_to_z/job/pcs-frontend/job/PR-2312/lastCompletedBuild/api/json?tree=' +
      'number,result,building,url,actions[_class,revision[hash,pullHash],lastBuiltRevision[SHA1],remoteUrls]',
    '/job/HMCTS_j_to_z/job/pcs-frontend/job/PR-2312/13/testReport/api/json?tree=' +
      'suites[cases[className,name,status,skipped,errorDetails,flakyFailures[message],rerunFailures[message],properties,stdout]]'])
    const data = e2e.data as { failures: { name: string; error?: string }[] }
    assert.equal(data.failures[0].error, 'secret-failure-detail')
    assert.ok(!JSON.stringify([e2e.value, e2e.note]).includes('secret-failure-detail'), 'failures stay in the evidence data')
    const header = byRule(items, 'e2e-build')
    assert.equal(header.value, 'pcs-frontend: PR-2312 #13 at 3d0d6bb, success')
  })

  test('all passing is a pass; no matching case, or none that ran, is a failure with a reason', async () => {
    const pass = { suites: [{ cases: [pl('a'), pl('b', { status: 'FIXED' })] }] }
    assert.equal(byRule(await read(jenkins({ report: pass })), 'e2e-feature').status, 'pass')
    const none = byRule(await read(jenkins({ report: { suites: [{ cases: [{ className: 'x.spec.ts', name: 'other @regression' }] }] } })), 'e2e-feature')
    assert.equal(none.status, 'fail')
    assert.match(none.note!, /no test in PR-2312 #13 matches the feature's tags or paths: the scope is misconfigured, or the suite did not run/)
    const javaOnly = byRule(await read(jenkins({ report: { suites: [{ cases: [{ className: 'uk.gov.hmcts.reform.pcs.FooTest', name: 'works()', status: 'PASSED' }] }] } })), 'e2e-feature')
    assert.equal(javaOnly.status, 'fail')
    assert.match(javaOnly.note!, /hold no Playwright tests: its E2E stage did not run, or does not publish JUnit results/)
    const skipped = byRule(await read(jenkins({ report: { suites: [{ cases: [pl('d', { status: 'SKIPPED', skipped: true })] }] } })), 'e2e-feature')
    assert.deepEqual([skipped.status, skipped.note], ['fail', "every one of the feature's tests was skipped in PR-2312 #13"])
  })

  test('a build with no test report, or no such build, fails: absent, not unreachable', async () => {
    const noReport = byRule(await read(jenkins({ report: new HttpError(404, 'HTTP 404') })), 'e2e-feature')
    assert.deepEqual([noReport.status, noReport.unreachable], ['fail', undefined])
    const noBuild = await read(jenkins({ build: new HttpError(404, 'HTTP 404') }))
    assert.deepEqual(noBuild.map((i) => [i.rule, i.status, !!i.unreachable]), [['e2e-feature', 'fail', false], ['e2e-build', 'unknown', false], ['ignored-tests-feature', 'unknown', false]])
  })

  test('unreachable Jenkins answers every rule unknown and unreachable', async () => {
    for (const fail of [new Unreachable('Jenkins redirected to a sign-in page (off the VPN?)'), Object.assign(new Error('x'), { status: 500 })]) {
      const items = await read(jenkins({ fail }))
      assert.deepEqual(items.map((i) => i.rule), E2E_RULES)
      assert.ok(items.every((i) => i.status === 'unknown' && i.unreachable), fail.message)
    }
  })

  test('scans only the feature\'s specs, at the commit the E2E build ran', async () => {
    const asked: string[] = []
    const items = await read(jenkins(), async (repo, sha) => {
      asked.push(`${repo}@${sha}`)
      return SPECS
    })
    assert.deepEqual(asked, [`hmcts/pcs-frontend@${E2E_SHA}`])
    const scan = byRule(items, 'ignored-tests-feature')
    assert.equal(scan.status, 'fail')
    assert.equal(scan.value, '1 ignored or pending (skip ×1) in 1 files')
    assert.equal((scan.data as { files: number }).files, 2)
  })

  test('the commit is a PR\'s head when Jenkins records one, else the repo\'s own checkout, never a library\'s', () => {
    assert.equal(revisionOf(BUILD, 'hmcts/pcs-frontend'), E2E_SHA)
    assert.equal(revisionOf({ actions: [...BUILD.actions, { revision: { hash: LIB_SHA, pullHash: SHA.fe1 } }] }, 'hmcts/pcs-frontend'), SHA.fe1)
    assert.equal(revisionOf({ actions: [BUILD.actions[0]] }, 'hmcts/pcs-frontend'), null)
  })

  test('tags match whole, paths match from a folder boundary', () => {
    assert.ok(hasTag('Journey @privateLandlord › a', '@privateLandlord'))
    assert.ok(hasTag('Journey @privateLandlord', '@privateLandlord'))
    assert.ok(!hasTag('Journey @privateLandlordWales › a', '@privateLandlord'))
    assert.ok(underPath('e2eTest/privateLandlordMakeAClaim.spec.ts', 'src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts'))
    assert.ok(underPath('tests-enforcement/enforcement.spec.ts', 'src/e2eTest/tests/tests-enforcement/'))
    assert.ok(!underPath('tests-enforcementWales/x.spec.ts', 'src/e2eTest/tests/tests-enforcement/'))
    assert.ok(!underPath('e2eTest/other.spec.ts', 'src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts'))
    const scope = specScope({ jenkins: { job: 'a', branch: 'b' }, paths: ['src/a/'], tags: ['@t'] })
    assert.deepEqual([scope('src/a/x.ts', ''), scope('src/ab/x.ts', ''), scope('src/b.ts', "test('x @t')")], [true, false, true])
  })

  test('outcomes, and the cases picked from a report', () => {
    assert.equal(outcome({ status: 'REGRESSION' }), 'failed')
    assert.equal(outcome({ status: 'PASSED', flakyFailures: [{ message: 'x' }] }), 'flaky')
    assert.equal(outcome({ status: 'PASSED', stdout: '[[ATTACHMENT|../test-results/a-chrome/trace.zip]]' }), 'passed')
    assert.equal(featureCases(REPORT, { jenkins: { job: 'a', branch: 'b' }, paths: ['src/test/ui/e2eTest/other.spec.ts'] }).length, 1)
  })

  test('job paths and build numbers are checked before they reach a URL', () => {
    assert.equal(jobPath('HMCTS_j_to_z/pcs-api', 'PR-12'), '/job/HMCTS_j_to_z/job/pcs-api/job/PR-12')
    assert.throws(() => jobPath('a/../b', 'PR-1'), /folder names and a branch only/)
    assert.throws(() => jobPath('a', 'PR-1?x=1'), /folder names and a branch only/)
    assert.equal(buildRef(undefined), 'lastCompletedBuild')
    assert.equal(buildRef(42), '42')
    assert.throws(() => buildRef('42'), /last-completed or a build number/)
    assert.throws(() => buildRef(-1), /last-completed or a build number/)
  })
})

describe('reading Jenkins', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=utf-8' } })

  test('an App Proxy redirect, a sign-in page, 401 and 403 are unreachable; 404 is not', async () => {
    const cases: [Response, RegExp][] = [
      [new Response(null, { status: 302, headers: { location: 'https://login.microsoftonline.com/x' } }), /redirected to a sign-in page/],
      [new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }), /web page, not JSON/],
      [json({}, 401), /refused the sign-in \(401\)/],
      [json({}, 403), /refused the sign-in \(403\)/],
    ]
    for (const [res, m] of cases) await assert.rejects(readJenkins(res), (e: Error) => e instanceof Unreachable && m.test(e.message))
    await assert.rejects(readJenkins(json({}, 404)), (e: Error) => e instanceof HttpError && e.status === 404)
    assert.deepEqual(await readJenkins(json({ number: 1 })), { number: 1 })
  })

  test('without credentials, or with a URL that isn\'t https, nothing is fetched', async () => {
    await assert.rejects(defaultJenkins({})('/api/json'), /JENKINS_USERNAME and JENKINS_PASSWORD are not set/)
    await assert.rejects(defaultJenkins({ JENKINS_URL: 'http://build.example', JENKINS_USERNAME: 'u', JENKINS_PASSWORD: 'p' })('/api/json'), /not an https URL/)
  })

  test('readers include Jenkins only for a feature', () => {
    assert.ok('jenkins' in readers(cfg))
    assert.ok(!('jenkins' in readers({ ...cfg, kind: 'release' })))
  })
})

describe('Jira and the RIA for a feature', () => {
  test('bugs, test complete comments and done counts come from the epics\' child tickets', async () => {
    const run = fakeTwg((args) => {
      const jql = jqlOf(args)
      if (jql.includes('statusCategory != Done')) return { data: { issues: [] } }
      return { data: { issues: [{ key: 'HDPI-2', status: { name: 'Closed', statusCategory: { key: 'done' } }, comment: { total: 0, comments: [] } },
        { key: 'HDPI-3', status: { name: 'New', statusCategory: { key: 'new' } }, comment: { total: 0, comments: [] } }] } }
    })
    const items = await jiraReader(cfg, run, NOW)()
    assert.ok(run.calls.every((a) => jqlOf(a).startsWith('(parent in (HDPI-10019)) AND ')))
    const done = items.find((i) => i.rule === 'stories-done')!
    assert.deepEqual([done.status, done.value], ['fail', '1 of 2 stories, tasks and bugs are done'])
  })

  test('a Jira failure is unreachable', async () => {
    const items = await jiraReader(cfg, fakeTwg(() => new Error('twg exited 1')), NOW)()
    assert.ok(items.every((i) => i.status === 'unknown' && i.unreachable))
  })

  test('with no ria_page, the RIA rows are N/A', async () => {
    const items = await riaReader(cfg, fakeTwg(() => new Error('not called')), NOW)()
    assert.ok(items.every((i) => i.status === 'pass' && i.answer === 'N/A' && i.value === 'no RIA for this feature'))
  })
})

describe('a source that can\'t be read keeps what the page says', () => {
  const ev = (items: Item[]): Evidence => ({ release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) })
  const e2e = (over: Partial<Item>) => fact({ rule: 'e2e-feature', status: 'pass', value: '7 of the feature\'s tests: 7 passed', repo: 'pcs-frontend', ...over })
  const row = (e: Evidence, key: string) => evaluate(cfg, layout, e).checklist.find((r) => r.key === key)!

  test('a row is kept only when it is unknown for want of an unreachable source', () => {
    assert.equal(row(ev([e2e({ status: 'unknown', value: 'not checked', unreachable: true })]), '9').keep, true)
    assert.equal(row(ev([e2e({ status: 'unknown', value: 'not checked' })]), '9').keep, false)
    assert.equal(row(ev([e2e({ status: 'unknown', unreachable: true }), e2e({ repo: 'pcs-api', status: 'fail' })]), '9').keep, false)
    assert.equal(row(ev([]), '9').keep, false)
    // Cosmos unreachable, GitHub with no such check: alternatives, so unknown for want of Cosmos.
    const alt = (source: string, unreachable: boolean) => fact({ rule: 'integration-contract', status: 'unknown', source, repo: 'pcs-frontend', candidate: SERVICE_WIDE, unreachable })
    assert.equal(row(ev([alt('cosmos', true), alt('github', false)]), '3').keep, true)
  })

  test('publishing leaves those cells as published, and updates the rest', () => {
    const published = withIds(renderPage(cfg, layout, evaluate(cfg, layout, ev([e2e({}), fact({ rule: 'e2e-build', status: 'pass', value: 'pcs-frontend: PR-2312 #13', repo: 'pcs-frontend' })]))))
    const now = ev([e2e({ status: 'unknown', value: 'not checked', note: 'Jenkins could not be read', unreachable: true }),
      fact({ rule: 'e2e-build', status: 'unknown', value: 'not checked', repo: 'pcs-frontend', unreachable: true }),
      fact({ rule: 'high-defects', status: 'pass', value: 'no Critical or High bugs open' })])
    const m = merge(published, layout, genRows(layout, evaluate(cfg, layout, now)))
    const action = (table: string, key: string, cell: string) => m.changes.find((c) => c.table === table && c.key === key && c.cell === cell)?.action
    assert.equal(action('checklist', '9', 'status'), 'keep-unreachable')
    assert.equal(action('checklist', '9', 'comments'), 'keep-unreachable')
    assert.equal(action('info', 'E2E build', 'details'), 'keep-unreachable')
    assert.equal(action('checklist', '20', 'status'), 'update')
    assert.match(m.html, /7 of the feature's tests: 7 passed/)
    assert.match(m.html, /pcs-frontend: PR-2312 #13/)
    // The same row, now known to be absent rather than unreachable, is rewritten.
    const absent = merge(published, layout, genRows(layout, evaluate(cfg, layout, ev([e2e({ status: 'unknown', value: 'not checked' })]))))
    assert.equal(absent.changes.find((c) => c.key === '9' && c.cell === 'status')?.action, 'update')
  })

  test('service-wide rows say so, with the commit; the header names the feature and its epics', () => {
    const e = ev([fact({ rule: 'sonar-coverage', status: 'pass', value: '96.2%', repo: 'pcs-api', sha: SHA.api2, candidate: SERVICE_WIDE })])
    const res = evaluate(cfg, layout, e)
    assert.equal(res.checklist.find((r) => r.key === '1')!.lines[0].text, `service-wide — pcs-api ${SHA.api2.slice(0, 7)}: 96.2%.`)
    const html = renderPage(cfg, layout, res)
    assert.match(html, /<h1>QA Readiness Report – private-landlord-make-a-claim<\/h1>/)
    assert.match(html, /https:\/\/hmcts\.atlassian\.net\/browse\/HDPI-10019/)
  })
})

describe('review fixes', () => {
  test('re-read evidence must have a commit for every repo, and only for its repos', () => {
    const doc = (shas: Record<string, string>) => ({ release: loaded.release, generatedAt: NOW().toISOString(), candidates: [{ name: SERVICE_WIDE, shas }], items: [] })
    assert.throws(() => evidenceFor(doc({ 'pcs-api': SHA.api2 }), loaded), /other commits than the config's/)
    assert.throws(() => evidenceFor(doc({ 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe2, toString: SHA.fe1 }), loaded), /other commits than the config's/)
    const { toString: _, ...noProto } = { toString: 1, 'pcs-api': SHA.api2 }
    assert.throws(() => evidenceFor(doc(noProto as Record<string, string>), { ...loaded, repos: { ...loaded.repos, toString: loaded.repos['pcs-api'] } }), /other commits/)
  })

  test('only the branch build status counts, and statuses are read a batch at a time, newest first', async () => {
    const sha = (n: number) => n.toString(16).padStart(40, 'b')
    const calls: string[] = []
    const api = async (path: string) => {
      calls.push(path)
      if (path.includes('/commits?')) return Array.from({ length: 10 }, (_, n) => ({ sha: sha(n + 1) }))
      const n = Number.parseInt(path.split('/')[4].slice(-1), 16)
      if (n === 2) return { statuses: [{ context: 'continuous-integration/jenkins/pr-head', state: 'success' }] }
      if (n === 6 || n === 7) return { statuses: [{ context: 'continuous-integration/jenkins/branch', state: 'success' }] }
      return { statuses: [{ context: 'continuous-integration/jenkins/branch', state: 'pending' }] }
    }
    assert.deepEqual(await latestFinished(api, 'hmcts/pcs-api', 'master'), { sha: sha(6) })
    assert.equal(calls.length, 1 + 8, 'two batches of four')
  })

  const tagged = tarball({
    'src/test/ui/e2eTest/privateLandlord.spec.ts': "test('claim', { tag: '@privateLandlord' }, () => {})\ntest.skip('later', () => {})\n",
    'src/test/ui/e2eTest/other.spec.ts': "test('other', () => {})\n",
    'src/test/ui/smokeTest/smoke.spec.ts': "test('smoke', () => {})\n",
    'src/test/ui/e2eTest/utils/privateLandlord.journey.ts': "// used by @privateLandlord\ntest.skip('not a spec', () => {})\n",
    'src/test/ui/config/tags.config.ts': "export const TAG = '@privateLandlord'\n",
  }, 'hmcts-pcs-frontend-3d0d6bb')
  const e2eCfg = { jenkins: { job: 'HMCTS_j_to_z/pcs-frontend', branch: 'PR-2312' }, tags: ['@privateLandlord'] }

  test('a scoped scan covers spec files only, never a page object or config that mentions the tag', () => {
    const scan = scanTarball(tagged, undefined, specScope(e2eCfg))
    assert.deepEqual(scan.scoped, ['src/test/ui/e2eTest/privateLandlord.spec.ts'])
    assert.equal(scan.specs!.length, 3)
    assert.deepEqual(scan.findings.map((f) => f.path), ['src/test/ui/e2eTest/privateLandlord.spec.ts'])
  })

  test('tags given as { tag } are not in the JUnit name, so cases are also picked by the tagged spec files the scan found', async () => {
    const report = { suites: [{ cases: [
      { className: 'e2eTest/privateLandlord.spec.ts', name: 'claim', status: 'PASSED' },
      { className: 'e2eTest/other.spec.ts', name: 'other', status: 'FAILED' },
      { className: 'e2eTest/other.spec.ts', name: 'by property', status: 'PASSED', properties: { tag: '@privateLandlord' } },
    ] }] }
    const scan = scanTarball(tagged, undefined, specScope(e2eCfg))
    assert.deepEqual(featureCases(report, e2eCfg, scan).map((c) => c.name), ['claim', 'by property'])
    assert.deepEqual(featureCases(report, e2eCfg).map((c) => c.name), ['by property'], 'without a scan, only names and properties')
    const items = await jenkinsReader(cfg, jenkins({ report }), async () => tagged, NOW)()
    assert.equal(items.find((i) => i.rule === 'e2e-feature')!.value, "2 of the feature's tests: 2 passed, 0 failed, 0 flaky, 0 skipped")
    assert.equal(items.find((i) => i.rule === 'ignored-tests-feature')!.value, '1 ignored or pending (skip ×1) in 1 files')
  })

  test('a configured path may be a spec file, a folder in testDir, testDir itself or above it, but not a sibling', () => {
    const specs = ['src/test/ui/e2eTest/a.spec.ts', 'src/test/ui/smokeTest/b.spec.ts']
    const c = 'e2eTest/a.spec.ts'
    assert.equal(repoPathOf(c, specs), 'src/test/ui/e2eTest/a.spec.ts')
    for (const p of ['src/test/ui/e2eTest', 'src/test/ui/e2eTest/', 'src/test/ui', 'src', 'src/test/ui/e2eTest/a.spec.ts']) assert.ok(underPath(c, p, specs), p)
    for (const p of ['src/test/ui/smokeTest', 'src/test/ui/e2eTest/b.spec.ts', 'src/test/uix']) assert.ok(!underPath(c, p, specs), p)
    assert.ok(underPath(c, 'src/test/ui/e2eTest'))
    assert.ok(underPath(c, 'src/test/ui/e2eTest/a.spec.ts'))
    assert.ok(!underPath(c, 'src/test/ui/smokeTest'))
  })

  test('a branch with a slash is valid, and its job name is encoded as multibranch encodes it', () => {
    assert.equal(jobPath('HMCTS_j_to_z/pcs-api', 'feature/x'), '/job/HMCTS_j_to_z/job/pcs-api/job/feature%252Fx')
    assert.throws(() => jobPath('a', 'feature/../x'), /folder names and a branch only/)
    const doc = { ...FEATURE_DOC, repos: { r: { github: 'hmcts/r', e2e: { jenkins: { job: 'a/b', branch: 'feature/HDPI-1-x' }, tags: ['@x'] } } } }
    assert.deepEqual(validateRelease(doc, 'f'), [])
  })

  test("stories-done counts the config's bug types for a feature; a release's query is as it was", async () => {
    const jqls: string[] = []
    const run = fakeTwg((args) => {
      jqls.push(jqlOf(args))
      return { data: { issues: [] } }
    })
    await jiraReader({ ...cfg, bug_types: ['Bug', 'Issue'] }, run, NOW)()
    assert.ok(jqls.includes('(parent in (HDPI-10019)) AND issuetype in ("Story", "Task", "Bug", "Issue")'))
    jqls.length = 0
    await jiraReader({ ...cfg, kind: 'release', jql: 'project = HDPI' }, run, NOW)()
    assert.ok(jqls.includes('(project = HDPI) AND issuetype in (Story, Task, Bug)'))
  })

  test('a long comment thread is read in full; only a failed read leaves it unknown and unreachable', async () => {
    const work = (key: string) => ({ key, status: { name: 'Closed', statusCategory: { key: 'done' } }, comment: { total: 30, comments: [{ body: 'chatter' }] } })
    const answer = (failThread: boolean) => fakeTwg((args) => {
      if (args[2] === 'comment') return failThread ? new Error('twg exited 1') : { data: [{ body: 'Testing is complete' }], pageInfo: { hasNextPage: false } }
      return { data: { issues: jqlOf(args).includes('issuetype in') ? [work('HDPI-5')] : [] } }
    })
    const read = (await jiraReader(cfg, answer(false), NOW)()).find((i) => i.rule === 'test-complete')!
    assert.equal(read.status, 'pass')
    const failed = (await jiraReader(cfg, answer(true), NOW)()).find((i) => i.rule === 'test-complete')!
    assert.deepEqual([failed.status, failed.unreachable, failed.note], ['unknown', true, 'the comments of 1 could not be read in full'])
  })

  test('the Generated row is the run date, and names the rows kept from an earlier run', () => {
    const e = { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates,
      items: fileUnderRows(layout, [fact({ rule: 'e2e-feature', status: 'unknown', repo: 'pcs-frontend', unreachable: true }),
        fact({ rule: 'e2e-build', status: 'unknown', repo: 'pcs-frontend', unreachable: true })]) }
    const gen = evaluate(cfg, layout, e).info.find((r) => r.rule === 'generated')!
    assert.deepEqual(gen.lines.map((l) => l.text), ['19 Sep 2026', 'Kept from an earlier run, as a source could not be read: E2E build, row 9.'])
    const fresh = evaluate(cfg, layout, { ...e, items: [] }).info.find((r) => r.rule === 'generated')!
    assert.deepEqual(fresh.lines.map((l) => l.text), ['19 Sep 2026'])
  })
})
