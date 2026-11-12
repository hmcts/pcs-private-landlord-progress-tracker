// The release's Release Impact Assessment page, read through twg: the performance and security
// teams sign their sections with a line such as
//   Signed by Perf Test:- @Name    Date:- <date>
//   Signed by Sec Ops:- Name       Date:- <date>
// and say above it whether testing is required. A blank sign-off line means not signed yet.

import type { ReleaseConfig } from '../config.ts'
import { defaultRunner, type TwgRunner } from '../../roadmap-runner.ts'
import { find, parse, textOf, type El } from '../html.ts'
import { day, item, type Item, reason } from './common.ts'

const SOURCE = 'ria'

export interface SignOff {
  who: string | null
  date: string | null
  required: boolean | null
}

export interface RiaFacts {
  perf: SignOff
  security: SignOff
}

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th'])
// The RIA template's own instructions, which mention "required" and "not required" themselves.
const GUIDANCE = /^(performance|security) team\s*:|please ensure|^note:\s*if the activity|required for 100% complete date/i

function signOff(blocks: { el: El; text: string }[], heading: RegExp, line: RegExp): SignOff {
  const end = blocks.findIndex((b) => line.test(b.text))
  if (end < 0) return { who: null, date: null, required: null }
  let start = end
  while (start > 0 && !heading.test(blocks[start].text)) start--
  const section = blocks.slice(start, end).map((b) => b.text).filter((t) => !GUIDANCE.test(t)).join('\n')
  const required = /\bnot\s+required\b|\bno\s+(performance|security)\s+testing\b|\bnot\s+needed\b/i.test(section) ? false
    : /\b(is|are|will be|be)\s+required\b|\brequired\s*:|\bmust\b|\bcritical\b/i.test(section) ? true : null

  const b = blocks[end]
  const m = /signed by[^:]*:\s*-?\s*(.*?)\s*date\s*:?\s*-?\s*(.*)$/i.exec(b.text)
  const who = m?.[1].replace(/^@/, '').trim() || null
  const time = find(b.el, (e) => e.tag === 'time')[0]?.attrs.datetime
  const date = time || m?.[2].trim() || null
  return { who, date: who || time ? date : null, required }
}

export function parseRia(html: string): RiaFacts {
  const root = parse(html)
  const blocks = find(root, (e) => BLOCKS.has(e.tag) && !find(e, (c) => c !== e && c.tag === 'p').length)
    .map((el) => ({ el, text: textOf(el) }))
  return {
    perf: signOff(blocks, /^performance testing\b/i, /^signed by perf/i),
    security: signOff(blocks, /^security (review|testing)\b/i, /^signed by sec/i),
  }
}

export function riaReader(cfg: ReleaseConfig, run: TwgRunner = defaultRunner, now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const rules = ['perf-signoff', 'perf-required', 'security-signoff']
    if (!cfg.ria_page) {
      return rules.map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note: 'no ria_page is configured' }, now))
    }
    const page = String(cfg.ria_page)
    const links = [{ text: 'Release Impact Assessment', url: `https://hmcts.atlassian.net/wiki/pages/viewpage.action?pageId=${page}` }]
    let facts: RiaFacts
    try {
      const out = JSON.parse(run(['confluence', 'content', 'get', page, '--detail', 'full', '--format', 'html', '-o', 'json', '--output-summary', 'none']))
      facts = parseRia(String(out.data?.body?.value ?? ''))
    } catch (e) {
      return rules.map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', links,
        note: `the RIA could not be read: ${reason(e)}` }, now))
    }
    const signed = (label: string, s: SignOff) => s.who
      ? `Signed by ${label}: ${s.who}${s.date ? `, ${/^\d{4}-\d{2}-\d{2}/.test(s.date) ? day(s.date) : s.date}` : ''}` : `not signed by ${label} yet`
    const { perf, security } = facts
    return [
      item({ source: SOURCE, rule: 'perf-signoff', status: perf.who ? 'pass' : 'unknown', value: signed('Perf Test', perf), links,
        note: perf.who ? undefined : 'the RIA has no Perf Test sign-off', data: { ...perf } }, now),
      item({ source: SOURCE, rule: 'perf-required', status: perf.required === null ? 'unknown' : 'pass',
        answer: perf.required === null ? undefined : perf.required ? 'Yes' : 'No',
        value: perf.required === null ? 'the RIA does not say' : `the RIA says performance testing is ${perf.required ? '' : 'not '}required`,
        links, data: { ...perf } }, now),
      item({ source: SOURCE, rule: 'security-signoff', status: security.who ? 'pass' : 'unknown',
        value: signed('Sec Ops', security) + (security.required === false ? ' (security testing not required)' : ''), links,
        note: security.who ? undefined : 'the RIA has no Sec Ops sign-off', data: { ...security } }, now),
    ]
  }
}
