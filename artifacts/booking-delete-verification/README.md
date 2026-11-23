# Booking deletion — browser and regression verification

Code commit under test: `6bdd9fe4b01358c2eb305a82e72408b67b462101`
(`test(bookings): cover bodyless 204 delete response (#12)`), the head of
`opencode/issue6-20261123135219` when the runs below were executed.

The harness used for the browser run is kept next to this file as
`booking-delete.verification.spec.ts`. It was copied into `e2e/` for the run
and is not part of the regular Playwright suite.

## Commands and results

| Command | Exit | Result |
|---|---|---|
| `pnpm --filter frontend exec vitest run src/lib/api.test.ts src/pages/owner-dashboard-page.test.tsx` | 0 | 23 passed (4 API, 19 dashboard) |
| `pnpm exec playwright test e2e/booking-delete.verification.spec.ts --reporter=list` | 0 | 1 passed — full deletion flow against the real backend and frontend |
| `pnpm exec playwright test e2e/golden-path.spec.ts --reporter=list` | 0 | 1 passed — existing guest booking golden path |
| `pnpm --filter backend exec vitest run --config ./vitest.config.e2e.ts test/bookings.e2e-spec.ts` | 0 | 29 passed — includes the `DELETE /bookings/:id` cases |
| `mise run check` | 0 | backend unit 49, backend e2e 63, frontend 71, Playwright 2, build, SDK freshness, versions, release-please and CI config |

`full-check-exit-code.txt` records the `mise run check` exit code. Logs for each
command are in this directory.

## Browser flow verified

Against the real NestJS backend (fresh SQLite database) and the real Vite frontend:

1. Created a meeting type and a booking through the public API.
2. Confirmed the booked interval was absent from `GET /availability`.
3. Opened `/admin`; the upcoming booking row showed the guest, email and meeting type.
4. Clicked **Delete booking**; the inline **Delete this booking?** confirmation appeared.
5. Clicked **Cancel**; the row stayed and the confirmation closed (neighbouring behaviour).
6. Clicked **Delete booking** → **Confirm**; the row disappeared without a refetch and
   the empty state appeared.
7. Confirmed the booking id was gone from `GET /bookings?scope=upcoming` and the
   interval was present again in `GET /availability`.
8. Booked the same freed slot again through the guest UI at `/book`, saw
   **Booking confirmed**, and verified the new booking id, the same start time,
   and that availability hid the interval again.

Screenshots:

- `01-delete-confirmation.png` — confirmation step in the owner dashboard.
- `02-booking-deleted.png` — row removed and empty state shown.
- `03-rebooked-by-guest.png` — guest confirmation after rebooking the freed slot.

A pre-existing Base UI console warning about a non-native `<button>` in `Layout`
and `LandingPage` appears in both the golden path and the deletion run. It is
unrelated to deletion and did not affect either test.

## Artifact upload note

The files above are committed with the change so the evidence travels with the
branch. The shared `check` workflow does not currently upload Playwright output;
adding an `actions/upload-artifact` step would require editing
`.github/workflows/check.yml`, which is outside this task's scope.
