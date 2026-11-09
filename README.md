# PCS Private Landlord progress tracker

A public site where stakeholders can follow the Possession Claims Service (PCS) Private Landlord
workstream: roadmap, RAID log, dependencies and architecture decisions. It's published with
GitHub Pages and rebuilt every weekday morning.

| Page | Where the content comes from |
|---|---|
| Overview | `src/_data/overview.yaml`, plus figures from the latest roadmap snapshot |
| Roadmap | Epics labelled `PrivateLandlord` in the HDPI Jira project |
| Quality assurance | Not live yet: test layering and pipeline health |
| Performance | Not live yet: waiting for the performance tests to run in Jenkins |
| RAID log | `src/_data/raid.yaml` |
| Dependencies | `src/_data/dependencies.yaml`, plus Jira links from our epics to other projects |
| ADRs | `src/adr/*.md` |

## How it works

`.github/workflows/publish.yml` runs at 06:00 UTC, Monday to Friday (and on every push to `master`):

1. Checks out the PCS roadmap generator from `hmcts/cft-workspace`, at the commit in
   `cft-workspace.ref`. This is the generator behind the `/pcs:roadmap` poster.
2. Reads the epics and their child items from Jira with `twg`, the Atlassian CLI that
   cft-workspace uses (`npm run fetch`). It saves
   `data/snapshots/<date>.json` and commits it. The site is built only from these
   snapshots, and together they give the burn-up chart.
3. Builds the site with Eleventy and the [GOV.UK Eleventy plugin](https://govuk-eleventy-plugin.x-govuk.org/),
   and deploys it to GitHub Pages.

If Jira can't be read, the site is still built from the last snapshot and shows an
"out of date" warning, and the run is marked as failed.

### What gets published

This is a public site.

- From Jira, a snapshot keeps only each epic's key, summary, status, dates and child-item
  counts, plus the key and status of any linked issue in another project. Descriptions,
  comments and child item summaries are never kept.
- Any issue labelled `not-public` is left out.
- The RAID log, dependencies and ADRs change only through pull requests, so a person reviews
  everything before it's published. Write entries for a public audience, and use roles
  rather than people's names.

## Updating the content

- **Overall status and milestones:** edit `src/_data/overview.yaml`.
- **RAID log:** add an entry to `src/_data/raid.yaml`. The file explains the fields.
- **Dependencies:** add an entry to `src/_data/dependencies.yaml`.
- **Architecture decision:** copy `src/adr/template.md.txt` to the next number, for example
  `src/adr/0003-choose-x.md`.
- **Roadmap:** change Jira. Label an HDPI epic `PrivateLandlord` and give it a start and due
  date. Swimlanes are set in `config/roadmap.json`.

CI (`.github/workflows/ci.yml`) validates the data files and builds the site on every pull request.

## Running it locally

You need Node 24, a checkout of `hmcts/cft-workspace`, and
[`twg`](https://developer.atlassian.com/platform/teamwork-graph/twg-cli/) logged in to
`hmcts.atlassian.net` (`twg login --site hmcts`).

```sh
npm ci
CFT_WORKSPACE=~/path/to/cft-workspace npm run vendor   # links the roadmap generator

npm run fetch   # read Jira with your twg login
npm start       # http://localhost:8080
npm test
npm run typecheck
```

## Setup

1. In Settings → Pages, set the source to **GitHub Actions**.
2. The workflow commits snapshots to `master`. If `master` is protected, allow
   `github-actions[bot]` to push to it.
3. Add the repository secrets and variables below.
4. Set up the Jira sign-in (next section).

| Secret | What it is |
|---|---|
| `CFT_WORKSPACE_TOKEN` | A fine-grained token with read-only Contents access to `hmcts/cft-workspace` |
| `TWG_AZURE_CLIENT_ID` | Client ID of the app registration the workflow signs in to Azure as |
| `AZURE_TENANT_ID` | The HMCTS Azure tenant ID |

| Variable | What it is |
|---|---|
| `TWG_KEY_VAULT` | The Key Vault holding the twg sign-in |
| `TWG_SECRET_NAME` | Optional. The secret's name. Defaults to `twg-auth-conf-pcs-progress-tracker` |

To pick up a newer version of the roadmap generator, put the new `hmcts/cft-workspace`
commit in `cft-workspace.ref`.

## Jira sign-in

`twg` has no credential designed for CI: its login is OAuth in a browser. So the workflow
uses the same arrangement as cft-workspace's doc-drift workflow. A sign-in is made once by
hand and stored in Key Vault as twg's `auth.conf`, minus its hour-long access token. Each run
restores it, runs `twg auth refresh`, and writes the rotated refresh token straight back.
Every refresh spends the previous token, so:

- **This workflow needs its own sign-in.** Don't reuse another job's secret, and don't seed it
  from your own `~/.config/twg`. Whichever copy refreshed first would sign the others out.
- **Runs must not overlap.** The workflow's `concurrency` group ensures that.
- Jira is read as whoever seeded the secret, so the roadmap shows what that account can see.

The workflow reaches the vault with `azure/login` over OIDC. It needs:

- an app registration (defined in
  [`hmcts/azure-github-federation-config`](https://github.com/hmcts/azure-github-federation-config))
  with a federated credential for `repo:hmcts/pcs-private-landlord-progress-tracker:ref:refs/heads/master`.
  Runs from other branches can't reach the vault, so they build from the last snapshot.
- a Key Vault access policy for that app with secrets **Get** and **Set**, and no other roles.

**Seed the secret**, or re-seed it when a run reports `twg auth refresh` exit 77 (Atlassian
rejected the token, typically after 90 days unused). A separate config directory starts a
separate token chain, so your own twg login is never spent:

```bash
d=$(mktemp -d); TWG_CONFIG_DIR=$d twg login --site hmcts
f=$(mktemp); grep -v '^oauth-access-token=' "$d/auth.conf" > "$f"
az keyvault secret set --vault-name <TWG_KEY_VAULT> --name twg-auth-conf-pcs-progress-tracker \
  --file "$f" --encoding utf-8 >/dev/null
rm -rf "$d" "$f"
```

`>/dev/null` matters, because `az keyvault secret set` prints the value it stored. The device
code from `twg login` expires quickly, so approve it as soon as it appears.

If the sign-in fails, the site is still published from the last snapshot with an "out of date"
warning, and the run fails so someone notices.
