// Runs every source reader and files their findings under the layout's rows. A reader that
// fails outright leaves its rows without evidence, which the report shows as "To confirm".

import type { Layout, ReleaseConfig } from './config.ts'
import { type CosmosQuery, cosmosReader } from './sources/cosmos.ts'
import { type GitHubApi, type GitHubTarball, githubReader } from './sources/github.ts'
import { jiraReader } from './sources/jira.ts'
import { riaReader } from './sources/ria.ts'
import { type HttpJson, type Item, reason } from './sources/common.ts'
import { sonarReader } from './sources/sonar.ts'
import { quietRunner } from './twg.ts'
import type { TwgRunner } from '../roadmap-runner.ts'
import type { Evidence, EvidenceItem } from './types.ts'

export interface Sources {
  http?: HttpJson
  cosmos?: CosmosQuery
  githubApi?: GitHubApi
  tarball?: GitHubTarball
  twg?: TwgRunner
  now?: () => Date
}

export function readers(cfg: ReleaseConfig, s: Sources = {}): Record<string, () => Promise<Item[]>> {
  return {
    sonarcloud: sonarReader(cfg, s.http, s.now),
    cosmos: cosmosReader(cfg, s.cosmos, s.now),
    github: githubReader(cfg, s.githubApi, s.tarball, s.now),
    jira: jiraReader(cfg, s.twg ?? quietRunner, s.now),
    ria: riaReader(cfg, s.twg ?? quietRunner, s.now),
  }
}

/** Gives each item the row(s) its rule answers in this layout; items no row asks for are dropped. */
export function fileUnderRows(layout: Layout, items: Item[]): EvidenceItem[] {
  const rows = [...(layout.info?.rows ?? []).map((r) => ({ ...r, table: 'info' })), ...layout.checklist.rows.map((r) => ({ ...r, table: 'checklist' }))]
  const out: EvidenceItem[] = []
  for (const it of items) {
    if (it.rule === 'human') {
      const row = String(it.data?.row ?? '')
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
