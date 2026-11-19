# 03: Record the hard-delete boundary reversal in the docs

**What to build:** The domain documentation matches the new product behaviour. Deleting a Booking reverses the previously documented "no cancellation or rescheduling" boundary, so the decision behind hard delete (row removed, interval freed immediately, no tombstone or status) is recorded and the boundary wording is updated so future contributors and agents do not treat it as forbidden.

**Blocked by:** None (can start immediately; the decision is already locked).

**Status:** ready-for-agent

- [ ] New `docs/adr/0004-deleting-bookings.md` records the decision: hard delete rather than cancellation, the alternatives considered, and the consequences (the interval frees immediately; no status, tombstone, or migration).
- [ ] The boundary wording in `docs/architecture.md` and the `AGENTS.md` Gotchas becomes "No rescheduling; the Calendar Owner can delete an upcoming Booking."
- [ ] `GLOSSARY.md` updates the **Booking** entry (a Booking can be deleted and its interval stops blocking) and the **Owner Dashboard** entry (it offers deletion of upcoming Bookings).
- [ ] No application code is changed.
