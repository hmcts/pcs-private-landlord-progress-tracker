import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cosmosReader, type CveDoc, newestReports, type StageEvent, summariseCve, toBuilds } from '../scripts/lib/qa/sources/cosmos.ts'
import { repoFromGitUrl } from '../scripts/lib/qa/sources/cve.ts'
import { CFG, NOW, SHA } from './qa-helpers.ts'

// Stage events shaped as MetricsPublisher.collectMetrics() writes them (cnp-jenkins-library).
function build(job: string, number: number, branch: string, sha: string, steps: [string, string?][], final?: string): StageEvent[] {
  const ev = steps.map(([name, result], n) => ({
    job_name: job, branch_name: branch, build_number: String(number), build_tag: `jenkins-${job.replace(/\//g, '-')}-${number}`,
    build_url: `https://build.example/job/${job}/${number}/`, current_step_name: name, current_build_current_result: result ?? 'SUCCESS',
    current_build_duration: (n + 1) * 1000, current_build_scheduled_time: '2026-09-17T18:10:00Z', git_commit: sha,
  }))
  if (final) ev.push({ ...ev[0], current_step_name: final, current_build_duration: 99_000 })
  return ev
}

const API_MASTER = 'HMCTS_j_to_z/pcs-api/master'
const API_NIGHTLY = 'HMCTS_j_to_z_Nightly/pcs-api/master'

const apiEvents = [
  ...build(API_MASTER, 2091, 'master', SHA.api2, [['checkout'], ['build'], ['test'], ['functionalTest:aat']], 'Pipeline Failed'),
  ...build(API_MASTER, 2092, 'master', SHA.api2, [['checkout'], ['build'], ['test'], ['securitychecks'], ['deprecated_gradle'],
    ['pact-consumer-tests'], ['smoketest:aat'], ['functionalTest:aat'], ['prod:promotion']], 'Pipeline Succeeded'),
  ...build(API_NIGHTLY, 653, 'master', SHA.api2, [['checkout'], ['fullFunctionalTest:aat']], 'Pipeline Succeeded'),
  ...build('HMCTS_j_to_z/pcs-api/ithc', 1365, 'ithc', SHA.api2, [['functionalTest:aat', 'FAILURE']], 'Pipeline Failed'),
]

const API_GIT = 'https://github.com/hmcts/pcs-api.git'
const FE_GIT = 'https://github.com/hmcts/pcs-frontend.git'

// GradleBuilder.prepareCVEReport: dependency-check trimmed to vulnerable dependencies. Suppressed
// entries carry no `severity` of their own, only CVSS blocks.
const javaReport: CveDoc = { _ts: 1_790_000_000, build: { branch_name: 'master', build_tag: `jenkins-${API_MASTER.replace(/\//g, '-')}-2092`, git_url: API_GIT, codebase_type: 'java' }, report: { dependencies: [
  { fileName: 'a.jar', vulnerabilities: [], suppressedVulnerabilities: [{ name: 'CVE-2026-0001', cvssv3: { baseSeverity: 'HIGH', baseScore: 7.5 } }, { name: 'CVE-2026-0002', cvssv2: { severity: 'LOW' } }] },
  { fileName: 'b.jar', suppressedVulnerabilities: [{ name: 'CVE-2026-0001', cvssv3: { baseSeverity: 'HIGH' } }] },
  { fileName: 'b.jar', suppressedVulnerabilities: [{ name: 'CVE-2026-0001', cvssv3: { baseSeverity: 'HIGH' } }] },
  { vulnerabilities: [{ name: 'CVE-2026-0003', severity: 'HIGH' }] },
] } }

// YarnBuilder.prepareCVEReport: the whole audit in `vulnerabilities` (accepted advisories included),
// the known-issues file in `suppressed`, and the all-null placeholder entry every report carries.
const NULL_ENTRY = { title: null, cves: null, vulnerable_versions: null, patched_versions: null, severity: null, cwe: null, cvss: null, url: null, module_name: null }
const nodeReport = (open: boolean): CveDoc => ({ _ts: 1_790_000_000, build: { branch_name: 'master', build_tag: 'jenkins-HMCTS_j_to_z-pcs-frontend-master-1569', git_url: FE_GIT, codebase_type: 'node' }, report: {
  vulnerabilities: [NULL_ENTRY, { title: 'ReDoS', cves: ['CVE-2026-1000'], module_name: 'x', severity: 'moderate', url: 'https://github.com/advisories/GHSA-a' },
    ...(open ? [{ title: 'Prototype pollution', cves: [], module_name: 'y', severity: 'high', url: 'https://github.com/advisories/GHSA-b' }] : [])],
  suppressed: [{ title: 'ReDoS', cves: ['CVE-2026-1000'], module_name: 'x', severity: 'moderate', url: 'https://github.com/advisories/GHSA-a' }],
  summary: { vulnerabilities: { critical: 0, high: open ? 1 : 0, moderate: 1, low: 0, info: 0 } },
} })

// PythonBuilder: uv audit, with no grades and no suppression.
const pythonReport: CveDoc = { build: { branch_name: 'master', build_tag: 't', git_url: 'git@github.com:hmcts/py-app.git', codebase_type: 'python' }, report: {
  vulnerabilities: [{ display_id: 'GHSA-xxxx', aliases: ['CVE-2026-2000'], package: 'requests' }, { aliases: [], dependency: { name: 'urllib3' } }] } }

describe('pipeline-metrics builds', () => {
  test('keeps master and nightly builds, newest first, and finds the failed stage', () => {
    const builds = toBuilds(apiEvents)
    assert.deepEqual(builds.map((b) => [b.kind, b.number, b.outcome]), [['master', 2092, 'SUCCESS'], ['master', 2091, 'FAILURE'], ['nightly', 653, 'SUCCESS']])
    // In a failed build the last stage to report is the one that failed, even though it said SUCCESS.
    assert.equal(builds[1].stages.get('functionalTest:aat'), 'fail')
    assert.equal(builds[1].stages.get('test'), 'pass')
    assert.ok(!builds[0].stages.has('deprecated_gradle'))
  })

  test('the first stage reporting a non-SUCCESS result, and the one before it, may be the failure', () => {
    const [b] = toBuilds(build(API_MASTER, 1, 'master', SHA.api2, [['checkout'], ['build'], ['test', 'UNSTABLE'], ['sonarscan']], 'Pipeline Failed'))
    assert.deepEqual([...b.stages], [['checkout', 'pass'], ['build', 'fail'], ['test', 'fail']])
    assert.deepEqual(b.suspects, ['build', 'test'])
  })

  test('builds that never finished, or were aborted, are not counted', () => {
    const aborted = build(API_MASTER, 3, 'master', SHA.api2, [['checkout'], ['functionalTest:aat']], 'Pipeline Failed')
    aborted.at(-1)!.current_build_current_result = 'ABORTED'
    const builds = toBuilds([...build(API_MASTER, 2, 'master', SHA.api2, [['checkout'], ['functionalTest:aat']]), ...aborted,
      ...build(API_MASTER, 1, 'master', SHA.api2, [['checkout'], ['functionalTest:aat']], 'Pipeline Succeeded')])
    assert.deepEqual(builds.map((b) => b.number), [1])
  })
})

describe('cve-reports', () => {
  test('counts open and suppressed findings per CVE and package, as the publishers shape them', () => {
    assert.deepEqual(summariseCve(javaReport), { type: 'java', open: 0, suppressed: 3, bySeverity: {} })
    assert.deepEqual(summariseCve(nodeReport(true)), { type: 'node', open: 1, suppressed: 1, bySeverity: { high: 1 } })
    assert.deepEqual(summariseCve(nodeReport(false)), { type: 'node', open: 0, suppressed: 1, bySeverity: {} })
    assert.deepEqual(summariseCve(pythonReport), { type: 'python', open: 1, suppressed: 0, bySeverity: { unrated: 1 } })
    assert.equal(summariseCve({ build: { codebase_type: 'go' }, report: {} }), undefined)
  })

  test('grades from CVSS, worse first, and folds moderate to medium', () => {
    const doc: CveDoc = { build: { codebase_type: 'java' }, report: { dependencies: [{ fileName: 'c.jar', vulnerabilities: [
      { name: 'CVE-1', severity: 'MEDIUM', cvssv3: { baseSeverity: 'HIGH' } }, { name: 'CVE-1', cvssv2: { severity: 'LOW' } }, { name: 'CVE-2' }] }] } }
    assert.deepEqual(summariseCve(doc)!.bySeverity, { high: 1, unrated: 1 })
  })

  test('attributes a report by git_url, stripping .git only as a suffix', () => {
    assert.equal(repoFromGitUrl('https://github.com/HMCTS/pcs-api.git'), 'hmcts/pcs-api')
    assert.equal(repoFromGitUrl('https://github.com/hmcts/foo.github.io.git'), 'hmcts/foo.github.io')
    assert.equal(repoFromGitUrl('git@github.com:hmcts/py-app.git'), 'hmcts/py-app')
    for (const bad of ['https://gitlab.com/hmcts/x.git', 'https://github.com/hmcts', 'https://github.com/a/b/c', 7]) assert.equal(repoFromGitUrl(bad), undefined)
  })

  test('keeps the newest report per build and type, and only the repo\'s own', () => {
    const older = { ...javaReport, _ts: 1 }
    const other = { ...javaReport, _ts: 9_999_999_999, build: { ...javaReport.build, git_url: 'https://github.com/hmcts/other.git' } }
    const kept = newestReports([older, javaReport, other], 'hmcts/pcs-api')
    assert.deepEqual([...kept.values()].map((d) => d._ts), [javaReport._ts])
  })
})

describe('cosmosReader', () => {
  const cfg = { ...CFG, candidates: [CFG.candidates[1]] }

  test('answers the stage rules and joins CVE reports through build_tag', async () => {
    const queries: { db: string; container: string; query: string; params: { name: string; value: unknown }[] }[] = []
    const items = await cosmosReader(cfg, async (db, container, query, params) => {
      queries.push({ db, container, query, params })
      // pcs-api moved to sds-jenkins after its earlier builds, as repos given the jenkins-sds topic do.
      if (container === 'pipeline-metrics') {
        if (db === 'jenkins') return []
        const sha = params.find((p) => p.name === '@sha')!.value
        const c = params.find((p) => p.name === '@c')!.value
        return c === 'api' ? apiEvents.filter((e) => e.git_commit === sha)
          : build('HMCTS_j_to_z/pcs-frontend/master', 1569, 'master', SHA.fe2, [['securitychecks'], ['smoketest:aat'], ['functionalTest:aat']], 'Pipeline Succeeded')
      }
      const tags = params[0].value as string[]
      return (db === 'jenkins' ? [nodeReport(true)] : [javaReport]).filter((d) => tags.includes(d.build.build_tag!))
    }, NOW)()

    const api = Object.fromEntries(items.filter((i) => i.repo === 'pcs-api').map((i) => [i.rule, i]))
    assert.equal(api['integration-contract'].status, 'pass')
    assert.equal(api.functional.status, 'pass')
    assert.match(api.functional.value, /master #2092.*functionalTest:aat passed.*nightly #653.*fullFunctionalTest:aat passed/)
    assert.equal(api['deployed-aat'].status, 'pass')
    assert.deepEqual([api['dependency-check'].status, api['dependency-check'].answer], ['pass', 'Yes'])
    assert.match(api['dependency-check'].value, /0 open, 3 suppressed/)
    assert.ok(Object.values(api).every((i) => i.sha === SHA.api2))

    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.equal(fe['integration-contract'].status, 'unknown')
    assert.deepEqual([fe['yarn-audit'].status, fe['yarn-audit'].answer], ['fail', 'Yes'])
    assert.ok(queries.filter((q) => q.container === 'pipeline-metrics').every((q) => q.params.some((p) => p.name === '@sha')))
    assert.deepEqual([...new Set(queries.map((q) => q.db))].sort(), ['jenkins', 'sds-jenkins'])
    assert.ok(queries.every((q) => /ARRAY_CONTAINS\(@branches, c\.(build\.)?branch_name\)/.test(q.query)))
  })

  test('access denied gives unknown rows, and Cosmos is not asked again', async () => {
    let calls = 0
    const items = await cosmosReader(CFG, async () => {
      calls++
      throw Object.assign(new Error('Request blocked by Auth pipeline-metrics : principal does not have required RBAC permissions'), { code: 403 })
    }, NOW)()
    assert.equal(calls, 2)
    assert.equal(items.length, 4 * 4)
    assert.ok(items.every((i) => i.status === 'unknown' && i.note === 'Cosmos pipeline-metrics could not be read: access denied (403)'))
  })

  test('uses the latest completed build of each job, and says when Jenkins cannot tell which stage failed', async () => {
    const events = [
      ...build(API_MASTER, 10, 'master', SHA.api2, [['checkout'], ['smoketest:aat'], ['functionalTest:aat', 'FAILURE']], 'Pipeline Failed'),
      ...build(API_MASTER, 11, 'master', SHA.api2, [['checkout'], ['smoketest:aat']]),
      ...build('HMCTS_j_to_z/pcs-api/main', 4, 'main', SHA.api2, [['checkout'], ['pact-consumer-tests']], 'Pipeline Succeeded'),
    ]
    const items = await cosmosReader({ ...cfg, candidates: [{ name: 'V2', shas: { 'pcs-api': SHA.api2 } }] },
      async (db, container) => (db === 'jenkins' && container === 'pipeline-metrics' ? events : []), NOW)()
    const api = Object.fromEntries(items.map((i) => [i.rule, i]))
    assert.equal(api.functional.status, 'fail')
    assert.match(api.functional.value, /master #10/)
    assert.equal(api.functional.note, "master #10: Jenkins can't tell whether smoketest:aat or functionalTest:aat failed")
    assert.equal(api['integration-contract'].status, 'pass')
    assert.match(api['integration-contract'].value, /master #4/)
  })

  test('a commit with no build recorded is unknown', async () => {
    const items = await cosmosReader(cfg, async () => [], NOW)()
    assert.ok(items.every((i) => i.status === 'unknown'))
    assert.match(items[0].note!, /no master or nightly Jenkins build of a8606ea/)
  })
})
