// Turns a QA readiness report page, as twg reads it from Confluence, into HTML for the site.
//
// The page is written by people as well as the pipeline, so only an allowlist of elements and
// attributes is kept: anything else is dropped, or replaced by its text. Confluence's macros
// (the pipeline's anchors among them) are dropped, and GOV.UK Frontend classes are added. The
// page's first heading is its title, which the site's layout shows, so it is returned apart.

import { esc, type El, type Node, parse, textOf } from './html.ts'

const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'noscript', 'textarea', 'title', 'head', 'select', 'button', 'form', 'input'])

const CLASSES: Record<string, string> = {
  p: 'govuk-body',
  ul: 'govuk-list govuk-list--bullet',
  ol: 'govuk-list govuk-list--number',
  table: 'govuk-table app-qa-table',
  thead: 'govuk-table__head',
  tbody: 'govuk-table__body',
  tr: 'govuk-table__row',
  th: 'govuk-table__header',
  td: 'govuk-table__cell',
  a: 'govuk-link',
  blockquote: 'govuk-inset-text',
  hr: 'govuk-section-break govuk-section-break--m govuk-section-break--visible',
}

const KEEP = new Set([...Object.keys(CLASSES), 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'li', 'sub', 'sup'])

// The page's h1 sections sit under the site's own h1, so every level moves down one.
const HEADINGS: Record<string, [string, string]> = {
  h1: ['h2', 'govuk-heading-l'], h2: ['h3', 'govuk-heading-m'], h3: ['h4', 'govuk-heading-s'],
  h4: ['h4', 'govuk-heading-s'], h5: ['h4', 'govuk-heading-s'], h6: ['h4', 'govuk-heading-s'],
}

const SAFE_HREF = /^(https?:|mailto:)/i

export interface SitePage {
  title: string
  body: string
}

export function sitePage(html: string): SitePage {
  const root = parse(html)
  const blocks = root.children.filter((c): c is El => c.type === 'el')
  const first = blocks.find((b) => /^h[1-6]$/.test(b.tag))
  const title = first ? textOf(first) : ''
  const skip = new Set<El>(first ? [first] : [])
  // "Created by" names a person, and the site names roles, not people.
  for (const b of blocks) if (b.tag === 'p' && /^Created by:/i.test(textOf(b))) skip.add(b)
  return { title, body: root.children.map((c) => render(c, skip)).join('') }
}

function render(n: Node, skip: Set<El>, inCell = false, inHeader = false): string {
  if (n.type === 'comment') return ''
  if (n.type === 'text') return esc(n.text)
  if (skip.has(n) || DROP.has(n.tag) || n.attrs['data-type']?.endsWith('extension')) return ''
  const cell = inCell || n.tag === 'td' || n.tag === 'th'
  const inner = (el: El) => el.children.map((c) => render(c, skip, cell, inHeader)).join('')
  if (n.tag === 'table') return table(n, skip)
  const heading = HEADINGS[n.tag]
  if (heading) return `<${heading[0]} class="${heading[1]}">${inner(n)}</${heading[0]}>`
  // A paragraph's class would reset a header cell's bold.
  if (!KEEP.has(n.tag) || (n.tag === 'p' && inHeader)) return inner(n)
  if (n.tag === 'br') return '<br>'
  if (n.tag === 'hr') return `<hr class="${CLASSES.hr}">`
  if (n.tag === 'a') {
    const href = (n.attrs.href ?? '').trim()
    return SAFE_HREF.test(href) ? `<a class="govuk-link" href="${esc(href)}">${inner(n)}</a>` : inner(n)
  }
  const cls = n.tag === 'p' && inCell ? 'govuk-body-s' : CLASSES[n.tag]
  return `<${n.tag}${cls ? ` class="${cls}"` : ''}>${inner(n)}</${n.tag}>`
}

/** A table, with its first row as the header when the page has none: Confluence writes it as plain cells. */
function table(t: El, skip: Set<El>): string {
  const rows: El[] = []
  const collect = (e: El) => {
    for (const c of e.children) {
      if (c.type !== 'el') continue
      if (c.tag === 'tr') rows.push(c)
      else if (['thead', 'tbody', 'tfoot'].includes(c.tag)) collect(c)
    }
  }
  collect(t)
  const hasHeader = rows.some((r) => r.children.some((c) => c.type === 'el' && c.tag === 'th'))
  const row = (r: El, head: boolean) => `<tr class="govuk-table__row">${r.children
    .filter((c): c is El => c.type === 'el' && (c.tag === 'td' || c.tag === 'th'))
    .map((c) => {
      const tag = head || c.tag === 'th' ? 'th' : 'td'
      const cls = tag === 'th' ? 'govuk-table__header' : 'govuk-table__cell'
      const scope = head ? ' scope="col"' : ''
      return `<${tag}${scope} class="${cls}">${c.children.map((x) => render(x, skip, true, tag === 'th')).join('')}</${tag}>`
    }).join('')}</tr>`
  const [head, ...body] = hasHeader ? [null, ...rows] : rows
  return `<table class="${CLASSES.table}">${head ? `<thead class="govuk-table__head">${row(head, true)}</thead>` : ''}` +
    `<tbody class="govuk-table__body">${body.map((r) => row(r!, false)).join('')}</tbody></table>`
}
