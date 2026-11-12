import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cosmosReader, type CveDoc, type StageEvent, summariseCve, toBuilds } from '../scripts/lib/qa/sources/cosmos.ts'
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

// A trimmed OWASP dependency-check report (GradleBuilder.prepareCVEReport keeps vulnerable deps only).
const javaReport: CveDoc = { build: { build_tag: `jenkins-${API_MASTER.replace(/\//g, '-')}-2092`, codebase_type: 'java' }, report: { dependencies: [
  { fileName: 'a.jar', vulnerabilities: [], suppressedVulnerabilities: [{ name: 'CVE-2026-0001', severity: 'HIGH' }, { name: 'CVE-2026-0002', severity: 'LOW' }] },
  { fileName: 'b.jar', suppressedVulnerabilities: [{ name: 'CVE-2026-0001', severity: 'HIGH' }] },
] } }

// YarnBuilder.prepareCVEReport: every advisory, with the known (suppressed) ones listed again.
const nodeReport = (open: boolean): CveDoc => ({ build: { build_tag: 'jenkins-HMCTS_j_to_z-pcs-frontend-master-1569', codebase_type: 'node' }, report: {
  vulnerabilities: [{ title: 'ReDoS', module_name: 'x', severity: 'moderate' }, ...(open ? [{ title: 'Prototype pollution', module_name: 'y', severity: 'high' }] : [])],
  suppressed: [{ title: 'ReDoS', module_name: 'x', severity: 'moderate' }],
  summary: { vulnerabilities: { critical: 0, high: open ? 1 : 0, moderate: 1, low: 0, info: 0 } },
} })

describe('pipeline-metrics builds', () => {
  test('keeps master and nightly builds, newest first, and finds the failed stage', () => {
    const builds = toBuilds(apiEvents)
    assert.deepEqual(builds.map((b) => [b.kind, b.number, b.outcome]), [['master', 2092, 'SUCCESS'], ['master', 2091, 'FAILURE'], ['nightly', 653, 'SUCCESS']])
    // In a failed build the last stage to report is the one that failed, even though it said SUCCESS.
    assert.equal(builds[1].stages.get('functionalTest:aat'), 'fail')
    assert.equal(builds[1].stages.get('test'), 'pass')
    assert.ok(!builds[0].stages.has('deprecated_gradle'))
  })

  test('a stage reporting a non-SUCCESS result is the failure', () => {
    const [b] = toBuilds(build(API_MASTER, 1, 'master', SHA.api2, [['build'], ['test', 'UNSTABLE'], ['sonarscan']], 'Pipeline Failed'))
    assert.deepEqual([...b.stages], [['build', 'pass'], ['test', 'fail']])
  })
})

describe('cve-reports', () => {
  test('counts open and suppressed findings', () => {
    assert.deepEqual(summariseCve(javaReport), { type: 'java', open: 0, suppressed: 2, bySeverity: {} })
    assert.deepEqual(summariseCve(nodeReport(true)), { type: 'node', open: 1, suppressed: 1, bySeverity: { high: 1 } })
  })
})

describe('cosmosReader', () => {
  const cfg = { ...CFG, candidates: [CFG.candidates[1]] }

  test('answers the stage rules and joins CVE reports through build_tag', async () => {
    const queries: { container: string; params: { name: string; value: unknown }[] }[] = []
    const items = await cosmosReader(cfg, async (container, _q, params) => {
      queries.push({ container, params })
      if (container === 'pipeline-metrics') {
        const sha = params.find((p) => p.name === '@sha')!.value
        const c = params.find((p) => p.name === '@c')!.value
        return c === 'api' ? apiEvents.filter((e) => e.git_commit === sha)
          : build('HMCTS_j_to_z/pcs-frontend/master', 1569, 'master', SHA.fe2, [['securitychecks'], ['smoketest:aat'], ['functionalTest:aat']], 'Pipeline Succeeded')
      }
      const tags = params[0].value as string[]
      return [javaReport, nodeReport(true)].filter((d) => tags.includes(d.build.build_tag!))
    }, NOW)()

    const api = Object.fromEntries(items.filter((i) => i.repo === 'pcs-api').map((i) => [i.rule, i]))
    assert.equal(api['integration-contract'].status, 'pass')
    assert.equal(api.functional.status, 'pass')
    assert.match(api.functional.value, /master #2092.*functionalTest:aat passed.*nightly #653.*fullFunctionalTest:aat passed/)
    assert.equal(api['deployed-aat'].status, 'pass')
    assert.deepEqual([api['dependency-check'].status, api['dependency-check'].answer], ['pass', 'Yes'])
    assert.match(api['dependency-check'].value, /0 open, 2 suppressed/)
    assert.ok(Object.values(api).every((i) => i.sha === SHA.api2))

    const fe = Object.fromEntries(items.filter((i) => i.repo === 'pcs-frontend').map((i) => [i.rule, i]))
    assert.equal(fe['integration-contract'].status, 'unknown')
    assert.deepEqual([fe['yarn-audit'].status, fe['yarn-audit'].answer], ['fail', 'Yes'])
    assert.ok(queries.filter((q) => q.container === 'pipeline-metrics').every((q) => q.params.some((p) => p.name === '@sha')))
  })

  test('access denied gives unknown rows, and Cosmos is not asked again', async () => {
    let calls = 0
    const items = await cosmosReader(CFG, async () => {
      calls++
      throw Object.assign(new Error('Request blocked by Auth pipeline-metrics : principal does not have required RBAC permissions'), { code: 403 })
    }, NOW)()
    assert.equal(calls, 1)
    assert.equal(items.length, 4 * 4)
    assert.ok(items.every((i) => i.status === 'unknown' && i.note === 'Cosmos pipeline-metrics could not be read: access denied (403)'))
  })

  test('a commit with no build recorded is unknown', async () => {
    const items = await cosmosReader(cfg, async () => [], NOW)()
    assert.ok(items.every((i) => i.status === 'unknown'))
    assert.match(items[0].note!, /no master or nightly Jenkins build of a8606ea/)
  })
})
