// Jira, read through twg as the roadmap is (scripts/lib/roadmap-runner.ts, but asynchronously, so
// the readers' twg calls overlap rather than queue): outstanding bugs by
// priority, "Test Complete" style comments on the release's stories, tasks and bugs, and the
// status of each ticket backing a human-answered row. The report is internal, so this doesn't
// apply the public site's not-public filter, and nothing it reads may reach the site.

import type { ReleaseConfig } from '../config.ts'
import { type AsyncTwgRunner, jiraKey, quietRunnerAsync } from '../twg.ts'
import { item, type Item, reason } from './common.ts'

const SOURCE = 'jira'
const JIRA = 'https://hmcts.atlassian.net'

export interface JiraIssue {
  key: string
  summary?: string
  issuetype?: { name: string }
  status?: { name: string; statusCategory?: { key: string } }
  priority?: { name: string } | null
  comment?: { total?: number; comments?: { body?: unknown }[] }
}

const READ_ONLY = ['jira', 'workitem', 'query']

/** All issues for a JQL query, following pagination. Only ever runs `twg jira workitem query`. */
export async function query(jql: string, fields: string, run: AsyncTwgRunner = quietRunnerAsync): Promise<JiraIssue[]> {
  const out: JiraIssue[] = []
  let cursor: string | undefined
  for (;;) {
    const args = [...READ_ONLY, '--jql', jql, '--fields', fields, '-n', '100', '-o', 'json', '--output-summary', 'none']
    if (cursor) args.push('--after', cursor)
    const page = JSON.parse(await run(args)) as { data: { issues: JiraIssue[] }; pageInfo?: { hasNextPage?: boolean; nextCursor?: string } }
    out.push(...page.data.issues)
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.nextCursor) return out
    cursor = page.pageInfo.nextCursor
  }
}

/** Every comment on one issue. Only ever runs `twg jira workitem comment query`. */
export async function commentThread(key: string, run: AsyncTwgRunner = quietRunnerAsync): Promise<{ body?: unknown }[]> {
  const out: { body?: unknown }[] = []
  let cursor: string | undefined
  for (;;) {
    const args = ['jira', 'workitem', 'comment', 'query', '--issue-id', jiraKey(key), '--first', '100', '-o', 'json', '--output-summary', 'none']
    if (cursor) args.push('--after', cursor)
    const page = JSON.parse(await run(args)) as { data: { body?: unknown }[]; pageInfo?: { hasNextPage?: boolean; nextCursor?: string | null } }
    out.push(...page.data)
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.nextCursor) return out
    cursor = page.pageInfo.nextCursor
  }
}

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const

/** HDPI priorities are "1-Highest" … "5-Lowest"; other projects use plain names. */
export function band(priority?: string): (typeof PRIORITIES)[number] {
  const p = (priority ?? '').toLowerCase()
  if (/^1\b|^1-|highest|critical|blocker/.test(p)) return 'Critical'
  if (/^2\b|^2-|high|major/.test(p)) return 'High'
  if (/^[45]\b|^[45]-|low|minor|trivial/.test(p)) return 'Low'
  return 'Medium'
}

/** Text of an ADF document (Jira's comment body). */
export function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : ''
  const n = node as { text?: string; content?: unknown[]; type?: string }
  const own = n.type === 'text' ? n.text ?? '' : ''
  return own + (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n' : '')
}

/** What a tester writes when a ticket's testing is done. Override with test_complete_pattern. */
export const TEST_COMPLETE = String.raw`test(ing)?\s+(is\s+|has\s+been\s+)?(complete|completed|done|passed)|test\s+summary|qa\s+(test(ing)?\s+)?(complete|completed|passed|done)|(functional|regression|qa)\s+testing\b.{0,60}\b(done|complete|completed|passed)|completed\s+(the\s+)?(functional\s+)?testing|re-?test(ed)?\b.{0,20}\b(passed|done|working)|retested|tested\s+and\s+(passed|verified|signed)|passed\s+(qa|testing)\b|happy\s+to\s+sign\s+(this\s+|it\s+)?off|verified\b.{0,60}\b(working|resolved|fixed)`

const CLOSED_UNDONE = /withdrawn|won.?t|cancel|duplicate|rejected|not required/i

const browse = (key: string) => ({ text: key, url: `${JIRA}/browse/${key}` })
const jqlLink = (text: string, jql: string) => ({ text, url: `${JIRA}/issues/?jql=${encodeURIComponent(jql)}` })

type Now = (() => Date) | undefined

async function bugItems(cfg: ReleaseConfig, run: AsyncTwgRunner, now: Now): Promise<Item[]> {
  const types = cfg.bug_types ?? ['Bug']
  const bugJql = `(${cfg.jql}) AND issuetype in (${types.map((t) => `"${t}"`).join(', ')}) AND statusCategory != Done`
  try {
    const bugs = await query(bugJql, 'priority,status,issuetype', run)
    const counts: Record<string, number> = Object.fromEntries(PRIORITIES.map((p) => [p, 0]))
    const keys: Record<string, string[]> = Object.fromEntries(PRIORITIES.map((p) => [p, []]))
    for (const b of bugs) {
      const p = band(b.priority?.name)
      counts[p]++
      keys[p].push(b.key)
    }
    const text = PRIORITIES.map((p) => `${p} – ${counts[p]}`).join(', ')
    const links = [jqlLink('Open bugs in the release', bugJql)]
    const high = counts.Critical + counts.High
    return [
      item({ source: SOURCE, rule: 'outstanding-bugs', status: 'pass', value: text, links, data: { counts, keys } }, now),
      item({ source: SOURCE, rule: 'high-defects', status: high ? 'fail' : 'pass',
        value: high ? `${high} Critical or High bug${high === 1 ? '' : 's'} still open` : 'no Critical or High bugs open',
        links: [...links, ...[...keys.Critical, ...keys.High].slice(0, 10).map(browse)], data: { counts } }, now),
    ]
  } catch (e) {
    const note = `Jira could not be read: ${reason(e)}`
    return ['outstanding-bugs', 'high-defects'].map((rule) => item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note }, now))
  }
}

/** Whether a ticket has a test complete comment, or null when its long thread couldn't be read. */
async function hasTestComplete(w: JiraIssue, re: RegExp, run: AsyncTwgRunner): Promise<boolean | null> {
  const comments = w.comment?.comments ?? []
  if (comments.some((c) => re.test(adfText(c.body)))) return true
  // Search returns at most 20 comments per issue; read the rest of a longer thread.
  if ((w.comment?.total ?? 0) <= comments.length) return false
  try {
    return (await commentThread(w.key, run)).some((c) => re.test(adfText(c.body)))
  } catch {
    return null
  }
}

async function testCompleteItem(cfg: ReleaseConfig, run: AsyncTwgRunner, now: Now): Promise<Item> {
  try {
    const workJql = `(${cfg.jql}) AND issuetype in (Story, Task, Bug)`
    const re = new RegExp(cfg.test_complete_pattern ?? TEST_COMPLETE, 'i')
    // Withdrawn or duplicate tickets were never going to be tested.
    const work = (await query(workJql, 'comment,issuetype,status', run)).filter((w) => !CLOSED_UNDONE.test(w.status?.name ?? ''))
    const missing: string[] = []
    const truncated: string[] = []
    for (const w of work) {
      const found = await hasTestComplete(w, re, run)
      if (found === false) missing.push(w.key)
      else if (found === null) truncated.push(w.key)
    }
    const done = work.length - missing.length - truncated.length
    return item({ source: SOURCE, rule: 'test-complete', status: missing.length ? 'fail' : truncated.length ? 'unknown' : 'pass',
      value: `${done} of ${work.length} stories, tasks and bugs have a test complete comment`,
      links: [jqlLink('Stories, tasks and bugs in the release', workJql), ...missing.slice(0, 15).map(browse)],
      note: truncated.length ? `${truncated.length} had more comments than Jira returned` : undefined,
      data: { total: work.length, missing, truncated } }, now)
  } catch (e) {
    return item({ source: SOURCE, rule: 'test-complete', status: 'unknown', value: 'not checked', note: `Jira could not be read: ${reason(e)}` }, now)
  }
}

/** The human_rows tickets by key, and why any couldn't be read. */
async function humanTickets(keys: string[], run: AsyncTwgRunner): Promise<{ byKey: Map<string, JiraIssue>; failed: Map<string, string> }> {
  const byKey = new Map<string, JiraIssue>()
  const failed = new Map<string, string>()
  const read = async (ks: string[]) => {
    for (const i of await query(`key in (${ks.map(jiraKey).join(', ')})`, 'status,issuetype', run)) byKey.set(i.key, i)
  }
  try {
    await read(keys)
  } catch {
    // One deleted or restricted key fails the whole query, so ask for each on its own.
    for (const k of keys) {
      try {
        await read([k])
      } catch (e) {
        failed.set(k, `Jira could not read ${k}: ${reason(e)}`)
      }
    }
  }
  return { byKey, failed }
}

const withdrawn = (i?: JiraIssue) => CLOSED_UNDONE.test(i?.status?.name ?? '')
const done = (i?: JiraIssue) => i?.status?.statusCategory?.key === 'done' && !withdrawn(i)

async function humanItems(cfg: ReleaseConfig, run: AsyncTwgRunner, now: Now): Promise<Item[]> {
  const human = Object.entries(cfg.human_rows ?? {}).map(([row, v]) => [row, Array.isArray(v) ? v : [v]] as const)
  const all = [...new Set(human.flatMap(([, ks]) => ks))]
  if (!all.length) return []
  const { byKey, failed } = await humanTickets(all, run)
  return human.map(([row, keys]) => {
    const error = keys.map((k) => failed.get(k)).find((x) => x) ?? null
    const issues = keys.map((k) => byKey.get(k))
    // Done once every ticket is done or withdrawn; withdrawn alone means the row doesn't apply.
    const status = error || issues.some((i) => !i) ? 'unknown' : issues.every((i) => done(i) || withdrawn(i)) ? 'pass' : 'unknown'
    return item({ source: SOURCE, rule: 'human', status, answer: !error && issues.every(withdrawn) ? 'N/A' : undefined,
      value: keys.map((k, n) => `${k}: ${issues[n]?.status?.name ?? 'not found'}`).join(', '), links: keys.map(browse),
      note: error ?? (status === 'unknown' ? 'the backing ticket is not done yet' : undefined), data: { row } }, now)
  })
}

export function jiraReader(cfg: ReleaseConfig, run: AsyncTwgRunner = quietRunnerAsync, now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const [bugs, tested, human] = await Promise.all([bugItems(cfg, run, now), testCompleteItem(cfg, run, now), humanItems(cfg, run, now)])
    return [...bugs, tested, ...human]
  }
}
