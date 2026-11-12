import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileUnderRows } from '../scripts/lib/qa/collect.ts'
import { loadRelease } from '../scripts/lib/qa/config.ts'
import { find, parse, rowsOf, cellsOf, shortHash, tableAfterHeading, textOf } from '../scripts/lib/qa/html.ts'
import { cellText, evaluate, genRows, MARKER, renderPage } from '../scripts/lib/qa/render.ts'
import type { Item } from '../scripts/lib/qa/sources/common.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { fact, NOW } from './qa-helpers.ts'

const { cfg, layout } = loadRelease('config/qa-readiness/R1.3A.yaml')

// Page 311427238's checklist as published: number, question and the answer given.
const GOLDEN: [string, string, string][] = [
  ['1', 'Is unit test coverage greater than 80% for all services?', 'Yes'],
  ['2', 'Have all SonarCloud Quality Gates passed?', 'Yes'],
  ['3', 'Have all Integration and Contract Tests passed?', 'Yes'],
  ['4', 'Have all Functional Automation Tests passed?', 'Yes'],
  ['5', 'Have all Cross Browser Tests passed?', 'Yes'],
  ['6', 'Have all Performance Tests passed?', 'Yes'],
  ['7', 'Was any additional Performance Testing required?', 'Yes'],
  ['8', 'Has Security Testing been completed?', 'Yes'],
  ['9', 'Was any additional Manual Accessibility Testing required?', 'No'],
  ['10', 'Has Yarn Audit reported any vulnerabilities?', 'No'],
  ['11', 'Have SonarJava / Static Analysis checks reported any vulnerabilities?', 'Yes'],
  ['12', 'Has Dependency Checker reported any vulnerabilities?', 'Yes'],
  ['13', 'Has OWASP ZAP Scanner reported any High or Medium vulnerabilities?', 'N/A'],
  ['14', 'Has the Release Candidate been deployed to AAT/SIT?', 'Yes'],
  ['15', 'Are any Automation Tests ignored, removed or pending?', 'Yes'],
  ['16', 'Has the Manual Regression Test Suite passed successfully?', 'Yes'],
  ['17', 'Have dependent services completed validation?', 'Yes'],
  ['18', 'Was formal Business Acceptance Testing (BAT) required?', 'Yes'],
  ['19', 'Has the Product Owner signed off the stories?', 'Yes'],
  ['20', 'Have Test Complete comments been added to all Stories and Defects?', 'Yes'],
  ['21', 'Have all Critical and High Priority defects been resolved?', 'Yes'],
  ['22', 'Have remaining defects been triaged and prioritised?', 'Yes'],
  ['23', 'Has testing been completed using representative Production-like environments?', 'Yes'],
]

/** Evidence matching what the R1.3A page reports, for both candidates and both repos. */
function goldenEvidence(): Evidence {
  const items: Item[] = []
  for (const c of cfg.candidates) {
    for (const [repo, sha] of Object.entries(c.shas)) {
      const at = { repo, sha, candidate: c.name }
      const api = repo === 'pcs-api'
      items.push(
        fact({ ...at, rule: 'sonar-coverage', status: 'pass', value: api ? '96.0%' : '94.1%', source: 'sonarcloud' }),
        fact({ ...at, rule: 'sonar-quality-gate', status: 'pass', value: 'passed', source: 'sonarcloud' }),
        fact({ ...at, rule: 'sonar-security', status: api ? 'pass' : 'fail', value: api ? '0 vulnerabilities' : '1 vulnerability', source: 'sonarcloud' }),
        fact({ ...at, rule: 'integration-contract', status: 'unknown', value: 'not checked', note: 'access denied (403)', source: 'cosmos' }),
        fact({ ...at, rule: 'integration-contract', status: 'pass', value: 'Pact Consumer Verification: success', source: 'github' }),
        fact({ ...at, rule: 'functional', status: 'pass', value: 'Functional Test - aat: success', source: 'github' }),
        fact({ ...at, rule: 'deployed-aat', status: 'pass', value: 'Smoke Test - AKS aat: success', source: 'github' }),
        fact({ ...at, rule: 'ignored-tests', status: 'fail', answer: 'Yes', value: '3 ignored', source: 'github' }),
        api ? fact({ ...at, rule: 'dependency-check', status: 'pass', answer: 'Yes', value: '0 open, 32 suppressed', source: 'cosmos' })
          : fact({ ...at, rule: 'yarn-audit', status: 'pass', answer: 'No', value: '0 open, 0 suppressed', source: 'cosmos' }),
      )
    }
  }
  items.push(
    fact({ rule: 'outstanding-bugs', status: 'pass', value: 'Critical – 0, High – 0, Medium – 0, Low – 0', source: 'jira' }),
    fact({ rule: 'high-defects', status: 'pass', value: 'no Critical or High bugs open', source: 'jira' }),
    fact({ rule: 'test-complete', status: 'pass', value: '157 of 157', source: 'jira' }),
    fact({ rule: 'perf-signoff', status: 'unknown', value: 'not signed by Perf Test yet', source: 'ria' }),
    fact({ rule: 'perf-required', status: 'pass', answer: 'Yes', value: 'required', source: 'ria' }),
    fact({ rule: 'security-signoff', status: 'pass', value: 'Signed by Sec Ops', source: 'ria' }),
    ...['6', '16', '17'].map((row) => fact({ rule: 'human', status: 'pass', value: 'Closed', source: 'jira', data: { row } })),
  )
  return { release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) }
}

describe('render', () => {
  test('reproduces the R1.3A checklist: same questions, same order, and its answers on the mechanical rows', () => {
    const res = evaluate(cfg, layout, goldenEvidence())
    assert.deepEqual(res.checklist.map((r) => [r.key, r.label]), GOLDEN.map(([k, q]) => [k, q]))
    for (const [key, , answer] of GOLDEN) {
      const r = res.checklist.find((x) => x.key === key)!
      // Row 6: the page says Yes, and its ticket is closed, but the RIA has no Perf Test sign-off.
      if ((r.needsJudgement && !cfg.human_rows?.[key]) || key === '6') assert.equal(r.answer, 'To confirm', `row ${key}`)
      else assert.equal(r.answer, answer, `row ${key}`)
    }
  })

  test('renders the Release Information and checklist tables in the page layout', () => {
    const res = evaluate(cfg, layout, goldenEvidence())
    const root = parse(renderPage(cfg, layout, res))
    const info = rowsOf(tableAfterHeading(root, /^Release Information$/)!).map((tr) => textOf(cellsOf(tr)[0]))
    assert.deepEqual(info, ['Item', 'Release', 'Release Type', 'Jira Board', 'Jira Tickets', 'Test Environments', 'External Dependencies',
      'External Risks', 'Outstanding Bugs', 'GIT', 'GIT Revision'])
    const rows = rowsOf(tableAfterHeading(root, /^QA Readiness Checklist$/)!)
    assert.deepEqual(cellsOf(rows[0]).map(textOf), ['No', 'Question', 'Status', 'Comments / Evidence'])
    assert.equal(rows.length, 24)
    const revision = rowsOf(tableAfterHeading(root, /^Release Information$/)!).at(-1)!
    assert.match(textOf(revision), /V1: pcs-api = e11f333 · pcs-frontend = a25f612 V2: pcs-api = a8606ea · pcs-frontend = 5b8fb2e/)
  })

  test('every generated cell carries a marker whose hash is its own text', () => {
    const rows = genRows(layout, evaluate(cfg, layout, goldenEvidence()))
    const owned = rows.flatMap((r) => r.cells.filter((c) => c.name).map((c) => ({ r, c })))
    assert.equal(owned.length, 23 * 2 + 5)
    for (const { r, c } of owned) {
      const [a] = find(parse(c.html), (e) => e.attrs['data-extension-key'] === 'anchor')
      const name = JSON.parse(a.attrs['data-parameters']).macroParams[''].value
      const m = MARKER.exec(name)!
      assert.equal(m[2], c.name)
      assert.equal(m[1], r.table === 'info' ? `info-${r.key.toLowerCase().replace(/ /g, '-')}` : r.key)
      assert.equal(m[3], shortHash(cellText(c.html)))
    }
  })

  test('the last candidate decides the status; earlier ones are listed', () => {
    const ev = goldenEvidence()
    ev.items = ev.items.map((i) => (i.row === '4' && i.candidate === 'V1' ? { ...i, status: 'fail' as const, value: 'nightly: failure' } : i))
    const r = evaluate(cfg, layout, ev).checklist.find((x) => x.key === '4')!
    assert.equal(r.status, 'pass')
    assert.ok(r.lines.some((l) => /^V1 — pcs-api e11f333: nightly: failure/.test(l.text)))
    assert.ok(r.lines.findIndex((l) => l.text.startsWith('V1')) < r.lines.findIndex((l) => l.text.startsWith('V2')))
  })

  test('a repo the last candidate leaves out is judged on its own latest candidate', () => {
    const partial = { ...cfg, candidates: [cfg.candidates[0], { name: 'V2', shas: { 'pcs-frontend': cfg.candidates[1].shas['pcs-frontend'] } }] }
    const ev = goldenEvidence()
    ev.items = ev.items.filter((i) => !(i.candidate === 'V2' && i.repo === 'pcs-api'))
      .map((i) => (i.row === '4' && i.candidate === 'V1' && i.repo === 'pcs-api' ? { ...i, status: 'fail' as const, value: 'nightly: failure' } : i))
    const res = evaluate(partial, layout, ev).checklist
    assert.deepEqual([res.find((x) => x.key === '4')!.status, res.find((x) => x.key === '4')!.answer], ['fail', 'No'])
    const sonar = evaluate(partial, layout, { ...ev, items: ev.items.map((i) => (i.row === '1' && i.candidate === 'V1' && i.repo === 'pcs-api' ? { ...i, status: 'unknown' as const } : i)) })
    assert.equal(sonar.checklist.find((x) => x.key === '1')!.status, 'unknown')
  })

  test('a done human_rows ticket never hides a mechanical check that could not be made', () => {
    const ev = goldenEvidence()
    const six = (e: Evidence) => evaluate(cfg, layout, e).checklist.find((x) => x.key === '6')!
    assert.deepEqual([six(ev).status, six(ev).answer], ['unknown', 'To confirm'])
    ev.items = ev.items.map((i) => (i.rule === 'perf-signoff' ? { ...i, status: 'pass' as const } : i))
    assert.deepEqual([six(ev).status, six(ev).answer], ['pass', 'Yes'])
  })

  test('an unknown is To confirm, with its reason, and never a guess', () => {
    const ev = goldenEvidence()
    ev.items = ev.items.filter((i) => !(i.row === '3' && i.source === 'github' && i.candidate === 'V2' && i.repo === 'pcs-frontend'))
    const r = evaluate(cfg, layout, ev).checklist.find((x) => x.key === '3')!
    assert.deepEqual([r.status, r.answer], ['unknown', 'To confirm'])
    assert.ok(r.lines.some((l) => l.text === 'V2 — pcs-frontend 5b8fb2e: not checked: access denied (403).'))
  })

  test('rows nobody can answer ask for a person', () => {
    const r = evaluate(cfg, layout, goldenEvidence()).checklist.find((x) => x.key === '19')!
    assert.ok(r.needsJudgement)
    assert.equal(r.lines[0].text, 'Needs a person to confirm: nothing records this automatically.')
  })
})
