# 01: Delete a Booking through the API

**What to build:** An API consumer can permanently delete a Booking by id with a new `DELETE /bookings/{id}` operation. The row is removed (hard delete), a successful delete returns `204 No Content`, and any id that is not an existing Booking — including a non-integer path segment — returns the standard `404 not_found` envelope. Because availability and overlap checks read the `Booking` table directly, the deleted Booking's interval becomes bookable again immediately: `GET /availability` re-offers the freed Slot and an overlapping `POST /bookings` now succeeds.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The TypeSpec `Bookings` namespace declares a `delete` operation at `/bookings/{id}` with an `@path id: int32` parameter, plus `204` (no body), `404` (`NotFoundError`) and `500` (`InternalError`) response models; the contract compiles.
- [ ] The generated SDK is regenerated (`pnpm generate:api`) and the freshness gate passes.
- [ ] `DELETE /bookings/{id}` on an existing Booking returns `204` with an empty body.
- [ ] A second delete of the same id returns `404 not_found`; an unknown id returns `404 not_found`; a non-integer id (e.g. `/bookings/abc`) also returns `404 not_found`.
- [ ] The existing `not_found` code and error envelope are reused; no new error code is introduced.
- [ ] After a delete, `GET /availability` re-offers the freed Slot and an overlapping `POST /bookings` for that interval succeeds.
- [ ] Backend unit tests cover: deleting an existing id succeeds; an unknown id throws `not_found`; a non-integer id throws `not_found`; the repository reports whether a row was affected.
- [ ] Backend e2e tests cover the contract behaviour and the availability side effects above.
- [ ] No status field, tombstone, soft delete, or schema/migration change is introduced.
- [ ] `mise run check` passes.
