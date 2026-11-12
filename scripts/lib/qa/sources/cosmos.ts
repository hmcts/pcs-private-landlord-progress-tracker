// Jenkins pipeline results from the pipeline-metrics Cosmos account, which cnp-jenkins-library
// writes to (database `jenkins`):
//
//   pipeline-metrics: one document per stage of every build, from MetricsPublisher.groovy. The
//     library's `after:all` callback publishes the stage name as current_step_name once the
//     stage has run, and "Pipeline Succeeded" / "Pipeline Failed" when the build ends.
//     current_build_current_result is the build's result at that moment, so a failing stage can
//     still say SUCCESS: in a failed build, the last stage to report is taken as the failure.
//   cve-reports: one document per security check, from CVEPublisher.groovy:
//     { build: { build_tag, build_display_name, branch_name, git_url, codebase_type }, report }.
//     A java report is OWASP dependency-check JSON trimmed to vulnerable dependencies
//     (GradleBuilder.prepareCVEReport); a node report is { vulnerabilities, summary, suppressed }
//     from yarn audit (YarnBuilder.prepareCVEReport). It has no commit, so it is joined to the
//     build through build_tag, which pipeline-metrics also records.
//
// Only builds of the candidate commit count: master builds, and nightly builds that ran on it.
// Every repo of every candidate gets an item for each rule it answers, unknown if need be.

import type { Candidate, ReleaseConfig } from '../config.ts'
import { day, item, type Item, reason, short } from './common.ts'

export const COSMOS_URL = 'https://pipeline-metrics.documents.azure.com:443/'
export const DATABASE = 'jenkins'
const SOURCE = 'cosmos'

export interface StageEvent {
  job_name: string
  branch_name?: string
  build_number: string | number
  build_tag?: string
  build_url?: string
  current_step_name: string
  current_build_current_result?: string | null
  current_build_duration?: number
  current_build_scheduled_time?: string
  git_commit?: string
}

export interface CveDoc {
  build: { build_tag?: string; build_display_name?: string; codebase_type?: string }
  report?: {
    dependencies?: { fileName?: string; vulnerabilities?: { name: string; severity?: string }[]; suppressedVulnerabilities?: { name: string; severity?: string }[] }[]
    vulnerabilities?: { title?: string; module_name?: string; severity?: string }[]
    suppressed?: { title?: string; module_name?: string; severity?: string }[]
    summary?: { vulnerabilities?: Record<string, number> }
  }
}

/** Runs one Cosmos SQL query against a container. Injected in tests. */
export type CosmosQuery = (container: 'pipeline-metrics' | 'cve-reports', query: string,
  parameters: { name: string; value: unknown }[]) => Promise<unknown[]>

/** A read-only key from COSMOS_PIPELINE_METRICS_KEY if set, else the Azure CLI's sign-in. */
export function defaultCosmosQuery(env: NodeJS.ProcessEnv = process.env): CosmosQuery {
  let db: Promise<{ container(id: string): { items: { query(q: unknown): { fetchAll(): Promise<{ resources: unknown[] }> } } } }> | undefined
  const open = async () => {
    const { CosmosClient } = await import('@azure/cosmos')
    const key = env.COSMOS_PIPELINE_METRICS_KEY
    const connectionPolicy = { requestTimeout: 30_000, retryOptions: { maxRetryAttemptCount: 2, fixedRetryIntervalInMilliseconds: 1000, maxWaitTimeInSeconds: 30 } }
    if (key) return new CosmosClient({ endpoint: COSMOS_URL, key, connectionPolicy }).database(DATABASE)
    const { AzureCliCredential } = await import('@azure/identity')
    return new CosmosClient({ endpoint: COSMOS_URL, aadCredentials: new AzureCliCredential(), connectionPolicy }).database(DATABASE)
  }
  return async (container, query, parameters) => {
    db ??= open()
    const { resources } = await (await db).container(container).items.query({ query, parameters }).fetchAll()
    return resources
  }
}

const FINAL = new Set(['Pipeline Succeeded', 'Pipeline Failed'])
// WarningCollector keys arrive as pseudo-stages; they are not stages (as scripts/pipeline-health in cft-workspace).
const WARNING = /deprecat|unpinned|_moved|^old_|^missing_|renovate_config|internal_domain|jitpack|not_approved|AUTO_ABORT|Terraform was not formatted|^not-approved/i

export interface Build {
  job: string
  number: number
  kind: 'master' | 'nightly'
  url: string
  tag: string
  started: string
  outcome: 'SUCCESS' | 'FAILURE' | 'UNFINISHED'
  stages: Map<string, 'pass' | 'fail'>
}

export function toBuilds(events: StageEvent[]): Build[] {
  const groups = new Map<string, StageEvent[]>()
  for (const e of events) {
    const k = `${e.job_name}#${e.build_number}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const out: Build[] = []
  for (const ev of groups.values()) {
    const first = ev[0]
    const nightly = first.job_name.split('/')[0].endsWith('_Nightly')
    const master = ['master', 'main'].includes(first.branch_name ?? '')
    if (!nightly && !master) continue
    ev.sort((a, b) => (a.current_build_duration ?? 0) - (b.current_build_duration ?? 0))
    const final = ev.filter((e) => FINAL.has(e.current_step_name)).at(-1)
    const outcome = !final ? 'UNFINISHED' : final.current_step_name === 'Pipeline Succeeded' ? 'SUCCESS' : 'FAILURE'
    const stages = ev.filter((e) => !FINAL.has(e.current_step_name) && !WARNING.test(e.current_step_name))
    let failed = stages.findIndex((e) => e.current_build_current_result && e.current_build_current_result !== 'SUCCESS')
    if (failed < 0 && outcome === 'FAILURE' && stages.length) failed = stages.length - 1
    const map = new Map<string, 'pass' | 'fail'>()
    stages.forEach((e, n) => {
      if (failed < 0 || n < failed) map.set(e.current_step_name, 'pass')
      else if (n === failed) map.set(e.current_step_name, 'fail')
    })
    out.push({ job: first.job_name, number: Number(first.build_number), kind: nightly ? 'nightly' : 'master',
      url: ev.find((e) => e.build_url)?.build_url ?? '', tag: ev.find((e) => e.build_tag)?.build_tag ?? '',
      started: ev.find((e) => e.current_build_scheduled_time)?.current_build_scheduled_time ?? '', outcome, stages: map })
  }
  return out.sort((a, b) => b.number - a.number)
}

/** Which stages answer which rule. Stage names are cnp-jenkins-library callAround names. */
export const STAGE_RULES: Record<string, RegExp> = {
  'integration-contract': /^(pact-consumer-tests|pact-provider-verification|contractTest|integrationTest)(:|$)/i,
  functional: /^(smoketest|functionalTest|fullFunctionalTest|E2eTest|crossBrowserTest|mutationTest|apiGatewayTest):(?!preview)/i,
  'deployed-aat': /^(smoketest|functionalTest):aat$/i,
}

export function stageItems(repo: string, sha: string, c: Candidate, builds: Build[], now?: () => Date): Item[] {
  const latest = (kind: Build['kind']) => builds.find((b) => b.kind === kind)
  const picked = [latest('master'), latest('nightly')].filter((b): b is Build => !!b)
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  return Object.entries(STAGE_RULES).map(([rule, re]) => {
    const hits: string[] = []
    const links = []
    let pass = 0
    let fail = 0
    for (const b of picked) {
      const st = [...b.stages].filter(([name]) => re.test(name))
      if (!st.length) continue
      for (const [, s] of st) s === 'pass' ? pass++ : fail++
      hits.push(`${b.kind} #${b.number}${b.started ? ` (${day(b.started)})` : ''}: ` +
        st.map(([name, s]) => `${name} ${s === 'pass' ? 'passed' : 'failed'}`).join(', '))
      if (b.url) links.push({ text: `${repo} ${b.kind} #${b.number}`, url: b.url })
    }
    if (!pass && !fail) {
      return item({ ...base, rule, status: 'unknown', value: 'not run',
        note: picked.length ? `no matching stage ran in the Jenkins builds of ${short(sha)}` : `no master or nightly Jenkins build of ${short(sha)} is recorded` }, now)
    }
    return item({ ...base, rule, status: fail ? 'fail' : 'pass', value: hits.join('; '), links,
      data: { builds: picked.map((b) => ({ job: b.job, number: b.number, outcome: b.outcome })) } }, now)
  })
}

const SEVERITY: Record<string, string> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', info: 'low' }

export interface CveSummary {
  type: 'java' | 'node'
  open: number
  suppressed: number
  bySeverity: Record<string, number>
}

export function summariseCve(doc: CveDoc): CveSummary {
  const type = doc.build.codebase_type === 'node' ? 'node' : 'java'
  const bySeverity: Record<string, number> = {}
  const count = (sev?: string) => {
    const s = SEVERITY[(sev ?? '').toLowerCase()] ?? 'unrated'
    bySeverity[s] = (bySeverity[s] ?? 0) + 1
  }
  if (type === 'java') {
    const open = new Map<string, string | undefined>()
    const supp = new Set<string>()
    for (const d of doc.report?.dependencies ?? []) {
      for (const v of d.vulnerabilities ?? []) open.set(v.name, v.severity)
      for (const v of d.suppressedVulnerabilities ?? []) supp.add(v.name)
    }
    for (const sev of open.values()) count(sev)
    return { type, open: open.size, suppressed: supp.size, bySeverity }
  }
  const key = (v: { title?: string; module_name?: string }) => `${v.module_name}|${v.title}`
  const supp = new Set((doc.report?.suppressed ?? []).map(key))
  const open = (doc.report?.vulnerabilities ?? []).filter((v) => !supp.has(key(v)))
  for (const v of open) count(v.severity)
  return { type, open: open.length, suppressed: supp.size, bySeverity }
}

const cveRule = (type: 'java' | 'node') => (type === 'java' ? 'dependency-check' : 'yarn-audit')
const CHECKER: Record<string, string> = { java: 'OWASP dependency-check', node: 'yarn audit' }

export function cveItem(repo: string, sha: string, c: Candidate, build: Build, doc: CveDoc, now?: () => Date): Item {
  const s = summariseCve(doc)
  const sev = Object.entries(s.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')
  // Suppressed findings were reported and then accepted, so the answer is Yes even when they pass.
  const answer = s.open + s.suppressed > 0 ? 'Yes' : 'No'
  return item({ source: SOURCE, sha, repo, candidate: c.name, rule: cveRule(s.type), status: s.open ? 'fail' : 'pass', answer,
    value: `${CHECKER[s.type]}: ${s.open} open${sev ? ` (${sev})` : ''}, ${s.suppressed} suppressed`,
    links: build.url ? [{ text: `${repo} ${build.kind} #${build.number}`, url: build.url }] : [],
    note: `${build.kind} build #${build.number} of ${short(sha)}`, data: { open: s.open, suppressed: s.suppressed, bySeverity: s.bySeverity } }, now)
}

const STAGE_FIELDS = ['job_name', 'branch_name', 'build_number', 'build_tag', 'build_url', 'current_step_name',
  'current_build_current_result', 'current_build_duration', 'current_build_scheduled_time', 'git_commit']

export function cosmosReader(cfg: ReleaseConfig, query: CosmosQuery = defaultCosmosQuery(), now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const out: Item[] = []
    let down: string | null = null
    for (const c of cfg.candidates) {
      for (const [repo, sha] of Object.entries(c.shas)) {
        const rc = cfg.repos[repo]
        const cveRules = rc.builder === 'gradle' ? ['dependency-check'] : rc.builder === 'yarn' ? ['yarn-audit'] : ['dependency-check', 'yarn-audit']
        const unknown = (note: string) => [...Object.keys(STAGE_RULES), ...cveRules].map((rule) =>
          item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked', note }, now))
        if (!rc.cosmos_product) {
          out.push(...unknown('no Jenkins product and component are configured for the repo'))
          continue
        }
        if (down) {
          out.push(...unknown(down))
          continue
        }
        let builds: Build[]
        try {
          const rows = await query('pipeline-metrics',
            `SELECT ${STAGE_FIELDS.map((f) => `c.${f}`).join(', ')} FROM c WHERE c.git_commit = @sha AND c.product = @p AND c.component = @c`,
            [{ name: '@sha', value: sha }, { name: '@p', value: rc.cosmos_product }, { name: '@c', value: rc.cosmos_component }])
          builds = toBuilds(rows as StageEvent[])
        } catch (e) {
          down = `Cosmos pipeline-metrics could not be read: ${reason(e)}`
          out.push(...unknown(down))
          continue
        }
        out.push(...stageItems(repo, sha, c, builds, now))

        const withCve = builds.filter((b) => b.tag)
        let docs: CveDoc[] = []
        let cveError: string | null = null
        if (withCve.length) {
          try {
            docs = await query('cve-reports',
              'SELECT c.build, c.report FROM c WHERE ARRAY_CONTAINS(@tags, c.build.build_tag)',
              [{ name: '@tags', value: withCve.map((b) => b.tag) }]) as CveDoc[]
          } catch (e) {
            cveError = `Cosmos cve-reports could not be read: ${reason(e)}`
          }
        }
        // The newest master build's report, else the newest nightly's.
        const ordered = [...withCve].sort((a, b) => (a.kind === b.kind ? b.number - a.number : a.kind === 'master' ? -1 : 1))
        const found = new Set<string>()
        for (const b of ordered) {
          for (const d of docs.filter((d) => d.build.build_tag === b.tag)) {
            const it = cveItem(repo, sha, c, b, d, now)
            if (found.has(it.rule)) continue
            found.add(it.rule)
            out.push(it)
          }
        }
        for (const rule of cveRules.filter((r) => !found.has(r))) {
          if (!cveError && rc.builder === undefined && found.size) continue
          out.push(item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked',
            note: cveError ?? `no ${rule === 'yarn-audit' ? 'yarn audit' : 'dependency-check'} report is recorded for the Jenkins builds of ${short(sha)}` }, now))
        }
      }
    }
    return out
  }
}
