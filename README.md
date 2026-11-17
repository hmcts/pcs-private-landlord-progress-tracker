# PCS Private Landlord progress tracker

A public site where stakeholders can follow the Possession Claims Service (PCS) Private Landlord
workstream: roadmap, links to the QA and performance reports, RAID log (including dependencies on
other teams), product and design decisions, non-functional requirements and architecture
decisions. It's published with GitHub Pages and rebuilt every weekday morning.

| Page | Where the content comes from |
|---|---|
| Overview | `src/_data/overview.yaml`, plus figures from the latest roadmap snapshot |
| Roadmap | Epics labelled `PrivateLandlord` in the HDPI Jira project |
| Reports | Links to the QA readiness reports in `config/qa-readiness/` with `active: true` and a `report_page`, and to the performance test reports in `src/_data/reports.yaml` |
| NFRs | `src/_data/nfrs.yaml`: PCS NFRs, QA standards and HMCTS engineering standards |
| RAID log | `src/_data/raid.yaml` |
| Decisions | `src/_data/decisions.yaml` |
| ADRs | `src/adr/*.md` |

## How it works

`.github/workflows/publish.yml` runs at 06:00 UTC, Monday to Friday (and on every push to `master`):

1. Reads the epics and their child items from Jira with `twg`, the Atlassian CLI that
   cft-workspace uses (`npm run fetch`). It uses `scripts/lib/roadmap-runner.ts`, a copy of
   the generator behind cft-workspace's `/pcs:roadmap` poster. It saves
   `data/snapshots/<date>.json` and commits it. The site is built only from these
   snapshots, and together they give the burn-up chart.
2. Updates the QA readiness report of each active release on Confluence (below).
3. Builds the site with Eleventy and the [GOV.UK Eleventy plugin](https://govuk-eleventy-plugin.x-govuk.org/),
   and deploys it to GitHub Pages.

If Jira can't be read, the site is still built from the last snapshot and shows an
"out of date" warning, and the run is marked as failed.

### What gets published

This is a public site.

- From Jira, a snapshot keeps only each epic's key, summary, status, dates and child-item
  counts; each child ticket's key, summary (title), status, status category and start and due
  dates (Tests are left out); and the key and status of any linked issue in another project.
  Descriptions, comments, assignees and every other field are never kept.
- A ticket without both a start and a due date in Jira gets a forecast instead: the undated
  tickets in an epic are laid end to end, in the order of the number their summary starts with,
  across the whole timeline. The site marks these as a forecast, never as Jira dates.
- Any issue labelled `not-public` is left out.
- From the QA readiness configs, the Reports page shows only each active report's title and
  Confluence page id.
- The RAID log, decisions log, NFRs, performance report links and ADRs change only through pull
  requests, so a person reviews everything before it's published. Write entries for a public audience, and use roles
  rather than people's names.

## Updating the content

- **Overall status and milestones:** edit `src/_data/overview.yaml`.
- **RAID log:** add an entry to `src/_data/raid.yaml`. The file explains the fields.
- **Dependencies on other teams:** add a `dependency` entry (`D-001`) to `src/_data/raid.yaml`.
- **Product or design decision:** add an entry (`DEC-001`) to `src/_data/decisions.yaml`. The file
  explains the fields. Architecture decisions are ADRs instead.
- **Non-functional requirements:** add an entry to `src/_data/nfrs.yaml`, citing one of its
  `standards`. The file explains the fields.
- **Performance test report:** add its Confluence page id and title to `performance` in
  `src/_data/reports.yaml`. The file explains the fields.
- **QA readiness report:** nothing to do on the site. A report is listed on the Reports page once
  its config in `config/qa-readiness/` has `active: true` and a `report_page`, under the title the
  report has on Confluence.
- **Architecture decision:** copy `src/adr/template.md.txt` to the next number, for example
  `src/adr/0003-choose-x.md`.
- **Roadmap:** change Jira. Label an HDPI epic `PrivateLandlord` and give it a start and due
  date. Swimlanes are set in `config/roadmap.json`, along with the timeline's `start` and
  `end`. The timeline runs to `end`, or further if an epic is due later.
  Each of its tickets gets its own row; give a ticket a start and due date in Jira to replace
  its forecast.

CI (`.github/workflows/ci.yml`) validates the data files and builds the site on every pull request.

## Running it locally

You need Node 24 and
[`twg`](https://developer.atlassian.com/platform/teamwork-graph/twg-cli/) logged in to
`hmcts.atlassian.net` (`twg login --site hmcts`).

```sh
npm ci
npm run fetch   # read Jira with your twg login
npm start       # http://localhost:8080
npm test
npm run typecheck
```

## QA readiness report

`npm run qa-report -- --release R1.3A` fills in a release's QA readiness report on Confluence, and
`npm run qa-report -- --feature <name>` a feature's.
It is internal, not part of the site: nothing it collects is committed, published or printed. The
site's Reports page only links to each active report's Confluence page.

```sh
npm run qa-report -- --release R1.3A                 # dry run: collect, render, merge
npm run qa-report -- --release R1.3A --validate      # also have twg check the edits, without writing
npm run qa-report -- --release R1.3A --publish       # update the page (the release must be active)
npm run qa-report -- --release R1.3A --evidence      # re-render from the last run's evidence.json
npm run qa-report -- --release R1.4 --create-under <parentPageId> [--publish]   # no report_page yet
npm run qa-report -- --release R1.3A --judgement     # rows a person answers, from judgement.yaml
npm run qa-report -- --feature private-landlord-make-a-claim   # a feature: the same options apply
npm run qa-report -- --all-active [--publish]        # every release and feature with active: true and a report_page
npm run qa-report -- --feature private-landlord-make-a-claim --collect-only     # evidence and the agent's input only
npm run qa-report -- --feature private-landlord-make-a-claim --evidence --answers   # render with the agent's answers.json
```

Each release has `config/qa-readiness/<release>.yaml`: the `candidates` (a full commit SHA per
repo for each release candidate), the `repos` (GitHub name, Sonar project key, the Jenkinsfile's
`product` and `component` for Cosmos, and `builder`), `jql` for the release's tickets,
`report_page` and `ria_page` (Confluence page ids), `human_rows` (the Jira ticket whose status
answers a row a person signs off) and `active`. The page's rows and questions are in
`config/qa-readiness/layouts/`. `npm run validate` checks both. This repo is public, so these files
hold only page ids, repo names, SHAs, Sonar keys and Jira keys (and, for a feature, Jenkins job
names, E2E tags and spec paths).

### Feature reports

The Private Landlord workstream has no releases, so a report can cover a feature instead:
`config/qa-readiness/<feature>.yaml` with `feature: <name>` in place of `release`, and no
`candidates` or `jql`. It uses the `pcs-feature` layout, which reproduces the R1.3A report
(Confluence page 311427238) exactly, and puts nothing on the page the template doesn't have:
the "Created by" and "Last Updated" lines, the title, the template's two intro paragraphs, the
"Release Information" table (Release, Release Type, Jira Board, Jira Tickets, Test Environments,
External Dependencies, External Risks, Outstanding Bugs, GIT and GIT Revision), the 23 checklist
questions in the same order, and the Testing Summary, Defect Summary, Risks, QA Summary, QA
Recommendation and Sign-off sections, at the template's heading levels. For a feature, Release
is the feature's name, Jira Board links its epics and Jira Tickets their child tickets (the
first 15, then one link to the search for the rest). The QA agent (see "Agent answers") writes
the checklist, Release Type, Test Environments, External Dependencies, External Risks and the
sections. "Created by" is the account twg runs as, and "Last Updated" the run's date.
See `config/qa-readiness/private-landlord-make-a-claim.yaml`.

```yaml
feature: private-landlord-make-a-claim
active: false
layout: pcs-feature
epics: [HDPI-10019]                # Jira scope: these epics' child tickets
repos:
  pcs-frontend:
    github: hmcts/pcs-frontend     # sonar, cosmos_product, cosmos_component, builder as for a release
    pr: 2312                       # every row read at this pull request (or `commit`, not both)
    # commit: master               # service-wide rows: this branch's latest finished build, or a full SHA
    e2e:                           # optional: where the feature's E2E tests ran
      jenkins: { job: HMCTS_j_to_z/pcs-frontend, branch: PR-2312, build: last-completed }   # or a build number
      label: enable_private_landlord_test   # optional: the PR label that runs the feature's tests
      tags: ['@privateLandlord']   # Playwright tags: the specs that carry them are the feature's
      paths: [src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts]   # spec files or folders
```

For a feature, the collectors below gather the evidence the agent answers from; in a layout of
mechanical rows they answer the rows themselves.

- **Service-wide checks** (coverage, quality gate, static analysis, integration and contract,
  functional, yarn audit, dependency check, ignored tests) are about each repo as a whole. They are
  read at one commit per repo, picked when the evidence is collected: the newest commit on
  `commit` (default: the repo's default branch) whose Jenkins build has finished, passed or
  failed, going by its `continuous-integration/jenkins/branch` status. A full SHA pins it. With
  `pr` instead, the commit is that of the PR job's latest finished Jenkins build (Cosmos
  `pipeline-metrics`, branch `PR-<n>`), else, when Cosmos has none or can't be read, the PR's
  head commit on GitHub with its `continuous-integration/jenkins/pr-head` status; the finding says
  which. Then every reader measures the PR: SonarCloud's analysis of the pull request (by
  `pullRequest`; with only new-code coverage, that, said as "coverage of new code"), the PR
  job's latest finished build for the stage rows and CVE reports, where functional stages run on
  preview and no AAT stage runs, and the GitHub checks and source at the commit. `e2e.jenkins.branch`
  must then be `PR-<pr>`. The header's "GIT Revision" row is `<repo> = <sha7>` per repo,
  linked to the commit, and each finding says "service-wide" and the commit.
- **Feature checks** are about the feature only. The E2E finding is the outcome of the E2E stages of
  the configured Jenkins build, as Cosmos `pipeline-metrics` records them under the repo's
  `cosmos_product` and `cosmos_component` and the configured `job`: the branch's latest finished
  build in the last 60 days, or the build number given, judged as the master builds are
  (finished builds only, both databases, the same rule for which stage failed). The stages are
  the CNP library's `functionalTest:<env>` (a PR build's default, where pcs-frontend's
  Playwright suite runs), `fullFunctionalTest:<env>` and `E2eTest:<env>` (the
  `enable_full_functional_tests` and `enable_e2e_test` labels), all `:preview` on a PR. A build
  that finished without one fails the row. Which tests a stage runs depends on the PR's labels
  (pcs-frontend's `Jenkinsfile_CNP` runs `@sanity` unless a label such as
  `enable_private_landlord_test` or `e2e-tag:<tag>` says otherwise), so with `label` set, a pass
  stands only while the PR carries that label and no `e2e-tag:` label; without it, the comment
  says the result covers whatever scope the build ran. When Cosmos has no finished build of the
  branch, the row falls back to GitHub: the `continuous-integration/jenkins/pr-head` status on
  the PR's head commit, which is the whole build's result, not the E2E stage's, and the comment
  says so. Its success is a pass only with `label` set (and on the PR); without one it is
  unknown. When Cosmos can't be read, the fallback's answer goes in the comment only, and a
  publish keeps the page's. Neither source has per-test results, so the row says which stages
  passed, not how many tests did. The `e2e-build` finding names the build and the commit it ran
  (or, from GitHub, the PR head). The
  feature's ignored-tests check scans only the specs `tags` and `paths` pick, at that commit.
  Outstanding bugs, Critical and High bugs, test complete comments and "are the stories done"
  read the epics' child tickets (`parent in (…)`, as the roadmap does). Performance and security
  rows come from `ria_page` if set, and are N/A ("no RIA for this feature") if not.

| Source | Rows |
|---|---|
| SonarCloud (public API), the analysis of each candidate commit | coverage, quality gate, static analysis |
| Cosmos `pipeline-metrics` and `cve-reports` (databases `jenkins` and `sds-jenkins`), the Jenkins builds of each candidate commit | integration and contract, functional, deployed to AAT, yarn audit, dependency check |
| GitHub check runs on each candidate commit | integration and contract, functional, deployed to AAT |
| Cosmos `pipeline-metrics`, else GitHub's Jenkins status on the PR head, for a feature's configured build | a feature's E2E tests passed, and which build ran them |
| The source at each candidate commit, and at a feature's E2E build | ignored or pending tests |
| Jira, through twg | outstanding bugs, Critical and High bugs, test complete comments, rows in `human_rows` |
| The Release Impact Assessment, through twg | performance and security sign-off |

A source that can't be read leaves its rows unknown with the reason, and the run carries on. A
release's unknown row says "To confirm"; a feature's, and any agent row, leaves its status blank,
its comment saying what is missing.
The evidence marks those items `unreachable`, apart from items that are unknown because what was
asked about isn't there (no analysis of the commit, no matching check, a ticket not done). When a
row is unknown only because of an unreachable source, a publish leaves its cells as the page has
them, so a published "Yes" isn't turned back into an unknown. That is what lets a local run,
where Cosmos usually refuses access, leave alone the rows the scheduled run filled in.
A row passes only when every check it asks for passes: Cosmos and GitHub are alternatives for the
same build check, but a closed `human_rows` ticket never makes up for a check that couldn't be made.
Only Jenkins builds that finished count, the latest of each job.
Cosmos is read with a read-only key in `COSMOS_PIPELINE_METRICS_KEY` if set, else your `az login`,
which needs a Cosmos DB data-plane reader role. Without one, the rows only Jenkins can answer
(yarn audit and dependency check) come out unknown.

Evidence, the rendered report and the merge go to `.cache/qa/<release>/` (gitignored), or
`$RUNNER_TEMP/qa` in CI, or `QA_CACHE_DIR`. `diff.txt` there says what a publish would change.
`--evidence` reuses the `evidence.json` there, and `--judgement` reads `judgement.yaml` (or
`judgement.json`) beside it. A `--config` file must be in `config/qa-readiness/` or the cache
directory. When a run fails it prints only what kind of failure it was;
the error itself is appended to `errors.log` in the cache directory.

The cells the pipeline writes begin with a hidden anchor macro, `qa-auto-<row>-<cell>-<hash>`, the
hash being of the cell's text, links and macros. A publish replaces only those cells, and only while
they still match the hash. Edit a cell, even just a link in it, and the pipeline leaves it alone from
then on, and leaves the other cell of that row alone too; delete a row and it is added back.
Rows the page has out of the layout's order are moved where the layout has it, as few as it
takes to put the table in order, whoever wrote them. A move keeps the row as it is: its content,
local ids and inline comments.

A layout with `sections` (`pcs-feature`) owns the rest of the page the same way. The header lines
above the title, the intro below it and each section (everything between its heading and the
next heading) begin with a hidden anchor macro, `qa-auto-part-<part>-<hash>`, hashing the
whole part. A publish rewrites a part only while it still matches; edit anything in it and it is
yours. A section the page lacks is added, with its heading, after the one before it. A run that
would change nothing but the "Last Updated" date leaves the page alone. Cells of an agent row
that are empty and unmarked hold nothing to lose, so they are written as if the pipeline's.
Changing a layout is migrated the same way, touching only what the pipeline wrote: rows it no
longer has are removed if nobody edited them, a table's heading is rewritten if it reads exactly
as one in the table's `formerly` list, and unmarked paragraphs between the title and the first
table are replaced if each reads exactly as one in the layout's `intro` or `former_intro`. If
only some do, those alone are replaced, and the paragraphs a person wrote stay beside the
template's intro, which the pipeline owns from then on.

Classic pages are edited through their draft. If the draft holds changes nobody has published yet,
publishing ours would publish theirs too, so `--publish` and `--validate` leave that page alone and
say "page has unpublished edits; skipped". The run doesn't fail; the next one tries again.

Some rows have nothing to answer them mechanically, and come out "To confirm" (unknown). `--judgement`
takes their answers from `judgement.yaml` in the release's cache directory, keyed by row
number, with a `status` (Yes, No or N/A), a `comment` and optional `links`:

```yaml
'16': { status: 'Yes', comment: Manual regression on V2 passed., links: [{ text: HDPI-8908, url: 'https://hmcts.atlassian.net/browse/HDPI-8908' }] }
```

Those cells are written without the marker, so once published they are a person's like any
other, and no later run changes them. They are written only over a cell the pipeline still owns
and nobody has edited, or into a missing row: if someone has written either cell of a row, the
row is left as it is. The file holds internal detail, so it goes in the cache directory. The
project skill `/qa-readiness-report` (`.claude/skills/qa-readiness-report/`)
walks an agent through it: the release config, a dry run, researching each row in Jira and
Confluence, drafting the judgements, and publishing once you've seen the diff and said so.
Run locally, edits are made as your own twg login.

### Agent answers

A layout row with `rule: agent` is answered by the QA agent, Claude, rather than by a mechanical
check. Every checklist row of `pcs-feature` is one, and so are its Release Type, Test
Environments, External Dependencies and External Risks rows. Such a row can also have:

- `evidence`: the rules whose findings the agent gets as facts for the row, e.g.
  `[functional, e2e-feature, e2e-build]` for "Have all Functional Automation Tests passed?".
  They inform the answer but don't decide it: a failing check isn't combined with the answer.
- `guide`: what Yes, No and N/A mean for the question, and what to look for.

It runs in three steps:

1. `--collect-only` collects the evidence and writes `evidence.json` and `agent-input.json` to
   the scope's cache directory, and stops. The input holds the scope (epics, repos, the commits
   read, the E2E config) and, per row, the question, guide, evidence and what the published page
   says now (read through twg, read-only; left out if the page can't be read), so the agent keeps
   the wording when nothing has changed. For a layout with sections it also has the agent info
   rows, each section's heading, columns and fixed entries, and `createdBy`, the display name of
   the account twg runs as (`twg confluence space me`, read-only; never printed), which the
   pipeline writes on the "Created by" line itself. With no name, the page's line stays as it
   is. It removes any earlier `answers.json`.
2. The agent follows `config/qa-readiness/agent-prompt.md`: it reads the input, investigates the
   repos, CI and the epics' tickets, and writes `answers.json` beside it, keyed by row:
   `{ "1": { "answer": "Yes", "comment": "…", "links": [{ "text": "…", "url": "https://…" }] } }`,
   with `answer` one of Yes, No, N/A or `""`, which leaves the status blank when the evidence
   can't establish it (the comment says what is missing). Under `sections` go
   `info` (the agent info rows' `text` and `links`),
   `testingSummary` (each activity: `✅ Completed`, `NA` or `""`), `defectSummary` (a count
   per severity and the sentence under the table), `risks` (up to 10 risks with their mitigations),
   `qaSummary`, `recommendation` (`approved` and the reason, rendered as the template's bold
   "✅ QA APPROVED FOR RELEASE" or "❌ QA NOT APPROVED FOR RELEASE" line and a paragraph) and
   `signOff` (each role's name and `✅ Approved` or `""`).
3. `--answers` renders and merges from the cached evidence and the answers (it implies
   `--evidence`, so the answers meet the evidence they were written against). Each answer is
   checked on its own: a comment of up to 1500 characters, up to 12 https links, and at least
   one link for a Yes or No. Each section is checked the same way, on its own: length caps,
   https-only links, and exactly the layout's entries. One that fails is left
   out, and why goes to `answers-rejected.txt`. A row or section with no answer keeps what the
   page says.

The answer alone decides the row's status. Its cells carry the pipeline's marker, like any other
generated cell, so the next run's answer replaces them, and a person who edits one takes the row
over. If a row's question on the page differs from the layout's, as when the layout's rows are
renumbered, the question is rewritten together with the row's new answer, and only when the
status and comment are written in the same merge. Until the agent answers it, the row stays as
the page has it, old question and old answer together.

To preview what CI would write, run the same steps locally (the skill below does this):
`--collect-only`, the prompt through `claude -p`, then `--evidence --answers` as a dry run.

### In the Publish workflow

The Publish workflow's `qa-report` job runs `npm run qa-report -- --all-active --collect-only`,
then the QA agent, then `npm run qa-report -- --all-active --answers --publish`. It has
its own twg sign-in, the QA secret (see "Jira sign-in"), so Confluence edits are made as whoever
seeded that, and that account needs edit rights on each report page. The answers come from
Claude on Amazon Bedrock. Each active release and
feature is done on its own; if any fails, or twg can't sign in, the run is marked as failed, but
the site is still deployed. Evidence goes to `$RUNNER_TEMP/qa` and is deleted with the sign-ins
at the end, and the log gets only counts. To stop a report being updated, set `active: false`
in its config.

The agent step uses `anthropics/claude-code-action` in agent mode, as hmcts/cath-service does:

- Claude Sonnet on Bedrock, through the shared `HMCTSClaudeGitHubActionsRole` AWS role (OIDC,
  `eu-west-1`), with `--max-turns 150` and the step limited to 35 minutes (the job to 75).
- A GitHub token from the HMCTS Claude Code app (`CLAUDE_CODE_APP_ID`,
  `CLAUDE_CODE_PRIVATE_KEY`, organisation secrets), minted with read-only contents and
  metadata permissions.
- The twg sign-in for read-only Jira and Confluence calls. Azure is signed out before the step, so
  the agent can't reach the vault; the job signs in again afterwards to store the twg sign-in.
- `--dangerously-skip-permissions`, as the other HMCTS workflows pass, so its `--allowedTools`
  list documents the read-only tools it's meant to use rather than enforcing them. The prompt
  forbids any command that writes, and has the agent treat Jira and Confluence text as data.
  Reads of the sign-ins on disk are denied, the full output is off (the logs are public), and
  the publish step runs only if the checkout is unchanged after the agent, with its dependencies
  reinstalled.

If the agent fails or times out, the reports are still published, with the agent rows as the
page had them, and the job fails. Before it can run, the repo must be in the AWS role's trust
policy (a platform request, as for hmcts/cft-workspace's doc-drift).

The job runs on GitHub's own runners (`ubuntu-latest`), each a fresh VM, only on the schedule
and on a manual dispatch from `master`, never on a push or from another branch. It has its own
concurrency group (`qa-report`) and nothing waits for it, so it never delays the site.

Cosmos is read with the account's read-only key in the `COSMOS_PIPELINE_METRICS_KEY` repository
secret. It's a copy of `cve-cosmos-readonly-key` in the `dtsse-aat` Key Vault, which
dtsse-github-metrics' CVE collector also reads; copy it again if that key is rotated. Only the
report step gets it. The workflow's Azure sign-in has no Cosmos role, so without the key the Cosmos
rows (yarn audit, dependency check, and the Jenkins stage rows GitHub doesn't answer) are unknown,
and a publish keeps their published answers, a feature's E2E rows included.
Giving the app registration the *Cosmos DB Built-in Data Reader* data-plane role on the
`pipeline-metrics` account (subscription DCD-CNP-Prod) would remove the stored key, but that's a
platform request.

## Setup

1. In Settings → Pages, set the source to **GitHub Actions**.
2. The workflow commits snapshots to `master`. If `master` is protected, allow
   `github-actions[bot]` to push to it.
3. Add the repository secrets and variables below.
4. Set up the Jira sign-in (next section).

| Secret | What it is |
|---|---|
| `TWG_AZURE_CLIENT_ID` | Client ID of the app registration the workflow signs in to Azure as |
| `AZURE_TENANT_ID` | The HMCTS Azure tenant ID |
| `COSMOS_PIPELINE_METRICS_KEY` | Optional. The `pipeline-metrics` Cosmos read-only key, for the QA readiness report |

| Variable | What it is |
|---|---|
| `TWG_KEY_VAULT` | The Key Vault holding the twg sign-in |
| `TWG_SECRET_NAME` | Optional. The secret's name. Defaults to `twg-auth-conf-pcs-progress-tracker` |
| `QA_TWG_SECRET_NAME` | Optional. The QA readiness report's twg sign-in, in the same vault. Defaults to `twg-auth-conf-pcs-progress-tracker-qa` |

Nothing reads Jenkins any more: the `JENKINS_TOKEN` secret and `JENKINS_USER` variable are no
longer used and can be deleted.

To pick up a newer version of the roadmap generator, copy
`apps/pcs/.claude/scripts/lib/roadmap/roadmap-runner.ts` from `hmcts/cft-workspace` over
`scripts/lib/roadmap-runner.ts`, keeping its header comment, and update the commit there.

## Jira sign-in

`twg` has no credential designed for CI: its login is OAuth in a browser. So the workflow
uses the same arrangement as cft-workspace's doc-drift workflow. A sign-in is made once by
hand and stored in Key Vault as an archive of twg's sign-in files. Each run restores
it, runs `twg auth refresh`, and writes the rotated sign-in straight back, in the format it came
in. Every refresh spends the previous token, so:

- **Each job needs its own sign-in.** The `build` job (the roadmap) uses
  `twg-auth-conf-pcs-progress-tracker`, and the `qa-report` job (the QA readiness reports) uses
  `twg-auth-conf-pcs-progress-tracker-qa`, both in `TWG_KEY_VAULT`. Don't reuse another job's
  or workflow's secret, and don't keep using a sign-in after you've stored it. Whichever copy
  refreshed first would sign the others out.
- **Two runs of one job must not overlap.** Each job's `concurrency` group (`publish` and
  `qa-report`) ensures that.
- Jira and Confluence are read, and the reports edited, as whoever seeded each secret, so the
  roadmap shows what that account can see.

The workflow reaches the vault with `azure/login` over OIDC. It needs:

- an app registration (defined in
  [`hmcts/azure-github-federation-config`](https://github.com/hmcts/azure-github-federation-config))
  with a federated credential for
  `repo:hmcts@22817111/pcs-private-landlord-progress-tracker@1451103556:ref:refs/heads/master`.
  GitHub puts the org and repo IDs in the subject for repos created after 15 July 2026.
  Runs from other branches can't reach the vault, so they build from the last snapshot.
- a Key Vault access policy for that app with secrets **Get** and **Set**, and no other roles.

**Seed a secret**, or re-seed it when a run reports `twg auth refresh` exit 77 (Atlassian
rejected the token, typically after 90 days unused). Make the seed login in a throwaway home,
so it never touches your own:

1. Sign in, in a temporary directory, as the account that job should read Jira as (and, for
   the QA secret, edit the reports as). `twg login` needs a terminal, and its device code
   expires quickly, so approve it as soon as it appears.

   ```bash
   d=$(mktemp -d)
   HOME="$d" XDG_CONFIG_HOME="$d/.config" twg login --force --site hmcts
   ```

   `HOME="$d" XDG_CONFIG_HOME="$d/.config" twg auth storage status` should report the `file`
   backend: a sign-in kept in the system keychain isn't in the directory, so it can't be stored.

2. Store it, and delete the temporary directory:

   ```bash
   scripts/seed-twg-secret.sh <TWG_KEY_VAULT> <secret name> "$d"
   ```

   `<secret name>` is `twg-auth-conf-pcs-progress-tracker` for the roadmap, or
   `twg-auth-conf-pcs-progress-tracker-qa` for the QA reports. The script packs only the
   sign-in files (`auth-profiles.json` and `auth.conf`, without their access tokens; the rest of
   the directory is caches twg rebuilds), using the same code as the workflow. It checks the
   value holds a refresh token, decodes to those files alone and fits Key Vault's 25 KB, stores
   it with `--file` so it's never on a command line, and keeps `az`'s output, which echoes the
   value, off the terminal. It prints only whether that worked and the size, and deletes `$d`
   only once the secret is stored. It needs GNU `tar`, `jq` and `az`.

That's all: there's no need to run the workflow first, or to sign in again yourself. The seed
was its own login, so it never shares a token with yours, and neither can sign the other out.
Seed the two secrets one at a time, each with its own login: the same sign-in stored twice
would be two copies of one token.

Secrets seeded the old way, as twg's `auth.conf` without its `oauth-access-token=` line, still
restore, and are stored back in that format. So do archives packed by hand from the whole
`twg` directory (`tar -C "$d/.config" -czf - twg`): only `auth-profiles.json` and `auth.conf`
are unpacked, the caches beside them are skipped, and the first store after the refresh
replaces the secret with those two files alone. An archive holding a link, a path outside
`twg/` or a name with a space is still refused.

If the roadmap's sign-in fails, the site is still published from the last snapshot with an "out
of date" warning, and the run fails so someone notices. If the QA sign-in isn't seeded or fails,
the `qa-report` job stands down without spending anything and fails, which never affects the site.
