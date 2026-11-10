import { govukEleventyPlugin } from '@x-govuk/govuk-eleventy-plugin'
import { existsSync } from 'node:fs'
import { loadYaml } from './scripts/lib/data.ts'
import { fmtDate } from './scripts/lib/svg.ts'

const NAV = [
  ['Overview', '/'],
  ['Roadmap', '/roadmap/'],
  ['Quality assurance', '/quality/'],
  ['Performance', '/performance/'],
  ['NFRs', '/nfrs/'],
  ['RAID log', '/raid/'],
  ['ADRs', '/adr/'],
]

const RAG_TAG = { red: 'govuk-tag--red', amber: 'govuk-tag--orange', green: 'govuk-tag--green' }
const CATEGORY_TAG = { new: 'govuk-tag--grey', indeterminate: 'govuk-tag--blue', done: 'govuk-tag--green' }

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(govukEleventyPlugin, {
    // Not part of GOV.UK, so no crown logo or GOV.UK title suffix (see the plugin's README).
    header: { logotype: { text: 'HMCTS Possession Claims Service' } },
    serviceNavigation: {
      serviceName: 'Private Landlord progress',
      serviceUrl: '/',
      navigation: NAV.map(([text, href]) => ({ text, href })),
    },
    icons: { mask: false, shortcut: false, touch: false },
    opengraphImageUrl: false,
    titleSuffix: 'PCS Private Landlord progress',
    footer: { logo: false, copyright: { text: '© HM Courts & Tribunals Service' } },
    showBreadcrumbs: false,
    templates: { error404: true, sitemap: false },
  })

  // The watcher parses imported files as JavaScript and fails on the TypeScript in scripts/lib.
  eleventyConfig.setWatchJavaScriptDependencies(false)

  // Dates stay strings in YAML, so templates can compare and format them.
  eleventyConfig.addDataExtension('yaml', (contents, path) => loadYaml(path))

  // Nunjucks' selectattr only tests truthiness, so it can't match on a value.
  eleventyConfig.addFilter('where', (items, key, value) => (items ?? []).filter((i) => i[key] === value))
  eleventyConfig.addFilter('date', (iso) => (iso ? fmtDate(String(iso)) : ''))
  eleventyConfig.addFilter('ragTag', (rag) =>
    `<strong class="govuk-tag ${RAG_TAG[rag] ?? 'govuk-tag--grey'}">${String(rag ?? 'unknown').toUpperCase()}</strong>`)
  eleventyConfig.addFilter('statusTag', (text, category) =>
    `<strong class="govuk-tag ${CATEGORY_TAG[category] ?? 'govuk-tag--grey'}">${text}</strong>`)

  eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' })
  if (existsSync('build/roadmap.pdf')) eleventyConfig.addPassthroughCopy({ 'build/roadmap.pdf': 'roadmap/roadmap.pdf' })

  return {
    dir: { input: 'src', includes: '_includes' },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk',
    // GitHub Pages serves the project at /<repo>/; the plugin rewrites absolute links to match.
    pathPrefix: process.env.PATH_PREFIX ?? '/',
  }
}
