import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadYaml, qaReports, validateDecisions, validateNfrs, validateOverview, validateRaid, validateReports } from '../scripts/lib/data.ts'

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

const decision = { id: 'DEC-001', date: '2026-11-11', area: 'journey', title: 'A decision',
  decision: 'What was decided.', outcome: 'fix', ref: 'OBS-1' }

describe('validateDecisions', () => {
  test('accepts valid entries and an empty log', () => {
    const { ref: _ref, ...noRef } = decision
    assert.deepEqual(validateDecisions([decision, { ...noRef, id: 'DEC-002', outcome: 'open-question' }]), [])
    assert.deepEqual(validateDecisions([]), [])
  })
  test('needs a DEC- id', () => {
    assert.match(validateDecisions([{ ...decision, id: 'D-001' }]).join(), /must look like DEC-001/)
    assert.match(validateDecisions([{ ...decision, id: 'DEC-1' }]).join(), /must look like DEC-001/)
  })
  test('rejects bad values and duplicate ids', () => {
    const errors = validateDecisions([{ ...decision, outcome: 'maybe', area: 'elsewhere', date: '11 Nov' }, decision]).join('\n')
    assert.match(errors, /"outcome" must be one of/)
    assert.match(errors, /"area" must be one of/)
    assert.match(errors, /"date" must be YYYY-MM-DD/)
    assert.match(errors, /duplicate id DEC-001/)
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

const report = { page: '317130017', title: 'A performance report', description: 'A run' }

describe('validateReports', () => {
  test('accepts valid entries, numeric ids and an empty list', () => {
    const { description: _description, ...noDescription } = report
    assert.deepEqual(validateReports({ performance: [report, { ...noDescription, page: 381847943 }] }), [])
    assert.deepEqual(validateReports({ performance: [] }), [])
  })
  test('needs a title and a page id', () => {
    const errors = validateReports({ performance: [{ ...report, title: ' ' }, { ...report, page: '3171-30017' }, { title: 'No page' }] }).join('\n')
    assert.match(errors, /performance\[0\]: "title" is required/)
    assert.match(errors, /performance\[1\]: "page" must be a Confluence page id/)
    assert.match(errors, /performance\[2\]: "page" must be a Confluence page id/)
  })
  test('rejects bad values and duplicate pages', () => {
    const errors = validateReports({ performance: [{ ...report, description: '' }, { ...report, page: 317130017 }] }).join('\n')
    assert.match(errors, /"description" must be text/)
    assert.match(errors, /duplicate page 317130017/)
    assert.match(validateReports([report]).join(), /expected a mapping/)
    assert.match(validateReports({ performance: report }).join(), /expected a list/)
  })
})

describe('qaReports', () => {
  test('lists the committed active configs that have a report page', () => {
    const make = qaReports('config/qa-readiness', 'no-such-dir').find((r) => r.name === 'private-landlord-make-a-claim')
    assert.deepEqual(make, {
      title: 'QA Readiness Report – private-landlord-make-a-claim',
      url: 'https://hmcts.atlassian.net/wiki/pages/viewpage.action?pageId=382468869',
      name: 'private-landlord-make-a-claim',
    })
  })
  test('skips inactive configs and those with no page, titles releases from their layout, and finds their site copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-reports-'))
    try {
      mkdirSync(join(dir, 'layouts'))
      writeFileSync(join(dir, 'layouts', 'pcs.yaml'), 'title: QA Readiness Report – {release}\n')
      writeFileSync(join(dir, 'layouts', 'pcs-feature.yaml'), 'title: QA Readiness Report – {feature}\n')
      writeFileSync(join(dir, 'R1.4.yaml'), "release: R1.4\nactive: true\nlayout: pcs\nreport_page: '0012345'\njql: x\n")
      writeFileSync(join(dir, 'R1.3A.yaml'), "release: R1.3A\nactive: false\nlayout: pcs\nreport_page: '311427238'\n")
      writeFileSync(join(dir, 'no-page.yaml'), 'feature: no-page\nactive: true\nlayout: pcs-feature\n')
      writeFileSync(join(dir, 'feature-x.yaml'), "feature: feature-x\nactive: true\nlayout: pcs-feature\nreport_page: '99'\nepics: [HDPI-1]\n")
      mkdirSync(join(dir, 'site'))
      writeFileSync(join(dir, 'site', 'feature-x.html'), '<h1>x</h1>')
      assert.deepEqual(qaReports(dir, join(dir, 'site')), [
        { title: 'QA Readiness Report – R1.4', url: 'https://hmcts.atlassian.net/wiki/pages/viewpage.action?pageId=12345', name: 'R1.4' },
        { title: 'QA Readiness Report – feature-x', url: 'https://hmcts.atlassian.net/wiki/pages/viewpage.action?pageId=99', name: 'feature-x', site: join(dir, 'site', 'feature-x.html') },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('the committed data files are valid', () => {
  assert.deepEqual(validateOverview(loadYaml('src/_data/overview.yaml')), [])
  assert.deepEqual(validateRaid(loadYaml('src/_data/raid.yaml')), [])
  assert.deepEqual(validateNfrs(loadYaml('src/_data/nfrs.yaml')), [])
  assert.deepEqual(validateDecisions(loadYaml('src/_data/decisions.yaml')), [])
  assert.deepEqual(validateReports(loadYaml('src/_data/reports.yaml')), [])
})
