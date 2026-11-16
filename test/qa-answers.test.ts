// The QA agent's rows: the layout's agent fields, its answers.json, how an answer decides a row,
// and what the agent is given.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentInput, answerItems, LIMITS, loadAnswers, validateAnswer, validateAnswers } from '../scripts/lib/qa/answers.ts'
import { fileUnderRows, SERVICE_WIDE } from '../scripts/lib/qa/collect.ts'
import { loadLayout, loadRelease, type ReleaseConfig, validateLayout, validateRelease } from '../scripts/lib/qa/config.ts'
import { merge, publishedRows } from '../scripts/lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from '../scripts/lib/qa/render.ts'
import type { Item } from '../scripts/lib/qa/sources/common.ts'
import type { Evidence } from '../scripts/lib/qa/types.ts'
import { fact, NOW, SHA, withIds } from './qa-helpers.ts'

const { cfg: loaded, layout } = loadRelease('config/qa-readiness/private-landlord-make-a-claim.yaml')
const cfg: ReleaseConfig = { ...loaded, candidates: [{ name: SERVICE_WIDE, shas: { 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe2 } }] }
const release = loadLayout('pcs')
const dir = mkdtempSync(join(tmpdir(), 'qa-answers-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const link = { text: 'pcs-api on SonarCloud', url: 'https://sonarcloud.io/summary/overall?id=x' }
const ev = (items: Item[]): Evidence => ({ release: cfg.release, generatedAt: NOW().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) })
const coverage = fact({ rule: 'sonar-coverage', status: 'fail', value: '61.0%', repo: 'pcs-api', sha: SHA.api2, candidate: SERVICE_WIDE, links: [link] })
const answered = (answers: Record<string, unknown>, extra: Item[] = []) => ev([...extra, ...answerItems(validateAnswers(answers, layout).answers, layout, NOW)])
const row = (e: Evidence, key: string) => evaluate(cfg, layout, e).checklist.find((r) => r.key === key)!

describe('the feature layout', () => {
  test('asks the R1.3A questions, in order, all of them the agent\'s, with the release\'s good answers', () => {
    assert.deepEqual(layout.checklist.rows.map((r) => [r.key, r.question, r.good]), release.checklist.rows.map((r) => [r.key, r.question, r.good]))
    assert.ok(layout.checklist.rows.every((r) => r.rule === 'agent' && r.guide))
    assert.deepEqual(layout.checklist.rows.find((r) => r.key === '15')!.evidence, ['ignored-tests', 'ignored-tests-feature'])
    assert.deepEqual(layout.info!.rows.map((r) => r.key), ['Feature', 'Release Type', 'Epics', 'Test Environments', 'External Dependencies',
      'External Risks', 'Outstanding Bugs', 'GIT', 'GIT Revision'])
  })

  test('evidence and guide are for agent rows only, and name rules the readers answer', () => {
    const doc = (r: Record<string, unknown>) => ({ title: 't', checklist: { heading: 'h', columns: ['No', 'Q'], rows: [{ key: '1', question: 'q', ...r }] } })
    assert.deepEqual(validateLayout(doc({ rule: 'agent', evidence: ['sonar-coverage', 'e2e-build'], guide: 'Yes if.' })), [])
    assert.match(validateLayout(doc({ rule: 'sonar-coverage', evidence: ['functional'], guide: 'x' })).join('\n'), /"evidence" is only for rule agent[\s\S]*"guide" is only for rule agent/)
    for (const evidence of [['human'], ['agent'], ['release'], 'functional', ['functional', 'functional']]) {
      assert.match(validateLayout(doc({ rule: 'agent', evidence })).join('\n'), /"evidence" must list distinct rules/, JSON.stringify(evidence))
    }
    assert.match(validateLayout(doc({ rule: 'agent', guide: 'x'.repeat(601) })).join('\n'), /"guide" must be text of at most 600/)
  })

  test('a release can\'t take evidence only a feature answers', () => {
    const { cfg: r } = loadRelease('config/qa-readiness/R1.3A.yaml')
    const custom = { ...release, checklist: { ...release.checklist, rows: [{ key: '1', rule: 'agent', question: 'q', evidence: ['e2e-feature'] }] } }
    assert.match(validateRelease({ ...r, kind: undefined }, 'r', custom).join('\n'), /row 1 uses rule e2e-feature, which a release config can't answer/)
  })

  test('evidence rules file items under the agent rows that ask for them, as well as the rows of their own rule', () => {
    const filed = fileUnderRows(layout, [fact({ rule: 'deployed-aat', status: 'pass' }), fact({ rule: 'outstanding-bugs', status: 'pass' })])
    assert.deepEqual(filed.map((i) => i.row), ['14', '23', 'info:Outstanding Bugs', '22'])
    assert.deepEqual(fileUnderRows(release, [fact({ rule: 'agent', status: 'pass', data: { row: '5' } })]), [], 'an answer goes to agent rows only')
  })
})

describe('answers.json', () => {
  test('takes Yes, No, N/A or To confirm, a comment, and https links; Yes and No need one', () => {
    assert.deepEqual(validateAnswer({ answer: 'Yes', comment: 'c', links: [link] }, 'a'), [])
    assert.deepEqual(validateAnswer({ answer: 'To confirm', comment: 'No record of a run.' }, 'a'), [])
    assert.deepEqual(validateAnswer({ answer: 'N/A', comment: 'No RIA.', links: [] }, 'a'), [])
    const bad = (a: unknown) => validateAnswer(a, 'a').join('\n')
    assert.match(bad({ answer: 'Maybe', comment: 'c', links: [link] }), /"answer" must be Yes, No, N\/A or To confirm/)
    assert.match(bad({ answer: 'No', comment: 'c' }), /must cite at least one link/)
    assert.match(bad({ answer: 'Yes', comment: ' ', links: [link] }), /"comment" must be 1 to 1500/)
    assert.match(bad({ answer: 'Yes', comment: 'x'.repeat(LIMITS.comment + 1), links: [link] }), /"comment" must be 1 to 1500/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [{ text: 'x', url: 'http://insecure' }] }), /"url" must be an https URL/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [{ text: 'x', url: 'https://a b' }] }), /"url" must be an https URL/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [{ text: 'x', url: `https://${'a'.repeat(LIMITS.url)}` }] }), /"url" must be an https URL/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [{ text: '', url: link.url }] }), /"text" must be 1 to 200/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [{ ...link, title: 'x' }] }), /expected \{ text, url \}/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: Array(LIMITS.links + 1).fill(link) }), /at most 12 links/)
    assert.match(bad({ answer: 'Yes', comment: 'c', links: [link], status: 'Yes' }), /unknown field "status"/)
    assert.match(bad('Yes'), /expected \{ answer, comment, links \}/)
  })

  test('leaves out each bad answer on its own, and any for a row that is not the agent\'s', () => {
    const res = validateAnswers({ '1': { answer: 'Yes', comment: 'c', links: [link] }, '2': { answer: 'Yes', comment: 'c' }, '99': { answer: 'N/A', comment: 'c' },
      __proto__: { answer: 'N/A', comment: 'c' } }, layout)
    assert.deepEqual(Object.keys(res.answers), ['1'])
    assert.equal(res.rejected, 2)
    assert.throws(() => validateAnswers([], layout), /expected a mapping/)
  })

  test('is read from the cache directory by its fixed name, with rejections written beside it', () => {
    assert.deepEqual(loadAnswers(dir, layout), { found: false, answers: {}, rejected: 0 })
    writeFileSync(join(dir, 'answers.json'), JSON.stringify({ '1': { answer: 'No', comment: 'Coverage is 61%.', links: [link] }, '2': { answer: 'Yes' } }))
    const res = loadAnswers(dir, layout)
    assert.deepEqual([res.found, Object.keys(res.answers), res.rejected], [true, ['1'], 1])
    assert.match(readFileSync(join(dir, 'answers-rejected.txt'), 'utf8'), /answers\.2: "comment"/)
    writeFileSync(join(dir, 'answers.json'), '{}')
    loadAnswers(dir, layout)
    assert.ok(!existsSync(join(dir, 'answers-rejected.txt')), 'a clean read removes the old rejections')
    writeFileSync(join(dir, 'answers.json'), '{ "1": ')
    assert.throws(() => loadAnswers(dir, layout), /not valid JSON/)
    writeFileSync(join(dir, 'answers.json'), `"${'x'.repeat(LIMITS.file)}"`)
    assert.throws(() => loadAnswers(dir, layout), /is over/)
  })
})

describe('an agent row', () => {
  test('is decided by the answer alone, mapped through the row\'s good answer', () => {
    const e = answered({ '1': { answer: 'Yes', comment: 'Coverage is 91%.\n\nBoth repos.', links: [link] }, '10': { answer: 'Yes', comment: '2 open.', links: [link] },
      '13': { answer: 'N/A', comment: 'No ZAP run is recorded.' }, '5': { answer: 'To confirm', comment: 'No cross-browser run found.' } }, [coverage])
    const r1 = row(e, '1')
    assert.deepEqual([r1.status, r1.answer, r1.keep, r1.needsJudgement], ['pass', 'Yes', false, false], 'a failing mechanical check is not worst-of\'d in')
    assert.deepEqual(r1.lines, [{ text: 'Coverage is 91%.', links: [] }, { text: 'Both repos.', links: [] }, { text: '', links: [link] }])
    assert.deepEqual([row(e, '10').status, row(e, '10').answer], ['fail', 'Yes'], 'row 10 is good when No')
    assert.deepEqual([row(e, '13').status, row(e, '13').answer], ['pass', 'N/A'])
    assert.deepEqual([row(e, '5').status, row(e, '5').answer, row(e, '5').keep], ['unknown', 'To confirm', false], 'To confirm is an answer, written')
  })

  test('with no answer keeps what the page says, and shows the evidence if the row is added', () => {
    const r = row(ev([coverage]), '1')
    assert.deepEqual([r.status, r.answer, r.keep], ['unknown', 'To confirm', true])
    assert.equal(r.lines[0].text, 'To confirm: the agent has not answered this row.')
    assert.match(r.lines[1].text, /61\.0%/)
  })
})

describe('publishing agent rows', () => {
  const answers = { '1': { answer: 'Yes', comment: 'Coverage is 91%.', links: [link] } }
  const published = withIds(renderPage(cfg, layout, evaluate(cfg, layout, answered(answers))))

  test('an unanswered row keeps the published answer; an answered one replaces it', () => {
    const m = merge(published, layout, genRows(layout, evaluate(cfg, layout, answered({ '2': { answer: 'Yes', comment: 'Passed.', links: [link] } }))))
    const action = (key: string, cell: string) => m.changes.find((c) => c.key === key && c.cell === cell)?.action
    assert.equal(action('1', 'status'), 'keep-unreachable')
    assert.equal(action('1', 'comments'), 'keep-unreachable')
    assert.equal(action('2', 'status'), 'update')
    assert.equal(action('1', null as unknown as string), undefined, 'the question is the same, so it is left alone')
    assert.match(m.html, /Coverage is 91%/)
  })

  test('a row whose question on the page is another one is rewritten whole, even with no answer', () => {
    const old = published.replace('Is unit test coverage greater than 80% for all services?', 'Service-wide: is unit test coverage greater than 80%?')
    const m = merge(old, layout, genRows(layout, evaluate(cfg, layout, answered({}))))
    const row1 = m.changes.filter((c) => c.key === '1' && c.table === 'checklist')
    assert.deepEqual(row1.map((c) => [c.cell, c.action]), [['status', 'update'], ['comments', 'update'], [null, 'update']])
    assert.match(m.html, /Is unit test coverage greater than 80% for all services\?/)
    assert.doesNotMatch(m.html, /Service-wide: is unit test coverage/)
    // A person's row is theirs, question and all.
    const edited = old.replace('Coverage is 91%.', 'Checked by hand.')
    const kept = merge(edited, layout, genRows(layout, evaluate(cfg, layout, answered({}))))
    assert.deepEqual(kept.changes.filter((c) => c.key === '1' && c.table === 'checklist').map((c) => c.action), ['skipped', 'keep-edited', 'skipped'])
  })

  test('release rows never rewrite their question', () => {
    const cfgR = { ...cfg, kind: 'release' as const, candidates: [{ name: 'V1', shas: { 'pcs-api': SHA.api1 } }] }
    const page = withIds(renderPage(cfgR, release, evaluate(cfgR, release, { ...ev([]), candidates: cfgR.candidates, items: [] })))
    const m = merge(page.replace('Have all SonarCloud Quality Gates passed?', 'Quality gates?'), release, genRows(release, evaluate(cfgR, release, { ...ev([]), candidates: cfgR.candidates, items: [] })))
    assert.ok(!m.changes.some((c) => c.cell === null && c.action === 'update'))
  })

  test('the page\'s text goes to the agent, marked when a person wrote it, and left out when the question differs', () => {
    const rows = publishedRows(published, layout)
    assert.deepEqual(rows['1'], { status: 'Yes', comment: 'Coverage is 91%. pcs-api on SonarCloud', links: [link.url] })
    assert.equal(rows['2'].status, 'To confirm')
    assert.equal(publishedRows(published.replace('Coverage is 91%.', 'Checked by hand.'), layout)['1'].byPerson, true)
    assert.equal(publishedRows(published.replace('Is unit test coverage greater than 80% for all services?', 'Other?'), layout)['1'], undefined)
    assert.deepEqual(publishedRows('<p>no table</p>', layout), {})
  })
})

describe('the agent input', () => {
  test('has the scope, and per agent row its question, guide, evidence and the page\'s text', () => {
    const e = ev([coverage, fact({ rule: 'e2e-feature', status: 'unknown', value: 'not checked', note: 'Cosmos 403', unreachable: true, repo: 'pcs-frontend' })])
    const input = agentInput(cfg, layout, e, { '1': { status: 'Yes', comment: 'old', links: [] } }) as { scope: Record<string, any>; rows: Record<string, any>[]; pageRead: boolean }
    assert.deepEqual(input.scope.epics, ['HDPI-10019'])
    assert.equal(input.scope.repos['pcs-api'].commits[SERVICE_WIDE], SHA.api2)
    assert.deepEqual(input.scope.repos['pcs-frontend'].e2e.tags, ['@privateLandlord'])
    assert.equal(input.pageRead, true)
    assert.equal(input.rows.length, 23)
    const [r1] = input.rows
    assert.deepEqual(Object.keys(r1), ['key', 'question', 'guide', 'evidence', 'published'])
    assert.deepEqual(r1.evidence, [{ rule: 'sonar-coverage', status: 'fail', value: '61.0%', links: [link], sha: SHA.api2, repo: 'pcs-api' }])
    assert.deepEqual(input.rows.find((r) => r.key === '4')!.evidence[0], { rule: 'e2e-feature', status: 'unknown', value: 'not checked', note: 'Cosmos 403',
      unreachable: true, links: [], repo: 'pcs-frontend' })
    assert.equal((agentInput(cfg, layout, e, null) as { pageRead: boolean }).pageRead, false)
  })
})
