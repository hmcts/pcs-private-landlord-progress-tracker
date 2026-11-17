// A feature measured at its pull requests (repos.*.pr): the config, picking each repo's commit
// from the PR's latest finished Jenkins build (Cosmos, then GitHub), and every reader reading the
// PR: SonarCloud's pull request analysis, the PR job's build in Cosmos and the PR's GitHub checks.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentInput } from '../scripts/lib/qa/answers.ts'
import { evidenceFor, fileUnderRows, scopeFeature, SERVICE_WIDE } from '../scripts/lib/qa/collect.ts'
import { loadLayout, loadRelease, prOf, type ReleaseConfig, validateRelease } from '../scripts/lib/qa/config.ts'
import { evaluate, genRows } from '../scripts/lib/qa/render.ts'
import { HttpError, type Item } from '../scripts/lib/qa/sources/common.ts'
import { type CosmosQuery, cosmosReader, type CveDoc, isRepoJob, type StageEvent } from '../scripts/lib/qa/sources/cosmos.ts'
import { e2eReader } from '../scripts/lib/qa/sources/e2e.ts'
import { checkItems, githubReader, pullCommits, withEarlierChecks } from '../scripts/lib/qa/sources/github.ts'
import { sonarReader } from '../scripts/lib/qa/sources/sonar.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { NOW, tarball } from './qa-helpers.ts'

const { cfg: loaded, layout } = loadRelease('config/qa-readiness/private-landlord-make-a-claim.yaml')
const API_HEAD = 'cfa90c771bb471c0334d83fdd193b5c1f1616adc'
const FE_HEAD = '9cc1a083edfe4fd1fb60a8b78e0355fdbf52a2d8'
const OLDER = 'ab8b356c39471cb7420f88de91aa501dd2f0b223'
const EARLIER = '3d0d6bb55bafc801c36fdc697a82a9421a8f9b2a'
const picked: ReleaseConfig = { ...loaded, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': API_HEAD, 'pcs-frontend': FE_HEAD } }] }

const DOC = {
  feature: 'F1', active: false, layout: 'pcs-feature', epics: ['HDPI-1'],
  repos: { r: { github: 'hmcts/r', pr: 12, e2e: { jenkins: { job: 'HMCTS_j_to_z/r', branch: 'PR-12' }, tags: ['@x'] } } },
}
const repoErrors = (r: Record<string, unknown>, doc: Record<string, unknown> = DOC) => validateRelease({ ...doc, repos: { r: { github: 'hmcts/r', ...r } } }, 'f').join('\n')

describe('config: pr', () => {
  test('the committed feature reads both repos at their PRs, as numbers', () => {
    assert.equal(loaded.repos['pcs-api'].pr, 3196)
    assert.equal(loaded.repos['pcs-frontend'].pr, 2312)
    assert.equal(loaded.repos['pcs-api'].commit, undefined)
    assert.equal(loaded.repos['pcs-frontend'].e2e?.jenkins.branch, 'PR-2312')
  })

  test('is a positive whole number; a numeric string is converted', () => {
    assert.deepEqual(validateRelease(DOC, 'f', loadLayout('pcs-feature')), [])
    assert.equal(prOf(2312), 2312)
    assert.equal(prOf('2312'), 2312)
    for (const bad of [0, -3, 1.5, '12a', '012', '', null, true, [12], Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(prOf(bad), null, String(bad))
      assert.match(repoErrors({ pr: bad }), /"pr" must be a pull request number/, String(bad))
    }
  })

  test('replaces commit, and the E2E build must be the same PR\'s', () => {
    assert.match(repoErrors({ pr: 12, commit: 'master' }), /set "commit" or "pr", not both/)
    assert.match(repoErrors({ pr: 13, e2e: DOC.repos.r.e2e }), /"branch" must be PR-13, the repo's "pr"/)
    assert.equal(repoErrors({ pr: 12, e2e: DOC.repos.r.e2e }), '')
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    const release = { ...r, kind: undefined, repos: { ...r.repos, 'pcs-api': { ...r.repos['pcs-api'], pr: 1 } } }
    assert.match(validateRelease(release, 'r').join('\n'), /"pr" is for feature configs/)
  })
})

// Stage events as MetricsPublisher writes them for a PR build (cnp-jenkins-library).
function prEvents(job: string, branch: string, number: number, sha: string, steps: string[], final?: string, result = 'SUCCESS'): StageEvent[] {
  const ev: StageEvent[] = steps.map((name, n) => ({
    job_name: job, branch_name: branch, build_number: String(number), build_tag: `jenkins-${job.replaceAll('/', '-')}-${number}`,
    build_url: `https://build.hmcts.net/job/${number}/`, current_step_name: name, current_build_current_result: result,
    current_build_duration: (n + 1) * 1000, current_build_scheduled_time: '2026-11-16T15:55:00Z', git_commit: sha,
  }))
  if (final) ev.push({ ...ev[0], current_step_name: final, current_build_duration: 99_000 })
  return ev
}

const PR_STEPS = ['checkout', 'build', 'test', 'integrationTest', 'securitychecks', 'akschartsinstall', 'smoketest:preview', 'functionalTest:preview']
const API_JOB = 'HMCTS_j_to_z/pcs-api/PR-3196'
const FE_JOB = 'HMCTS_j_to_z/pcs-frontend/PR-2312'

/** Cosmos answering branch queries from these events, filtered as the query is, recording each query. */
function cosmos(events: StageEvent[] | Error, cve: CveDoc[] = []) {
  const calls: { container: string; query: string; params: Record<string, unknown> }[] = []
  const query: CosmosQuery = async (db, container, q, parameters) => {
    const p = Object.fromEntries(parameters.map((x) => [x.name, x.value]))
    calls.push({ container, query: q, params: p })
    if (events instanceof Error) throw events
    if (db !== 'jenkins') return []
    if (container === 'cve-reports') return cve.filter((d) => (p['@tags'] as string[]).includes(d.build.build_tag!))
    return events.filter((e) => e.branch_name === p['@b'])
  }
  return Object.assign(query, { calls })
}

/** The PRs' commits on GitHub, oldest first. */
const PR_COMMITS: Record<string, string[]> = { 'pcs-api/pulls/3196': [OLDER, API_HEAD], 'pcs-frontend/pulls/2312': [OLDER, EARLIER, FE_HEAD] }

/**
 * GitHub with the PRs' heads, commits (`commits`, by repo and PR) and the Jenkins pr-head status
 * on the heads: success on pcs-api's, and `fe` (null for none) on pcs-frontend's.
 */
function github(fail?: Error, fe: string | null = 'error', commits: Record<string, string[] | Error> = PR_COMMITS) {
  const calls: string[] = []
  const api = async (path: string) => {
    calls.push(path)
    if (fail) throw fail
    if (path === 'repos/hmcts/pcs-api/pulls/3196') return { head: { sha: API_HEAD } }
    if (path === 'repos/hmcts/pcs-frontend/pulls/2312') return { head: { sha: FE_HEAD } }
    const listed = Object.entries(commits).find(([k]) => path === `repos/hmcts/${k}/commits?per_page=100&page=1`)?.[1]
    if (listed instanceof Error) throw listed
    if (listed) return listed.map((sha) => ({ sha }))
    const [repo, job, sha] = path.includes(API_HEAD) ? ['pcs-api', 'PR-3196/22', API_HEAD] : ['pcs-frontend', 'PR-2312/14', FE_HEAD]
    if (path === `repos/hmcts/${repo}/commits/${sha}/status?per_page=100`) {
      const state = repo === 'pcs-api' ? 'success' : fe
      return { statuses: state === null ? [] : [{ context: 'continuous-integration/jenkins/pr-head', state,
        target_url: `https://build.hmcts.net/job/HMCTS_j_to_z/job/${repo}/job/${job}/display/redirect` }] }
    }
    throw new HttpError(404, 'HTTP 404')
  }
  return Object.assign(api, { calls })
}

const revisions = (items: Item[]) => Object.fromEntries(items.filter((i) => i.rule === 'service-revision').map((i) => [i.repo, i]))

describe('the revision of a repo with pr', () => {
  test('is the commit of the PR job\'s latest finished build in Cosmos', async () => {
    const events = [
      ...prEvents(API_JOB, 'PR-3196', 21, OLDER, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(API_JOB, 'PR-3196', 22, API_HEAD, PR_STEPS, 'Pipeline Failed', 'FAILURE'),
      ...prEvents(API_JOB, 'PR-3196', 23, 'd'.repeat(40), PR_STEPS.slice(0, 3)), // still running
      ...prEvents('HMCTS_j_to_z/other-repo/PR-3196', 'PR-3196', 40, 'e'.repeat(40), PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, PR_STEPS, 'Pipeline Succeeded'),
    ]
    const q = cosmos(events)
    const gh = github()
    const res = await scopeFeature(loaded, gh, NOW, q)
    assert.deepEqual(res.cfg.candidates, [{ name: SERVICE_WIDE, shas: { 'pcs-api': API_HEAD, 'pcs-frontend': FE_HEAD } }])
    assert.deepEqual(res.unpicked, [])
    const r = revisions(res.items)
    assert.equal(r['pcs-api'].value, 'pcs-api = cfa90c7')
    assert.deepEqual(r['pcs-api'].links, [{ text: 'pcs-api = cfa90c7', url: `https://github.com/hmcts/pcs-api/commit/${API_HEAD}` }])
    assert.equal(r['pcs-api'].data?.from, 'cosmos')
    assert.equal(r['pcs-api'].data?.number, 22)
    assert.match(r['pcs-api'].note!, /PR-3196 #22, the PR's latest finished Jenkins build \(failure, 16 Nov 2026\), from Cosmos/)
    assert.ok(q.calls.every((c) => /c\.branch_name = @b/.test(c.query)))
    assert.deepEqual(q.calls.map((c) => c.params['@b']).sort(), ['PR-2312', 'PR-2312', 'PR-3196', 'PR-3196'])
    assert.deepEqual(gh.calls, [], 'GitHub is not needed')
  })

  test('falls back to the PR head on GitHub when Cosmos can\'t be read or has nothing, if its Jenkins build finished', async () => {
    for (const q of [cosmos(Object.assign(new Error('Forbidden'), { code: 403 })), cosmos([])]) {
      const res = await scopeFeature(loaded, github(undefined, 'failure'), NOW, q)
      assert.deepEqual(res.cfg.candidates[0].shas, { 'pcs-api': API_HEAD, 'pcs-frontend': FE_HEAD })
      const r = revisions(res.items)
      assert.deepEqual([r['pcs-frontend'].value, r['pcs-frontend'].status], ['pcs-frontend = 9cc1a08', 'pass'])
      assert.deepEqual([r['pcs-frontend'].data?.from, r['pcs-frontend'].data?.state, r['pcs-frontend'].data?.number], ['github', 'failure', 14])
      assert.match(r['pcs-frontend'].note!, /^the PR's head commit, from GitHub, where its Jenkins status \(PR-2312 #14\) is failure: Cosmos/)
    }
    const denied = revisions((await scopeFeature(loaded, github(), NOW, cosmos(Object.assign(new Error('x'), { code: 403 })))).items)
    assert.match(denied['pcs-api'].note!, /Cosmos pipeline-metrics could not be read: access denied \(403\)$/)
    const none = revisions((await scopeFeature(loaded, github(), NOW, cosmos([]))).items)
    assert.match(none['pcs-api'].note!, /Cosmos records no finished build of PR-3196 in the last 60 days$/)
  })

  test('never picks a PR head whose Jenkins build is pending, errored or has no status', async () => {
    for (const state of ['pending', 'error', null]) {
      for (const [q, down] of [[cosmos([]), false], [cosmos(Object.assign(new Error('x'), { code: 403 })), true]] as const) {
        const res = await scopeFeature(loaded, github(undefined, state), NOW, q)
        assert.deepEqual(res.cfg.candidates[0].shas, { 'pcs-api': API_HEAD }, String(state))
        assert.deepEqual(res.unpicked, ['pcs-frontend'])
        const fe = res.items.filter((i) => i.repo === 'pcs-frontend')
        assert.ok(fe.length > 1 && fe.every((i) => i.status === 'unknown' && !!i.unreachable === down), 'unreachable only while Cosmos may have a finished build')
        const rev = revisions(res.items)['pcs-frontend']
        assert.equal(rev.value, 'pcs-frontend = 9cc1a08', 'the head is still named')
        assert.match(rev.note!, new RegExp(`^the PR's head commit 9cc1a08 has no finished Jenkins build: ${state ? `its Jenkins status \\(PR-2312 #14\\) is ${state}` : 'it has no Jenkins status'}; `))
      }
    }
  })

  test('when neither can be read, the repo is unpicked and its rules unknown and unreachable', async () => {
    const res = await scopeFeature(loaded, github(new HttpError(502, 'HTTP 502')), NOW, cosmos(new Error('timeout')))
    assert.deepEqual(res.unpicked, ['pcs-api', 'pcs-frontend'])
    assert.ok(res.items.every((i) => i.status === 'unknown' && i.unreachable))
  })

  test('the job filter takes the configured job, else the repo\'s job in any folder but a nightly one', () => {
    assert.ok(isRepoJob(API_JOB, 'hmcts/pcs-api', 'PR-3196'))
    assert.ok(!isRepoJob('HMCTS_j_to_z/other/PR-3196', 'hmcts/pcs-api', 'PR-3196'))
    assert.ok(!isRepoJob('HMCTS_j_to_z_Nightly/pcs-api/PR-3196', 'hmcts/pcs-api', 'PR-3196'))
    assert.ok(!isRepoJob('HMCTS_j_to_z/pcs-api/PR-31967', 'hmcts/pcs-api', 'PR-3196'))
    assert.ok(isRepoJob(FE_JOB, 'hmcts/pcs-frontend', 'PR-2312', 'HMCTS_j_to_z/pcs-frontend'))
    assert.ok(!isRepoJob('Other/pcs-frontend/PR-2312', 'hmcts/pcs-frontend', 'PR-2312', 'HMCTS_j_to_z/pcs-frontend'))
  })

  test('evidence for PR candidates reads back, and may record a repo as unpicked when applying answers', () => {
    const doc = { release: loaded.release, generatedAt: NOW().toISOString(), candidates: picked.candidates, items: [] }
    assert.deepEqual(evidenceFor(doc, loaded).candidates, picked.candidates)
    const partial = { ...doc, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': API_HEAD } }], unpicked: ['pcs-frontend'] }
    assert.deepEqual(evidenceFor(partial, loaded, { allowUnpicked: true }).unpicked, ['pcs-frontend'])
    assert.throws(() => evidenceFor(partial, loaded), /other commits/)
  })
})

// What SonarCloud's public API returned for pcs-frontend#2312 (measures/component and
// qualitygates/project_status with pullRequest, and project_pull_requests/list), trimmed.
const FE_MEASURES = {
  component: {
    key: 'pcs-frontend', qualifier: 'TRK', pullRequest: '2312', measures: [
      { metric: 'coverage', value: '95.4', bestValue: false },
      { metric: 'new_security_hotspots', periods: [{ index: 1, value: '0', bestValue: true }] },
      { metric: 'new_vulnerabilities', periods: [{ index: 1, value: '0', bestValue: true }] },
      { metric: 'security_rating', value: '1.0', bestValue: true },
      { metric: 'new_coverage', periods: [{ index: 1, value: '95.67567567567568', bestValue: false }] },
      { metric: 'vulnerabilities', value: '0', bestValue: true },
      { metric: 'security_hotspots', value: '0', bestValue: true },
    ],
  },
}
const FE_GATE = { projectStatus: { status: 'OK', conditions: [
  { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', periodIndex: 1, errorThreshold: '80', actualValue: '95.7' },
  { status: 'OK', metricKey: 'new_security_hotspots_reviewed', comparator: 'LT', periodIndex: 1, errorThreshold: '100', actualValue: '100.0' },
], periods: [], ignoredConditions: false } }
const PR_LIST = (sha: string) => ({ pullRequests: [
  { key: '2349', branch: 'HDPI-9670-WelshData', analysisDate: '2026-11-16T18:07:42+0000', commit: { sha: 'ac0fb8e0fa76643cab83cd62b1278d4da1eb9947' } },
  { key: '2312', title: 'feat/private-landlord-make-a-claim', branch: 'feat/private-landlord-make-a-claim', base: 'master',
    status: { qualityGateStatus: 'OK', bugs: 0, vulnerabilities: 0, codeSmells: 9 }, analysisDate: '2026-11-16T08:42:26+0000', target: 'master', commit: { sha } },
] })

function sonar(over: { measures?: unknown; gate?: unknown; list?: unknown; missing?: boolean } = {}) {
  const urls: string[] = []
  const get = async (url: string) => {
    urls.push(url)
    const u = new URL(url)
    const p = u.searchParams
    if (u.pathname.endsWith('/project_pull_requests/list')) return p.get('project') === 'pcs-frontend' ? over.list ?? PR_LIST(FE_HEAD) : { pullRequests: [] }
    if (over.missing) throw new HttpError(404, 'HTTP 404')
    if (u.pathname.endsWith('/measures/component')) {
      assert.deepEqual([p.get('component'), p.get('pullRequest')], ['pcs-frontend', '2312'])
      assert.ok(p.get('metricKeys')!.split(',').includes('new_coverage'))
      return over.measures ?? FE_MEASURES
    }
    if (u.pathname.endsWith('/qualitygates/project_status')) {
      assert.deepEqual([p.get('projectKey'), p.get('pullRequest'), p.get('analysisId')], ['pcs-frontend', '2312', null])
      return over.gate ?? FE_GATE
    }
    throw new HttpError(404, 'HTTP 404')
  }
  return Object.assign(get, { urls })
}

const sonarOf = async (get: ReturnType<typeof sonar>, cfg = picked) => {
  const items = await sonarReader(cfg, get, NOW)()
  return Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
}

describe('SonarCloud at the PR', () => {
  test('reads the pull request analysis, never the branch history', async () => {
    const get = sonar()
    const fe = await sonarOf(get)
    assert.deepEqual([fe['sonar-coverage'].status, fe['sonar-coverage'].value], ['pass', '95.4%'])
    assert.equal(fe['sonar-coverage'].note, 'analysis of PR #2312 at 9cc1a08 on 16 Nov 2026')
    assert.deepEqual([fe['sonar-quality-gate'].status, fe['sonar-quality-gate'].value], ['pass', 'passed'])
    assert.deepEqual([fe['sonar-security'].status, fe['sonar-security'].value], ['pass', '0 vulnerabilities, 0 security hotspots'])
    assert.deepEqual(fe['sonar-coverage'].links, [{ text: 'SonarCloud pcs-frontend PR #2312', url: 'https://sonarcloud.io/summary/new_code?id=pcs-frontend&pullRequest=2312' }])
    assert.ok(get.urls.every((u) => !/project_analyses|search_history/.test(u)))
  })

  test('with only new-code coverage, leaves the row unknown for the agent, with the figure', async () => {
    const newOnly = { component: { ...FE_MEASURES.component, measures: FE_MEASURES.component.measures.filter((m) => m.metric.startsWith('new_')) } }
    const fe = await sonarOf(sonar({ measures: newOnly }))
    assert.deepEqual([fe['sonar-coverage'].status, fe['sonar-coverage'].value], ['unknown', '95.7% coverage of new code (no overall figure for the PR)'])
    assert.ok(!fe['sonar-coverage'].unreachable)
    assert.equal(fe['sonar-coverage'].data?.newCoverage, 95.67567567567568)
    assert.equal(fe['sonar-security'].value, '0 vulnerabilities, 0 security hotspots in new code')
    const low = { component: { measures: [{ metric: 'new_coverage', periods: [{ index: 1, value: '61.25' }] }] } }
    assert.equal((await sonarOf(sonar({ measures: low })))['sonar-coverage'].status, 'unknown', 'neither passed nor failed on new code')
    const low2 = { component: { measures: [{ metric: 'coverage', value: '61.2' }, { metric: 'new_coverage', periods: [{ index: 1, value: '99' }] }] } }
    assert.deepEqual([(await sonarOf(sonar({ measures: low2 })))['sonar-coverage'].status], ['fail'], 'the overall figure decides when there is one')
  })

  test('takes the latest PR analysis when it is of another commit, and says which it covers', async () => {
    const fe = await sonarOf(sonar({ list: PR_LIST(OLDER) }))
    assert.equal(fe['sonar-coverage'].status, 'pass')
    assert.equal(fe['sonar-coverage'].sha, FE_HEAD)
    assert.equal(fe['sonar-coverage'].note, 'the latest analysis of PR #2312 on 16 Nov 2026, which covers ab8b356, not 9cc1a08')
  })

  test('a 404 from the list, measures or gate is unknown and absent; network, auth and 5xx errors are unreachable', async () => {
    const api = await sonarReader(picked, sonar(), NOW)()
    assert.ok(api.filter((i) => i.repo === 'pcs-api').every((i) => i.status === 'unknown' && !i.unreachable && i.note === 'SonarCloud keeps no analysis of PR #3196'))
    const gone = await sonarOf(sonar({ missing: true }))
    for (const rule of ['sonar-coverage', 'sonar-security', 'sonar-quality-gate']) {
      assert.deepEqual([gone[rule].status, gone[rule].unreachable], ['unknown', undefined], rule)
      assert.match(gone[rule].note!, /^SonarCloud has no (measures|quality gate) for the analysis \(404\)$/)
    }
    const fails = (e: unknown) => async () => { throw e }
    const noList = await sonarReader(picked, fails(new HttpError(404, 'HTTP 404')), NOW)()
    assert.ok(noList.every((i) => i.status === 'unknown' && !i.unreachable && i.note === 'SonarCloud has no such project (404)'))
    for (const e of [new HttpError(503, 'HTTP 503'), new HttpError(401, 'HTTP 401'), new HttpError(403, 'HTTP 403'), new TypeError('fetch failed')]) {
      assert.ok((await sonarReader(picked, fails(e), NOW)()).every((i) => i.status === 'unknown' && i.unreachable), e.message)
    }
    // A 5xx on the measures alone leaves the gate readable.
    const flaky = sonar()
    const measures5xx = Object.assign(async (url: string) => (url.includes('/measures/') ? fails(new HttpError(502, 'HTTP 502'))() : flaky(url)), { urls: [] })
    const fe = await sonarOf(measures5xx)
    assert.deepEqual([fe['sonar-coverage'].unreachable, fe['sonar-quality-gate'].status], [true, 'pass'])
  })

  test('the gate fails on an ERROR condition', async () => {
    const fe = await sonarOf(sonar({ gate: { projectStatus: { status: 'ERROR', conditions: [{ status: 'ERROR', metricKey: 'new_coverage' }] } } }))
    assert.deepEqual([fe['sonar-quality-gate'].status, fe['sonar-quality-gate'].data?.failed], ['fail', ['new_coverage']])
  })
})

const NODE_REPORT = (tag: string, branch: string): CveDoc => ({
  _ts: 1_763_300_000, build: { branch_name: branch, build_tag: tag, git_url: 'https://github.com/hmcts/pcs-frontend.git', codebase_type: 'node' },
  report: { vulnerabilities: [], suppressed: [] },
} as unknown as CveDoc)

describe('Cosmos at the PR', () => {
  const gh = github()
  test('reads the PR job\'s finished build of the candidate, functional on preview, and no AAT stage', async () => {
    const events = [
      ...prEvents(FE_JOB, 'PR-2312', 13, OLDER, PR_STEPS, 'Pipeline Failed', 'FAILURE'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents('HMCTS_j_to_z/pcs-frontend/master', 'master', 1600, FE_HEAD, ['smoketest:aat', 'functionalTest:aat'], 'Pipeline Succeeded'),
    ]
    const tag = 'jenkins-HMCTS_j_to_z-pcs-frontend-PR-2312-14'
    const q = cosmos(events, [NODE_REPORT(tag, 'PR-2312')])
    const items = await cosmosReader(picked, q, NOW, gh)()
    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].value], ['pass', 'PR-2312 #14 (16 Nov 2026): integrationTest passed'])
    assert.equal(fe.functional.status, 'pass')
    assert.match(fe.functional.value, /^PR-2312 #14 .*smoketest:preview passed, functionalTest:preview passed$/)
    assert.deepEqual([fe['deployed-aat'].status, fe['deployed-aat'].value, fe['deployed-aat'].note], ['unknown', 'not run', 'PR builds deploy to preview, not AAT'])
    assert.deepEqual([fe['yarn-audit'].status, fe['yarn-audit'].note], ['pass', 'PR-2312 #14, at 9cc1a08'])
    const stage = q.calls.filter((c) => c.container === 'pipeline-metrics' && c.params['@b'] === 'PR-2312')
    assert.ok(stage.length && stage.every((c) => /c\.branch_name = @b/.test(c.query) && !('@sha' in c.params)))
    const cve = q.calls.filter((c) => c.container === 'cve-reports')
    assert.ok(cve.length && cve.every((c) => JSON.stringify(c.params['@branches']) === '["PR-2312"]' || JSON.stringify(c.params['@branches']) === '["PR-3196"]'))
    assert.ok(cve.some((c) => (c.params['@tags'] as string[]).includes(tag)))
  })

  test('a stage the PR head\'s build never reached is read at the newest finished build that ran it, of an earlier commit', async () => {
    // pcs-frontend PR #2312: #14 at the head stopped early; #13, a commit before, passed smoke and functional.
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 13, EARLIER, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, ['checkout', 'build'], 'Pipeline Failed', 'FAILURE')],
    [NODE_REPORT('jenkins-HMCTS_j_to_z-pcs-frontend-PR-2312-13', 'PR-2312')])
    const items = await cosmosReader(picked, q, NOW, gh)()
    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    const at = 'PR-2312 #13 at 3d0d6bb, an earlier commit than the PR head 9cc1a08'
    assert.deepEqual([fe.functional.status, fe.functional.sha, fe.functional.data?.head], ['pass', EARLIER, FE_HEAD])
    assert.equal(fe.functional.value, 'PR-2312 #13 (16 Nov 2026): smoketest:preview passed, functionalTest:preview passed')
    assert.equal(fe.functional.note, at, 'said once, in the note')
    assert.deepEqual(fe.functional.links, [{ text: 'pcs-frontend PR-2312 #13', url: 'https://build.hmcts.net/job/13/' }])
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].sha], ['pass', EARLIER])
    assert.deepEqual([fe['yarn-audit'].status, fe['yarn-audit'].sha, fe['yarn-audit'].note], ['pass', EARLIER, at])
    assert.equal(fe['yarn-audit'].value, 'yarn audit: 0 open, 0 suppressed')
    assert.deepEqual([fe['deployed-aat'].status, fe['deployed-aat'].note], ['unknown', 'PR builds deploy to preview, not AAT'])
  })

  test('the PR head is GitHub\'s: a latest finished build behind it says the head has no finished build yet', async () => {
    const q = cosmos(prEvents(FE_JOB, 'PR-2312', 13, EARLIER, PR_STEPS, 'Pipeline Succeeded'))
    const fe = (await cosmosReader(picked, q, NOW, gh)()).find((i) => i.repo === 'pcs-frontend' && i.rule === 'functional')!
    assert.deepEqual([fe.status, fe.sha], ['pass', EARLIER])
    assert.equal(fe.note, 'PR-2312 #13 at 3d0d6bb, an earlier commit than the PR head 9cc1a08; the head 9cc1a08 has no finished build yet')
  })

  test('a build of a commit no longer on the PR is skipped, as after a force-push', async () => {
    const gone = 'c'.repeat(40)
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 12, EARLIER, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 13, gone, PR_STEPS, 'Pipeline Failed', 'FAILURE'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, ['checkout', 'build'], 'Pipeline Failed', 'FAILURE')])
    const fe = (await cosmosReader(picked, q, NOW, gh)()).find((i) => i.repo === 'pcs-frontend' && i.rule === 'functional')!
    assert.deepEqual([fe.status, fe.sha, fe.value.startsWith('PR-2312 #12 ')], ['pass', EARLIER, true])
  })

  test('a build that ran a stage without recording its outcome is skipped for an older one that recorded it', async () => {
    // #14 failed at integrationTest; the functional stages after it have no recorded outcome.
    const fourteen = prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, PR_STEPS, 'Pipeline Failed', 'SUCCESS')
      .map((e) => (['smoketest:preview', 'functionalTest:preview', 'securitychecks', 'akschartsinstall', 'Pipeline Failed'].includes(e.current_step_name)
        ? { ...e, current_build_current_result: 'FAILURE' } : e))
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 13, EARLIER, PR_STEPS, 'Pipeline Succeeded'), ...fourteen])
    const fe = Object.fromEntries((await cosmosReader(picked, q, NOW, gh)()).filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].sha], ['fail', FE_HEAD])
    assert.deepEqual([fe.functional.status, fe.functional.sha], ['pass', EARLIER])
  })

  test('while GitHub can\'t say which commits are on the PR, only builds of the candidate are used, and the rest is unreachable', async () => {
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 13, EARLIER, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, ['checkout', 'build', 'integrationTest'], 'Pipeline Failed', 'SUCCESS')])
    const items = await cosmosReader(picked, q, NOW, github(undefined, 'error', { 'pcs-frontend/pulls/2312': new HttpError(502, 'HTTP 502') }))()
    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].sha], ['fail', FE_HEAD])
    assert.deepEqual([fe.functional.status, fe.functional.unreachable], ['unknown', true])
    assert.equal(fe.functional.note, 'no finished Jenkins build of PR-2312 at 9cc1a08 in the last 60 days recorded a matching stage\'s outcome, ' +
      'and builds of other commits were not used: the PR\'s commits could not be read from GitHub: HTTP 502 (502)')
  })

  test('CVE reports are looked for in the newest few builds that ran the security checks, not every PR build', async () => {
    const events = [10, 11, 12, 13, 14].flatMap((n) => prEvents(FE_JOB, 'PR-2312', n, EARLIER, n === 12 ? ['checkout', 'build'] : PR_STEPS, 'Pipeline Succeeded'))
    const q = cosmos(events)
    await cosmosReader(picked, q, NOW, gh)()
    const tags = q.calls.filter((c) => c.container === 'cve-reports').flatMap((c) => c.params['@tags'] as string[])
    assert.deepEqual([...new Set(tags)], [14, 13, 11].map((n) => `jenkins-HMCTS_j_to_z-pcs-frontend-PR-2312-${n}`))
  })

  test('a stage no finished build of the PR ran is unknown, and so is every rule of a PR with no finished build', async () => {
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 13, EARLIER, ['checkout', 'build', 'smoketest:preview'], 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, ['checkout', 'build'], 'Pipeline Failed', 'FAILURE')])
    const items = await cosmosReader(picked, q, NOW, gh)()
    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].sha, fe['integration-contract'].note, fe['integration-contract'].unreachable],
      ['unknown', FE_HEAD, 'no finished Jenkins build of PR-2312 of a commit on the PR in the last 60 days recorded a matching stage\'s outcome', undefined])
    assert.deepEqual([fe.functional.status, fe.functional.sha], ['pass', EARLIER])
    assert.deepEqual([fe['yarn-audit'].status, fe['yarn-audit'].note], ['unknown', 'no yarn audit report is recorded for the newest finished Jenkins builds of PR-2312'])
    const api = items.find((i) => i.repo === 'pcs-api' && i.rule === 'functional')!
    assert.deepEqual([api.status, api.note], ['unknown', 'no finished Jenkins build of PR-3196 is recorded in the last 60 days'])
  })

  test('the PR head\'s build decides a stage it ran, even when an earlier build passed it', async () => {
    const q = cosmos([...prEvents(FE_JOB, 'PR-2312', 13, EARLIER, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, [...PR_STEPS.slice(0, 7), 'functionalTest:preview'], 'Pipeline Failed', 'SUCCESS')
        .map((e) => (e.current_step_name === 'Pipeline Failed' ? { ...e, current_build_current_result: 'FAILURE' } : e))])
    const items = await cosmosReader(picked, q, NOW, gh)()
    const fe = items.find((i) => i.repo === 'pcs-frontend' && i.rule === 'functional')!
    assert.deepEqual([fe.status, fe.sha, fe.note], ['fail', FE_HEAD, undefined])
    assert.match(fe.value, /^PR-2312 #14 \(16 Nov 2026\): smoketest:preview passed, functionalTest:preview failed$/)
  })

  test('never compares build numbers across jobs: the job with the newest event is read', async () => {
    // The PR job moved folder: the old job's build numbers are higher, but its builds older.
    const old = prEvents('Old_folder/pcs-frontend/PR-2312', 'PR-2312', 90, OLDER, PR_STEPS, 'Pipeline Failed', 'FAILURE').map((e) => ({ ...e, _ts: 1_763_200_000 }))
    const moved = prEvents('HMCTS_j_to_z/pcs-frontend/PR-2312', 'PR-2312', 2, FE_HEAD, PR_STEPS, 'Pipeline Succeeded').map((e) => ({ ...e, _ts: 1_763_300_000 }))
    const noE2e = { ...picked, repos: { ...picked.repos, 'pcs-frontend': { ...picked.repos['pcs-frontend'], e2e: undefined } } }
    const items = await cosmosReader(noE2e, cosmos([...old, ...moved]), NOW, gh)()
    const fe = items.find((i) => i.repo === 'pcs-frontend' && i.rule === 'functional')!
    assert.deepEqual([fe.status, fe.value.startsWith('PR-2312 #2 ')], ['pass', true])
    const res = await scopeFeature({ ...noE2e, repos: { 'pcs-frontend': noE2e.repos['pcs-frontend'] } }, github(), NOW, cosmos([...moved, ...old]))
    assert.deepEqual([res.cfg.candidates[0].shas['pcs-frontend'], revisions(res.items)['pcs-frontend'].data?.number], [FE_HEAD, 2])
  })

  test('one run reads a PR\'s builds and head once, shared by scopeFeature, cosmosReader and the E2E reader', async () => {
    const q = cosmos(prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, PR_STEPS, 'Pipeline Succeeded'))
    const gh = github(undefined, 'success')
    const res = await scopeFeature(loaded, gh, NOW, q)
    await cosmosReader(res.cfg, q, NOW, gh)()
    await e2eReader(res.cfg, q, gh, async () => tarball({}), NOW)()
    const branchReads = (b: string) => q.calls.filter((c) => c.container === 'pipeline-metrics' && c.params['@b'] === b).length
    assert.deepEqual([branchReads('PR-2312'), branchReads('PR-3196')], [2, 2], 'one query per database')
    assert.equal(gh.calls.filter((p) => p === 'repos/hmcts/pcs-api/pulls/3196').length, 1)
    assert.equal(gh.calls.filter((p) => p.startsWith(`repos/hmcts/pcs-api/commits/${API_HEAD}/status`)).length, 1)
  })

  test('a release still reads master and nightly builds of the commit, and filters CVE reports to master and main', async () => {
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    const q = cosmos([])
    await cosmosReader(r, q, NOW, gh)()
    assert.ok(q.calls.filter((c) => c.container === 'pipeline-metrics').every((c) => '@sha' in c.params))
  })
})

describe('GitHub checks at the PR', () => {
  const run = (id: number, name: string) => ({ id, name, status: 'completed', conclusion: 'success', details_url: `https://github.com/x/${id}` })
  const runs = [run(1, 'Tests / Functional Test - preview'), run(2, 'Tests / Smoke Test - AKS preview'), run(3, 'Integration tests')]
  const c = picked.candidates[0]

  test('a PR\'s preview functional tests count, and its missing AAT deploy is said so', () => {
    const items = Object.fromEntries(checkItems('pcs-api', API_HEAD, c, runs, NOW, 3196).map((i) => [i.rule, i]))
    assert.equal(items.functional.status, 'pass')
    assert.match(items['deployed-aat'].note!, /PR builds deploy to preview, not AAT/)
    const master = Object.fromEntries(checkItems('pcs-api', API_HEAD, c, runs, NOW).map((i) => [i.rule, i]))
    assert.equal(master.functional.status, 'unknown', 'a master candidate needs AAT')
  })

  test('a rule with no check on the PR head is read at the PR\'s newest earlier commit with finished ones', async () => {
    // pcs-frontend PR #2312: 9cc1a08's build reported no stages; 3d0d6bb's passed smoke and functional on preview.
    const older = 'b'.repeat(40)
    const byCommit: Record<string, unknown[]> = {
      [FE_HEAD]: [run(10, 'CodeQL')],
      [EARLIER]: [run(5, 'Tests / Functional Test - preview'), run(6, 'Tests / Smoke Test - AKS preview')],
      [older]: [run(1, 'Tests / Functional Test - preview'), { ...run(2, 'Integration tests'), conclusion: 'cancelled' }],
    }
    const calls: string[] = []
    const api = async (path: string) => {
      calls.push(path)
      if (path === 'repos/hmcts/pcs-frontend/pulls/2312/commits?per_page=100&page=1') return [{ sha: older }, { sha: EARLIER }, { sha: FE_HEAD }]
      const sha = Object.keys(byCommit).find((s) => path.startsWith(`repos/hmcts/pcs-frontend/commits/${s}/check-runs`))
      if (sha) return { total_count: byCommit[sha].length, check_runs: byCommit[sha] }
      if (path.startsWith('repos/hmcts/pcs-api/')) return { total_count: 0, check_runs: [] }
      throw new HttpError(404, 'HTTP 404')
    }
    const items = await githubReader(picked, api, async () => tarball({}), NOW)()
    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.deepEqual([fe.functional.status, fe.functional.sha], ['pass', EARLIER])
    assert.equal(fe.functional.value, 'Tests / Functional Test - preview: success; Tests / Smoke Test - AKS preview: success')
    assert.equal(fe.functional.note, 'the PR head 9cc1a08 has no matching GitHub check, so these are from 3d0d6bb, an earlier commit of the PR and its latest with finished ones')
    assert.deepEqual([fe['integration-contract'].status, fe['integration-contract'].sha], ['unknown', FE_HEAD], 'a cancelled check is not a finished one')
    assert.equal(fe['integration-contract'].note, 'no matching GitHub check on 9cc1a08 or the 2 commits of the PR before it')
    assert.deepEqual([fe['deployed-aat'].status, fe['deployed-aat'].sha], ['unknown', FE_HEAD])
    assert.equal(calls.filter((p) => p.includes('/check-runs')).length, 3 + 1, 'each commit once, and pcs-api\'s head')
  })

  const noChecks = (repo: string, head: string, c: typeof picked.candidates[0]) => checkItems(repo, head, c, [], NOW, 2312)
  const fe = (items: Item[]) => Object.fromEntries(items.map((i) => [i.rule, i]))

  test('the PR\'s commits are read a page at a time up to GitHub\'s 250; a head beyond them leaves the look-back unknown, saying so', async () => {
    const shas = Array.from({ length: 260 }, (_, n) => n.toString(16).padStart(3, '0').padEnd(40, '0'))
    const pages: string[] = []
    const api = async (path: string) => {
      const page = Number.parseInt(new URL(`https://x/${path}`).searchParams.get('page') ?? '', 10)
      pages.push(String(page))
      return shas.slice((page - 1) * 100, page * 100).map((sha) => ({ sha }))
    }
    const listed = await pullCommits(api, 'hmcts/pcs-frontend', 2312)
    assert.deepEqual([listed.length, pages], [250, ['1', '2', '3']])
    const head = shas[255]
    const items = await withEarlierChecks(api, 'hmcts/pcs-frontend', 2312, 'pcs-frontend', head, c, noChecks('pcs-frontend', head, c), async () => [], NOW)
    assert.deepEqual([fe(items).functional.status, fe(items).functional.unreachable], ['unknown', undefined])
    assert.match(fe(items).functional.note!, /; 0ff0000 is not among the 250 commits GitHub lists for PR #2312, so earlier commits were not looked at$/)
    assert.equal(fe(items)['deployed-aat'].note, 'no matching GitHub check on 0ff0000: PR builds deploy to preview, not AAT')
  })

  test('when the PR\'s commits can\'t be listed, the look-back\'s items are unreachable, with the reason', async () => {
    const api = async () => { throw new HttpError(502, 'HTTP 502') }
    const items = fe(await withEarlierChecks(api, 'hmcts/pcs-frontend', 2312, 'pcs-frontend', FE_HEAD, c, noChecks('pcs-frontend', FE_HEAD, c), async () => [], NOW))
    assert.deepEqual([items.functional.status, items.functional.unreachable], ['unknown', true])
    assert.match(items.functional.note!, /; the PR's commits could not be read from GitHub to look at earlier ones: HTTP 502 \(502\)$/)
    assert.equal(items['deployed-aat'].unreachable, undefined)
  })
})

describe('the GIT Revision row', () => {
  const revisionItems = [
    { rule: 'service-revision', source: 'github', repo: 'pcs-api', status: 'pass' as const, sha: API_HEAD, value: 'pcs-api = cfa90c7', fetchedAt: NOW().toISOString(),
      links: [{ text: 'pcs-api = cfa90c7', url: `https://github.com/hmcts/pcs-api/commit/${API_HEAD}` }], note: 'from Cosmos', data: { from: 'cosmos' } },
    { rule: 'service-revision', source: 'github', repo: 'pcs-frontend', status: 'pass' as const, sha: FE_HEAD, value: 'pcs-frontend = 9cc1a08', fetchedAt: NOW().toISOString(),
      links: [{ text: 'pcs-frontend = 9cc1a08', url: `https://github.com/hmcts/pcs-frontend/commit/${FE_HEAD}` }], note: 'from GitHub', data: { from: 'github' } },
  ]
  const ev: Evidence = { release: loaded.release, generatedAt: NOW().toISOString(), candidates: picked.candidates, items: fileUnderRows(layout, revisionItems) }

  test('is each repo and its short SHA, linked to the commit, and nothing else', () => {
    const row = evaluate(picked, layout, ev).info.find((r) => r.key === 'GIT Revision')!
    assert.deepEqual(row.lines, revisionItems.map((i) => ({ text: '', links: i.links })))
    const cell = genRows(layout, evaluate(picked, layout, ev)).find((r) => r.table === 'info' && r.key === 'GIT Revision')!.cells.find((x) => x.name === 'details')!
    assert.ok(cell.html.endsWith(`</span><a href="https://github.com/hmcts/pcs-api/commit/${API_HEAD}">pcs-api = cfa90c7</a></p>` +
      `<p><a href="https://github.com/hmcts/pcs-frontend/commit/${FE_HEAD}">pcs-frontend = 9cc1a08</a></p></td>`), cell.html)
  })

  test('a head that was not picked is still the bare link, but the row is not a pass', () => {
    const unpicked = { ...revisionItems[1], status: 'unknown' as const, note: 'the PR\'s head commit 9cc1a08 has no finished Jenkins build' }
    const e = { ...ev, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': API_HEAD } }], unpicked: ['pcs-frontend'],
      items: fileUnderRows(layout, [revisionItems[0], unpicked]) }
    const row = evaluate(picked, layout, e).info.find((r) => r.key === 'GIT Revision')!
    assert.deepEqual(row.lines, revisionItems.map((i) => ({ text: '', links: i.links })))
    assert.equal(row.status, 'unknown')
  })

  test('the agent is told the evidence is from the PRs, and how each commit was picked', () => {
    type Input = { scope: { measuredAt: string; repos: Record<string, { pullRequest: unknown; revision: unknown }> } }
    const input = agentInput(picked, layout, ev, null) as Input
    assert.equal(input.scope.measuredAt, 'The evidence is from the feature\'s pull requests, not master: hmcts/pcs-api#3196 at cfa90c7, hmcts/pcs-frontend#2312 at 9cc1a08.')
    assert.deepEqual(input.scope.repos['pcs-api'].pullRequest, { number: 3196, repo: 'hmcts/pcs-api', url: 'https://github.com/hmcts/pcs-api/pull/3196', commit: API_HEAD })
    assert.deepEqual(input.scope.repos['pcs-api'].revision, { status: 'pass', sha: API_HEAD, from: 'cosmos', note: 'from Cosmos' })
    assert.deepEqual(input.scope.repos['pcs-frontend'].revision, { status: 'pass', sha: FE_HEAD, from: 'github', note: 'from GitHub' })
    const one = { ...picked, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': API_HEAD } }] }
    assert.match((agentInput(one, layout, ev, null) as Input).scope.measuredAt, /hmcts\/pcs-frontend#2312, with no commit picked\.$/)
  })

  test('the agent is given each repo\'s head and, per candidate, the commit each stage result came from', () => {
    const stage = (rule: string, source: string, sha: string | null, over: Partial<Item> = {}) =>
      ({ rule, source, repo: 'pcs-frontend', status: 'pass' as const, sha, value: 'v', links: [], fetchedAt: NOW().toISOString(), ...over })
    const items = [stage('functional', 'cosmos', EARLIER, { candidate: SERVICE_WIDE, data: { head: FE_HEAD } }), stage('e2e-feature', 'e2e', EARLIER, { data: { head: FE_HEAD } }),
      stage('yarn-audit', 'cosmos', FE_HEAD, { candidate: SERVICE_WIDE }), stage('integration-contract', 'cosmos', null, { candidate: SERVICE_WIDE, status: 'unknown' }),
      stage('sonar-coverage', 'sonarcloud', FE_HEAD)]
    const e = { ...ev, items: [...ev.items, ...fileUnderRows(layout, items)] }
    type Repo = { head?: string; stageResults?: { candidate?: string; rule: string; sha: string | null; earlierThanHead: boolean | 'unknown' }[] }
    const repoOf = (cfg: ReleaseConfig, ev2: Evidence) => (agentInput(cfg, layout, ev2, null) as { scope: { repos: Record<string, Repo> } }).scope.repos['pcs-frontend']
    const fe = repoOf(picked, e)
    assert.equal(fe.head, FE_HEAD)
    assert.deepEqual(fe.stageResults!.map((r) => [r.rule, r.sha, r.earlierThanHead]).sort(),
      [['e2e-feature', EARLIER, true], ['functional', EARLIER, true], ['integration-contract', null, 'unknown'], ['yarn-audit', FE_HEAD, false]])

    // Two candidates: each result is against its own candidate's commit, and both are kept.
    const two = { ...picked, candidates: [{ name: 'A', shas: { 'pcs-frontend': FE_HEAD } }, { name: 'B', shas: { 'pcs-frontend': EARLIER } }] }
    const both = [stage('functional', 'cosmos', FE_HEAD, { candidate: 'A' }), stage('functional', 'cosmos', EARLIER, { candidate: 'B' })]
    const results = repoOf(two, { ...ev, candidates: two.candidates, items: fileUnderRows(layout, both) }).stageResults!
    assert.deepEqual(results.map((r) => [r.candidate, r.sha, r.earlierThanHead]), [['A', FE_HEAD, false], ['B', EARLIER, false]])
  })


})
