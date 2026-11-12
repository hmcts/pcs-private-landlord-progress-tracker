// The QA report's evidence is internal and this repo and its site are public. These tests run
// the CLI on evidence full of distinctive strings and check they end up only in the gitignored
// cache: never in its output, and never anywhere that is committed or published.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    const ev: Evidence = { release, generatedAt: NOW().toISOString(), candidates: [{ name: 'V1', shas: { 'pcs-api': CFG.candidates[0].shas['pcs-api'] } }], items: fileUnderRows(layout, items) }
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

describe('CLI failures', () => {
  const cache = mkdtempSync(join(tmpdir(), 'qa-cli-'))
  after(() => rmSync(cache, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { ...process.env, QA_CACHE_DIR: cache }
  delete env.RUNNER_TEMP
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', ...args], { encoding: 'utf8', env })
  const sha = CFG.candidates[0].shas['pcs-api']
  const config = join(cache, 'config.yaml')
  writeFileSync(config, ['release: TEST-ERR', 'active: false', 'layout: pcs', 'jql: project = HDPI', 'candidates:', '  - name: V1', '    shas:',
    `      pcs-api: ${sha}`, 'repos:', '  pcs-api: { github: hmcts/pcs-api }', ''].join('\n'))
  const evFile = join(cache, 'evidence.json')
  writeFileSync(evFile, JSON.stringify({ release: 'TEST-ERR', generatedAt: NOW().toISOString(), candidates: [{ name: 'V1', shas: { 'pcs-api': sha } }], items: [] }))

  test('print only the kind of failure; the error itself, canary and all, goes to errors.log', () => {
    const judgement = join(cache, 'judgement.json')
    writeFileSync(judgement, JSON.stringify({ '16': { status: 'Yes', comment: 'x', [CANARY[1]]: CANARY[2] } }))
    const r = cli('--config', config, '--evidence', evFile, '--judgement', judgement)
    assert.equal(r.status, 1)
    const printed = r.stdout + r.stderr
    for (const c of CANARY) assert.ok(!printed.includes(c), `printed ${c}`)
    assert.match(r.stderr, /^qa-report failed: the judgement file is not valid: see errors\.log in the cache directory$/m)
    assert.ok(readFileSync(join(cache, 'errors.log'), 'utf8').includes(CANARY[1]))
  })

  test('refuse evidence for other candidate commits', () => {
    const other = join(cache, 'other.json')
    writeFileSync(other, JSON.stringify({ release: 'TEST-ERR', candidates: [{ name: 'V1', shas: { 'pcs-api': CFG.candidates[1].shas['pcs-api'] } }], items: [] }))
    const r = cli('--config', config, '--evidence', other)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /the evidence file is for another release or other candidate commits/)
  })

  test('refuse release names and files outside the places they belong', () => {
    for (const args of [['--release', '../../etc/passwd'], ['--release', 'R1..3'], ['--config', 'src/_data/raid.yaml'],
      ['--config', config, '--evidence', 'package.json'], ['--config', config, '--judgement', '/etc/hostname'], ['--release', 'R1.3A', '--create-under=-y']]) {
      const r = cli(...args)
      assert.equal(r.status, 1, args.join(' '))
      assert.ok(!(r.stdout + r.stderr).includes('passwd') && !(r.stdout + r.stderr).includes('hostname'), args.join(' '))
      assert.match(r.stderr, /^qa-report failed: (a command-line argument is not valid|a file given is outside)/m, args.join(' '))
    }
  })

  test('a malformed command line prints the usage, not the arguments', () => {
    const r = cli('--release', 'R1.3A', '--evidence', '--canary-secret-test-name')
    assert.equal(r.status, 2)
    assert.ok(!r.stderr.includes(CANARY[1]))
    assert.match(r.stderr, /^usage: /m)
  })
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'node_modules') return []
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}
