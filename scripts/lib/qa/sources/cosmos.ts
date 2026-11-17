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
// A feature's repo with `pr` is read at its PR job's finished builds (branch PR-<n>) instead: only
// those of commits still on the PR (GitHub's list of its commits; a force-push drops the rest),
// each rule at the newest of them that recorded an outcome for one of its stages, and each CVE
// report type at the newest of the last few that recorded one. A build stopped early runs none of
// the later stages, so their results may come from a build of an earlier commit than the PR's
// head on GitHub; the finding's note then says so once, and its sha is that commit. While GitHub
// can't be read, only builds of the candidate commit are used. A PR build deploys to preview,
// not AAT (sectionDeployToAKS in cnp-jenkins-library), so its functional stages are :preview ones
// and it has no AAT stage to answer deployed-aat. A feature's E2E rows read the builds of the
// branch its config names the same way (e2e.ts).
// Every repo of every candidate gets an item for each rule it answers, unknown if need be.

import { type Candidate, prOfRepo, type ReleaseConfig, type RepoConfig } from '../config.ts'
import { str } from '../util.ts'
import { day, item, type Item, reason, short } from './common.ts'
import { defaultGitHubApi, type GitHubApi, prCommits } from './github.ts'
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
  /** When Cosmos stored the event, in seconds. */
  _ts?: number
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
export async function everywhere(query: CosmosQuery, container: 'pipeline-metrics' | 'cve-reports', q: string,
  parameters: { name: string; value: unknown }[]): Promise<unknown[]> {
  return (await Promise.all(DATABASES.map((db) => query(db, container, q, parameters)))).flat()
}

const FINAL = new Set(['Pipeline Succeeded', 'Pipeline Failed'])
// WarningCollector keys arrive as pseudo-stages; they are not stages (as scripts/pipeline-health in cft-workspace).
const WARNING = /deprecat|unpinned|_moved|^old_|^missing_|renovate_config|internal_domain|jitpack|not_approved|AUTO_ABORT|Terraform was not formatted|^not-approved/i

export interface Build {
  job: string
  number: number
  /** A master build, a nightly build, or a build of any other branch, such as a PR's. */
  kind: 'master' | 'nightly' | 'branch'
  branch: string
  /** The commit the build ran, or '' when it recorded none. */
  sha: string
  url: string
  tag: string
  started: string
  outcome: 'SUCCESS' | 'FAILURE'
  stages: Map<string, 'pass' | 'fail'>
  /** Every stage that ran, in order, whether or not its outcome is known. */
  ran: string[]
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

/** One build's events as a Build, or null for a build that hasn't finished or was aborted. */
export function completedBuild(ev: StageEvent[]): Build | null {
  const first = ev[0]
  const nightly = first.job_name.split('/')[0].endsWith('_Nightly')
  const branch = first.branch_name ?? ''
  const sorted = [...ev].sort((a, b) => (a.current_build_duration ?? 0) - (b.current_build_duration ?? 0))
  const final = sorted.filter((e) => FINAL.has(e.current_step_name)).at(-1)
  if (!final || final.current_build_current_result === 'ABORTED') return null
  const outcome = final.current_step_name === 'Pipeline Succeeded' ? 'SUCCESS' : 'FAILURE'
  const stages = sorted.filter((e) => !FINAL.has(e.current_step_name) && !WARNING.test(e.current_step_name))
  const suspect = suspectStages(stages, outcome)
  const field = (k: 'build_url' | 'build_tag' | 'current_build_scheduled_time' | 'git_commit') => sorted.find((e) => e[k])?.[k] ?? ''
  return { job: first.job_name, number: Number(first.build_number), kind: nightly ? 'nightly' : BRANCHES.includes(branch) ? 'master' : 'branch',
    branch, sha: field('git_commit'), url: field('build_url'), tag: field('build_tag'), started: field('current_build_scheduled_time'), outcome,
    stages: stageResults(stages, suspect), ran: stages.map((e) => e.current_step_name), suspects: suspect.map((n) => stages[n].current_step_name) }
}

/** Events grouped by build: by job and build number. */
export function byBuild(events: StageEvent[]): StageEvent[][] {
  const groups = new Map<string, StageEvent[]>()
  for (const e of events) {
    const k = `${e.job_name}#${e.build_number}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return [...groups.values()]
}

/** The finished master and nightly builds among the events, newest first. */
export function toBuilds(events: StageEvent[]): Build[] {
  return byBuild(events).map(completedBuild).filter((b): b is Build => !!b && b.kind !== 'branch').sort((a, b) => b.number - a.number)
}

/** Which stages answer which rule. Stage names are cnp-jenkins-library callAround names. */
export const STAGE_RULES: Record<string, RegExp> = {
  'integration-contract': /^(pact-consumer-tests|pact-provider-verification|contractTest|integrationTest)(:|$)/i,
  functional: /^(smoketest|functionalTest|fullFunctionalTest|E2eTest|crossBrowserTest|mutationTest|apiGatewayTest):(?!preview)/i,
  'deployed-aat': /^(smoketest|functionalTest):aat$/i,
}

/** For a PR build: its functional stages run on preview. */
export const PR_STAGE_RULES: Record<string, RegExp> = {
  ...STAGE_RULES,
  functional: /^(smoketest|functionalTest|fullFunctionalTest|E2eTest|crossBrowserTest|mutationTest|apiGatewayTest):/i,
}

/** What a build is called in a finding: "master #12", or a PR's "PR-2312 #14". */
const labelOf = (b: Build) => `${b.kind === 'branch' ? b.branch : b.kind} #${b.number}`

/** How a PR's builds are read: only those of commits still on the PR, against its head on GitHub. */
export interface PrRead {
  number: number
  /** The PR's head commit on GitHub, or the candidate's when GitHub can't be read. */
  head: string
  /** Whether a finished build ran the head. */
  headBuilt: boolean
  /** Whether the PR has any finished build in Cosmos. */
  any: boolean
  /** Why builds of other commits than the candidate's weren't used: GitHub couldn't say which are on the PR. */
  unverified?: string
}

/**
 * How a PR build stands against the PR head, said once in its finding's note: '' for a build of
 * the head, else "PR-2312 #13 at 3d0d6bb, an earlier commit than the PR head 9cc1a08".
 */
export function againstHead(b: Build, pr: Pick<PrRead, 'head' | 'headBuilt'>, of = 'the PR head'): string {
  if (b.sha === pr.head) return ''
  const at = b.sha ? `at ${short(b.sha)}, an earlier commit than` : 'with no recorded commit, not'
  return `${labelOf(b)} ${at} ${of} ${short(pr.head)}${pr.headBuilt ? '' : `; the head ${short(pr.head)} has no finished build yet`}`
}

/** The newest of the builds with a recorded outcome for a stage `re` matches. */
export const newestWithOutcome = (builds: Build[], re: RegExp): Build | undefined => builds.find((b) => [...b.stages.keys()].some((n) => re.test(n)))

/** The latest build of each job, master jobs first. */
const latestPerJob = (builds: Build[]) => [...new Map(builds.map((b) => [b.job, b] as const).reverse()).values()].sort((a, b) =>
  a.kind === b.kind ? a.job.localeCompare(b.job) : a.kind === 'master' ? -1 : 1)

function stageItem(rule: string, re: RegExp, picked: Build[], repo: string, sha: string, base: Omit<Parameters<typeof item>[0], 'rule' | 'status' | 'value'>,
  now?: () => Date, pr?: PrRead): Item {
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
      unsure.push(`${labelOf(b)}: Jenkins can't tell whether ${b.suspects.join(' or ')} failed`)
    }
    hits.push(`${labelOf(b)}${b.started ? ` (${day(b.started)})` : ''}: ` +
      st.map(([name, s]) => `${name} ${s === 'pass' ? 'passed' : 'failed'}`).join(', '))
    if (b.url) links.push({ text: `${repo} ${labelOf(b)}`, url: b.url })
  }
  // A PR's rule is read at one build, which may be of an earlier commit.
  const [own] = pr ? picked : []
  const at = own ? { sha: own.sha || null } : {}
  if (!pass && !fail && pr) {
    const branch = `PR-${String(pr.number)}`
    if (rule === 'deployed-aat' && pr.any) return item({ ...base, rule, status: 'unknown', value: 'not run', note: 'PR builds deploy to preview, not AAT' }, now)
    if (!pr.any) return item({ ...base, rule, status: 'unknown', value: 'not run', note: `no finished Jenkins build of ${branch} is recorded in the last ${BRANCH_DAYS} days` }, now)
    const none = `no finished Jenkins build of ${branch} ${pr.unverified ? `at ${short(sha)}` : 'of a commit on the PR'} in the last ${BRANCH_DAYS} days recorded a matching stage's outcome`
    return item({ ...base, rule, status: 'unknown', value: 'not run', unreachable: !!pr.unverified,
      note: pr.unverified ? `${none}, and builds of other commits were not used: ${pr.unverified}` : none }, now)
  }
  if (!pass && !fail) {
    return item({ ...base, rule, status: 'unknown', value: 'not run',
      note: picked.length ? `no matching stage ran in the Jenkins builds of ${short(sha)}` : `no master or nightly Jenkins build of ${short(sha)} is recorded` }, now)
  }
  const earlier = own && pr ? againstHead(own, pr) : ''
  const notes = [...(earlier ? [earlier] : []), ...unsure]
  return item({ ...base, ...at, rule, status: fail ? 'fail' : 'pass', value: hits.join('; '), links, note: notes.join('; ') || undefined,
    data: { builds: picked.map((b) => ({ job: b.job, number: b.number, outcome: b.outcome, ...(pr ? { sha: b.sha || null } : {}) })), ...(pr ? { head: pr.head } : {}) } }, now)
}

/**
 * The stage rules' items. For a repo read at its PR, `builds` are the PR's finished builds of
 * commits on it, newest first: each rule is read at the newest that recorded an outcome for one
 * of its stages.
 */
export function stageItems(repo: string, sha: string, c: Candidate, builds: Build[], now?: () => Date, pr?: PrRead): Item[] {
  const base = { source: SOURCE, sha, repo, candidate: c.name }
  if (!pr) return Object.entries(STAGE_RULES).map(([rule, re]) => stageItem(rule, re, latestPerJob(builds), repo, sha, base, now))
  return Object.entries(PR_STAGE_RULES).map(([rule, re]) => {
    const own = newestWithOutcome(builds, re)
    return stageItem(rule, re, own ? [own] : [], repo, sha, base, now, pr)
  })
}

export const CVE_RULE: Record<CodebaseType, string> = { java: 'dependency-check', node: 'yarn-audit' }

/** The security checks a repo's Jenkins build runs: by its builder, or both when it names none. */
export function cveRulesFor(rc: { builder?: 'gradle' | 'yarn' }): string[] {
  return rc.builder === 'gradle' ? [CVE_RULE.java] : rc.builder === 'yarn' ? [CVE_RULE.node] : Object.values(CVE_RULE)
}
const CHECKER: Record<CodebaseType, string> = { java: 'OWASP dependency-check', node: 'yarn audit' }
type Builder = 'gradle' | 'yarn' | undefined

export function cveItem(repo: string, sha: string, c: Candidate, build: Build, doc: CveDoc, now?: () => Date, builder?: Builder, pr?: PrRead): Item | null {
  const s = summariseCve(doc, builder)
  if (!s) return null
  const sev = Object.entries(s.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')
  // Suppressed findings were reported and then accepted, so the answer is Yes even when they pass.
  const answer = s.open + s.suppressed > 0 ? 'Yes' : 'No'
  const earlier = pr ? againstHead(build, pr) : ''
  const note = earlier || (build.kind === 'branch' ? `${labelOf(build)}${build.sha ? `, at ${short(build.sha)}` : ''}` : `${build.kind} build #${build.number} of ${short(sha)}`)
  return item({ source: SOURCE, sha: pr ? build.sha || null : sha, repo, candidate: c.name, rule: CVE_RULE[s.type], status: s.open ? 'fail' : 'pass', answer,
    value: `${CHECKER[s.type]}: ${s.open} open${sev ? ` (${sev})` : ''}, ${s.suppressed} suppressed`,
    links: build.url ? [{ text: `${repo} ${labelOf(build)}`, url: build.url }] : [],
    note, data: { open: s.open, suppressed: s.suppressed, bySeverity: s.bySeverity, ...(pr ? { head: pr.head } : {}) } }, now)
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
function cveItems(repo: string, sha: string, c: Candidate, builds: Build[], reports: Map<string, CveDoc>, builder: Builder, now?: () => Date, pr?: PrRead): Item[] {
  const ordered = [...builds].sort((a, b) => (a.kind === b.kind ? b.number - a.number : a.kind === 'master' ? -1 : 1))
  const found = new Map<string, Item>()
  for (const b of ordered) {
    for (const [k, d] of reports) {
      if (!k.startsWith(`${b.tag}|`)) continue
      const it = cveItem(repo, sha, c, b, d, now, builder, pr)
      if (it && !found.has(it.rule)) found.set(it.rule, it)
    }
  }
  return [...found.values()]
}

const STAGE_FIELDS = ['job_name', 'branch_name', 'build_number', 'build_tag', 'build_url', 'current_step_name',
  'current_build_current_result', 'current_build_duration', 'current_build_scheduled_time', 'git_commit', '_ts']

const STAGE_QUERY = `SELECT ${STAGE_FIELDS.map((f) => `c.${f}`).join(', ')} FROM c ` +
  'WHERE c.git_commit = @sha AND c.product = @p AND c.component = @c'
/** How far back a branch's latest build is looked for (e2e.ts); an older one counts as none. */
export const BRANCH_DAYS = 60

/** The stage events of one build of a branch (@n, as Jenkins's BUILD_NUMBER string), or of its builds since @since (_ts). */
export const branchQuery = (pinned: boolean): string => `SELECT ${STAGE_FIELDS.map((f) => `c.${f}`).join(', ')} FROM c ` +
  `WHERE c.branch_name = @b AND c.product = @p AND c.component = @c AND ${pinned ? 'c.build_number = @n' : 'c._ts > @since'}`
// Joined to master and nightly builds of the commit (or a PR's build) through build_tag; a report
// that names no branch is kept, since the build it joins to already says which.
const CVE_QUERY = 'SELECT c._ts, c.build, c.report FROM c WHERE ARRAY_CONTAINS(@tags, c.build.build_tag) AND ' +
  '(NOT IS_DEFINED(c.build.branch_name) OR IS_NULL(c.build.branch_name) OR ARRAY_CONTAINS(@branches, c.build.branch_name))'

/** Whether a Cosmos job_name (<folder>/<repo>/<branch>) is the configured job's build of the branch. */
export function isJob(jobName: string, job: string, branch: string): boolean {
  return jobName === `${job}/${branch}` || jobName === `${job}/${encodeURIComponent(branch)}`
}

/**
 * Whether a Cosmos job_name is the repo's build of the branch: the configured job's, or with none,
 * any folder's job named after the repo (<folder>/<repo>/<branch>).
 */
export function isRepoJob(jobName: string, github: string, branch: string, job?: string): boolean {
  if (job) return isJob(jobName, job, branch)
  const parts = jobName.split('/')
  const repo = github.split('/').at(-1)
  return parts.length === 3 && !parts[0].endsWith('_Nightly') && parts[1] === repo && (parts[2] === branch || parts[2] === encodeURIComponent(branch))
}

type BranchRepo = Pick<RepoConfig, 'github' | 'cosmos_product' | 'cosmos_component'>

// One query per repo, branch and job for the run: scopeFeature, cosmosReader and the E2E reader
// all read a PR's builds, and share the query they are given.
const branchMemo = new WeakMap<CosmosQuery, Map<string, Promise<StageEvent[][]>>>()

/** The repo's builds of a branch in Cosmos, as stage events grouped by build: one build (@n), or those of the last BRANCH_DAYS. */
export function branchBuilds(query: CosmosQuery, rc: BranchRepo, branch: string, job: string | undefined, wanted: number | null,
  now: () => Date): Promise<StageEvent[][]> {
  const memo = branchMemo.get(query) ?? new Map<string, Promise<StageEvent[][]>>()
  branchMemo.set(query, memo)
  const key = JSON.stringify([rc.github, rc.cosmos_product, rc.cosmos_component, branch, job ?? null, wanted])
  const hit = memo.get(key)
  if (hit) return hit
  const read = readBranchBuilds(query, rc, branch, job, wanted, now)
  memo.set(key, read)
  return read
}

async function readBranchBuilds(query: CosmosQuery, rc: BranchRepo, branch: string, job: string | undefined, wanted: number | null,
  now: () => Date): Promise<StageEvent[][]> {
  const bound = wanted === null ? { name: '@since', value: Math.floor(now().getTime() / 1000) - BRANCH_DAYS * 86_400 } : { name: '@n', value: String(wanted) }
  const events = await everywhere(query, 'pipeline-metrics', branchQuery(wanted !== null), [{ name: '@b', value: branch },
    { name: '@p', value: rc.cosmos_product }, { name: '@c', value: rc.cosmos_component }, bound]) as StageEvent[]
  return byBuild(events.filter((e) => e.branch_name === branch && isRepoJob(str(e.job_name), rc.github, branch, job)))
}

const eventTime = (e: StageEvent) => e._ts ?? (Date.parse(e.current_build_scheduled_time ?? '') / 1000 || 0)

/**
 * The builds of the job with the newest event, when the groups span several (a repo's PR job
 * moved folder, say). Build numbers are only comparable within a job.
 */
export function newestJob(groups: StageEvent[][]): StageEvent[][] {
  const latest = new Map<string, number>()
  for (const e of groups.flat()) latest.set(e.job_name, Math.max(latest.get(e.job_name) ?? 0, eventTime(e)))
  const [job] = [...latest].sort((a, b) => b[1] - a[1])[0] ?? []
  return groups.filter((g) => g[0].job_name === job)
}

/** The finished builds of the newest job among the groups, newest first. */
export const finishedBuilds = (groups: StageEvent[][]): Build[] => newestJob(groups).map(completedBuild).filter((b): b is Build => !!b).sort((a, b) => b.number - a.number)

/** The newest finished build among the groups, or null. */
export const latestBuild = (groups: StageEvent[][]): Build | null => finishedBuilds(groups)[0] ?? null

/** How many of a PR's newest builds its CVE reports are looked for in. */
export const CVE_BUILDS = 3
/** The cnp-jenkins-library stage that runs the security checks CVEPublisher reports. */
const SECURITY_STAGE = 'securitychecks'

/** A PR's builds whose CVE reports are read: the newest few that ran the security checks, else the newest few. */
function cveBuilds(builds: Build[]): Build[] {
  const ran = builds.filter((b) => b.ran.includes(SECURITY_STAGE))
  return (ran.length ? ran : builds).slice(0, CVE_BUILDS)
}

/** A PR's finished builds of commits still on it, and how they stand against its head on GitHub. */
async function readPr(all: Build[], api: GitHubApi, gh: string, pr: number, sha: string): Promise<{ builds: Build[]; read: PrRead }> {
  const on = await prCommits(api, gh, pr)
  const head = 'error' in on ? sha : on.head
  const builds = 'error' in on ? all.filter((b) => b.sha === sha) : all.filter((b) => on.on(b.sha))
  return { builds, read: { number: pr, head, headBuilt: all.some((b) => b.sha === head), any: all.length > 0, ...('error' in on ? { unverified: on.error } : {}) } }
}

export function cosmosReader(cfg: ReleaseConfig, query: CosmosQuery = defaultCosmosQuery(), now?: () => Date,
  api: GitHubApi = defaultGitHubApi()): () => Promise<Item[]> {
  return async () => {
    const out: Item[] = []
    let down: string | null = null
    for (const c of cfg.candidates) {
      for (const [repo, sha] of Object.entries(c.shas)) {
        const rc = cfg.repos[repo]
        const cveRules = cveRulesFor(rc)
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
        const pr = prOfRepo(cfg, repo)
        let builds: Build[]
        let read: PrRead | undefined
        try {
          if (pr) {
            const all = finishedBuilds(await branchBuilds(query, rc, `PR-${String(pr)}`, rc.e2e?.jenkins.job, null, now ?? (() => new Date())))
            const r = await readPr(all, api, rc.github, pr, sha)
            builds = r.builds
            read = r.read
          } else {
            builds = toBuilds(await everywhere(query, 'pipeline-metrics', STAGE_QUERY, [{ name: '@sha', value: sha },
              { name: '@p', value: rc.cosmos_product }, { name: '@c', value: rc.cosmos_component }]) as StageEvent[])
          }
        } catch (e) {
          down = `Cosmos pipeline-metrics could not be read: ${reason(e)}`
          out.push(...unknown(down, true))
          continue
        }
        out.push(...stageItems(repo, sha, c, builds, now, read))

        const tagged = builds.filter((b) => b.tag)
        const withCve = read ? cveBuilds(tagged) : tagged
        let docs: CveDoc[] = []
        let cveError: string | null = null
        if (withCve.length) {
          try {
            docs = await everywhere(query, 'cve-reports', CVE_QUERY,
              [{ name: '@tags', value: withCve.map((b) => b.tag) }, { name: '@branches', value: pr ? [`PR-${String(pr)}`] : BRANCHES }]) as CveDoc[]
          } catch (e) {
            cveError = `Cosmos cve-reports could not be read: ${reason(e)}`
          }
        }
        const reports = newestReports(docs, rc.github, rc.builder)
        const found = cveItems(repo, sha, c, withCve, reports, rc.builder, now, read)
        const unread = [...reports.values()].filter((d) => !summariseCve(d, rc.builder)).length
        out.push(...found)
        for (const rule of cveRules.filter((r) => !found.some((i) => i.rule === r))) {
          if (!cveError && !unread && rc.builder === undefined && found.length) continue
          const missing = `no ${rule === 'yarn-audit' ? 'yarn audit' : 'dependency-check'} report is recorded for the ${pr ? `newest finished Jenkins builds of PR-${String(pr)}` : `Jenkins builds of ${short(sha)}`}`
          out.push(item({ source: SOURCE, sha, repo, candidate: c.name, rule, status: 'unknown', value: 'not checked',
            unreachable: !!cveError, note: cveError ?? (unread ? `${missing}, and ${unread} report${unread === 1 ? '' : 's'} of a type nothing here reads` : missing) }, now))
        }
      }
    }
    return out
  }
}
