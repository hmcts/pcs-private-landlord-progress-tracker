// Jenkins pipeline results from the pipeline-metrics Cosmos account, which cnp-jenkins-library
// writes to. Both its publishers pick the database through CosmosDbTargetResolver: `sds-jenkins`
// for repos with the `jenkins-sds` topic, `jenkins` for the rest. A repo that gained the topic has
// older documents in one and newer in the other, so both are always read.
//
//   pipeline-metrics: one document per stage of every build, from MetricsPublisher.groovy. The
//     library's `after:all` callback publishes the stage name as current_step_name once the
//     stage has run, and "Pipeline Succeeded" / "Pipeline Failed" when the build ends.
//     current_build_current_result is the build's result at that moment, and a failing stage can
//     still say SUCCESS, so the first event that doesn't may come from the stage after the one
//     that failed. In a failed build, that stage and the one before it are both taken as the
//     failure (the last stage, if none says otherwise); only stages before them passed, and
//     nothing is known about later ones. Builds with no final event, or that were aborted,
//     aren't counted.
//   cve-reports: one document per security check, from CVEPublisher.groovy (shapes in cve.ts).
//     It has no commit, so it is joined to the build through build_tag, which pipeline-metrics
//     also records, and must name the repo in build.git_url. Of two reports for one build and
//     type, the newer (_ts) wins.
//
// Only builds of the candidate commit count: master builds, and nightly builds that ran on it.
// Every repo of every candidate gets an item for each rule it answers, unknown if need be.

import type { Candidate, ReleaseConfig } from '../config.ts'
import { day, item, type Item, reason, short } from './common.ts'
import { codebaseType, type CodebaseType, type CveDoc, repoFromGitUrl, summariseCve } from './cve.ts'

export type { CveDoc } from './cve.ts'
export { summariseCve } from './cve.ts'

export const COSMOS_URL = 'https://pipeline-metrics.documents.azure.com:443/'
export const DATABASES = ['jenkins', 'sds-jenkins'] as const
export type Database = (typeof DATABASES)[number]
export const BRANCHES = ['master', 'main']
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

/** Runs one Cosmos SQL query against a container in one database. Injected in tests. */
export type CosmosQuery = (database: Database, container: 'pipeline-metrics' | 'cve-reports', query: string,
  parameters: { name: string; value: unknown }[]) => Promise<unknown[]>

/** A read-only key from COSMOS_PIPELINE_METRICS_KEY if set, else the Azure CLI's sign-in. */
export function defaultCosmosQuery(env: NodeJS.ProcessEnv = process.env): CosmosQuery {
  type Client = { database(id: string): { container(id: string): { items: { query(q: unknown): { fetchAll(): Promise<{ resources: unknown[] }> } } } } }
  let client: Promise<Client> | undefined
  const open = async (): Promise<Client> => {
    const { CosmosClient } = await import('@azure/cosmos')
    const key = env.COSMOS_PIPELINE_METRICS_KEY
    const connectionPolicy = { requestTimeout: 30_000, retryOptions: { maxRetryAttemptCount: 2, fixedRetryIntervalInMilliseconds: 1000, maxWaitTimeInSeconds: 30 } }
    if (key) return new CosmosClient({ endpoint: COSMOS_URL, key, connectionPolicy })
    const { AzureCliCredential } = await import('@azure/identity')
    return new CosmosClient({ endpoint: COSMOS_URL, aadCredentials: new AzureCliCredential(), connectionPolicy })
  }
  return async (database, container, query, parameters) => {
    client ??= open()
    const { resources } = await (await client).database(database).container(container).items.query({ query, parameters }).fetchAll()
    return resources
  }
}

/** The same query against both databases, their rows together. */
async function everywhere(query: CosmosQuery, container: 'pipeline-metrics' | 'cve-reports', q: string,
  parameters: { name: string; value: unknown }[]): Promise<unknown[]> {
  return (await Promise.all(DATABASES.map((db) => query(db, container, q, parameters)))).flat()
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
  outcome: 'SUCCESS' | 'FAILURE'
  stages: Map<string, 'pass' | 'fail'>
  /** In a failed build, the stages that may have failed: one, or two Jenkins can't tell apart. */
  suspects: string[]
}

/** Indexes of the stages that may have failed (see the header). */
function suspectStages(stages: StageEvent[], outcome: Build['outcome']): number[] {
  if (outcome === 'SUCCESS' || !stages.length) return []
  const bad = stages.findIndex((e) => e.current_build_current_result && e.current_build_current_result !== 'SUCCESS')
  return bad < 0 ? [stages.length - 1] : [bad - 1, bad].filter((n) => n >= 0)
}

function stageResults(stages: StageEvent[], suspect: number[]): Map<string, 'pass' | 'fail'> {
  const map = new Map<string, 'pass' | 'fail'>()
  stages.forEach((e, n) => {
    if (!suspect.length || n < suspect[0]) map.set(e.current_step_name, 'pass')
    else if (suspect.includes(n)) map.set(e.current_step_name, 'fail')
  })
  return map
}

/** One build's events as a Build, or null for a build that doesn't count. */
function toBuild(ev: StageEvent[]): Build | null {
  const first = ev[0]
  const nightly = first.job_name.split('/')[0].endsWith('_Nightly')
  if (!nightly && !BRANCHES.includes(first.branch_name ?? '')) return null
  const sorted = [...ev].sort((a, b) => (a.current_build_duration ?? 0) - (b.current_build_duration ?? 0))
  const final = sorted.filter((e) => FINAL.has(e.current_step_name)).at(-1)
  if (!final || final.current_build_current_result === 'ABORTED') return null
  const outcome = final.current_step_name === 'Pipeline Succeeded' ? 'SUCCESS' : 'FAILURE'
  const stages = sorted.filter((e) => !FINAL.has(e.current_step_name) && !WARNING.test(e.current_step_name))
  const suspect = suspectStages(stages, outcome)
  const field = (k: 'build_url' | 'build_tag' | 'current_build_scheduled_time') => sorted.find((e) => e[k])?.[k] ?? ''
  return { job: first.job_name, number: Number(first.build_number), kind: nightly ? 'nightly' : 'master', url: field('build_url'),
    tag: field('build_tag'), started: field('current_build_scheduled_time'), outcome, stages: stageResults(stages, suspect),
    suspects: suspect.map((n) => stages[n].current_step_name) }
}

export function toBuilds(events: StageEvent[]): Build[] {
  const groups = new Map<string, StageEvent[]>()
  for (const e of events) {
    const k = `${e.job_name}#${e.build_number}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return [...groups.values()].map(toBuild).filter((b): b is Build => !!b).sort((a, b) => b.number - a.number)
}

/** Which stages answer which rule. Stage names are cnp-jenkins-library callAround names. */
export const STAGE_RULES: Record<string, RegExp> = {
  'integration-contract': /^(pact-consumer-tests|pact-provider-verification|contractTest|integrationTest)(:|$)/i,
  functional: /^(smoketest|functionalTest|fullFunctionalTest|E2eTest|crossBrowserTest|mutationTest|apiGatewayTest):(?!preview)/i,
  'deployed-aat': /^(smoketest|functionalTest):aat$/i,
}

/** The latest build of each job, master jobs first. */
const latestPerJob = (builds: Build[]) => [...new Map(builds.map((b) => [b.job, b] as const).reverse()).values()].sort((a, b) =>
  a.kind === b.kind ? a.job.localeCompare(b.job) : a.kind === 'master' ? -1 : 1)

function stageItem(rule: string, re: RegExp, picked: Build[], repo: string, sha: string, base: Omit<Parameters<typeof item>[0], 'rule' | 'status' | 'value'>,
  now?: () => Date): Item {
  const hits: string[] = []
  const links = []
  const unsure: string[] = []
  let pass = 0
  let fail = 0
  for (const b of picked) {
    const st = [...b.stages].filter(([name]) => re.test(name))
    if (!st.length) continue
    for (const [, s] of st) s === 'pass' ? pass++ : fail++
    if (b.suspects.length > 1 && st.some(([name, s]) => s === 'fail' && b.suspects.includes(name))) {
      unsure.push(`${b.kind} #${b.number}: Jenkins can't tell whether ${b.suspects.join(' or ')} failed`)
    }
    hits.push(`${b.kind} #${b.number}${b.started ? ` (${day(b.started)})` : ''}: ` +
      st.map(([name, s]) => `${name} ${s === 'pass' ? 'passed' : 'failed'}`).join(', '))
    if (b.url) links.push({ text: `${repo} ${b.kind} #${b.number}`, url: b.url })
  }
  if (!pass && !fail) {
    return item({ ...base, rule, status: 'unknown', value: 'not run',
      note: picked.length ? `no matching stage ran in the Jenkins builds of ${short(sha)}` : `no master or nightly Jenkins build of ${short(sha)} is recorded` }, now)
  }
  return item({ ...base, rule, status: fail ? 'fail' : 'pass', value: hits.join('; '), links, note: unsure.join('; ') || undefined,
    data: { builds: picked.map((b) => ({ job: b.job, number: b.number, outcome: b.outcome })) } }, now)
}

export function stageItems(repo: string, sha: string, c: Candidate, builds: Build[], now?: () => Date): Item[] {
  const picked = latestPerJob(builds)
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  return Object.entries(STAGE_RULES).map(([rule, re]) => stageItem(rule, re, picked, repo, sha, base, now))
}

export const CVE_RULE: Record<CodebaseType, string> = { java: 'dependency-check', node: 'yarn-audit' }
const CHECKER: Record<CodebaseType, string> = { java: 'OWASP dependency-check', node: 'yarn audit' }
type Builder = 'gradle' | 'yarn' | undefined

export function cveItem(repo: string, sha: string, c: Candidate, build: Build, doc: CveDoc, now?: () => Date, builder?: Builder): Item | null {
  const s = summariseCve(doc, builder)
  if (!s) return null
  const sev = Object.entries(s.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')
  // Suppressed findings were reported and then accepted, so the answer is Yes even when they pass.
  const answer = s.open + s.suppressed > 0 ? 'Yes' : 'No'
  return item({ source: SOURCE, sha, repo, candidate: c.name, rule: CVE_RULE[s.type], status: s.open ? 'fail' : 'pass', answer,
    value: `${CHECKER[s.type]}: ${s.open} open${sev ? ` (${sev})` : ''}, ${s.suppressed} suppressed`,
    links: build.url ? [{ text: `${repo} ${build.kind} #${build.number}`, url: build.url }] : [],
    note: `${build.kind} build #${build.number} of ${short(sha)}`, data: { open: s.open, suppressed: s.suppressed, bySeverity: s.bySeverity } }, now)
}

/** Per build tag and codebase type, the newest report about this repo; ties keep the first read. */
export function newestReports(docs: CveDoc[], github: string, builder?: Builder): Map<string, CveDoc> {
  const out = new Map<string, CveDoc>()
  for (const d of docs) {
    if (repoFromGitUrl(d.build.git_url) !== github.toLowerCase()) continue
    const k = `${d.build.build_tag}|${codebaseType(d, builder)}`
    const had = out.get(k)
    if (!had || (d._ts ?? 0) > (had._ts ?? 0)) out.set(k, d)
  }
  return out
}

/** The newest master build's report of each type, else the newest nightly's. */
function cveItems(repo: string, sha: string, c: Candidate, builds: Build[], reports: Map<string, CveDoc>, builder: Builder, now?: () => Date): Item[] {
  const ordered = [...builds].sort((a, b) => (a.kind === b.kind ? b.number - a.number : a.kind === 'master' ? -1 : 1))
  const found = new Map<string, Item>()
  for (const b of ordered) {
    for (const [k, d] of reports) {
      if (!k.startsWith(`${b.tag}|`)) continue
      const it = cveItem(repo, sha, c, b, d, now, builder)
      if (it && !found.has(it.rule)) found.set(it.rule, it)
    }
  }
  return [...found.values()]
}

const STAGE_FIELDS = ['job_name', 'branch_name', 'build_number', 'build_tag', 'build_url', 'current_step_name',
  'current_build_current_result', 'current_build_duration', 'current_build_scheduled_time', 'git_commit']

const STAGE_QUERY = `SELECT ${STAGE_FIELDS.map((f) => `c.${f}`).join(', ')} FROM c ` +
  'WHERE c.git_commit = @sha AND c.product = @p AND c.component = @c'
// Joined to master and nightly builds of the commit through build_tag; a report that names no
// branch is kept, since the build it joins to already says which.
const CVE_QUERY = 'SELECT c._ts, c.build, c.report FROM c WHERE ARRAY_CONTAINS(@tags, c.build.build_tag) AND ' +
  '(NOT IS_DEFINED(c.build.branch_name) OR IS_NULL(c.build.branch_name) OR ARRAY_CONTAINS(@branches, c.build.branch_name))'

export function cosmosReader(cfg: ReleaseConfig, query: CosmosQuery = defaultCosmosQuery(), now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const out: Item[] = []
    let down: string | null = null
    for (const c of cfg.candidates) {
      for (const [repo, sha] of Object.entries(c.shas)) {
        const rc = cfg.repos[repo]
        const cveRules = rc.builder === 'gradle' ? ['dependency-check'] : rc.builder === 'yarn' ? ['yarn-audit'] : ['dependency-check', 'yarn-audit']
        const unknown = (note: string, unreachable = false) => [...Object.keys(STAGE_RULES), ...cveRules].map((rule) =>
          item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked', note, unreachable }, now))
        if (!rc.cosmos_product) {
          out.push(...unknown('no Jenkins product and component are configured for the repo'))
          continue
        }
        if (down) {
          out.push(...unknown(down, true))
          continue
        }
        let builds: Build[]
        try {
          builds = toBuilds(await everywhere(query, 'pipeline-metrics', STAGE_QUERY, [{ name: '@sha', value: sha },
            { name: '@p', value: rc.cosmos_product }, { name: '@c', value: rc.cosmos_component }]) as StageEvent[])
        } catch (e) {
          down = `Cosmos pipeline-metrics could not be read: ${reason(e)}`
          out.push(...unknown(down, true))
          continue
        }
        out.push(...stageItems(repo, sha, c, builds, now))

        const withCve = builds.filter((b) => b.tag)
        let docs: CveDoc[] = []
        let cveError: string | null = null
        if (withCve.length) {
          try {
            docs = await everywhere(query, 'cve-reports', CVE_QUERY,
              [{ name: '@tags', value: withCve.map((b) => b.tag) }, { name: '@branches', value: BRANCHES }]) as CveDoc[]
          } catch (e) {
            cveError = `Cosmos cve-reports could not be read: ${reason(e)}`
          }
        }
        const reports = newestReports(docs, rc.github, rc.builder)
        const found = cveItems(repo, sha, c, withCve, reports, rc.builder, now)
        const unread = [...reports.values()].filter((d) => !summariseCve(d, rc.builder)).length
        out.push(...found)
        for (const rule of cveRules.filter((r) => !found.some((i) => i.rule === r))) {
          if (!cveError && !unread && rc.builder === undefined && found.length) continue
          const missing = `no ${rule === 'yarn-audit' ? 'yarn audit' : 'dependency-check'} report is recorded for the Jenkins builds of ${short(sha)}`
          out.push(item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked',
            unreachable: !!cveError, note: cveError ?? (unread ? `${missing}, and ${unread} report${unread === 1 ? '' : 's'} of a type nothing here reads` : missing) }, now))
        }
      }
    }
    return out
  }
}
