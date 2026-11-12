// The QA report's evidence is internal and this repo and its site are public. These tests run
// the CLI on evidence full of distinctive strings and check they end up only in the gitignored
// cache: never in its output, and never anywhere that is committed or published.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheDir } from '../scripts/lib/qa/cache.ts'
import { fileUnderRows } from '../scripts/lib/qa/collect.ts'
import { loadLayout } from '../scripts/lib/qa/config.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { CFG, fact, NOW } from './qa-helpers.ts'

const CANARY = ['CANARY-CVE-2099-0001', 'canary-secret-test-name', 'Canary ticket summary', 'https://canary.internal.example/build/1']

describe('where evidence may be written', () => {
  test('.cache/qa by default, $RUNNER_TEMP in CI, or anywhere outside the repo', () => {
    const root = process.cwd()
    assert.equal(cacheDir({}, root), resolve(root, '.cache/qa'))
    assert.equal(cacheDir({ RUNNER_TEMP: '/tmp/runner' }, root), '/tmp/runner/qa')
    assert.equal(cacheDir({ QA_CACHE_DIR: '/tmp/elsewhere' }, root), '/tmp/elsewhere')
  })

  test('never in the repo outside .cache/', () => {
    for (const d of ['src/_data', '_site', 'data/snapshots', 'build', 'config', '.', 'scripts/lib']) {
      assert.throws(() => cacheDir({ QA_CACHE_DIR: d }), /must not be written inside the repo/, d)
    }
  })

  test('.cache/ is gitignored', (t) => {
    const r = spawnSync('git', ['check-ignore', '-q', '.cache/qa/R1.3A/evidence.json'])
    if (r.error) return t.skip('git is not available')
    assert.equal(r.status, 0)
  })
})

describe('the CLI', () => {
  const release = 'TEST-CANARY'
  const out = join('.cache/qa', release)
  const fixtures = join('.cache/qa', 'fixtures-canary')
  after(() => {
    for (const d of [out, fixtures]) rmSync(d, { recursive: true, force: true })
  })

  test('prints only counts and statuses, and keeps evidence out of committed and published paths', () => {
    mkdirSync(fixtures, { recursive: true })
    const config = join(fixtures, 'config.yaml')
    writeFileSync(config, [`release: ${release}`, 'active: false', 'layout: pcs', `jql: project = HDPI`, 'candidates:', '  - name: V1', '    shas:',
      `      pcs-api: ${CFG.candidates[0].shas['pcs-api']}`, 'repos:', '  pcs-api: { github: hmcts/pcs-api }', ''].join('\n'))
    const layout = loadLayout('pcs')
    const items = [
      fact({ rule: 'dependency-check', status: 'fail', value: `1 open: ${CANARY[0]}`, links: [{ text: CANARY[1], url: CANARY[3] }], repo: 'pcs-api', candidate: 'V1' }),
      fact({ rule: 'test-complete', status: 'fail', value: CANARY[2], note: CANARY[1] }),
      fact({ rule: 'outstanding-bugs', status: 'pass', value: CANARY[2] }),
    ]
    const ev: Evidence = { release, generatedAt: NOW().toISOString(), candidates: CFG.candidates.slice(0, 1), items: fileUnderRows(layout, items) }
    const evFile = join(fixtures, 'evidence.json')
    writeFileSync(evFile, JSON.stringify(ev))
    const judgement = join(fixtures, 'judgement.json')
    writeFileSync(judgement, JSON.stringify({ '16': { status: 'Yes', comment: CANARY[2], links: [{ text: CANARY[1], url: CANARY[3] }] } }))

    const env = { ...process.env }
    delete env.QA_CACHE_DIR
    delete env.RUNNER_TEMP
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--config', config, '--evidence', evFile, '--judgement', judgement], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    const printed = r.stdout + r.stderr
    for (const c of CANARY) assert.ok(!printed.includes(c), `printed ${c}`)
    assert.doesNotMatch(printed, /https?:\/\//)
    assert.match(r.stdout, /^row 12  fail$/m)
    assert.match(r.stdout, /^23 rows: /m)
    assert.match(r.stdout, /^row 16  unknown \(judgement given\)$/m)

    const report = readFileSync(join(out, 'report.html'), 'utf8')
    assert.ok(report.includes(CANARY[0]), 'the report itself does carry the evidence')
    assert.equal(spawnSync('git', ['check-ignore', '-q', join(out, 'report.html')]).status ?? 0, 0)

    const published = ['src', 'data', '_site', 'build', 'config', 'scripts', 'test'].filter((d) => existsSync(d))
    for (const d of published) {
      for (const f of files(d)) {
        const text = readFileSync(f, 'utf8')
        for (const c of CANARY) assert.ok(!text.includes(c) || f.endsWith('qa-public-safety.test.ts'), `${c} in ${f}`)
      }
    }
  })
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'node_modules') return []
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}
