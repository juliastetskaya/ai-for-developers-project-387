# 02: Delete a Booking from the Owner Dashboard

**What to build:** Each upcoming Booking card on the Owner Dashboard gains a "Delete booking" control. The first click swaps the card into an explicit inline confirmation ("Delete this booking?" with Confirm and Cancel); Cancel restores the card. Confirming calls the delete operation. On `204` the row is removed from local list state without a refetch. On `404` the row is also removed silently (already gone). Any other failure keeps the row and shows an inline error on the bookings list with retry. No new dependency, no dialog primitive, no undo.

**Blocked by:** 01 (the delete endpoint and generated SDK must exist).

**Status:** ready-for-agent

- [ ] The frontend API module exposes `deleteBooking(id)` using the generated client, correctly treating a `204` with no body as success, and returning the normalized error on failure so callers can branch on `code === 'not_found'`.
- [ ] Each upcoming Booking card renders a "Delete booking" control.
- [ ] First click shows the inline confirm step; Confirm deletes, Cancel leaves the Booking intact.
- [ ] On `204` the row disappears from the list without a refetch.
- [ ] On `404` the row disappears without an error banner.
- [ ] On any non-404 failure the row stays and the bookings list shows an inline error with retry.
- [ ] Page tests cover the control, the confirm step, the `204` removal, the silent `404` removal, the non-404 error branch, and Cancel.
- [ ] The Playwright guest golden path is unchanged.
- [ ] `mise run check` passes.
