// The parts of a page outside its two tables, for a layout that reproduces the whole template
// (one with `sections`): the "Created by" and "Last Updated" lines above the title, the intro
// below it, and the sections after the checklist.
//
// Each part is a run of top-level blocks: the ones before the first heading (the header), the
// ones between the title and the next heading (the intro), or the ones between a section's
// heading and the next heading. Like a cell, a part the generator writes starts with an anchor
// macro, named
//   qa-auto-part-<part>-<hash>
// where <hash> is a hash of the part's text as generated, so publish can tell an untouched part
// (replaced on each run) from one a person has edited (theirs from then on).

import type { Layout, LayoutSection, SectionKind } from './config.ts'
import { type El, esc, fingerprint, type Node, parse, shortHash } from './html.ts'
import type { Link } from './types.ts'
import type { SectionAnswers } from './answers.ts'
import { anchor, anchorName, type Line, para, paragraphs } from './render.ts'

export const PART_PREFIX = 'qa-auto-part-'

export const APPROVED = '✅ QA APPROVED FOR RELEASE'
export const NOT_APPROVED = '❌ QA NOT APPROVED FOR RELEASE'

/** A part marker's part and hash, or null if the name is not one. */
export function partMarker(name: string): { part: string; hash: string } | null {
  if (!name.startsWith(PART_PREFIX)) return null
  const rest = name.slice(PART_PREFIX.length)
  const cut = rest.lastIndexOf('-')
  const hash = rest.slice(cut + 1)
  return cut > 0 && /^[0-9a-f]{8}$/.test(hash) ? { part: rest.slice(0, cut), hash } : null
}

const isPartMarker = (e: El) => partMarker(anchorName(e) ?? '') !== null

/** What a part's ownership hash covers: its blocks' text, links, mentions and macros, leaving out the marker. */
export const partText = (nodes: Node[]): string => nodes.map((n) => fingerprint(n, isPartMarker)).join(' ').replace(/\s+/g, ' ').trim()

export interface GenPart {
  /** header, intro, or the section's kind, lower-cased. */
  part: string
  /** The section's heading, written when the page lacks it. The header and intro have none. */
  heading?: { text: string; level: number }
  html: string
  hash: string
  /** Nothing valid to write: a part the page has stays as it is; one it lacks is added empty. */
  keep: boolean
  /** The intro: paragraphs reading exactly as one of these, unmarked, are the generator's own. */
  legacy?: string[]
  /** The header: the same part with another date, to tell a change of date alone. */
  withDate?: (date: string) => GenPart
}

/** dd/mm/yyyy, as the template writes "Last Updated", in UK time. */
export const ukDate = (d: Date): string => d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric' })

function marked(part: string, blocks: string[], extra: Partial<GenPart> = {}): GenPart {
  const body = blocks.join('')
  const hash = shortHash(partText(parse(body).children))
  return { part, html: body.replace('<p>', `<p>${anchor(`${PART_PREFIX}${part}-${hash}`)}`), hash, keep: false, ...extra }
}

const cell = (lines: Line[]) => `<td>${(lines.length ? lines : [{ text: '', links: [] }]).map(para).join('')}</td>`
const text = (t: string, links: Link[] = []): Line[] => [{ text: t, links }]
const table = (rows: Line[][][]) => `<table data-layout="center"><tbody>${rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table>`

/** A section's blocks from its answer, or, with none, its structure with nothing filled in. */
function sectionBlocks(s: LayoutSection, a: SectionAnswers): string[] {
  const head = (s.columns ?? []).map((c) => text(c))
  const fixed = s.rows ?? []
  switch (s.kind) {
    case 'testingSummary':
      return [table([head, ...fixed.map((r) => [text(r), text(a.testingSummary?.[r] ?? '')])])]
    case 'defectSummary': {
      const d = a.defectSummary
      return [table([head, ...fixed.map((r) => [text(r), text(d?.counts[r] ?? '')])]), ...(d ? paragraphs(d.comment).map(para) : [])]
    }
    case 'risks':
      return [table([head, ...(a.risks ?? [{ risk: '', mitigation: '', links: [] }]).map((r) => [text(r.risk, r.links), text(r.mitigation)])])]
    case 'qaSummary':
      return a.qaSummary === undefined ? ['<p></p>'] : paragraphs(a.qaSummary).map(para)
    case 'recommendation': {
      const r = a.recommendation
      return r ? [`<p><strong>${esc(r.approved ? APPROVED : NOT_APPROVED)}</strong></p>`, ...paragraphs(r.reason).map(para)] : ['<p></p>']
    }
    case 'signOff':
      return [table([head, ...fixed.map((role) => {
        const o = a.signOff?.[role]
        return [text(role), text(o?.name ?? ''), text(o?.status ?? '', o?.links ?? [])]
      })])]
  }
}

const has = (a: SectionAnswers, kind: SectionKind): boolean => a[kind] !== undefined

function header(name: string, date: string): GenPart {
  const p = `<p><strong>Created by:</strong> ${esc(name)}<br><strong>Last Updated:</strong> ${esc(date)}</p>`
  return marked('header', [p], { withDate: (d) => header(name, d) })
}

/**
 * The parts a layout with sections has, in page order: header, intro, then each section. The
 * header names `createdBy`, the account name the pipeline collected; with none, there is no
 * header part, so the page's stays as it is. A part with nothing to write is left out.
 */
export function genParts(layout: Layout, answers: SectionAnswers, date: Date, createdBy: string | null = null): GenPart[] {
  if (!layout.sections) return []
  const parts: GenPart[] = []
  if (layout.header && createdBy) parts.push(header(createdBy, ukDate(date)))
  parts.push(marked('intro', (layout.intro ?? []).map((p) => `<p>${esc(p)}</p>`), { legacy: layout.former_intro ?? [] }))
  for (const s of layout.sections) {
    parts.push(marked(s.kind.toLowerCase(), sectionBlocks(s, answers), { heading: { text: s.heading, level: s.level }, keep: !has(answers, s.kind) }))
  }
  return parts.filter((p) => p.html)
}
