// A small parser for the HTML twg reads and writes Confluence pages in (an ADF-backed format,
// not storage XML). It keeps each node's offsets into the source, so a merge can splice in new
// cells and leave every other byte of the page as it was.

import { createHash } from 'node:crypto'
import { esc } from '../svg.ts'

export interface El {
  type: 'el'
  tag: string
  attrs: Record<string, string>
  start: number
  end: number
  children: Node[]
  parent: El | null
}

export interface Text {
  type: 'text' | 'comment'
  text: string
  start: number
  end: number
}

export type Node = El | Text

const VOID = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr', 'meta', 'link', 'source'])
// Closing one of these also closes any of the listed tags left open inside it.
const IMPLIED: Record<string, string[]> = { p: ['p'], li: ['li'], td: ['td', 'th'], th: ['td', 'th'], tr: ['tr', 'td', 'th'] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      // Out of range, or half a surrogate pair: not a character, so left as written.
      return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? m : String.fromCodePoint(cp)
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export { esc }

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '')
  return out
}

export function parse(html: string): El {
  const root: El = { type: 'el', tag: '#root', attrs: {}, start: 0, end: html.length, children: [], parent: null }
  let cur = root
  const tag = /<!--([\s\S]*?)-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
  let pos = 0
  let m: RegExpExecArray | null
  const close = (name: string, from: number, to: number) => {
    for (let n: El | null = cur; n && n !== root; n = n.parent) {
      if (n.tag === name) {
        for (let c: El | null = cur; c && c !== n; c = c.parent) c.end = from
        n.end = to
        cur = n.parent!
        return
      }
    }
  }
  while ((m = tag.exec(html))) {
    if (m.index > pos) cur.children.push({ type: 'text', text: decode(html.slice(pos, m.index)), start: pos, end: m.index })
    pos = tag.lastIndex
    if (m[1] !== undefined) {
      cur.children.push({ type: 'comment', text: m[1], start: m.index, end: pos })
    } else if (m[2]) {
      close(m[2].toLowerCase(), m.index, pos)
    } else {
      const name = m[3].toLowerCase()
      for (const implied of IMPLIED[name] ?? []) {
        if (cur.tag === implied) close(implied, m.index, m.index)
      }
      const el: El = { type: 'el', tag: name, attrs: parseAttrs(m[4]), start: m.index, end: pos, children: [], parent: cur }
      cur.children.push(el)
      if (!VOID.has(name) && !m[5]) cur = el
    }
  }
  if (pos < html.length) cur.children.push({ type: 'text', text: decode(html.slice(pos)), start: pos, end: html.length })
  return root
}

export function* walk(n: Node): Generator<El> {
  if (n.type !== 'el') return
  yield n
  for (const c of n.children) yield* walk(c)
}

export const find = (n: Node, pred: (e: El) => boolean): El[] => [...walk(n)].filter(pred)

/** The text a reader sees, whitespace collapsed. Anchor macros and other extensions add nothing. */
export function textOf(n: Node): string {
  const parts: string[] = []
  const go = (x: Node) => {
    if (x.type === 'text') parts.push(x.text)
    else if (x.type === 'el') {
      if (x.attrs['data-type']?.endsWith('extension')) return
      if (x.tag === 'br') parts.push(' ')
      for (const c of x.children) go(c)
      if (['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'].includes(x.tag)) parts.push(' ')
    }
  }
  go(n)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

const PARAM_VOLATILE = new Set(['macroMetadata', 'legacyAnchorId', 'localId', '_parentId'])

function extensionKey(e: El): string {
  let params: unknown = {}
  try {
    params = JSON.parse(e.attrs['data-parameters'] ?? '{}')
  } catch {
    params = e.attrs['data-parameters'] ?? ''
  }
  const clean = (v: unknown): unknown => Array.isArray(v) ? v.map(clean)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !PARAM_VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => [k, clean(x)]))
      : v
  return `${e.attrs['data-extension-key'] ?? e.attrs['data-type']}${JSON.stringify(clean(params))}`
}

/**
 * What a cell says, for the ownership hash: its text, plus each link's target, mention and
 * extension (macro), so a person changing only a link or adding a macro counts as an edit.
 * Markup, local ids and macro metadata Confluence adds on its own don't count, and neither do
 * extensions `skip` matches (the generator's own marker).
 */
export function fingerprint(n: Node, skip: (e: El) => boolean = () => false): string {
  const parts: string[] = []
  const go = (x: Node) => {
    if (x.type === 'text') parts.push(x.text)
    else if (x.type === 'el') {
      const type = x.attrs['data-type'] ?? ''
      if (type.endsWith('extension')) {
        if (!skip(x)) parts.push(` {${extensionKey(x)}} `)
        return
      }
      if (type === 'mention') parts.push(` {@${x.attrs['data-user-id'] ?? ''}} `)
      if (x.tag === 'img') parts.push(` {img ${x.attrs.src ?? ''}} `)
      if (x.tag === 'br') parts.push(' ')
      for (const c of x.children) go(c)
      if (x.tag === 'a' && x.attrs.href) parts.push(` {${x.attrs.href}} `)
      if (['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'].includes(x.tag)) parts.push(' ')
    }
  }
  go(n)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/** Rows of a table in document order, whether or not they sit in thead/tbody. */
export function rowsOf(table: El): El[] {
  return find(table, (e) => e.tag === 'tr' && nearest(e, 'table') === table)
}

export const cellsOf = (tr: El): El[] => tr.children.filter((c): c is El => c.type === 'el' && (c.tag === 'td' || c.tag === 'th'))

export function nearest(e: El, tag: string): El | null {
  for (let p = e.parent; p; p = p.parent) if (p.tag === tag) return p
  return null
}

const isHeading = (e: El) => /^h[1-6]$/.test(e.tag)

/** The table under the heading whose text matches, before any other heading, or null. */
export function tableAfterHeading(root: El, heading: RegExp): El | null {
  const all = [...walk(root)]
  const h = all.findIndex((e) => isHeading(e) && heading.test(textOf(e)))
  if (h < 0) return null
  for (const e of all.slice(h + 1)) {
    if (isHeading(e)) return null
    if (e.tag === 'table') return e
  }
  return null
}

export const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** Replaces [start, end) ranges in `src`. Ranges must not overlap. */
export function splice(src: string, edits: { start: number; end: number; text: string }[]): string {
  let out = src
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
