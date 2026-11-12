import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadLayout, loadRelease, validateAll, validateLayout, validateRelease } from '../scripts/lib/qa/config.ts'
import { CFG, SHA } from './qa-helpers.ts'

const layout = loadLayout('pcs')

describe('QA readiness config', () => {
  test('the committed releases and layouts are valid', () => {
    assert.deepEqual(validateAll(), [])
    const { cfg } = loadRelease('config/qa-readiness/R1.3A.yaml')
    assert.equal(cfg.active, false)
    assert.deepEqual(cfg.candidates.map((c) => c.name), ['V1', 'V2'])
  })

  test('accepts a valid release', () => {
    assert.deepEqual(validateRelease(CFG, 'r', layout), [])
  })

  test('needs full SHAs for known repos', () => {
    const errors = validateRelease({ ...CFG, candidates: [{ name: 'V1', shas: { 'pcs-api': 'e11f333', other: SHA.api1 } }] }, 'r', layout).join('\n')
    assert.match(errors, /pcs-api must be a full 40-character commit SHA/)
    assert.match(errors, /"other" is not one of the repos/)
  })

  test('checks page ids, active, human rows and dashboards', () => {
    const errors = validateRelease({ ...CFG, active: 'yes', report_page: 'page-1', human_rows: { '16': 'not a key', '99': 'HDPI-1' },
      dashboards: [{ label: 'x', url: 'http://insecure' }] }, 'r', layout).join('\n')
    assert.match(errors, /"active" must be true or false/)
    assert.match(errors, /"report_page" must be a Confluence page id/)
    assert.match(errors, /human_rows.16: must be a Jira key/)
    assert.match(errors, /the layout has no row 99/)
    assert.match(errors, /dashboards\[0\]: needs a "label" and an https "url"/)
  })

  test('a layout row must name a known rule, once, with no stray fields', () => {
    const bad = { title: 't', checklist: { heading: 'h', columns: ['No', 'Q'], rows: [
      { key: '1', rule: 'magic', question: 'q' }, { key: '1', rule: 'human', question: 'q' },
      { key: '2', rule: 'human', question: 'a', 'b or c?': null }] } }
    const errors = validateLayout(bad).join('\n')
    assert.match(errors, /"rule" must be one of/)
    assert.match(errors, /duplicate row key 1/)
    assert.match(errors, /unknown field "b or c\?"/)
  })
})
