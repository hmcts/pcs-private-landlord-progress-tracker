// A row's verdict covers only the repos that have an item in it, so every per-repo source must
// answer each of its rules for every repo of every candidate, if only with unknown.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReleaseConfig } from '../scripts/lib/qa/config.ts'
import { cosmosReader, STAGE_RULES } from '../scripts/lib/qa/sources/cosmos.ts'
import type { Item } from '../scripts/lib/qa/sources/common.ts'
import { CHECK_RULES, githubReader } from '../scripts/lib/qa/sources/github.ts'
import { SONAR_RULES, sonarReader } from '../scripts/lib/qa/sources/sonar.ts'
import { CFG, NOW, SHA } from './qa-helpers.ts'

// pcs-frontend has no Sonar or Cosmos settings, and V2 changes only pcs-api.
const cfg: ReleaseConfig = {
  ...CFG,
  candidates: [CFG.candidates[0], { name: 'V2', shas: { 'pcs-api': SHA.api2 } }],
  repos: { 'pcs-api': CFG.repos['pcs-api'], 'pcs-frontend': { github: 'hmcts/pcs-frontend' } },
}

function covered(items: Item[], rules: (repo: string) => string[]) {
  for (const c of cfg.candidates) {
    for (const repo of Object.keys(c.shas)) {
      for (const rule of rules(repo)) {
        assert.ok(items.some((i) => i.candidate === c.name && i.repo === repo && i.rule === rule), `${c.name} ${repo} ${rule}`)
      }
    }
  }
}

const fail = async () => {
  throw Object.assign(new Error('forbidden'), { status: 403 })
}

describe('every repo of every candidate is answered', () => {
  test('SonarCloud, with no figures, no project, or no access', async () => {
    const empty = async (url: string) => (url.includes('project_analyses') ? { paging: { total: 2, pageSize: 500 },
      analyses: [{ key: 'a1', date: '2026-09-10T10:00:00+0000', revision: SHA.api1 }, { key: 'a2', date: '2026-09-18T10:00:00+0000', revision: SHA.api2 }] }
      : url.includes('search_history') ? { measures: [{ metric: 'coverage', history: [] }] } : { projectStatus: { status: 'OK' } })
    for (const get of [empty, fail]) covered(await sonarReader(cfg, get, NOW)(), () => SONAR_RULES)
  })

  test('Cosmos, with no builds, no settings, or no access', async () => {
    const rules = (repo: string) => [...Object.keys(STAGE_RULES), ...(repo === 'pcs-api' ? ['dependency-check'] : ['dependency-check', 'yarn-audit'])]
    for (const query of [async () => [], fail]) covered(await cosmosReader(cfg, query, NOW)(), rules)
  })

  test('GitHub, with no checks, or no access', async () => {
    const rules = () => [...Object.keys(CHECK_RULES), 'ignored-tests']
    covered(await githubReader(cfg, async () => ({ total_count: 0, check_runs: [] }), fail, NOW)(), rules)
    covered(await githubReader(cfg, fail, fail, NOW)(), rules)
  })
})
