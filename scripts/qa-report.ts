// Generates a release's QA readiness report and merges it into its Confluence page.
//
//   node scripts/qa-report.ts --release R1.3A [--evidence <file>] [--judgement <file>] [--publish]
//                             [--validate] [--create-under <parentPageId>] [--config <file>]
//   node scripts/qa-report.ts --all-active [--publish] [--validate]
//
// Collects evidence for the release's candidate commits (SonarCloud, Jenkins results in Cosmos,
// GitHub, Jira and the Release Impact Assessment), renders the report, and merges it into
// report_page. It's a dry run unless --publish is given: the merged page and a diff are
// written to the cache directory (see scripts/lib/qa/cache.ts) and nothing is written to
// Confluence. --validate also has twg check the edits, without writing them. --evidence
// skips collecting and uses an evidence file from an earlier run. --judgement fills rows a
// person answers from a file (see scripts/lib/qa/judgement.ts). --all-active runs every
// release with `active: true` and a report_page, each on its own: one failing doesn't stop the
// rest, but fails the run.
//
// This repo and its logs are public, so this prints only counts and each row's pass, fail or
// unknown. Everything else, evidence included, stays in the cache directory. A failure prints
// only a fixed message for its kind (lib/qa/errors.ts); the error itself goes to errors.log
// there. Files named on the command line must be in config/qa-readiness or the cache directory.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { cacheDir, releaseDir, releaseName, within } from './lib/qa/cache.ts'
import { collect, evidenceFor, readers } from './lib/qa/collect.ts'
import { activeReleases, CONFIG_DIR, loadRelease, releasePath } from './lib/qa/config.ts'
import { logError, publicMessage, QaError } from './lib/qa/errors.ts'
import { type Judgements, loadJudgements } from './lib/qa/judgement.ts'
import { createPage, publishToPage, releaseTitle } from './lib/qa/publish.ts'
import { evaluate, genRows, renderPage } from './lib/qa/render.ts'
import { pageId, quietRunner } from './lib/qa/twg.ts'
import type { Evidence } from './lib/qa/types.ts'

const USAGE = 'usage: npm run qa-report -- --release <name> [--evidence <file>] [--judgement <file>] [--publish] [--validate] [--create-under <pageId>]\n' +
  '       npm run qa-report -- --all-active [--publish] [--validate]'

const OPTIONS = {
  release: { type: 'string' },
  config: { type: 'string' },
  evidence: { type: 'string' },
  judgement: { type: 'string' },
  publish: { type: 'boolean', default: false },
  validate: { type: 'boolean', default: false },
  'create-under': { type: 'string' },
  'all-active': { type: 'boolean', default: false },
} as const

function args() {
  try {
    return parseArgs({ options: OPTIONS }).values
  } catch {
    console.error(USAGE)
    process.exit(2)
  }
}

const values = args()

const say = (s: string) => console.log(s)

interface Options {
  release?: string
  evidence?: string
  judgement?: string
  createUnder?: string
  publish: boolean
  validate: boolean
}

/** 'skipped' when the page has unpublished edits, so it was left alone. */
async function report(path: string, o: Options): Promise<'done' | 'skipped'> {
  const { cfg, layout } = loadRelease(path)
  if (o.release && o.release !== cfg.release) throw new QaError('config-mismatch', `the config is for ${cfg.release}, not ${o.release}`)
  if (o.publish && !cfg.active) throw new QaError('not-active', `${cfg.release} is not active`)
  const createUnder = o.createUnder === undefined ? undefined : pageId(o.createUnder)
  const dir = releaseDir(cfg.release)

  let evidence: Evidence
  if (o.evidence) {
    let doc: unknown
    try {
      doc = JSON.parse(readFileSync(o.evidence, 'utf8'))
    } catch (e) {
      throw new QaError('evidence-invalid', `the evidence file could not be read as JSON: ${(e as Error).message}`)
    }
    evidence = evidenceFor(doc, cfg)
    say(`evidence: ${evidence.items.length} items from a file`)
  } else {
    const res = await collect(cfg, layout, readers(cfg))
    evidence = res.evidence
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    for (const source of ['sonarcloud', 'cosmos', 'github', 'jira', 'ria']) {
      const its = evidence.items.filter((i) => i.source === source)
      const n = (s: string) => its.filter((i) => i.status === s).length
      say(`${source}: ${res.errors[source] ? 'failed' : `${its.length} items, ${n('pass')} pass, ${n('fail')} fail, ${n('unknown')} unknown`}`)
    }
  }

  const results = evaluate(cfg, layout, evidence)
  const judgements: Judgements = o.judgement ? loadJudgements(o.judgement, results.checklist) : {}
  for (const r of results.checklist) {
    const note = judgements[r.key] ? ' (judgement given)' : r.needsJudgement ? ' (needs a person)' : ''
    say(`row ${r.key.padEnd(3)} ${r.status}${note}`)
  }
  const tally = (s: string) => results.checklist.filter((r) => r.status === s).length
  say(`${results.checklist.length} rows: ${tally('pass')} pass, ${tally('fail')} fail, ${tally('unknown')} unknown` +
    (o.judgement ? `, ${Object.keys(judgements).length} judgements given` : ''))

  const rows = genRows(layout, results, judgements)
  const page = renderPage(cfg, layout, results, judgements)
  writeFileSync(join(dir, 'report.html'), page)

  const run = quietRunner
  if (cfg.report_page) {
    const res = publishToPage(run, pageId(cfg.report_page), layout, rows, dir, { publish: o.publish, validate: o.validate })
    if (res.unpublishedEdits) {
      say(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}${cfg.release}: page has unpublished edits; skipped`)
      return 'skipped'
    }
    const c = res.counts
    const would = res.published ? '' : 'would be '
    const tail = `${c.judged} judgement cells ${would}written, ${c.added} rows ${would}added, ${c.human} cells kept as people wrote them, ${c.skipped} skipped`
    say(res.published ? `${c.change} cells changed, ${tail}${res.retried ? ' (after re-reading the page)' : ''}`
      : `${c.change} cells would change, ${tail}`)
    if (res.validated !== undefined) say(`twg validation: ${res.validated ? 'passed' : 'failed'}`)
  } else if (createUnder) {
    const id = createPage(run, createUnder, releaseTitle(cfg, layout), page, dir, o.publish)
    say(id ? `created page ${id}: set report_page: '${id}' in the config` : `a new page with ${rows.length} rows would be created`)
  } else {
    say('no report_page in the config, so the report was only rendered (use --create-under <pageId> to create one)')
  }
  return 'done'
}

async function main(): Promise<number> {
  if (values['all-active']) {
    const only = (['release', 'config', 'evidence', 'judgement', 'create-under'] as const).filter((k) => values[k] !== undefined)
    if (only.length) {
      console.error(`--all-active can't be combined with --${only.join(', --')}`)
      return 2
    }
    const paths = activeReleases()
    if (!paths.length) {
      say('no active releases with a report_page, so there is nothing to do')
      return 0
    }
    let failed = 0
    let skipped = 0
    for (const path of paths) {
      const name = basename(path, '.yaml')
      say(`release ${name}`)
      try {
        if (await report(path, { publish: values.publish, validate: values.validate }) === 'skipped') skipped++
      } catch (e) {
        failed++
        logError(cacheDir(), name, e)
        console.error(`qa-report failed for ${name}: ${publicMessage(e)}`)
      }
    }
    say(`${paths.length} releases: ${paths.length - failed - skipped} done, ${skipped} skipped for unpublished edits, ${failed} failed`)
    return failed ? 1 : 0
  }

  if (!values.release && !values.config) {
    console.error(USAGE)
    return 2
  }
  const cache = cacheDir()
  const release = values.release === undefined ? undefined : releaseName(values.release)
  const config = values.config === undefined ? releasePath(release!) : within(values.config, [CONFIG_DIR, cache])
  await report(config, {
    release,
    evidence: values.evidence === undefined ? undefined : within(values.evidence, [cache]),
    judgement: values.judgement === undefined ? undefined : within(values.judgement, [cache]),
    createUnder: values['create-under'], publish: values.publish, validate: values.validate,
  })
  return 0
}

main().then((code) => process.exit(code), (e) => {
  try {
    logError(cacheDir(), values.release ?? 'qa-report', e)
  } catch {
    // No cache directory to log to; the message below is all there is.
  }
  console.error(`qa-report failed: ${publicMessage(e)}`)
  process.exit(1)
})
