import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRia, riaReader } from '../scripts/lib/qa/sources/ria.ts'
import { CFG, fakeTwg, NOW } from './qa-helpers.ts'

// The RIA template's sections, as twg returns them, with made-up people.
const html = (perf: string, sec: string) => `
<h2 data-local-id="a1">Security Review</h2>
<p data-local-id="a2">Security team:- Is there a requirement for any Security related activity or testing for this release? Please sign and date when complete.</p>
<p data-local-id="a3">ITHC Not Required</p>
<p data-local-id="a4">${sec}</p>
<h2 data-local-id="b1">Performance Testing</h2>
<p data-local-id="b2">Performance team:- Is Perf testing required? Please share how the decision of what is required or not required was reached.</p>
<p data-local-id="b3"><time datetime="2026-08-17">August 17, 2026</time> Performance Testing is required:</p>
<p data-local-id="b4">${perf}</p>`

const SIGNED_PERF = 'Signed by Perf Test:- <span data-type="mention" data-user-id="1">@Pat Tester</span>     Date:-<time datetime="2026-08-17">August 17, 2026</time>'
const BLANK_SEC = 'Signed by Sec Ops:-                                Date:-'

describe('Release Impact Assessment', () => {
  test('reads who signed, when, and whether testing is required', () => {
    const facts = parseRia(html(SIGNED_PERF, 'Signed by Sec Ops:- Sam Secure    Date:- <time datetime="2026-08-20">August 20, 2026</time>'))
    assert.deepEqual(facts.perf, { who: 'Pat Tester', date: '2026-08-17', required: true })
    assert.deepEqual(facts.security, { who: 'Sam Secure', date: '2026-08-20', required: false })
  })

  test('a blank sign-off line is not signed', () => {
    assert.deepEqual(parseRia(html(SIGNED_PERF, BLANK_SEC)).security, { who: null, date: null, required: false })
  })

  test('the reader turns sign-offs into rows', async () => {
    const run = fakeTwg(() => ({ data: { body: { value: html(SIGNED_PERF, BLANK_SEC) } } }))
    const items = await riaReader({ ...CFG, ria_page: '123' }, run, NOW)()
    assert.deepEqual(items.map((i) => [i.rule, i.status, i.answer]), [
      ['perf-signoff', 'pass', undefined], ['perf-required', 'pass', 'Yes'], ['security-signoff', 'unknown', undefined]])
    assert.equal(items[0].value, 'Signed by Perf Test: Pat Tester, 17 Aug 2026')
    assert.deepEqual(run.calls[0].slice(0, 4), ['confluence', 'content', 'get', '123'])
  })

  test('no page, or an unreadable one, gives unknown rows', async () => {
    assert.ok((await riaReader(CFG, fakeTwg(() => ({})), NOW)()).every((i) => i.status === 'unknown'))
    const items = await riaReader({ ...CFG, ria_page: '123' }, fakeTwg(() => new Error('twg exited 1')), NOW)()
    assert.ok(items.every((i) => i.status === 'unknown' && /could not be read/.test(i.note!)))
  })
})
