import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sitePage } from '../scripts/lib/qa/site.ts'

const ANCHOR = '<span data-type="inline-extension" data-extension-key="anchor" data-parameters="{}"></span>'

describe('sitePage', () => {
  test('takes the first heading as the title and drops the "Created by" line', () => {
    const p = sitePage('<p><strong>Created by:</strong> A Person</p><p>Last Updated: 25/11/2026</p><h1>QA Readiness Report – x</h1><h1>Risks</h1>')
    assert.equal(p.title, 'QA Readiness Report – x')
    assert.equal(p.body, '<p class="govuk-body">Last Updated: 25/11/2026</p><h2 class="govuk-heading-l">Risks</h2>')
  })

  test('drops macros, scripts, unsafe links and every attribute it does not set', () => {
    const p = sitePage(`<h1>T</h1><p data-local-id="1" style="x" onclick="y">a${ANCHOR}<a href="javascript:alert(1)">b</a> <a href="https://x.test/?a=1&amp;b=&quot;2" onmouseover="z">c</a></p><script>bad()</script><iframe src="https://x"></iframe><div><em>d</em></div>`)
    assert.equal(p.body, '<p class="govuk-body">ab <a class="govuk-link" href="https://x.test/?a=1&amp;b=&quot;2">c</a></p><em>d</em>')
  })

  test('escapes text', () => {
    assert.equal(sitePage('<p>&lt;img src=x onerror=1&gt;</p>').body, '<p class="govuk-body">&lt;img src=x onerror=1&gt;</p>')
  })

  test('makes a table\'s first row its header when it has none, keeping header cells bold', () => {
    const p = sitePage('<table><tbody><tr><td><p>No</p></td><td><p>Question</p></td></tr><tr><td><p>1</p></td><td><p>Is it?</p></td></tr></tbody></table>')
    assert.equal(p.body, '<table class="govuk-table app-qa-table"><thead class="govuk-table__head"><tr class="govuk-table__row">' +
      '<th scope="col" class="govuk-table__header">No</th><th scope="col" class="govuk-table__header">Question</th></tr></thead>' +
      '<tbody class="govuk-table__body"><tr class="govuk-table__row"><td class="govuk-table__cell"><p class="govuk-body-s">1</p></td>' +
      '<td class="govuk-table__cell"><p class="govuk-body-s">Is it?</p></td></tr></tbody></table>')
  })

  test('keeps a header row the page already has', () => {
    const p = sitePage('<table><thead><tr><th><p>Item</p></th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>')
    assert.match(p.body, /^<table class="govuk-table app-qa-table"><tbody class="govuk-table__body"><tr class="govuk-table__row"><th class="govuk-table__header">Item<\/th><\/tr><tr class="govuk-table__row"><td class="govuk-table__cell">x<\/td><\/tr><\/tbody><\/table>$/)
  })
})
