// Feature-scoped reports: the config, picking each repo's service-wide commit, the E2E reader
// (Cosmos, then GitHub), Jira by epics, and rows whose source couldn't be read keeping what the
// page says.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceFor, fileUnderRows, readers, scopeFeature, serviceRules, SERVICE_WIDE } from '../scripts/lib/qa/collect.ts'
import { loadLayout, loadRelease, type ReleaseConfig, validateAll, validateRelease } from '../scripts/lib/qa/config.ts'
import { merge } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from '../scripts/lib/qa/render.ts'
import { HttpError, type Item } from '../scripts/lib/qa/sources/common.ts'
import type { CosmosQuery, StageEvent } from '../scripts/lib/qa/sources/cosmos.ts'
import { buildNumberOf, E2E_RULES, E2E_STAGE, e2eReader, hasTag, prNumber, specScope, wantedBuild } from '../scripts/lib/qa/sources/e2e.ts'
import { type GitHubApi, type GitHubTarball, latestFinished, scanTarball } from '../scripts/lib/qa/sources/github.ts'
import { jiraReader } from '../scripts/lib/qa/sources/jira.ts'
import { riaReader } from '../scripts/lib/qa/sources/ria.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { fact, fakeTwg, jqlOf, NOW, SHA, tarball, withIds } from './qa-helpers.ts'

const PATH = 'config/qa-readiness/private-landlord-make-a-claim.yaml'
const { cfg: loaded, layout } = loadRelease(PATH)
const E2E_SHA = '3d0d6bb55bafc801c36fdc697a82a9421a8f9b2a'
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
    assert.equal(loaded.active, true)
    assert.equal(loaded.report_page, '382468869')
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

// Stage events shaped as MetricsPublisher writes them for a pcs-frontend PR build (cnp-jenkins-library).
const PR_JOB = 'HMCTS_j_to_z/pcs-frontend/PR-2312'
function prBuild(number: number, steps: [string, string?][], final?: string, sha = E2E_SHA): StageEvent[] {
  const ev = steps.map(([name, result], n) => ({
    job_name: PR_JOB, branch_name: 'PR-2312', build_number: String(number), build_tag: `jenkins-HMCTS_j_to_z-pcs-frontend-PR-2312-${number}`,
    build_url: `https://build.example/job/x/${number}/`, current_step_name: name, current_build_current_result: result ?? 'SUCCESS',
    current_build_duration: (n + 1) * 1000, current_build_scheduled_time: '2026-09-17T18:10:00Z', git_commit: sha,
  }))
  if (final) ev.push({ ...ev[0], current_step_name: final, current_build_duration: 99_000 })
  return ev
}
const PR_STEPS: [string, string?][] = [['checkout'], ['build'], ['test'], ['securitychecks'], ['akschartsinstall'], ['smoketest:preview'], ['functionalTest:preview']]

/** Cosmos with these PR events in the jenkins database, recording each query. */
function cosmos(events: StageEvent[] | Error) {
  const calls: { db: string; query: string; params: Record<string, unknown> }[] = []
  const query = async (db: string, _container: string, q: string, parameters: { name: string; value: unknown }[]) => {
    calls.push({ db, query: q, params: Object.fromEntries(parameters.map((p) => [p.name, p.value])) })
    if (events instanceof Error) throw events
    return db === 'jenkins' ? events.filter((e) => e.branch_name === parameters.find((p) => p.name === '@b')?.value) : []
  }
  return Object.assign(query, { calls })
}

const HEAD = '9cc1a083edfe4fd1fb60a8b78e0355fdbf52a2d8'
const TARGET = 'https://build.hmcts.net/job/HMCTS_j_to_z/job/pcs-frontend/job/PR-2312/14/display/redirect'

/** GitHub with PR 2312's head and the Jenkins status on it, recording each path. */
function github(over: { state?: string | null; fail?: Error; url?: string } = {}) {
  const calls: string[] = []
  const api = async (path: string) => {
    calls.push(path)
    if (over.fail) throw over.fail
    if (path === 'repos/hmcts/pcs-frontend/pulls/2312') return { head: { sha: HEAD } }
    if (path === `repos/hmcts/pcs-frontend/commits/${HEAD}/status?per_page=100`) {
      return { statuses: over.state === null ? [] : [{ context: 'continuous-integration/jenkins/branch', state: 'failure' },
        { context: 'continuous-integration/jenkins/pr-head', state: over.state ?? 'success', target_url: over.url ?? TARGET }] }
    }
    throw new HttpError(404, 'HTTP 404')
  }
  return Object.assign(api, { calls })
}

const SPECS = tarball({
  'src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts': "test.describe('j @privateLandlord', () => {\n  test.skip('later', () => {})\n})\n",
  'src/test/ui/e2eTest/tagged.spec.ts': "test('t @privateLandlord', () => {})\n",
  'src/test/ui/e2eTest/unrelated.spec.ts': "test.skip('not the feature', () => {})\n",
}, 'hmcts-pcs-frontend-3d0d6bb')

const DENIED = Object.assign(new Error('forbidden'), { code: 403 })
const read = (q: CosmosQuery, api: GitHubApi = github(), tar: GitHubTarball = async () => SPECS, c: ReleaseConfig = cfg) => e2eReader(c, q, api, tar, NOW)()
const byRule = (items: Item[], rule: string) => items.find((i) => i.rule === rule)!
const withBuild = (build: number | 'last-completed') => ({ ...cfg, repos: { ...cfg.repos,
  'pcs-frontend': { ...cfg.repos['pcs-frontend'], e2e: { ...cfg.repos['pcs-frontend'].e2e!, jenkins: { ...cfg.repos['pcs-frontend'].e2e!.jenkins, build } } } } })

describe('E2E reader, from Cosmos', () => {
  test('the latest finished build of the branch answers with its E2E stage, from both databases', async () => {
    const q = cosmos([...prBuild(12, PR_STEPS, 'Pipeline Succeeded'), ...prBuild(13, PR_STEPS, 'Pipeline Succeeded'), ...prBuild(14, PR_STEPS.slice(0, 3)),
      ...prBuild(15, PR_STEPS, 'Pipeline Failed').map((e) => ({ ...e, current_build_current_result: 'ABORTED' }))])
    const api = github()
    const items = await read(q, api)
    const e2e = byRule(items, 'e2e-feature')
    assert.deepEqual([e2e.status, e2e.value, e2e.sha, e2e.source], ['pass', 'PR-2312 #13: functionalTest:preview passed', E2E_SHA, 'e2e'])
    assert.match(e2e.note!, /stage outcome only: Cosmos keeps no per-test results/)
    assert.deepEqual(e2e.links, [{ text: 'pcs-frontend PR-2312 #13', url: 'https://build.example/job/x/13/' }])
    assert.deepEqual([...new Set(q.calls.map((c) => c.db))].sort(), ['jenkins', 'sds-jenkins'])
    assert.deepEqual(q.calls[0].params, { '@b': 'PR-2312', '@p': 'pcs', '@c': 'frontend' })
    assert.deepEqual(api.calls, [], 'GitHub is not asked when Cosmos answers')
    const header = byRule(items, 'e2e-build')
    assert.deepEqual([header.status, header.value], ['pass', 'pcs-frontend: PR-2312 #13 at 3d0d6bb, success'])
  })

  test('a failed E2E stage fails the row, saying when Jenkins can\'t tell it from the next stage', async () => {
    const steps: [string, string?][] = [...PR_STEPS, ['pact-consumer-can-i-deploy', 'FAILURE']]
    const e2e = byRule(await read(cosmos(prBuild(13, steps, 'Pipeline Failed'))), 'e2e-feature')
    assert.deepEqual([e2e.status, e2e.value], ['fail', 'PR-2312 #13: functionalTest:preview failed'])
    assert.match(e2e.note!, /Jenkins can't tell whether functionalTest:preview or pact-consumer-can-i-deploy failed/)
  })

  test('full functional and E2E stages count too; a build that ran none fails the row, saying why', async () => {
    const full = byRule(await read(cosmos(prBuild(13, [['checkout'], ['fullFunctionalTest:preview'], ['E2eTest:preview']], 'Pipeline Succeeded'))), 'e2e-feature')
    assert.equal(full.value, 'PR-2312 #13: fullFunctionalTest:preview passed, E2eTest:preview passed')
    const none = byRule(await read(cosmos(prBuild(13, [['checkout'], ['build'], ['smoketest:preview']], 'Pipeline Succeeded'))), 'e2e-feature')
    assert.deepEqual([none.status, none.value, none.unreachable], ['fail', 'PR-2312 #13: no E2E stage ran', undefined])
    assert.match(none.note!, /finished without running an E2E or functional stage: the E2E labels were not set/)
    const early = byRule(await read(cosmos(prBuild(13, [['checkout'], ['build', 'FAILURE']], 'Pipeline Failed'))), 'e2e-feature')
    assert.match(early.note!, /the build failed at checkout or build first/)
  })

  test('a configured build number is that build; one not finished is unknown, not unreachable', async () => {
    const q = () => cosmos([...prBuild(12, PR_STEPS, 'Pipeline Succeeded'), ...prBuild(13, PR_STEPS.slice(0, 3))])
    assert.equal(byRule(await read(q(), github(), undefined, withBuild(12)), 'e2e-feature').value, 'PR-2312 #12: functionalTest:preview passed')
    const running = await read(q(), github(), undefined, withBuild(13))
    assert.deepEqual(running.map((i) => [i.rule, i.status, !!i.unreachable]), [['e2e-feature', 'unknown', false], ['e2e-build', 'unknown', false], ['ignored-tests-feature', 'fail', false]])
    assert.match(running[0].note!, /PR-2312 #13 has not finished, or was aborted/)
  })

  test('scans only the feature\'s specs, at the commit the build ran', async () => {
    const asked: string[] = []
    const items = await read(cosmos(prBuild(13, PR_STEPS, 'Pipeline Succeeded')), github(), async (repo, sha) => {
      asked.push(`${repo}@${sha}`)
      return SPECS
    })
    assert.deepEqual(asked, [`hmcts/pcs-frontend@${E2E_SHA}`])
    const scan = byRule(items, 'ignored-tests-feature')
    assert.deepEqual([scan.status, scan.value, scan.source], ['fail', '1 ignored or pending (skip ×1) in 1 files', 'github'])
    assert.equal((scan.data as { files: number }).files, 2)
  })
})

describe('E2E reader, from GitHub when Cosmos has no answer', () => {
  test('Cosmos refused: the PR head\'s Jenkins status answers, as the whole build\'s result', async () => {
    const api = github()
    const items = await read(cosmos(DENIED), api)
    assert.deepEqual(api.calls, ['repos/hmcts/pcs-frontend/pulls/2312', `repos/hmcts/pcs-frontend/commits/${HEAD}/status?per_page=100`])
    const e2e = byRule(items, 'e2e-feature')
    assert.deepEqual([e2e.status, e2e.value, e2e.sha, e2e.unreachable], ['pass', 'PR-2312 #14: the build passed', HEAD, undefined])
    assert.match(e2e.note!, /^GitHub's Jenkins status on the PR head: the whole build's result, not the E2E stage's \(Cosmos pipeline-metrics could not be read: access denied \(403\)\)$/)
    assert.deepEqual(e2e.links, [{ text: 'pcs-frontend PR-2312 #14', url: TARGET }])
    const header = byRule(items, 'e2e-build')
    assert.deepEqual([header.status, header.value], ['pass', 'pcs-frontend: PR-2312 #14, PR head 9cc1a08, Jenkins status success'])
    assert.equal(byRule(items, 'ignored-tests-feature').sha, HEAD)
    for (const state of ['failure', 'error']) assert.equal(byRule(await read(cosmos(DENIED), github({ state })), 'e2e-feature').status, 'fail')
    assert.deepEqual(['unknown', undefined], (({ status, unreachable }) => [status, unreachable])(byRule(await read(cosmos(DENIED), github({ state: 'pending' })), 'e2e-feature')))
  })

  test('no build in Cosmos for the branch: GitHub answers, and with no status there either, the row fails as absent', async () => {
    const other = prBuild(9, PR_STEPS, 'Pipeline Succeeded').map((e) => ({ ...e, branch_name: 'PR-1' }))
    assert.equal(byRule(await read(cosmos(other)), 'e2e-feature').status, 'pass')
    const items = await read(cosmos([]), github({ state: null }))
    const e2e = byRule(items, 'e2e-feature')
    assert.deepEqual([e2e.status, e2e.value, e2e.unreachable], ['fail', 'no build', undefined])
    assert.match(e2e.note!, /Cosmos records no finished build of PR-2312, and the PR head has no Jenkins status/)
  })

  test('Cosmos unreadable and no status on GitHub, or neither readable: unknown and unreachable', async () => {
    const quiet = byRule(await read(cosmos(DENIED), github({ state: null })), 'e2e-feature')
    assert.deepEqual([quiet.status, quiet.unreachable], ['unknown', true])
    const both = await read(cosmos(DENIED), github({ fail: Object.assign(new Error('x'), { status: 500 }) }))
    assert.deepEqual(both.map((i) => i.rule), E2E_RULES)
    assert.ok(both.every((i) => i.status === 'unknown' && i.unreachable))
    const gone = await read(cosmos([]), github({ fail: new Error('fetch failed') }))
    assert.ok(gone.every((i) => i.status === 'unknown' && i.unreachable))
  })

  test('a configured build number must be the one the status is for', async () => {
    const e2e = byRule(await read(cosmos(DENIED), github(), undefined, withBuild(13)), 'e2e-feature')
    assert.deepEqual([e2e.status, e2e.unreachable], ['unknown', true])
    assert.match(e2e.note!, /is not for build #13/)
    assert.equal(byRule(await read(cosmos(DENIED), github(), undefined, withBuild(14)), 'e2e-feature').status, 'pass')
  })

  test('a branch that is not a PR falls back to its head commit\'s branch build status', async () => {
    const c = { ...cfg, repos: { 'pcs-frontend': { ...cfg.repos['pcs-frontend'], e2e: { ...cfg.repos['pcs-frontend'].e2e!, jenkins: { job: 'HMCTS_j_to_z/pcs-frontend', branch: 'master' } } } } }
    const api = async (path: string) => (path === 'repos/hmcts/pcs-frontend/commits/master' ? { sha: HEAD }
      : { statuses: [{ context: 'continuous-integration/jenkins/branch', state: 'failure', target_url: 'https://build.example/job/x/job/master/7/' }] })
    const items = await read(cosmos(DENIED), api, undefined, c)
    assert.deepEqual([byRule(items, 'e2e-feature').status, byRule(items, 'e2e-feature').value], ['fail', 'master #7: the build failed'])
    assert.equal(byRule(items, 'e2e-build').value, 'pcs-frontend: master #7, branch head 9cc1a08, Jenkins status failure')
  })
})

describe('E2E helpers', () => {
  test('ids are numbers and SHAs before they reach a path; build numbers come from the job\'s own segment', () => {
    assert.deepEqual(['PR-2312', 'PR-0', 'PR-12x', 'PR-012', 'master'].map(prNumber), [2312, null, null, null, null])
    assert.deepEqual([wantedBuild('last-completed'), wantedBuild(undefined), wantedBuild(7)], [null, null, 7])
    assert.equal(buildNumberOf(TARGET, 'PR-2312'), 14)
    assert.equal(buildNumberOf('https://build.example/job/a/job/feature%252Fx/3/', 'feature/x'), 3)
    assert.equal(buildNumberOf(TARGET, 'PR-1'), null)
    assert.equal(buildNumberOf('not a url', 'PR-2312'), null)
  })

  test('the E2E stages are the library\'s functional and E2E stages, in any environment', () => {
    for (const s of ['functionalTest:preview', 'fullFunctionalTest:preview', 'E2eTest:preview', 'functionalTest:aat', 'E2eTest', 'fullFunctionalTest']) assert.ok(E2E_STAGE.test(s), s)
    for (const s of ['smoketest:preview', 'functionalTestX:preview', 'crossBrowserTest:aat', 'pact-consumer-tests']) assert.ok(!E2E_STAGE.test(s), s)
  })

  test('tags match whole; a scope covers its paths and tagged specs', () => {
    assert.ok(hasTag('Journey @privateLandlord › a', '@privateLandlord'))
    assert.ok(hasTag('Journey @privateLandlord', '@privateLandlord'))
    assert.ok(!hasTag('Journey @privateLandlordWales › a', '@privateLandlord'))
    const scope = specScope({ jenkins: { job: 'a', branch: 'b' }, paths: ['src/a/'], tags: ['@t'] })
    assert.deepEqual([scope('src/a/x.ts', ''), scope('src/ab/x.ts', ''), scope('src/b.ts', "test('x @t')")], [true, false, true])
  })

  test('readers include the E2E reader only for a feature', () => {
    assert.ok('e2e' in readers(cfg))
    assert.ok(!('e2e' in readers({ ...cfg, kind: 'release' })))
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

  test('a branch with a slash is valid', () => {
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
