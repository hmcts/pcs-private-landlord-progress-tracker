# PCS Private Landlord progress tracker

A public site where stakeholders can follow the Possession Claims Service (PCS) Private Landlord
workstream: roadmap, RAID log (including dependencies on other teams), product and design
decisions, non-functional requirements and architecture decisions. It's published with
GitHub Pages and rebuilt every weekday morning.

| Page | Where the content comes from |
|---|---|
| Overview | `src/_data/overview.yaml`, plus figures from the latest roadmap snapshot |
| Roadmap | Epics labelled `PrivateLandlord` in the HDPI Jira project |
| Quality assurance | Not live yet: test layering and pipeline health |
| Performance | Not live yet: waiting for the performance tests to run in Jenkins |
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
- The RAID log, decisions log, NFRs and ADRs change only through pull requests, so a person reviews
  everything before it's published. Write entries for a public audience, and use roles
  rather than people's names.

## Updating the content

- **Overall status and milestones:** edit `src/_data/overview.yaml`.
- **RAID log:** add an entry to `src/_data/raid.yaml`. The file explains the fields.
- **Dependencies on other teams:** add a `dependency` entry (`D-001`) to `src/_data/raid.yaml`.
- **Product or design decision:** add an entry (`DEC-001`) to `src/_data/decisions.yaml`. The file
  explains the fields. Architecture decisions are ADRs instead.
- **Non-functional requirements:** add an entry to `src/_data/nfrs.yaml`, citing one of its
  `standards`. The file explains the fields.
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
It is internal, not part of the site: nothing it collects is committed, published or printed.

```sh
npm run qa-report -- --release R1.3A                 # dry run: collect, render, merge
npm run qa-report -- --release R1.3A --validate      # also have twg check the edits, without writing
npm run qa-report -- --release R1.3A --publish       # update the page (the release must be active)
npm run qa-report -- --release R1.3A --evidence      # re-render from the last run's evidence.json
npm run qa-report -- --release R1.4 --create-under <parentPageId> [--publish]   # no report_page yet
npm run qa-report -- --release R1.3A --judgement     # rows a person answers, from judgement.yaml
npm run qa-report -- --feature private-landlord-make-a-claim   # a feature: the same options apply
npm run qa-report -- --all-active [--publish]        # every release and feature with active: true and a report_page
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
`candidates` or `jql`. It uses the `pcs-feature` layout. See
`config/qa-readiness/private-landlord-make-a-claim.yaml`.

```yaml
feature: private-landlord-make-a-claim
active: false
layout: pcs-feature
epics: [HDPI-10019]                # Jira scope: these epics' child tickets
repos:
  pcs-frontend:
    github: hmcts/pcs-frontend     # sonar, cosmos_product, cosmos_component, builder as for a release
    commit: master                 # service-wide rows: this branch's latest finished build, or a full SHA
    e2e:                           # optional: where the feature's E2E tests ran
      jenkins: { job: HMCTS_j_to_z/pcs-frontend, branch: PR-2312, build: last-completed }   # or a build number
      tags: ['@privateLandlord']   # Playwright tags in the test titles
      paths: [src/test/ui/e2eTest/privateLandlordMakeAClaim.spec.ts]   # spec files or folders
```

- **Service-wide rows** (coverage, quality gate, static analysis, integration and contract,
  functional, yarn audit, dependency check, ignored tests) are about each repo as a whole. They are
  read at one commit per repo, picked when the evidence is collected: the newest commit on
  `commit` (default: the repo's default branch) whose Jenkins build has finished, passed or
  failed, going by its `continuous-integration/jenkins/branch` status. A full SHA pins it. The
  header's "Service-wide revision" row names the commit, and each row's comment says
  "service-wide" and the commit.
- **Feature rows** are about the feature only. The E2E row counts the passed, failed, flaky and
  skipped tests among the configured Jenkins build's results that carry one of `tags` in their
  title or come from one of `paths`; the header's "E2E build" row names the build and the commit
  it ran. No matching test is a failure (the scope is wrong, or the suite didn't run), not a pass.
  The results come from the build's JUnit report: pcs-frontend's PR builds publish their Playwright
  results there, but pcs-api's "E2E Test - AKS preview" stage doesn't (only an HTML report), so a
  pcs-api E2E build fails the row with a note saying its report holds no Playwright tests.
  The feature's ignored-tests row scans only those specs, at that commit. Outstanding bugs,
  Critical and High bugs, test complete comments and "are the stories done" read the epics' child
  tickets (`parent in (…)`, as the roadmap does). Performance and security rows come from
  `ria_page` if set, and are N/A ("no RIA for this feature") if not.

Jenkins (`build.hmcts.net`) is reachable only on the VPN, with Basic auth: set
`JENKINS_USERNAME` (your Entra object id) and `JENKINS_PASSWORD` (a Jenkins API token), the
same variables cft-workspace's `scripts/mcp-jenkins` uses. `JENKINS_URL` overrides the host.
Off the VPN Jenkins answers with a redirect to a sign-in page; that, a 401 or 403, or missing
variables all count as unreachable.

| Source | Rows |
|---|---|
| SonarCloud (public API), the analysis of each candidate commit | coverage, quality gate, static analysis |
| Cosmos `pipeline-metrics` and `cve-reports` (databases `jenkins` and `sds-jenkins`), the Jenkins builds of each candidate commit | integration and contract, functional, deployed to AAT, yarn audit, dependency check |
| GitHub check runs on each candidate commit | integration and contract, functional, deployed to AAT |
| The source at each candidate commit | ignored or pending tests |
| Jira, through twg | outstanding bugs, Critical and High bugs, test complete comments, rows in `human_rows` |
| The Release Impact Assessment, through twg | performance and security sign-off |

A source that can't be read leaves its rows "To confirm" with the reason, and the run carries on.
The evidence marks those items `unreachable`, apart from items that are unknown because what was
asked about isn't there (no analysis of the commit, no matching check, a ticket not done). When a
row is unknown only because of an unreachable source, a publish leaves its cells as the page has
them, so a published "Yes" isn't turned back into "To confirm". That is what lets the scheduled
run, which has no VPN and so no Jenkins, leave alone the E2E rows a local run filled in.
A row passes only when every check it asks for passes: Cosmos and GitHub are alternatives for the
same build check, but a closed `human_rows` ticket never makes up for a check that couldn't be made.
Only Jenkins builds that finished count, the latest of each job.
Cosmos is read with a read-only key in `COSMOS_PIPELINE_METRICS_KEY` if set, else your `az login`,
which needs a Cosmos DB data-plane reader role. Without one, the rows only Jenkins can answer
(yarn audit and dependency check) come out "To confirm".

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

Classic pages are edited through their draft. If the draft holds changes nobody has published yet,
publishing ours would publish theirs too, so `--publish` and `--validate` leave that page alone and
say "page has unpublished edits; skipped". The run doesn't fail; the next one tries again.

Some rows have nothing to answer them mechanically, and come out "To confirm". `--judgement`
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

### In the Publish workflow

The Publish workflow runs `npm run qa-report -- --all-active --publish` after reading the
roadmap, with the same twg sign-in, so Confluence edits are made as whoever seeded the twg secret
(see "Jira sign-in"), and that account needs edit rights on each report page. It runs only on
`master` and only once twg is signed in. Each active release and feature is done on its own; if
any fails, the run is marked as failed, but the site is still deployed. Evidence goes to
`$RUNNER_TEMP/qa` and the log gets only counts. To stop a report being updated, set
`active: false` in its config.

The workflow has no VPN, so it can't reach Jenkins: a feature's E2E rows, and its header's
"E2E build" row, keep what the page already says. Refresh them by running the report locally
on the VPN, with the `JENKINS_*` variables set, and `--publish`.

Cosmos needs one of:

- The account's read-only key in the `COSMOS_PIPELINE_METRICS_KEY` repository secret. It's a
  copy of `cve-cosmos-readonly-key` in the `dtsse-aat` Key Vault, which dtsse-github-metrics'
  CVE collector also reads; copy it again if that key is rotated. Only the report step gets it.
- The *Cosmos DB Built-in Data Reader* data-plane role on the `pipeline-metrics` account
  (subscription DCD-CNP-Prod) for the workflow's app registration, read as the `azure/login`
  sign-in. That would remove the stored key, but it's a platform request.

With neither, yarn audit and dependency check stay "To confirm", and the rest of the report is
still filled in.

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

To pick up a newer version of the roadmap generator, copy
`apps/pcs/.claude/scripts/lib/roadmap/roadmap-runner.ts` from `hmcts/cft-workspace` over
`scripts/lib/roadmap-runner.ts`, keeping its header comment, and update the commit there.

## Jira sign-in

`twg` has no credential designed for CI: its login is OAuth in a browser. So the workflow
uses the same arrangement as cft-workspace's doc-drift workflow. A sign-in is made once by
hand and stored in Key Vault as twg's `auth.conf`, minus its hour-long access token. Each run
restores it, runs `twg auth refresh`, and writes the rotated refresh token straight back.
Every refresh spends the previous token, so:

- **This workflow needs its own sign-in.** Don't reuse another job's secret, and don't keep using
  a sign-in after you've stored it. Whichever copy refreshed first would sign the others out.
- **Runs must not overlap.** The workflow's `concurrency` group ensures that.
- Jira is read as whoever seeded the secret, so the roadmap shows what that account can see.

The workflow reaches the vault with `azure/login` over OIDC. It needs:

- an app registration (defined in
  [`hmcts/azure-github-federation-config`](https://github.com/hmcts/azure-github-federation-config))
  with a federated credential for
  `repo:hmcts@22817111/pcs-private-landlord-progress-tracker@1451103556:ref:refs/heads/master`.
  GitHub puts the org and repo IDs in the subject for repos created after 15 July 2026.
  Runs from other branches can't reach the vault, so they build from the last snapshot.
- a Key Vault access policy for that app with secrets **Get** and **Set**, and no other roles.

**Seed the secret**, or re-seed it when a run reports `twg auth refresh` exit 77 (Atlassian
rejected the token, typically after 90 days unused). `twg login` always writes its token to
`~/.config/twg/auth.conf`. `TWG_CONFIG_DIR` moves only the profile files, so it can't keep a
seed login apart from your own. Instead, hand your sign-in over to the workflow, then sign in
again:

1. Sign in as the account the roadmap should read Jira as. `twg login` needs a terminal, and
   its device code expires quickly, so approve it as soon as it appears.

   ```bash
   twg login --force --site hmcts
   ```

2. Store it, without its access token:

   ```bash
   f=$(mktemp); grep -v '^oauth-access-token=' ~/.config/twg/auth.conf > "$f"
   az keyvault secret set --vault-name <TWG_KEY_VAULT> --name twg-auth-conf-pcs-progress-tracker \
     --file "$f" --encoding utf-8 >/dev/null
   rm -f "$f"
   ```

   `>/dev/null` matters, because `az keyvault secret set` prints the value it stored.

3. Before you use twg again, run the Publish workflow from `master` (Actions → Publish → Run
   workflow), and check that its log says "stored the rotated twg sign-in". That refresh spends
   the copy on your machine, so it can never sign the workflow out.
4. Sign in again for your own use: `twg login --force --site hmcts`.

If the sign-in fails, the site is still published from the last snapshot with an "out of date"
warning, and the run fails so someone notices.
