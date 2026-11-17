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
import { loadLayout, loadRelease } from '../scripts/lib/qa/config.ts'
import { e2eReader } from '../scripts/lib/qa/sources/e2e.ts'
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
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'evidence.json'), JSON.stringify(ev))
    const judgement = join(out, 'judgement.json')
    writeFileSync(judgement, JSON.stringify({ '16': { status: 'Yes', comment: CANARY[2], links: [{ text: CANARY[1], url: CANARY[3] }] } }))

    const env = { ...process.env }
    delete env.QA_CACHE_DIR
    delete env.RUNNER_TEMP
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--config', config, '--evidence', '--judgement'], { encoding: 'utf8', env })
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

describe('the CLI, for a feature with E2E evidence from Cosmos and GitHub', () => {
  const feature = 'TEST-CANARY-FEATURE'
  const out = join('.cache/qa', feature)
  const fixtures = join('.cache/qa', 'fixtures-canary-feature')
  after(() => {
    for (const d of [out, fixtures]) rmSync(d, { recursive: true, force: true })
  })

  test('prints no build URL, stage name, commit or reason', async () => {
    mkdirSync(fixtures, { recursive: true })
    const config = join(fixtures, 'config.yaml')
    writeFileSync(config, [`feature: ${feature}`, 'active: false', 'layout: pcs-feature', 'epics: [HDPI-1]', 'repos:', '  pcs-frontend:',
      '    github: hmcts/pcs-frontend', '    cosmos_product: pcs', '    cosmos_component: frontend', '    e2e:',
      '      jenkins: { job: HMCTS_j_to_z/pcs-frontend, branch: PR-1 }', '      label: enable_x', "      tags: ['@x']", '  pcs-api:', '    github: hmcts/pcs-api',
      '    cosmos_product: pcs', '    cosmos_component: api', '    e2e:', '      jenkins: { job: HMCTS_j_to_z/pcs-api, branch: PR-2 }', "      tags: ['@x']", ''].join('\n'))
    const { cfg, layout } = loadRelease(config)
    const sha = CFG.candidates[0].shas['pcs-frontend']
    const head = CFG.candidates[0].shas['pcs-api']
    // pcs-frontend's build is in Cosmos, with a canary for a stage name and its URL; pcs-api's
    // isn't, so GitHub's status answers, with a canary for its target URL.
    const events = ['checkout', `functionalTest:${CANARY[1]}`].map((name, n) => ({ job_name: 'HMCTS_j_to_z/pcs-frontend/PR-1', branch_name: 'PR-1', build_number: '2',
      build_url: CANARY[3], current_step_name: name, current_build_current_result: 'SUCCESS', current_build_duration: n, git_commit: sha }))
    events.push({ ...events[0], current_step_name: 'Pipeline Failed', current_build_duration: 9 })
    const query = async (db: string, _c: string, _q: string, p: { name: string; value: unknown }[]) =>
      (db === 'jenkins' && p.some((x) => x.value === 'frontend') ? events : [])
    const api = async (path: string) => (path.endsWith('/pulls/2') ? { head: { sha: head } } : path.includes('/labels') ? [{ name: 'enable_x' }]
      : { statuses: [{ context: 'continuous-integration/jenkins/pr-head', state: 'failure', target_url: `${CANARY[3]}/job/PR-2/5/` }] })
    const tar = async () => {
      throw new Error(CANARY[2])
    }
    const items = await e2eReader(cfg, query, api, tar, NOW)()
    assert.ok(items.some((i) => i.value.includes(CANARY[1])) && items.some((i) => i.links.some((l) => l.url.startsWith(CANARY[3]))))
    const ev: Evidence = { release: feature, generatedAt: NOW().toISOString(), items: fileUnderRows(layout, items),
      candidates: [{ name: 'service-wide', shas: { 'pcs-frontend': sha, 'pcs-api': head } }] }
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'evidence.json'), JSON.stringify(ev))

    const env = { ...process.env }
    for (const k of ['QA_CACHE_DIR', 'RUNNER_TEMP', 'COSMOS_PIPELINE_METRICS_KEY']) delete env[k]
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--config', config, '--evidence'], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    const printed = r.stdout + r.stderr
    for (const c of CANARY) assert.ok(!printed.includes(c), `printed ${c}`)
    for (const s of [sha, head]) assert.ok(!printed.includes(s.slice(0, 7)), 'printed a commit')
    assert.doesNotMatch(printed, /https?:\/\/|functionalTest|PR-[12]/)
    assert.match(r.stdout, /^row 4   unknown \(no agent answer: keeps the published answer\)$/m)
    assert.match(r.stdout, /^23 rows: 0 pass, 0 fail, 23 unknown$/m)
    assert.ok(readFileSync(join(out, 'report.html'), 'utf8').includes(CANARY[3]), 'the report itself does carry the build link')
  })
})

describe('the CLI, with the agent\'s input and answers', () => {
  const feature = 'TEST-CANARY-AGENT'
  const out = join('.cache/qa', feature)
  const fixtures = join('.cache/qa', 'fixtures-canary-agent')
  after(() => {
    for (const d of [out, fixtures]) rmSync(d, { recursive: true, force: true })
  })
  const AGENT_CANARY = ['Canary agent comment about HDPI-99999', 'https://canary.internal.example/agent/evidence', 'canary-agent-link-text', 'canary-row-key',
    'Canary QA summary sentence', 'Canary risk wording', 'Canary Signer Name', 'Canary external dependency']
  // The name of the account twg runs as: collected into agent-input.json, never printed.
  const NAME = 'Canary Account Holder'

  test('collect-only and answers print only counts; the input, answers and rejections stay in the cache', () => {
    mkdirSync(fixtures, { recursive: true })
    const config = join(fixtures, 'config.yaml')
    writeFileSync(config, [`feature: ${feature}`, 'active: false', 'layout: pcs-feature', 'epics: [HDPI-1]', 'repos:', '  pcs-api: { github: hmcts/pcs-api }', ''].join('\n'))
    const { layout } = loadRelease(config)
    const sha = CFG.candidates[0].shas['pcs-api']
    const items = [
      fact({ rule: 'sonar-coverage', status: 'pass', value: `91.0% ${CANARY[0]}`, links: [{ text: CANARY[1], url: CANARY[3] }], repo: 'pcs-api', sha, candidate: 'service-wide' }),
      fact({ rule: 'high-defects', status: 'fail', value: CANARY[2], note: CANARY[1] }),
    ]
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'evidence.json'), JSON.stringify({ release: feature, generatedAt: NOW().toISOString(),
      candidates: [{ name: 'service-wide', shas: { 'pcs-api': sha } }], items: fileUnderRows(layout, items) }))
    writeFileSync(join(out, 'answers.json'), '{}')

    // A twg that answers only "who am I", with the canary name, so the collect step reads it without a real sign-in.
    const bin = resolve(fixtures, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'twg'), ['#!/bin/sh', 'if [ "$1 $2 $3" = "confluence space me" ]; then',
      `  echo '${JSON.stringify({ data: { currentUser: { displayName: NAME } } })}'`, '  exit 0', 'fi', 'exit 1', ''].join('\n'), { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    for (const k of ['QA_CACHE_DIR', 'RUNNER_TEMP', 'COSMOS_PIPELINE_METRICS_KEY']) delete env[k]
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--config', config, ...args], { encoding: 'utf8', env })
    const quiet = (r: ReturnType<typeof cli>) => {
      assert.equal(r.status, 0, r.stderr)
      const printed = r.stdout + r.stderr
      for (const c of [...CANARY, ...AGENT_CANARY, NAME, sha.slice(0, 7)]) assert.ok(!printed.includes(c), `printed ${c}`)
      assert.doesNotMatch(printed, /https?:\/\//)
      return r.stdout
    }

    const collected = quiet(cli('--evidence', '--collect-only'))
    assert.match(collected, /^agent input: 23 rows, 6 sections, the account name, 3 evidence items, the page could not be read$/m)
    assert.ok(!existsSync(join(out, 'answers.json')), 'an earlier answers.json is removed')
    const input = JSON.parse(readFileSync(join(out, 'agent-input.json'), 'utf8'))
    assert.equal(input.rows.length, 23)
    assert.equal(input.createdBy, NAME)
    assert.deepEqual(input.info.map((r: { key: string }) => r.key), ['Release Type', 'Test Environments', 'External Dependencies', 'External Risks'])
    assert.equal(input.sections.length, 6)
    assert.equal(input.rows[0].evidence[0].links[0].url, CANARY[3])
    assert.ok(!existsSync(join(out, 'report.html')), 'collect-only renders nothing')

    const link = [{ text: AGENT_CANARY[2], url: AGENT_CANARY[1] }]
    writeFileSync(join(out, 'answers.json'), JSON.stringify({
      '1': { answer: 'Yes', comment: AGENT_CANARY[0], links: link },
      '21': { answer: 'No', comment: AGENT_CANARY[0], links: link },
      '9': { answer: '', comment: AGENT_CANARY[0], links: [] },
      '13': { answer: 'N/A', comment: AGENT_CANARY[0], links: [{ text: AGENT_CANARY[2], url: 'http://canary.internal.example/insecure' }] },
      '2': { answer: 'Yes', comment: AGENT_CANARY[0] },
      [AGENT_CANARY[3]]: { answer: 'Yes', comment: AGENT_CANARY[0], links: link },
      sections: {
        info: { 'External Dependencies': { text: AGENT_CANARY[7], links: link } },
        qaSummary: AGENT_CANARY[4],
        recommendation: { approved: false, reason: AGENT_CANARY[0] },
        risks: [{ risk: AGENT_CANARY[5], mitigation: '', links: link }],
        signOff: Object.fromEntries(['QA Manager', 'TCOE QA lead', 'Product Owner', 'Delivery Manager', 'Technical Lead']
          .map((role, n) => [role, { name: n ? '' : AGENT_CANARY[6], status: n ? '' : '✅ Approved', links: [] }])),
        testingSummary: { 'Smoke Testing': 'To confirm' },
        [AGENT_CANARY[3]]: AGENT_CANARY[0],
      },
    }))
    // --answers alone reuses the evidence the answers were written against; it never collects afresh.
    const answered = quiet(cli('--answers'))
    assert.match(answered, /^evidence: 3 items from a file$/m)
    assert.match(answered, /^agent: 3 items, 1 pass, 1 fail, 1 unknown, 20 rows without an answer, 5 section answers \(5 rejected: see answers-rejected\.txt in the cache directory\)$/m)
    assert.match(answered, /^row 1   pass$/m)
    assert.match(answered, /^row 21  fail$/m)
    assert.match(answered, /^row 9   unknown$/m)
    assert.match(answered, /^row 2   unknown \(no agent answer: keeps the published answer\)$/m)
    const report = readFileSync(join(out, 'report.html'), 'utf8')
    assert.ok(report.includes(AGENT_CANARY[0]) && report.includes(AGENT_CANARY[1]), 'the report itself does carry the answers')
    for (const c of [NAME, ...AGENT_CANARY.slice(4)]) assert.ok(report.includes(c), `the report carries the sections and "Created by": ${c}`)
    assert.match(report, /❌ QA NOT APPROVED FOR RELEASE/)
    const rejected = readFileSync(join(out, 'answers-rejected.txt'), 'utf8')
    assert.ok(rejected.includes(AGENT_CANARY[3]))
    assert.match(rejected, /answers\.sections\.testingSummary\.Smoke Testing: must be/)

    for (const d of ['src', 'data', '_site', 'build', 'config', 'scripts', 'test'].filter((x) => existsSync(x))) {
      for (const f of files(d)) {
        const text = readFileSync(f, 'utf8')
        for (const c of [...AGENT_CANARY, NAME]) assert.ok(!text.includes(c) || f.endsWith('qa-public-safety.test.ts'), `${c} in ${f}`)
      }
    }
  })

  test('a malformed answers file counts as no answers: the report still renders, saying only that', () => {
    writeFileSync(join(out, 'answers.json'), `{ "1": ${JSON.stringify(AGENT_CANARY[0])} `)
    rmSync(join(out, 'report.html'), { force: true })
    const env = { ...process.env }
    for (const k of ['QA_CACHE_DIR', 'RUNNER_TEMP']) delete env[k]
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--config', join(fixtures, 'config.yaml'), '--evidence', '--answers'], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!(r.stdout + r.stderr).includes(AGENT_CANARY[0]))
    assert.match(r.stdout, /^agent: answers\.json could not be read, so 0 answers were taken and every agent row keeps the published answer$/m)
    assert.match(r.stdout, /^row 1   unknown \(no agent answer: keeps the published answer\)$/m)
    assert.match(r.stdout, /^23 rows: 0 pass, 0 fail, 23 unknown$/m)
    assert.ok(existsSync(join(out, 'report.html')))
    assert.match(readFileSync(join(out, 'answers-rejected.txt'), 'utf8'), /not valid JSON/)
    assert.match(readFileSync(join('.cache/qa', 'errors.log'), 'utf8'), new RegExp(`${feature} answers-invalid`))
  })

  test('--collect-only takes no publishing or answers', () => {
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/qa-report.ts', '--all-active', '--collect-only', '--publish'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /^--collect-only can't be combined with --publish$/m)
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
  const dir = join(cache, 'TEST-ERR')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ release: 'TEST-ERR', generatedAt: NOW().toISOString(), candidates: [{ name: 'V1', shas: { 'pcs-api': sha } }], items: [] }))

  test('print only the kind of failure; the error itself, canary and all, goes to errors.log', () => {
    writeFileSync(join(dir, 'judgement.yaml'), JSON.stringify({ '16': { status: 'Yes', comment: 'x', [CANARY[1]]: CANARY[2] } }))
    const r = cli('--config', config, '--evidence', '--judgement')
    rmSync(join(dir, 'judgement.yaml'))
    assert.equal(r.status, 1)
    const printed = r.stdout + r.stderr
    for (const c of CANARY) assert.ok(!printed.includes(c), `printed ${c}`)
    assert.match(r.stderr, /^qa-report failed: the judgement file is not valid: see errors\.log in the cache directory$/m)
    assert.ok(readFileSync(join(cache, 'errors.log'), 'utf8').includes(CANARY[1]))
  })

  test('refuse evidence for other candidate commits', () => {
    const otherConfig = join(cache, 'other.yaml')
    writeFileSync(otherConfig, readFileSync(config, 'utf8').replace('TEST-ERR', 'TEST-OTHER'))
    mkdirSync(join(cache, 'TEST-OTHER'), { recursive: true })
    writeFileSync(join(cache, 'TEST-OTHER', 'evidence.json'), JSON.stringify({ release: 'TEST-OTHER', candidates: [{ name: 'V1', shas: { 'pcs-api': CFG.candidates[1].shas['pcs-api'] } }], items: [] }))
    const r = cli('--config', otherConfig, '--evidence')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /the evidence file is for another release or feature, or other commits/)
  })

  test('refuse release names and files outside the places they belong', () => {
    for (const args of [['--release', '../../etc/passwd'], ['--release', 'R1..3'], ['--config', 'src/_data/raid.yaml'],
      ['--release', 'R1.3A', '--create-under=-y']]) {
      const r = cli(...args)
      assert.equal(r.status, 1, args.join(' '))
      assert.ok(!(r.stdout + r.stderr).includes('passwd') && !(r.stdout + r.stderr).includes('hostname'), args.join(' '))
      assert.match(r.stderr, /^qa-report failed: (a command-line argument is not valid|a file given is outside)/m, args.join(' '))
    }
  })

  test('a malformed command line prints the usage, not the arguments', () => {
    for (const args of [['--release', 'R1.3A', '--canary-secret-test-name'], ['--release', 'R1.3A', '--evidence=canary-secret-test-name']]) {
      const r = cli(...args)
      assert.equal(r.status, 2)
      assert.ok(!r.stderr.includes(CANARY[1]))
      assert.match(r.stderr, /^usage: /m)
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
