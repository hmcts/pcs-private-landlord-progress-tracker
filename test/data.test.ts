import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadYaml, validateNfrs, validateOverview, validateRaid } from '../scripts/lib/data.ts'

const risk = { id: 'R-001', type: 'risk', title: 'A risk', owner: 'Delivery manager', rag: 'amber', status: 'open',
  raised: '2026-11-09', review: '2026-11-23' }

describe('validateRaid', () => {
  test('accepts a valid entry and an empty log', () => {
    assert.deepEqual(validateRaid([risk]), [])
    assert.deepEqual(validateRaid([]), [])
  })
  test('needs the id prefix to match the type', () => {
    assert.match(validateRaid([{ ...risk, id: 'I-001' }]).join(), /prefix doesn't match/)
  })
  test('needs a review date while open', () => {
    const { review: _review, ...noReview } = risk
    assert.match(validateRaid([noReview]).join(), /need a "review" date/)
    assert.deepEqual(validateRaid([{ ...noReview, status: 'closed' }]), [])
  })
  test('rejects bad values and duplicate ids', () => {
    const errors = validateRaid([{ ...risk, rag: 'purple', raised: '9 Nov' }, risk]).join('\n')
    assert.match(errors, /"rag" must be one of/)
    assert.match(errors, /"raised" must be YYYY-MM-DD/)
    assert.match(errors, /duplicate id R-001/)
  })
})

const standard = { id: 'pcs-nfrs', title: 'PCS NFRs', url: 'https://example.org/nfrs' }
const nfr = { id: 'PERF-01', category: 'performance', requirement: 'Fast screens', source: 'pcs-nfrs' }

describe('validateNfrs', () => {
  test('accepts valid entries and an empty list', () => {
    assert.deepEqual(validateNfrs({ standards: [standard], nfrs: [nfr] }), [])
    assert.deepEqual(validateNfrs({ standards: [], nfrs: [] }), [])
  })
  test('needs the id prefix to match the category', () => {
    assert.match(validateNfrs({ standards: [standard], nfrs: [{ ...nfr, id: 'QA-01' }] }).join(), /must look like PERF-01/)
  })
  test('needs the source to be a listed standard', () => {
    assert.match(validateNfrs({ standards: [standard], nfrs: [{ ...nfr, source: 'unknown' }] }).join(), /"source" must be one of/)
  })
  test('rejects bad values and duplicate ids', () => {
    const errors = validateNfrs({ standards: [{ ...standard, url: 'not a link' }], nfrs: [{ ...nfr, category: 'speed' }, nfr, nfr] }).join('\n')
    assert.match(errors, /"url" must be an https link/)
    assert.match(errors, /"category" must be one of/)
    assert.match(errors, /duplicate id PERF-01/)
  })
})

describe('validateOverview', () => {
  test('checks the overall status', () => {
    assert.deepEqual(validateOverview({ rag: 'green', headline: 'Going well', updated: '2026-11-09', milestones: [] }), [])
    assert.match(validateOverview({ rag: 'green', headline: '', updated: '2026-11-09' }).join(), /"headline" is required/)
  })
})

test('the committed data files are valid', () => {
  assert.deepEqual(validateOverview(loadYaml('src/_data/overview.yaml')), [])
  assert.deepEqual(validateRaid(loadYaml('src/_data/raid.yaml')), [])
  assert.deepEqual(validateNfrs(loadYaml('src/_data/nfrs.yaml')), [])
})
