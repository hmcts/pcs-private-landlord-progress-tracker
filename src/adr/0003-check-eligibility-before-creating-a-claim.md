---
title: Check eligibility before creating a claim
status: accepted
date: "2026-11-11"
---
## Context

Before a claim exists, a self-represented private landlord answers some eligibility questions:
the type of claimant, whether the claim is against trespassers, the property address and who is
making the claim. The property must be in England, and its postcode must be covered by a court in
the pilot. If a postcode crosses a border, the landlord is asked which country the property is in.

The rules for which courts cover which postcodes, and the list of pilot courts, are held in
pcs-api's own data, so pcs-frontend cannot check them alone. When the check ran only as the claim
was created, after the "Who are you making this claim for?" question, a property outside the pilot
made it look as though answering "Myself" had failed. And a claim (a CCD case) should not exist for
someone who is not eligible to make one.

## Options considered

1. Create the case first, and check eligibility in CCD mid-event checks on it
2. Check eligibility before any case exists, with a read-only pcs-api lookup that pcs-frontend
   calls from the property address page
3. Check eligibility only when the case is created

## Decision

Option 2. No case is created until the eligibility answers allow it. An ineligible property goes
to its exit page as soon as the address is entered.

The lookup only reads data, needs the citizen to be signed in and is turned off by the journey's
feature flag. It uses the same rules as case creation, which still checks as a backstop. This
follows the existing pattern of pcs-frontend calling pcs-api directly for reads that are not about
an existing case, such as the citizen's list of claims.

## Consequences

- No empty or ineligible cases are created.
- The landlord finds out early that they cannot use the service.
- There is one more pcs-api endpoint to keep in step with case creation. Both call the same code,
  so they cannot disagree.
- If the lookup is unavailable, the journey carries on and the check at case creation still applies.
