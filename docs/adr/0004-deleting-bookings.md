# Deleting bookings

Status: accepted

The Owner Dashboard could list upcoming Bookings but offered no way to remove
one. The product now needs an "undo the reservation" action, which reverses the
previous "no cancellation" boundary in `docs/architecture.md` and `AGENTS.md`.
We decided:

- **Hard delete, not cancellation.** `DELETE /bookings/{id}` removes the
  `Booking` row. There is no `status` field, no `cancelledAt`, no soft delete,
  no tombstone and no schema migration.
- **The interval frees immediately.** Availability and overlap checks read the
  `Booking` table directly (`apps/backend/src/availability/availability.repository.ts`,
  `apps/backend/src/bookings/bookings.repository.ts`), so once the row is gone
  `GET /availability` offers the Slot again and an overlapping `POST /bookings`
  succeeds. This is the intended behaviour: deleting is a true undo of the
  Booking, not a soft cancellation that keeps the time blocked.
- **Any Booking by id is deletable at the API level.** There is no `startAt`
  guard on delete. The UI only lists — and therefore only offers deletion for —
  upcoming Bookings.
- **Contract:** `204 No Content` on success; the existing
  `404 not_found` envelope for any id that is not an existing Booking,
  including a non-integer path segment. No new error code.
- **Owner-side only.** There is no authentication, so this is an action on the
  open Owner Dashboard, matching the existing exposure. No guest-facing cancel
  link.

## Alternatives considered

- **Cancellation (status field / `cancelledAt`).** Rejected: it needs a
  migration and forces a new decision about whether a cancelled Booking keeps
  blocking its interval. It is far more machinery than "remove this reservation".
- **Idempotent `204` for unknown ids.** Rejected: it hides whether the row
  existed and departs from the resource view. A replayed delete returns `404`,
  which the Owner Dashboard treats as "already gone" and removes the stale row.
- **A `startAt` guard on delete.** Rejected: the API stays honest and simple; the
  UI is responsible for only offering upcoming Bookings.

## Consequences

- Deleting a Booking is allowed; rescheduling still is not. The boundary
  wording becomes "No rescheduling; the Calendar Owner can delete an upcoming
  Booking."
- There is no undo or restore: a deleted Booking is gone. The UI guards against
  a stray click with an inline two-step confirmation, not with persistence.
- The guest golden path is unchanged; deletion is an owner action.
