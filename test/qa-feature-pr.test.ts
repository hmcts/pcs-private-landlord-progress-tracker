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
import { checkItems } from '../scripts/lib/qa/sources/github.ts'
import { sonarReader } from '../scripts/lib/qa/sources/sonar.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { NOW } from './qa-helpers.ts'

const { cfg: loaded, layout } = loadRelease('config/qa-readiness/private-landlord-make-a-claim.yaml')
const API_HEAD = 'cfa90c771bb471c0334d83fdd193b5c1f1616adc'
const FE_HEAD = '9cc1a083edfe4fd1fb60a8b78e0355fdbf52a2d8'
const OLDER = 'ab8b356c39471cb7420f88de91aa501dd2f0b223'
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

/** GitHub with the PRs' heads and the Jenkins pr-head status on them. */
function github(fail?: Error) {
  const calls: string[] = []
  const api = async (path: string) => {
    calls.push(path)
    if (fail) throw fail
    if (path === 'repos/hmcts/pcs-api/pulls/3196') return { head: { sha: API_HEAD } }
    if (path === 'repos/hmcts/pcs-frontend/pulls/2312') return { head: { sha: FE_HEAD } }
    const [repo, job, sha] = path.includes(API_HEAD) ? ['pcs-api', 'PR-3196/22', API_HEAD] : ['pcs-frontend', 'PR-2312/14', FE_HEAD]
    if (path === `repos/hmcts/${repo}/commits/${sha}/status?per_page=100`) {
      return { statuses: [{ context: 'continuous-integration/jenkins/pr-head', state: repo === 'pcs-api' ? 'success' : 'error',
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

  test('falls back to the PR head on GitHub, with its Jenkins status, when Cosmos can\'t be read or has nothing', async () => {
    for (const q of [cosmos(Object.assign(new Error('Forbidden'), { code: 403 })), cosmos([])]) {
      const res = await scopeFeature(loaded, github(), NOW, q)
      assert.deepEqual(res.cfg.candidates[0].shas, { 'pcs-api': API_HEAD, 'pcs-frontend': FE_HEAD })
      const r = revisions(res.items)
      assert.equal(r['pcs-frontend'].value, 'pcs-frontend = 9cc1a08')
      assert.equal(r['pcs-frontend'].status, 'pass')
      assert.deepEqual([r['pcs-frontend'].data?.from, r['pcs-frontend'].data?.state, r['pcs-frontend'].data?.number], ['github', 'error', 14])
      assert.match(r['pcs-frontend'].note!, /^the PR's head commit, from GitHub, where its Jenkins status \(PR-2312 #14\) is error: Cosmos/)
    }
    const denied = revisions((await scopeFeature(loaded, github(), NOW, cosmos(Object.assign(new Error('x'), { code: 403 })))).items)
    assert.match(denied['pcs-api'].note!, /Cosmos pipeline-metrics could not be read: access denied \(403\)$/)
    const none = revisions((await scopeFeature(loaded, github(), NOW, cosmos([]))).items)
    assert.match(none['pcs-api'].note!, /Cosmos records no finished build of PR-3196 in the last 60 days$/)
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

  test('with only new-code figures, judges by them and says so', async () => {
    const newOnly = { component: { ...FE_MEASURES.component, measures: FE_MEASURES.component.measures.filter((m) => m.metric.startsWith('new_')) } }
    const fe = await sonarOf(sonar({ measures: newOnly }))
    assert.deepEqual([fe['sonar-coverage'].status, fe['sonar-coverage'].value], ['pass', '95.7% coverage of new code'])
    assert.match(fe['sonar-coverage'].note!, /has no overall coverage figure, only the new code's/)
    assert.equal(fe['sonar-coverage'].data?.newCode, true)
    assert.equal(fe['sonar-security'].value, '0 vulnerabilities, 0 security hotspots in new code')
    const low = { component: { measures: [{ metric: 'new_coverage', periods: [{ index: 1, value: '61.25' }] }] } }
    assert.deepEqual([(await sonarOf(sonar({ measures: low })))['sonar-coverage'].status], ['fail'])
  })

  test('takes the latest PR analysis when it is of another commit, and says which it covers', async () => {
    const fe = await sonarOf(sonar({ list: PR_LIST(OLDER) }))
    assert.equal(fe['sonar-coverage'].status, 'pass')
    assert.equal(fe['sonar-coverage'].sha, FE_HEAD)
    assert.equal(fe['sonar-coverage'].note, 'the latest analysis of PR #2312 on 16 Nov 2026, which covers ab8b356, not 9cc1a08')
  })

  test('a PR SonarCloud has no analysis of is unknown, not unreachable; SonarCloud down is unreachable', async () => {
    const api = await sonarReader(picked, sonar(), NOW)()
    assert.ok(api.filter((i) => i.repo === 'pcs-api').every((i) => i.status === 'unknown' && !i.unreachable && i.note === 'SonarCloud keeps no analysis of PR #3196'))
    const gone = await sonarOf(sonar({ missing: true }))
    assert.equal(gone['sonar-coverage'].status, 'unknown')
    assert.ok(!gone['sonar-coverage'].unreachable)
    const down = await sonarReader(picked, async () => { throw new HttpError(503, 'HTTP 503') }, NOW)()
    assert.ok(down.every((i) => i.status === 'unknown' && i.unreachable))
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
  test('reads the PR job\'s finished build of the candidate, functional on preview, and no AAT stage', async () => {
    const events = [
      ...prEvents(FE_JOB, 'PR-2312', 13, OLDER, PR_STEPS, 'Pipeline Failed', 'FAILURE'),
      ...prEvents(FE_JOB, 'PR-2312', 14, FE_HEAD, PR_STEPS, 'Pipeline Succeeded'),
      ...prEvents('HMCTS_j_to_z/pcs-frontend/master', 'master', 1600, FE_HEAD, ['smoketest:aat', 'functionalTest:aat'], 'Pipeline Succeeded'),
    ]
    const tag = 'jenkins-HMCTS_j_to_z-pcs-frontend-PR-2312-14'
    const q = cosmos(events, [NODE_REPORT(tag, 'PR-2312')])
    const items = await cosmosReader(picked, q, NOW)()
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

  test('a PR build of another commit is used, and says which commit it ran; no build is said so', async () => {
    const q = cosmos(prEvents(FE_JOB, 'PR-2312', 13, OLDER, PR_STEPS, 'Pipeline Succeeded'))
    const items = await cosmosReader(picked, q, NOW)()
    const fe = items.find((i) => i.repo === 'pcs-frontend' && i.rule === 'functional')!
    assert.match(fe.note!, /PR-2312 #13 ran ab8b356, not 9cc1a08/)
    const api = items.find((i) => i.repo === 'pcs-api' && i.rule === 'functional')!
    assert.deepEqual([api.status, api.note], ['unknown', 'no finished Jenkins build of PR-3196 is recorded in the last 60 days'])
  })

  test('a release still reads master and nightly builds of the commit, and filters CVE reports to master and main', async () => {
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    const q = cosmos([])
    await cosmosReader(r, q, NOW)()
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

  test('the agent is told the evidence is from the PRs', () => {
    const input = agentInput(picked, layout, ev, null) as { scope: { measuredAt: string; repos: Record<string, { pullRequest: unknown }> } }
    assert.equal(input.scope.measuredAt, 'The evidence is from the feature\'s pull requests, not master: hmcts/pcs-api#3196 at cfa90c7, hmcts/pcs-frontend#2312 at 9cc1a08.')
    assert.deepEqual(input.scope.repos['pcs-api'].pullRequest, { number: 3196, url: 'https://github.com/hmcts/pcs-api/pull/3196', commit: API_HEAD,
      commitFrom: 'the PR\'s latest finished Jenkins build' })
    assert.deepEqual(input.scope.repos['pcs-frontend'].pullRequest, { number: 2312, url: 'https://github.com/hmcts/pcs-frontend/pull/2312', commit: FE_HEAD,
      commitFrom: 'the PR\'s head on GitHub' })
  })
})
