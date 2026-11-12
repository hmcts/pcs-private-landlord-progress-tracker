// Jira, read through twg as the roadmap is (scripts/lib/roadmap-runner.ts): outstanding bugs by
// priority, "Test Complete" style comments on the release's stories, tasks and bugs, and the
// status of each ticket backing a human-answered row. The report is internal, so this doesn't
// apply the public site's not-public filter, and nothing it reads may reach the site.

import type { ReleaseConfig } from '../config.ts'
import { defaultRunner, type TwgRunner, twgQuery } from '../../roadmap-runner.ts'
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

/** All issues for a JQL query, through the roadmap's read-only, paginating twgQuery. */
export const query = (jql: string, fields: string, run: TwgRunner = defaultRunner): JiraIssue[] =>
  twgQuery(jql, run, fields) as unknown as JiraIssue[]

/** Every comment on one issue. Only ever runs `twg jira workitem comment query`. */
export function commentThread(key: string, run: TwgRunner = defaultRunner): { body?: unknown }[] {
  const out: { body?: unknown }[] = []
  let cursor: string | undefined
  for (;;) {
    const args = ['jira', 'workitem', 'comment', 'query', '--issue-id', key, '--first', '100', '-o', 'json', '--output-summary', 'none']
    if (cursor) args.push('--after', cursor)
    const page = JSON.parse(run(args)) as { data: { body?: unknown }[]; pageInfo?: { hasNextPage?: boolean; nextCursor?: string | null } }
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

export function jiraReader(cfg: ReleaseConfig, run: TwgRunner = defaultRunner, now?: () => Date): () => Promise<Item[]> {
  return async () => {
    const out: Item[] = []
    const types = cfg.bug_types ?? ['Bug']
    const bugJql = `(${cfg.jql}) AND issuetype in (${types.map((t) => `"${t}"`).join(', ')}) AND statusCategory != Done`

    try {
      const bugs = query(bugJql, 'priority,status,issuetype', run)
      const counts: Record<string, number> = Object.fromEntries(PRIORITIES.map((p) => [p, 0]))
      const keys: Record<string, string[]> = Object.fromEntries(PRIORITIES.map((p) => [p, []]))
      for (const b of bugs) {
        const p = band(b.priority?.name)
        counts[p]++
        keys[p].push(b.key)
      }
      const text = PRIORITIES.map((p) => `${p} – ${counts[p]}`).join(', ')
      const links = [jqlLink('Open bugs in the release', bugJql)]
      out.push(item({ source: SOURCE, rule: 'outstanding-bugs', status: 'pass', value: text, links, data: { counts, keys } }, now))
      const high = counts.Critical + counts.High
      out.push(item({ source: SOURCE, rule: 'high-defects', status: high ? 'fail' : 'pass',
        value: high ? `${high} Critical or High bug${high === 1 ? '' : 's'} still open` : 'no Critical or High bugs open',
        links: [...links, ...[...keys.Critical, ...keys.High].slice(0, 10).map(browse)], data: { counts } }, now))
    } catch (e) {
      const note = `Jira could not be read: ${reason(e)}`
      for (const rule of ['outstanding-bugs', 'high-defects']) out.push(item({ source: SOURCE, rule, status: 'unknown', value: 'not checked', note }, now))
    }

    try {
      const workJql = `(${cfg.jql}) AND issuetype in (Story, Task, Bug)`
      const re = new RegExp(cfg.test_complete_pattern ?? TEST_COMPLETE, 'i')
      // Withdrawn or duplicate tickets were never going to be tested.
      const work = query(workJql, 'comment,issuetype,status', run).filter((w) => !CLOSED_UNDONE.test(w.status?.name ?? ''))
      const missing: string[] = []
      const truncated: string[] = []
      for (const w of work) {
        let comments = w.comment?.comments ?? []
        if (comments.some((c) => re.test(adfText(c.body)))) continue
        // Search returns at most 20 comments per issue; read the rest of a longer thread.
        if ((w.comment?.total ?? 0) > comments.length) {
          try {
            comments = commentThread(w.key, run)
          } catch {
            truncated.push(w.key)
            continue
          }
          if (comments.some((c) => re.test(adfText(c.body)))) continue
        }
        missing.push(w.key)
      }
      const done = work.length - missing.length - truncated.length
      out.push(item({ source: SOURCE, rule: 'test-complete', status: missing.length ? 'fail' : truncated.length ? 'unknown' : 'pass',
        value: `${done} of ${work.length} stories, tasks and bugs have a test complete comment`,
        links: [jqlLink('Stories, tasks and bugs in the release', workJql), ...missing.slice(0, 15).map(browse)],
        note: truncated.length ? `${truncated.length} had more comments than Jira returned` : undefined,
        data: { total: work.length, missing, truncated } }, now))
    } catch (e) {
      out.push(item({ source: SOURCE, rule: 'test-complete', status: 'unknown', value: 'not checked', note: `Jira could not be read: ${reason(e)}` }, now))
    }

    const human = Object.entries(cfg.human_rows ?? {}).map(([row, v]) => [row, Array.isArray(v) ? v : [v]] as const)
    const all = [...new Set(human.flatMap(([, ks]) => ks))]
    if (all.length) {
      let byKey = new Map<string, JiraIssue>()
      let error: string | null = null
      try {
        byKey = new Map(query(`key in (${all.join(', ')})`, 'status,issuetype', run).map((i) => [i.key, i]))
      } catch (e) {
        error = `Jira could not be read: ${reason(e)}`
      }
      for (const [row, keys] of human) {
        const issues = keys.map((k) => byKey.get(k))
        const withdrawn = (i?: JiraIssue) => CLOSED_UNDONE.test(i?.status?.name ?? '')
        const done = (i?: JiraIssue) => i?.status?.statusCategory?.key === 'done' && !withdrawn(i)
        // Done once every ticket is done or withdrawn; withdrawn alone means the row doesn't apply.
        const status = error || issues.some((i) => !i) ? 'unknown' : issues.every((i) => done(i) || withdrawn(i)) ? 'pass' : 'unknown'
        out.push(item({ source: SOURCE, rule: 'human', status, answer: !error && issues.every(withdrawn) ? 'N/A' : undefined,
          value: keys.map((k, n) => `${k}: ${issues[n]?.status?.name ?? 'not found'}`).join(', '), links: keys.map(browse),
          note: error ?? (status === 'unknown' ? 'the backing ticket is not done yet' : undefined), data: { row } }, now))
      }
    }
    return out
  }
}
