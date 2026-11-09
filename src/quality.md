---
layout: page
title: Quality assurance
description: The health of the workstream's tests and pipelines.
---
<div class="govuk-inset-text">This page is not live yet.</div>

It will report on two things.

## Test layering

Whether the code has the right balance of tests: many fast unit tests, fewer integration
tests and a small number of end-to-end tests. For each repository it will show the number of
tests at each layer, and how that compares with the target shape.

## Pipeline health

Whether the build pipelines are healthy:

- how often the main and nightly pipelines pass
- how long it has been since each was last green
- whether builds finish within the agreed time

The repositories in scope and the thresholds will be agreed before this page goes live.
