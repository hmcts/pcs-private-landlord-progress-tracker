---
name: qa-readiness-report
description: Fill in a PCS release's or feature's QA readiness report on Confluence. Set up the release's or feature's config, collect the evidence (SonarCloud, Jenkins in Cosmos, GitHub, Jira, the Release Impact Assessment), dry-run the merge, research the rows a person has to answer and draft their judgements, then publish once the user confirms. Use when the user asks "do the QA readiness report for R1.4", "set up the QA report for the next release", "do a QA report for the private landlord feature", "scope a QA report to epic HDPI-…", "what's still To confirm on the R1.3A report", "fill in the rows the pipeline can't answer", "publish the QA report".
---

# Fill in a QA readiness report

Drive `npm run qa-report` from the root of this repo. The README's "QA readiness report"
section explains the config fields, the sources and how a merge keeps what people wrote.

**This repo, its site and its Actions logs are public.** Evidence, judgements and diffs stay in
`.cache/qa/<release>/` (gitignored). Never commit them, paste them into a PR or an issue, or move
them anywhere under `src/`, `data/`, `config/` or `_site/`. Release configs hold only page ids,
repo names, SHAs, Sonar keys and Jira keys; feature configs also Jenkins job names, E2E tags and
spec paths.

**Never write to Confluence or Jira without the user's explicit go-ahead.** A dry run and
`--validate` write nothing. `--publish` and `--create-under … --publish` edit Confluence as the
user's own twg login, so the page history shows them as the author. Publish only to the page
the user named (the config's `report_page`); if a release has none, ask which parent page to
create it under rather than picking one.

## 1. The release config

Use `config/qa-readiness/<release>.yaml` if it exists. Otherwise copy `R1.3A.yaml`, rename
it to the release (the file name must match `release:`), and fill in:

- `candidates`: one entry per release candidate (V1, V2, …), each with the full 40-character
  SHA per repo. Take them from the release's code-freeze or release-candidate tickets in Jira,
  or the "GIT Revision" row of an earlier draft of the report. Check each one exists with
  `gh api repos/hmcts/<repo>/commits/<sha> --jq .sha`. Don't guess a SHA from a date: ask.
- `repos`: copy from R1.3A unless the release adds a repo. The Sonar key is
  `sonar.projectKey` in the repo's `build.gradle` or `sonar-project.properties`; the Cosmos
  `cosmos_product` and `cosmos_component` are the `product` and `component` in its
  `Jenkinsfile_CNP`.
- `jql`: the release's tickets, usually its fix version or labels. Check the count with
  `TWG_AGENT_DEFAULTS=1 twg jira workitem query --jql '<jql>'` before relying on it.
- `ria_page`: the Release Impact Assessment's page id. Find it with
  `TWG_AGENT_DEFAULTS=1 twg confluence search text '<release> Release Impact Assessment'`, and
  confirm the title with the user.
- `report_page`: only the page id the user gives you.
- `human_rows`: for rows a person signs off (performance report, manual regression, dependent
  services), the Jira ticket(s) whose status backs the answer.
- `active: true` only when the user wants it published. Active releases with a `report_page`
  are also updated by the Publish workflow every weekday (its `qa-report` job, on the
  `azure-nonprod` self-hosted runners).

Run `npm run validate` after editing.

### A feature instead of a release

The Private Landlord workstream has no releases: its reports are per feature. Copy
`private-landlord-make-a-claim.yaml`, rename it to the feature (the file name must match
`feature:`), and fill in:

- `epics`: the feature's HDPI epic keys. Its Jira rows read their child tickets. Epic keys and
  summaries are in the latest `data/snapshots/*.json`; confirm the list with the user.
- `repos`: as for a release, plus `commit` (leave it `master` for the latest finished master
  build; pin a full SHA only if the user wants a fixed commit). These are the service-wide rows.
- `repos.<repo>.e2e`, for each repo whose E2E tests cover the feature:
  - `tags` / `paths`: the feature's Playwright tag (`git -C <clone> grep -n "@<tag>" origin/master -- src/e2eTest src/test/ui`)
    and/or its spec files. Check they pick only the feature's specs.
  - `jenkins`: the build that ran them, usually a PR's, e.g.
    `{ job: HMCTS_j_to_z/pcs-frontend, branch: PR-2312, build: last-completed }`. Find the PR with
    `gh pr list --repo hmcts/<repo> --label <e2e label>`; the labels that pick an E2E suite are
    in the repo's `Jenkinsfile_CNP`. Check the build ran them: the Jenkins MCP's
    `get_build_test_report` should list cases with the tag in their name.
- `layout: pcs-feature`, and `ria_page` only if the feature has its own RIA.

Use `--feature <name>` in place of `--release <name>` below.

**E2E rows need Jenkins**, which is reachable only on the VPN, with `JENKINS_USERNAME` and
`JENKINS_PASSWORD` set in the environment (never read or print them, and never read
`.claude/*.env` files). Without them the E2E rows come out unknown and unreachable, and the
run says "(source unreachable: keeps the published answer)". That's expected off the VPN: a
publish leaves those rows as the page has them. The scheduled Publish workflow runs on the
`azure-nonprod` self-hosted runners with its own Jenkins token; its "Check Jenkins can be
reached" notice says whether it could read Jenkins. If it couldn't, refresh the rows by running
the report locally on the VPN, and publish once the user says so.

```sh
npm run qa-report -- --release <release>              # collect, render, merge; writes nothing
npm run qa-report -- --release <release> --validate   # also has twg check the edits
```

Locally, Cosmos usually answers 403 (no data-plane role), so the Jenkins rows come out
unknown with a note; that's expected, not a fault to fix. A row unknown only because a source
couldn't be read is marked "(source unreachable: keeps the published answer)": a publish leaves
its cells as they are, and `diff.txt` says "kept as published". The output is counts only, and a
failure prints only its kind: the reason is in `.cache/qa/errors.log`. The detail
is in `.cache/qa/<release>/`: `evidence.json` (what each source said), `report.html`,
`page.html` (the page as read), `merged.html`, `edits.json` and `diff.txt` (what a publish would
change, and which cells are kept because a person wrote them).

## 3. Rows that need a person

Rows marked `(needs a person)`, and rows left "To confirm", have no mechanical answer. For each:

1. Read its question in `config/qa-readiness/layouts/<layout>.yaml` and what `evidence.json`
   and `page.html` already say for it. If the page already has a person's answer, leave it.
2. Gather what is on record: the `human_rows` tickets and the tickets linked from them
   (`twg jira workitem get <key>`, including comments), test reports and sign-offs on Confluence
   (`twg confluence search text …`, `twg confluence content get <id>`), the RIA.
3. Draft `.cache/qa/<release>/judgement.yaml`, keyed by row number:

   ```yaml
   '16':
     status: 'Yes'   # Yes, No or N/A
     comment: Manual regression on V2 passed with no open defects.
     links:
       - { text: HDPI-8908, url: 'https://hmcts.atlassian.net/browse/HDPI-8908' }
   ```

   Comments state facts and where they come from. Never answer "Yes" without evidence that
   says so; "N/A" needs the reason in the comment. If the evidence is missing, contradictory or
   only someone's say-so in chat, leave the row out so it stays "To confirm", and tell the user
   what's missing and who could answer.
4. Re-run with the judgement and the evidence already collected:

   ```sh
   npm run qa-report -- --release <release> --evidence --judgement
   ```

Judgement cells are written without the pipeline's marker, so once published they belong to a
person and no later run changes them. They are only written over a cell the pipeline still owns
and nobody has edited, or into a missing row; a row where someone has written either cell is
left as it is, and `diff.txt` says so.

## 4. Show, then publish

Show the user `diff.txt`, and each judgement with its evidence. Publish only when they say so
for this page:

```sh
npm run qa-report -- --release <release> --evidence --judgement --publish
```

Report the counts it prints. "page has unpublished edits; skipped" means someone has the page
open with changes they haven't published: nothing was written. Tell the user, and re-run once that
person has published or discarded their draft. If it fails on a page conflict twice, someone is
editing the page: wait and re-run, don't retry in a loop.
