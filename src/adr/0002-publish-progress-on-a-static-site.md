---
title: Publish progress on a static site built daily
status: accepted
date: "2026-11-09"
---
## Context

Stakeholders need to see progress, risks and decisions without access to Jira.

## Options considered

1. A Confluence page, updated by hand
2. A static site in GitHub Pages, built every day from Jira and files in this repository

## Decision

Option 2. A scheduled GitHub Action reads the roadmap from Jira, saves a daily snapshot and
rebuilds the site. The RAID log, dependencies and ADRs are files in this repository, changed
through pull requests.

## Consequences

- Progress updates itself every weekday. The RAID log and dependencies change only through
  reviewed pull requests, so nothing sensitive is published without a review.
- The roadmap reuses the PCS roadmap generator from `hmcts/cft-workspace`, so the poster and
  the site show the same thing.
- Daily snapshots give a history for the burn-up chart.
