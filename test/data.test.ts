import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadYaml, validateDependencies, validateOverview, validateRaid } from '../scripts/lib/data.ts'

const risk = { id: 'R-001', type: 'risk', title: 'A risk', owner: 'Delivery manager', rag: 'amber', status: 'open',
  raised: '2026-11-09', review: '2026-11-23' }
const dep = { id: 'DEP-001', team: 'PRD', need: 'An API', owner: 'Tech lead', status: 'not-started', rag: 'green' }

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

describe('validateDependencies', () => {
  test('accepts a valid entry', () => assert.deepEqual(validateDependencies([dep]), []))
  test('checks the jira key and status', () => {
    const errors = validateDependencies([{ ...dep, jira: 'not a key', status: 'waiting' }]).join('\n')
    assert.match(errors, /"jira" must be an issue key/)
    assert.match(errors, /"status" must be one of/)
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
  assert.deepEqual(validateDependencies(loadYaml('src/_data/dependencies.yaml')), [])
})
