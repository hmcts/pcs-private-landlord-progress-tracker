// A TwgRunner for the public site: the generator's own `twg` runner, with not-public issues
// kept out.
//
// Jira is read with `twg`, the same CLI and sign-in mechanism cft-workspace uses. Locally
// that's your own `twg login`; in CI it's a sign-in restored from Key Vault (see
// .github/workflows/publish.yml). This wrapper changes two things about each call: it adds
// a not-public exclusion to the query's JQL, and it drops any not-public issue that still
// comes back. Everything else (arguments, paging, output shape) is the generator's.

import { defaultRunner, type Issue, type TwgRunner } from './lib/roadmap-runner.ts'

export const NOT_PUBLIC = 'not-public'

/** Adds the not-public exclusion, keeping any ORDER BY at the end. */
export function publicJql(jql: string): string {
  const m = [...jql.matchAll(/\sORDER\s+BY(?=\s)/gi)]
    .find((o) => !/[\n\r\u2028\u2029]/.test(jql.slice(o.index + o[0].length).trimStart()))
  let cut = m ? m.index : jql.length
  while (m && cut > 0 && /\s/.test(jql[cut - 1])) cut--
  // `labels not in (...)` alone would also drop every issue that has no labels at all.
  return `(${jql.slice(0, cut)}) AND (labels is EMPTY OR labels not in ("${NOT_PUBLIC}"))${jql.slice(cut)}`
}

export function publicRunner(run: TwgRunner = defaultRunner): TwgRunner {
  return (args) => {
    const n = args.indexOf('--jql')
    if (n < 0 || n + 1 >= args.length) throw new Error('expected a --jql argument')
    const out = JSON.parse(run(args.map((a, i) => (i === n + 1 ? publicJql(a) : a))))
    out.data.issues = (out.data.issues as Issue[]).filter((i) => !(i.labels ?? []).includes(NOT_PUBLIC))
    return JSON.stringify(out)
  }
}
