---
title: Use CCD events and mid-event saves once a claim exists
status: accepted
date: "2026-11-11"
---
## Context

The citizen frontend, pcs-frontend, reads and writes case data through CCD (Core Case Data). CCD
calls pcs-api, which owns and stores the PCS case data, because PCS is a "decentralised" CCD
service.

The defendant's respond-to-claim journey already works this way. It starts an event, saves a draft
on each page through a CCD mid-event validation call, and submits the event at the end. The
make-a-claim journey has to choose how to read and write the claim.

## Options considered

1. CCD events with mid-event draft saves, as the respond-to-claim journey does
2. Bespoke pcs-api endpoints for reading and writing the claim's answers

## Decision

Option 1, once a case exists. A citizen create event creates the claim. Every page then saves the
draft through the claim event's mid-event, and the final submit is the same event, so CCD's access
control, event history and callbacks all apply.

pcs-frontend still calls pcs-api directly for things that are not events on an existing case:
checking eligibility before a case exists (ADR 0003), the list of claims, and payments.

## Consequences

- The claim journey works the same way as the defendant journey, and uses CCD's audit and access
  model.
- Drafts are versioned, so a save from an out-of-date page is refused.
- A change to the claim's data needs the CCD definition, which pcs-api generates, and pcs-frontend
  to change together.
