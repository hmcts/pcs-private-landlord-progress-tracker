// A feature's E2E rows, for the Jenkins build its config names in repos.<repo>.e2e: usually a PR
// build run with the E2E labels, the latest finished one or a given build number.
//
// - Cosmos pipeline-metrics: the configured job's builds of the branch, read as cosmos.ts reads
//   master builds (finished builds only, from both databases, with the same rule for which stage
//   failed). The E2E row is the outcome of the build's E2E stages: cnp-jenkins-library's
//   functionalTest:<env> (a PR build's default, where pcs-frontend's Playwright suite runs),
//   fullFunctionalTest:<env> (the enable_full_functional_tests label, and nightly) and
//   E2eTest:<env> (the enable_e2e_test label, and nightly), all :preview on a PR. A build that
//   finished without one fails the row. Cosmos keeps no per-test results, so the row says which
//   stages passed, not which tests.
// - When Cosmos has no finished build of the branch, or can't be read: the Jenkins status on the
//   head commit of the PR (continuous-integration/jenkins/pr-head) or branch, which is the whole
//   build's result only. Its target URL names the build, so a configured build number is checked
//   against it. While Cosmos can't be read, the fallback's items are unreachable, so a publish
//   keeps what the page says.
//
// What a stage ran depends on the PR's labels, so a pass stands only when the PR carries the
// config's e2e.label. The scan for ignored or pending tests (github.ts) is run again over the
// feature's specs only, at the commit the build ran.

import type { E2eConfig, ReleaseConfig, RepoConfig } from '../config.ts'
import { mapLimit, SHA, str } from '../util.ts'
import { item, type Item, reason, short } from './common.ts'
import { type Build, BRANCH_DAYS, branchBuilds, completedBuild, type CosmosQuery, defaultCosmosQuery, latestBuild, type StageEvent } from './cosmos.ts'

export { isJob, isRepoJob } from './cosmos.ts'
import { BRANCH_STATUS, defaultGitHubApi, defaultTarball, type GitHubApi, type GitHubTarball, ignoredItem, type Scan, scanTarball } from './github.ts'

const SOURCE = 'e2e'
export const E2E_RULES = ['e2e-feature', 'e2e-build', 'ignored-tests-feature']
/** Repos whose E2E builds are read at once. */
export const E2E_CONCURRENCY = 4

/** The stages that run a repo's E2E or functional tests against a deployment. */
export const E2E_STAGE = /^(functionalTest|fullFunctionalTest|E2eTest)(:[\w-]+)?$/i

/** The status Jenkins sets on a PR build's head commit. */
export const PR_STATUS = 'continuous-integration/jenkins/pr-head'

export interface Deps {
  cosmos: CosmosQuery
  api: GitHubApi
  tarball: GitHubTarball
  now?: () => Date
}

/** Whether a test title carries the tag, as a whole tag (@enforcement, not @enforcementWales). */
export function hasTag(text: string, tag: string): boolean {
  for (let at = text.indexOf(tag); at >= 0; at = text.indexOf(tag, at + 1)) {
    const next = text.charAt(at + tag.length)
    if (!next || !/[\w-]/.test(next)) return true
  }
  return false
}

const trimSlash = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p)

/** Which spec files the feature's ignored-tests scan covers: under its paths, or carrying one of its tags. */
export function specScope(e2e: E2eConfig): (path: string, text: string) => boolean {
  const paths = (e2e.paths ?? []).map(trimSlash)
  return (path, text) => paths.some((p) => path === p || path.startsWith(`${p}/`)) || (e2e.tags ?? []).some((t) => hasTag(text, t))
}

/** The PR number of a PR-<n> branch, else null. */
export function prNumber(branch: string): number | null {
  if (!branch.startsWith('PR-')) return null
  const digits = branch.slice(3)
  const n = Number.parseInt(digits, 10)
  return Number.isSafeInteger(n) && n > 0 && String(n) === digits ? n : null
}

/** The configured build number, or null for the latest finished build. */
export function wantedBuild(build: E2eConfig['jenkins']['build']): number | null {
  const n = typeof build === 'number' ? build : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The build number in a Jenkins build URL: the path segment after the branch's job. */
export function buildNumberOf(url: string, branch: string): number | null {
  let parts: string[]
  try {
    parts = new URL(url).pathname.split('/')
  } catch {
    return null
  }
  // A multibranch job is named by the branch URL-encoded, and that name is encoded again in its URL.
  const at = parts.indexOf(encodeURIComponent(encodeURIComponent(branch)))
  const digits = at >= 0 ? (parts[at + 1] ?? '') : ''
  const n = Number.parseInt(digits, 10)
  return Number.isSafeInteger(n) && n > 0 && String(n) === digits ? n : null
}

type CosmosFind =
  | { kind: 'found'; build: Build }
  | { kind: 'pending'; number: number }
  | { kind: 'missing' | 'unset' | 'down'; note: string }

/** The configured build in Cosmos: found, not finished, or not there and why. */
async function fromCosmos(query: CosmosQuery, rc: RepoConfig, e2e: E2eConfig, wanted: number | null, now: () => Date): Promise<CosmosFind> {
  if (!rc.cosmos_product) return { kind: 'unset', note: 'no Jenkins product and component are configured for the repo' }
  const { job, branch } = e2e.jenkins
  let groups: StageEvent[][]
  try {
    groups = await branchBuilds(query, rc, branch, job, wanted, now)
  } catch (e) {
    return { kind: 'down', note: `Cosmos pipeline-metrics could not be read: ${reason(e)}` }
  }
  if (wanted !== null) {
    const ev = groups.find((g) => Number(g[0].build_number) === wanted)
    if (!ev) return { kind: 'missing', note: `Cosmos records no build #${wanted} of ${branch}` }
    const build = completedBuild(ev)
    return build ? { kind: 'found', build } : { kind: 'pending', number: wanted }
  }
  const build = latestBuild(groups)
  return build ? { kind: 'found', build } : { kind: 'missing', note: `Cosmos records no finished build of ${branch} in the last ${BRANCH_DAYS} days` }
}

export interface Head {
  sha: string
  pr: number | null
  /** The Jenkins status on the head commit, if it has one. */
  state?: string
  url?: string
  number?: number | null
}

/** The head commit of the branch (a PR's head, for PR-<n>) and its Jenkins status. */
export async function fromGitHub(api: GitHubApi, gh: string, branch: string): Promise<Head | null> {
  const pr = prNumber(branch)
  const res = await api(pr === null ? `repos/${gh}/commits/${encodeURIComponent(branch)}` : `repos/${gh}/pulls/${String(pr)}`) as
    { sha?: unknown; head?: { sha?: unknown } }
  const sha = str(pr === null ? res?.sha : res?.head?.sha)
  if (!SHA.test(sha)) return null
  const st = await api(`repos/${gh}/commits/${sha}/status?per_page=100`) as { statuses?: { context?: unknown; state?: unknown; target_url?: unknown }[] }
  const context = pr === null ? BRANCH_STATUS : PR_STATUS
  const hit = (Array.isArray(st?.statuses) ? st.statuses : []).find((s) => s?.context === context)
  if (!hit) return { sha, pr }
  const url = str(hit.target_url)
  return { sha, pr, state: str(hit.state), url: url.startsWith('https://') ? url : undefined, number: buildNumberOf(url, branch) }
}

/**
 * Whether the PR asks its build to run the feature's tests. pcs-frontend's Jenkinsfile_CNP sets
 * the suite's scope (E2E_TEST_SCOPE) from PR labels: @sanity by default, the feature's tag with
 * a label such as enable_private_landlord_test, and any e2e-tag:<tag> label overrides both.
 */
type Labels = { state: 'labelled' | 'unlabelled' | 'unread' | 'none'; note: string }

async function labelsOf(api: GitHubApi, gh: string, e2e: E2eConfig): Promise<Labels> {
  const label = e2e.label
  if (!label) return { state: 'none', note: 'no e2e.label is configured, so the stage result covers whatever scope the build ran' }
  const pr = prNumber(e2e.jenkins.branch)
  if (pr === null) return { state: 'unlabelled', note: `${e2e.jenkins.branch} is not a PR, so it can't carry the ${label} label` }
  let names: string[]
  try {
    const res = await api(`repos/${gh}/issues/${String(pr)}/labels?per_page=100`)
    names = (Array.isArray(res) ? res : []).map((l) => str((l as { name?: unknown })?.name))
  } catch (e) {
    return { state: 'unread', note: `the PR's labels could not be read: ${reason(e)}` }
  }
  if (!names.includes(label)) return { state: 'unlabelled', note: `the PR isn't labelled ${label} to run the feature's tests, so the stage result says nothing about them` }
  if (names.some((n) => n.startsWith('e2e-tag:'))) {
    return { state: 'unlabelled', note: `the PR's e2e-tag: label replaces the scope ${label} sets, so the stage result says nothing about the feature's tests` }
  }
  return { state: 'labelled', note: `the PR is labelled ${label}, so the build ran the feature's tests` }
}

type Verdict = { status: 'pass' | 'fail' | 'unknown'; unreachable?: boolean }

/**
 * A pass stands only when the PR is labelled to run the feature's tests. With no label
 * configured, a stage's pass stands, but a whole build's success says nothing about E2E.
 */
function gate(status: Verdict['status'], labels: Labels, wholeBuild: boolean): Verdict {
  if (status !== 'pass') return { status }
  if (labels.state === 'labelled') return { status }
  if (labels.state === 'unread') return { status: 'unknown', unreachable: true }
  if (labels.state === 'none') return { status: wholeBuild ? 'unknown' : 'pass' }
  return { status: 'fail' }
}

const outcomeOf = (s: 'pass' | 'fail' | undefined) => (s === 'pass' ? 'passed' : s === 'fail' ? 'failed' : 'outcome not recorded')

/** The E2E row from a finished build's stages. */
async function stageItem(repo: string, branch: string, b: Build, links: Item['links'], labels: () => Promise<Labels>, now?: () => Date): Promise<Item> {
  const label = `${branch} #${b.number}`
  const sha = SHA.test(b.sha) ? b.sha : null
  const base = { source: SOURCE, rule: 'e2e-feature', repo, sha, links }
  const names = b.ran.filter((n) => E2E_STAGE.test(n))
  const data = { from: 'cosmos', branch, number: b.number, outcome: b.outcome, stages: Object.fromEntries(names.map((n) => [n, b.stages.get(n) ?? 'unknown'])) }
  if (!names.length) {
    const why = b.outcome === 'FAILURE' && b.suspects.length ? `the build failed at ${b.suspects.join(' or ')} first` : 'the E2E labels were not set'
    return item({ ...base, status: 'fail', value: `${label}: no E2E stage ran`, data,
      note: `${label} finished without running an E2E or functional stage: ${why}` }, now)
  }
  const results = names.map((n) => [n, b.stages.get(n)] as const)
  const failed = results.filter(([, s]) => s === 'fail')
  const stages: Verdict['status'] = failed.length ? 'fail' : results.some(([, s]) => !s) ? 'unknown' : 'pass'
  const notes = ['the stage outcome only: Cosmos keeps no per-test results']
  if (failed.length && b.suspects.length > 1 && failed.some(([n]) => b.suspects.includes(n))) notes.unshift(`Jenkins can't tell whether ${b.suspects.join(' or ')} failed`)
  if (stages === 'unknown') notes.unshift('an E2E stage ran after the stage that failed, so its outcome is not recorded')
  const l = stages === 'pass' ? await labels() : null
  const v: Verdict = l ? gate(stages, l, false) : { status: stages }
  if (l) notes.unshift(l.note)
  return item({ ...base, ...v, value: `${label}: ${results.map(([n, s]) => `${n} ${outcomeOf(s)}`).join(', ')}`, note: notes.join('; '), data }, now)
}

/**
 * The E2E row from the head commit's Jenkins status: the whole build's result. With no status, a
 * build Cosmos doesn't have is absent.
 */
async function statusItem(repo: string, branch: string, head: Head, wanted: number | null, cosmos: { kind: string; note: string },
  labels: () => Promise<Labels>, now?: () => Date): Promise<Item> {
  const at = head.pr === null ? `the ${branch} head` : 'the PR head'
  const why = cosmos.note
  const base = { source: SOURCE, rule: 'e2e-feature', repo, sha: head.sha }
  const unknown = (note: string, unreachable = false) => item({ ...base, status: 'unknown', value: 'not checked', note, unreachable }, now)
  if (!head.state && cosmos.kind === 'missing') return item({ ...base, status: 'fail', value: 'no build', note: `${why}, and ${at} has no Jenkins status` }, now)
  if (!head.state) return unknown(`${why}, and ${at} has no Jenkins status`)
  if (wanted !== null && !head.number) return unknown(`${why}, and the Jenkins status link on ${at} names no build to match to #${wanted}`, true)
  if (wanted !== null && head.number !== wanted) return unknown(`${why}, and the Jenkins status on ${at} is not for build #${wanted}`)
  const build = head.number ? `${branch} #${head.number}` : branch
  const links = head.url ? [{ text: `${repo} ${build}`, url: head.url }] : []
  const notes = [`GitHub's Jenkins status on ${at}: the whole build's result, not the E2E stage's`, why]
  const data = { from: 'github', branch, number: head.number ?? null, state: head.state }
  const state: Verdict['status'] = head.state === 'success' ? 'pass' : head.state === 'failure' || head.state === 'error' ? 'fail' : 'unknown'
  const value = `${build}: ${state === 'pass' ? 'the build passed' : state === 'fail' ? 'the build failed' : 'still running'}`
  const l = state === 'pass' ? await labels() : null
  if (l) notes.unshift(l.note)
  return item({ ...base, ...(l ? gate(state, l, true) : { status: state }), value, links, note: notes.join('; '), data }, now)
}

/**
 * A fallback answer while Cosmos can't be read: unknown and unreachable, so a publish keeps the
 * page's answer, which may have come from Cosmos. What the fallback said stays in the note and data.
 */
function kept(it: Item, now?: () => Date): Item {
  return item({ source: it.source, rule: it.rule, repo: it.repo, sha: it.sha, links: it.links, status: 'unknown', value: 'not checked', unreachable: true,
    note: `GitHub's fallback, not used while Cosmos can't be read, says: ${it.value}${it.note ? ` (${it.note})` : ''}`,
    data: { ...it.data, fallback: { status: it.status, value: it.value } } }, now)
}

/** The feature's spec files at the E2E build's commit, and the ignored-tests finding for them. */
async function scopedScan(repo: string, rc: RepoConfig, e2e: E2eConfig, sha: string | null, tarball: GitHubTarball,
  noSha: { note: string; unreachable: boolean }, now?: () => Date): Promise<Item> {
  const rule = 'ignored-tests-feature'
  const base = { source: 'github', rule, repo, sha, status: 'unknown' as const, value: 'not checked' }
  if (!sha) return item({ ...base, ...noSha }, now)
  let scan: Scan
  try {
    scan = scanTarball(await tarball(rc.github, sha), rc.test_paths, specScope(e2e))
  } catch (e) {
    return item({ ...base, note: `the source at ${short(sha)} could not be read: ${reason(e)}`, unreachable: true }, now)
  }
  if (!scan.files) return item({ ...base, note: `no spec file at ${short(sha)} matches the feature's tags or paths` }, now)
  return ignoredItem(repo, rc.github, sha, null, scan, now, rule)
}

/** The commit a finished build ran: Cosmos's, or for the latest build, the head commit if its status is for that build. */
async function buildCommit(b: Build, wanted: number | null, api: GitHubApi, rc: RepoConfig, branch: string): Promise<{ sha: string | null; note: string; unreachable: boolean }> {
  if (SHA.test(b.sha)) return { sha: b.sha, note: '', unreachable: false }
  const none = `Cosmos recorded no commit for ${branch} #${b.number}`
  if (wanted !== null) return { sha: null, note: none, unreachable: false }
  try {
    const head = await fromGitHub(api, rc.github, branch)
    return head?.number === b.number ? { sha: head.sha, note: '', unreachable: false }
      : { sha: null, note: `${none}, and the Jenkins status on its head commit is not for that build`, unreachable: false }
  } catch (e) {
    return { sha: null, note: `${none}, and GitHub could not be read: ${reason(e)}`, unreachable: true }
  }
}

async function one(repo: string, rc: RepoConfig, e2e: E2eConfig, d: Deps): Promise<Item[]> {
  const { branch } = e2e.jenkins
  const now = d.now ?? (() => new Date())
  const wanted = wantedBuild(e2e.jenkins.build)
  const header = (a: Omit<Parameters<typeof item>[0], 'source' | 'rule' | 'repo'>) => item({ source: SOURCE, rule: 'e2e-build', repo, ...a }, d.now)
  const unknown = (note: string, unreachable: boolean) => E2E_RULES.map((rule) =>
    item({ source: rule === 'ignored-tests-feature' ? 'github' : SOURCE, rule, repo, status: 'unknown', value: 'not checked', note, unreachable }, d.now))
  let read: Promise<Labels> | undefined
  const labels = () => (read ??= labelsOf(d.api, rc.github, e2e))
  const found = await fromCosmos(d.cosmos, rc, e2e, wanted, now)

  if (found.kind === 'found') {
    const b = found.build
    const label = `${branch} #${b.number}`
    const links = b.url.startsWith('https://') ? [{ text: `${repo} ${label}`, url: b.url }] : []
    const commit = await buildCommit(b, wanted, d.api, rc, branch)
    return [await stageItem(repo, branch, b, links, labels, d.now),
      header({ sha: commit.sha, status: 'pass', links, value: `${repo}: ${label}${commit.sha ? ` at ${short(commit.sha)}` : ''}, ${b.outcome.toLowerCase()}`,
        note: commit.note || undefined, data: { from: 'cosmos', branch, number: b.number, outcome: b.outcome, sha: commit.sha } }),
      await scopedScan(repo, rc, e2e, commit.sha, d.tarball, commit, d.now)]
  }
  if (found.kind === 'pending') return unknown(`${branch} #${found.number} has not finished, or was aborted`, false)

  // Cosmos has no answer: the configured build isn't there, or Cosmos can't be read.
  let head: Head | null
  try {
    head = await fromGitHub(d.api, rc.github, branch)
  } catch (e) {
    return unknown(`${found.note}, and GitHub could not be read: ${reason(e)}`, true)
  }
  if (!head) return unknown(`${found.note}, and GitHub has no head commit for ${branch}`, found.kind === 'down')
  const at = head.pr === null ? 'branch head' : 'PR head'
  const build = head.number ? `${branch} #${head.number}` : branch
  const links = [{ text: `${repo} ${short(head.sha)}`, url: `https://github.com/${rc.github}/commit/${head.sha}` },
    ...(head.url ? [{ text: `${repo} ${build}`, url: head.url }] : [])]
  const items = [await statusItem(repo, branch, head, wanted, found, labels, d.now),
    header({ sha: head.sha, status: 'pass', links, value: `${repo}: ${build}, ${at} ${short(head.sha)}${head.state ? `, Jenkins status ${head.state}` : ''}`,
      data: { from: 'github', branch, sha: head.sha, number: head.number ?? null, state: head.state ?? null } }),
    await scopedScan(repo, rc, e2e, head.sha, d.tarball, { note: '', unreachable: false }, d.now)]
  return found.kind === 'down' ? items.map((i) => kept(i, d.now)) : items
}

export function e2eReader(cfg: ReleaseConfig, cosmos: CosmosQuery = defaultCosmosQuery(), api: GitHubApi = defaultGitHubApi(),
  tarball: GitHubTarball = defaultTarball(), now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const repos = Object.entries(cfg.repos).filter(([, rc]) => rc.e2e)
    if (!repos.length) {
      return E2E_RULES.map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note: 'no repo has an E2E build configured' }, now))
    }
    const deps = { cosmos, api, tarball, now }
    return (await mapLimit(repos, E2E_CONCURRENCY, ([repo, rc]) => one(repo, rc, rc.e2e!, deps))).flat()
  }
}
