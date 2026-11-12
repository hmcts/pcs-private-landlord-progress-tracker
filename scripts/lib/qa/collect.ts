// Runs every source reader and files their findings under the layout's rows. A reader that
// fails outright leaves its rows without evidence, which the report shows as "To confirm".

import type { Layout, ReleaseConfig } from './config.ts'
import { type CosmosQuery, cosmosReader } from './sources/cosmos.ts'
import { type GitHubApi, type GitHubTarball, githubReader } from './sources/github.ts'
import { jiraReader } from './sources/jira.ts'
import { riaReader } from './sources/ria.ts'
import { type HttpJson, type Item, reason } from './sources/common.ts'
import { sonarReader } from './sources/sonar.ts'
import { type AsyncTwgRunner, quietRunnerAsync } from './twg.ts'
import type { Evidence, EvidenceItem } from './types.ts'
import { QaError } from './errors.ts'
import { isRec, str } from './util.ts'

export interface Sources {
  http?: HttpJson
  cosmos?: CosmosQuery
  githubApi?: GitHubApi
  tarball?: GitHubTarball
  twg?: AsyncTwgRunner
  now?: () => Date
}

export function readers(cfg: ReleaseConfig, s: Sources = {}): Record<string, () => Promise<Item[]>> {
  return {
    sonarcloud: sonarReader(cfg, s.http, s.now),
    cosmos: cosmosReader(cfg, s.cosmos, s.now),
    github: githubReader(cfg, s.githubApi, s.tarball, s.now),
    jira: jiraReader(cfg, s.twg ?? quietRunnerAsync, s.now),
    ria: riaReader(cfg, s.twg ?? quietRunnerAsync, s.now),
  }
}

/** Gives each item the row(s) its rule answers in this layout; items no row asks for are dropped. */
export function fileUnderRows(layout: Layout, items: Item[]): EvidenceItem[] {
  const rows = [...(layout.info?.rows ?? []).map((r) => ({ ...r, table: 'info' })), ...layout.checklist.rows.map((r) => ({ ...r, table: 'checklist' }))]
  const out: EvidenceItem[] = []
  for (const it of items) {
    if (it.rule === 'human') {
      const row = str(it.data?.row)
      if (layout.checklist.rows.some((r) => r.key === row)) out.push({ ...it, row })
      continue
    }
    for (const r of rows.filter((r) => r.rule === it.rule)) out.push({ ...it, row: r.table === 'info' ? `info:${r.key}` : r.key })
  }
  return out
}

export async function collect(cfg: ReleaseConfig, layout: Layout, rs: Record<string, () => Promise<Item[]>>,
  now: () => Date = () => new Date()): Promise<{ evidence: Evidence; errors: Record<string, string> }> {
  const items: Item[] = []
  const errors: Record<string, string> = {}
  await Promise.all(Object.entries(rs).map(async ([name, read]) => {
    try {
      items.push(...await read())
    } catch (e) {
      errors[name] = reason(e)
    }
  }))
  const order = Object.keys(rs)
  items.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))
  return {
    evidence: { release: cfg.release, generatedAt: now().toISOString(), candidates: cfg.candidates, items: fileUnderRows(layout, items) },
    errors,
  }
}

/** An evidence file read back, checked to be this release's, for exactly its candidate commits. */
export function evidenceFor(doc: unknown, cfg: ReleaseConfig): Evidence {
  if (!isRec(doc) || !Array.isArray(doc.items) || !Array.isArray(doc.candidates)) {
    throw new QaError('evidence-invalid', 'expected { release, candidates, items }')
  }
  const same = (a: unknown, b: { name: string; shas: Record<string, string> }) => {
    if (!isRec(a) || a.name !== b.name || !isRec(a.shas)) return false
    const shas = a.shas
    return Object.keys(shas).length === Object.keys(b.shas).length && Object.entries(b.shas).every(([r, sha]) => shas[r] === sha)
  }
  const given: unknown[] = doc.candidates
  if (doc.release !== cfg.release || given.length !== cfg.candidates.length || !cfg.candidates.every((c, n) => same(given[n], c))) {
    throw new QaError('evidence-mismatch', `the evidence is for ${str(doc.release)}, or other candidates than the config's`)
  }
  return doc as unknown as Evidence
}
