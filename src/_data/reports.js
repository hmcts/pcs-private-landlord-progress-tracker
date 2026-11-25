// The QA readiness reports, from config/qa-readiness/. Eleventy merges this with reports.yaml,
// which holds the performance test reports. `pages` are the reports the Publish workflow has
// copied from Confluence to data/qa-reports/, each rendered for the site.
import { readFileSync } from 'node:fs'
import { qaReports } from '../../scripts/lib/data.ts'
import { sitePage } from '../../scripts/lib/qa/site.ts'

export default function () {
  const qa = qaReports()
  const pages = qa.filter((r) => r.site).map((r) => {
    const { title, body } = sitePage(readFileSync(r.site, 'utf8'))
    return { ...r, title: title || r.title, body }
  })
  return { qa: qa.map((r) => (r.site ? { ...r, href: `/reports/qa/${r.name}/` } : r)), pages }
}
