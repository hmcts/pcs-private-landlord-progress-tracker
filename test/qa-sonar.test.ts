import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpError } from '../scripts/lib/qa/sources/common.ts'
import { findAnalysis, sonarReader } from '../scripts/lib/qa/sources/sonar.ts'
import { CFG, NOW, SHA } from './qa-helpers.ts'

const at = '2026-09-17T18:04:17+0000'

/** SonarCloud's API, answering for pcs-api's V2 commit only, as when older analyses are gone. */
function sonar(opts: { gate?: string; coverage?: string; vulns?: string } = {}) {
  const urls: string[] = []
  const get = async (url: string) => {
    urls.push(url)
    const u = new URL(url)
    const p = u.searchParams
    if (u.pathname.endsWith('/project_analyses/search')) {
      if (p.get('project') !== 'uk.gov.hmcts.reform:pcs-api-2') return { paging: { total: 1, pageSize: 500 }, analyses: [{ key: 'fe', date: at, revision: 'f'.repeat(40) }] }
      const page = Number(p.get('p'))
      return page === 1
        ? { paging: { total: 501, pageSize: 500 }, analyses: [{ key: 'newer', date: '2026-11-12T10:32:00+0000', revision: 'c'.repeat(40) }] }
        : { paging: { total: 501, pageSize: 500 }, analyses: [{ key: 'a2', date: at, revision: SHA.api2 }] }
    }
    if (u.pathname.endsWith('/measures/search_history')) {
      assert.equal(p.get('from'), at)
      return { measures: [
        { metric: 'coverage', history: [{ date: at, value: opts.coverage ?? '96.1' }] },
        { metric: 'vulnerabilities', history: [{ date: at, value: opts.vulns ?? '0' }] },
        { metric: 'security_hotspots', history: [{ date: at, value: '0' }] },
      ] }
    }
    if (u.pathname.endsWith('/qualitygates/project_status')) {
      assert.equal(p.get('analysisId'), 'a2')
      return { projectStatus: { status: opts.gate ?? 'OK', conditions: [{ metricKey: 'new_coverage', status: opts.gate === 'ERROR' ? 'ERROR' : 'OK' }] } }
    }
    throw new HttpError(404, 'HTTP 404')
  }
  return { get, urls }
}

const only = (cfg = CFG) => ({ ...cfg, candidates: [cfg.candidates[1]] })

describe('SonarCloud', () => {
  test('finds the analysis of the exact commit, paging past newer ones', async () => {
    const { get } = sonar()
    assert.equal((await findAnalysis('uk.gov.hmcts.reform:pcs-api-2', SHA.api2, get))?.key, 'a2')
    assert.equal(await findAnalysis('uk.gov.hmcts.reform:pcs-api-2', SHA.api1, get), null)
  })

  test('reads coverage, quality gate and security at that analysis', async () => {
    const items = await sonarReader(only(), sonar().get, NOW)()
    const api = items.filter((i) => i.repo === 'pcs-api')
    assert.deepEqual(api.map((i) => [i.rule, i.status, i.value]), [
      ['sonar-coverage', 'pass', '96.1%'],
      ['sonar-security', 'pass', '0 vulnerabilities, 0 security hotspots'],
      ['sonar-quality-gate', 'pass', 'passed'],
    ])
    assert.ok(api.every((i) => i.sha === SHA.api2 && i.candidate === 'V2' && i.fetchedAt === NOW().toISOString()))
  })

  test('fails coverage under the threshold, a failed gate and open vulnerabilities', async () => {
    const items = await sonarReader({ ...only(), coverage_threshold: 97 }, sonar({ gate: 'ERROR', vulns: '2' }).get, NOW)()
    const api = Object.fromEntries(items.filter((i) => i.repo === 'pcs-api').map((i) => [i.rule, i.status]))
    assert.deepEqual(api, { 'sonar-coverage': 'fail', 'sonar-quality-gate': 'fail', 'sonar-security': 'fail' })
  })

  test('a commit SonarCloud has no analysis of is unknown, not the nearest analysis', async () => {
    const items = await sonarReader(only(), sonar().get, NOW)()
    const fe = items.filter((i) => i.repo === 'pcs-frontend')
    assert.equal(fe.length, 3)
    assert.ok(fe.every((i) => i.status === 'unknown' && /no analysis of 5b8fb2e/.test(i.note!)))
  })

  test('an unreachable SonarCloud gives unknown rows with the reason', async () => {
    const items = await sonarReader(only(), async () => { throw new HttpError(503, 'HTTP 503') }, NOW)()
    assert.equal(items.length, 6)
    assert.ok(items.every((i) => i.status === 'unknown' && /could not be read: HTTP 503/.test(i.note!)))
  })
})
