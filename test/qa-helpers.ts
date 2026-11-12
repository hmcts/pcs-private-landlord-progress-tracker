// Fixtures shared by the QA report tests. Everything here is made up, apart from the R1.3A
// commits, repo names and Jira keys, which are in the committed config anyway.

import { gzipSync } from 'node:zlib'
import type { ReleaseConfig } from '../scripts/lib/qa/config.ts'
import type { Item } from '../scripts/lib/qa/sources/common.ts'
import type { TwgRunner } from '../scripts/lib/roadmap-runner.ts'

export const NOW = () => new Date('2026-09-19T08:00:00Z')

export const SHA = {
  api1: 'e11f333989ad16e73efc00a06882f9d36bc26444',
  fe1: 'a25f6121da3a13da2acd9377ed8d4df8b37754bd',
  api2: 'a8606ea0ce95532cd7d270baeb6a07881082259e',
  fe2: '5b8fb2e8578af40c76312cb1437e387048a78dec',
}

export const CFG: ReleaseConfig = {
  release: 'TEST',
  active: true,
  layout: 'pcs',
  jql: 'project = HDPI AND labels = "TEST"',
  candidates: [
    { name: 'V1', shas: { 'pcs-api': SHA.api1, 'pcs-frontend': SHA.fe1 } },
    { name: 'V2', shas: { 'pcs-api': SHA.api2, 'pcs-frontend': SHA.fe2 } },
  ],
  repos: {
    'pcs-api': { github: 'hmcts/pcs-api', sonar: 'uk.gov.hmcts.reform:pcs-api-2', cosmos_product: 'pcs', cosmos_component: 'api', builder: 'gradle' },
    'pcs-frontend': { github: 'hmcts/pcs-frontend', sonar: 'pcs-frontend', cosmos_product: 'pcs', cosmos_component: 'frontend', builder: 'yarn' },
  },
  human_rows: { '16': 'HDPI-8908', '17': ['HDPI-8670', 'HDPI-8671'] },
}

/** A twg runner that answers from a function of its arguments, and records every call. */
export function fakeTwg(answer: (args: string[]) => unknown): TwgRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = ((args: string[]) => {
    calls.push(args)
    const out = answer(args)
    if (out instanceof Error) throw out
    return typeof out === 'string' ? out : JSON.stringify(out)
  }) as TwgRunner & { calls: string[][] }
  run.calls = calls
  return run
}

export const jqlOf = (args: string[]): string => args[args.indexOf('--jql') + 1] ?? ''

/** A gzipped tarball laid out as GitHub's codeload serves one. */
export function tarball(files: Record<string, string>, root = 'hmcts-pcs-api-a8606ea'): Buffer {
  const blocks: Buffer[] = []
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512)
    h.write(name.slice(0, 100), 0)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124)
    h.write(type, 156)
    h.write('ustar\0', 257)
    return h
  }
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
  blocks.push(header('pax_global_header', 0, 'g'))
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`
    const body = Buffer.from(text)
    if (full.length > 100) {
      const rec = ` path=${full}\n`
      let len = rec.length + 2
      while (`${len}${rec}`.length !== len) len++
      const pax = Buffer.from(`${len}${rec}`)
      blocks.push(header('PaxHeader', pax.length, 'x'), pad(pax))
    }
    blocks.push(header(full, body.length, '0'), pad(body))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export function fact(over: Partial<Item> & { rule: string; status: Item['status'] }): Item {
  return { value: over.status, links: [], source: 'test', sha: null, fetchedAt: NOW().toISOString(), ...over }
}

/** Gives every block a local id, as twg does when it returns a page. */
export function withIds(html: string): string {
  let n = 0
  return html.replace(/<(h1|h2|p|table|tr|th|td)(?=[\s>])/g, (_m, tag: string) => `<${tag} data-local-id="${(++n).toString(16).padStart(12, '0')}"`)
}
