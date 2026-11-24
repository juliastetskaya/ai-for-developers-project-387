# Call Calendar Architecture

A simplified cal.com clone: one predefined Calendar Owner publishes Meeting Types, and Guests
book Slots without registration. The app is single-user, with no authentication and no external
calendar integrations — these boundaries are deliberate (see [Boundaries and limitations](#boundaries-and-limitations)).

Domain terms come from [`GLOSSARY.md`](../GLOSSARY.md). Decisions that shaped the design live in
[`docs/adr/`](adr/). The first project's original specification is
[issue #15](https://github.com/juliastetskaya/ai-for-developers-project-386/issues/15), and the
decision map it was synthesized from is
[issue #3](https://github.com/juliastetskaya/ai-for-developers-project-386/issues/3).

## Contents

- [Stack](#stack)
- [Monorepo layout](#monorepo-layout)
- [Request flow](#request-flow)
- [Backend](#backend)
- [Domain and business rules](#domain-and-business-rules)
- [Data and migrations](#data-and-migrations)
- [API contract and SDK](#api-contract-and-sdk)
- [Frontend](#frontend)
- [Configuration](#configuration)
- [Build, run and deploy](#build-run-and-deploy)
- [Testing](#testing)
- [Boundaries and limitations](#boundaries-and-limitations)

## Stack

| Layer | Technologies |
| --- | --- |
| Backend | NestJS 12 (ESM), better-sqlite3, luxon, oxlint |
| Frontend | React 19, Vite, Tailwind CSS 4, shadcn/ui, react-router, Vitest + Testing Library |
| Contract | TypeSpec → OpenAPI → `@hey-api/openapi-ts` SDK |
| Data | SQLite; Prisma is used only to describe the schema and migrations |
| Tooling | pnpm 10 (workspace), mise (Node 22, pnpm, hk, pitchfork), Docker |

## Monorepo layout

```text
apps/backend/                 NestJS API and serving of the built SPA
├── prisma/schema.prisma      Meeting Type and Booking models (migrations source only)
├── prisma/migrations/        SQL migrations, applied on startup
└── src/
    ├── main.ts               bootstrap, $PORT, shutdown hooks, SPA
    ├── app.module.ts         root module
    ├── app.setup.ts          shared configuration (CORS) for main and e2e
    ├── static-frontend.ts    SPA static files + fallback, bypassing API prefixes
    ├── database/             single SQLite connection + migrations
    ├── common/               error envelope, codes, validation
    ├── slots/                pure logic for Working Window, horizon and Slot slicing
    ├── meeting-types/        controller → service → repository
    ├── availability/         free Slots for a single day
    ├── bookings/             Booking creation, listing and deletion
    └── health/               GET /health

apps/frontend/                React SPA
└── src/
    ├── pages/                Landing, Booking Page, Owner Dashboard
    ├── components/           layout, calendar, async-section, ui (shadcn)
    └── lib/                  API client, 14-day horizon, forms, limits

packages/api-client/          generated typed SDK
typespec/main.tsp             source API contract
e2e/                          Playwright browser scenarios (guest golden path and owner deletion)
scripts/                      version, CI config and release-please checks, Playwright backend
```

Generated directories (`typespec/tsp-output/`, `packages/api-client/src/client/`) are recreated
by `pnpm generate:api` and are never edited by hand.

## Request flow

```text
browser
  └─ SPA (React) ── fetch /meeting-types ──┐
                                           ▼
                        NestJS HTTP (port $PORT)
                          ├─ AllExceptionsFilter   unified error envelope
                          ├─ Controller            input parsing, HTTP statuses
                          ├─ Service               validation and business rules
                          ├─ Repository            SQL through better-sqlite3
                          └─ DatabaseService       single SQLite connection (WAL)
                                           │
                                           ▼
                                /data/app.db (SQLite)

static GET (not /health, /meeting-types, /availability, /bookings)
  └─ static-frontend.ts ──> apps/frontend/dist/index.html (+ /assets/*)
```

In production the backend serves both the API and the SPA from one origin, so the browser uses
relative paths and CORS is not involved in the main scenario.

## Backend

Layers inside each module are the same: the controller handles HTTP, the service handles
validation and rules, and the repository handles SQL. Controllers never talk to the database
directly.

| Module | Responsibility |
| --- | --- |
| `DatabaseModule` (`@Global`) | single better-sqlite3 connection: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`; applies migrations before the first request |
| `HealthModule` | `GET /health` → `{ "status": "ok" }` |
| `MeetingTypesModule` | list and create Meeting Types; field limits and trimming |
| `AvailabilityModule` | free Slots for a date for the selected Meeting Type |
| `BookingsModule` | create, list and delete Bookings; deletion frees the interval |
| `slots/` | pure functions: working window, horizon, Slot slicing, alignment check |
| `common/` | `ApiError`, error codes, field reading and validation, `AllExceptionsFilter` |

**Errors.** Every exception becomes a single envelope
`{ statusCode, code, message, details? }`. Codes: `validation_failed`, `meeting_type_not_found`,
`date_out_of_range`, `slot_unavailable`, `not_found`, `request_error`, `internal_error`.
Unknown exceptions are logged and returned as 500 without internal details.

## Domain and business rules

**User journey.** The Calendar Owner creates a Meeting Type in the Owner Dashboard (`/admin`) and
sees all upcoming Bookings there. A Guest on the Booking Page (`/book`) selects a Meeting Type, a
day within the 14-day horizon and a free Slot, then enters a name, email and comment.

**Domain constants** (`apps/backend/src/slots/slots.ts`, mirrored in the frontend):

| Rule | Value |
| --- | --- |
| Owner timezone | `Europe/Moscow`, fixed; the user cannot change it |
| Working Window | 09:00–18:00 in the owner's timezone |
| Booking horizon | 14 days starting from the owner's today |
| Meeting Type duration | 5–240 minutes |

**Slots.** Inside the Working Window the day is sliced into half-open intervals
`[startAt, endAt)` based on the Meeting Type duration. A Slot is free if its interval does not
overlap any Booking — of any Meeting Type. Slots that have already started are discarded; window
and grid boundaries are checked both on the client and on the server.

**Global occupancy.** Any time overlap blocks the interval for all meeting types: predicate
`startAt < newEnd AND endAt > newStart`.

**Booking atomicity.** The overlap check and the insert run in a single `BEGIN IMMEDIATE`
transaction (`.immediate()` in better-sqlite3). A losing concurrent request sees the other row and
receives 409 `slot_unavailable`; there are no retries. Any other SQLite error is logged and turned
into 500 `internal_error`.

**Time.** Storage and the API use UTC ISO-8601, so lexicographic string comparison matches
chronological order. The owner's timezone is applied only when computing dates and labels.
Details — [ADR 0003](adr/0003-owner-timezone-and-booking-horizon.md).

## Data and migrations

The schema is described in `apps/backend/prisma/schema.prisma`: `MeetingType` and `Booking` with
the relation `Booking.meetingTypeId → MeetingType.id` (`ON DELETE RESTRICT`) and indexes for the
overlap predicate and lookup by type.

- **Prisma is only a schema-authoring tool** (devDependency). SQL migrations live in
  `prisma/migrations/<timestamp>_<name>/migration.sql`; Prisma Client is not used at runtime.
- **The backend applies migrations on startup**: `DatabaseService` reads the `prisma/migrations`
  directory from the working directory, executes not-yet-applied files in order and records them
  in `_migrations`. Re-running is safe; no separate migrate step is needed.
- **One connection per process** — so transactions do not compete inside the app; WAL and
  `busy_timeout` protect against external writers.
- Locally the database lives in `apps/backend/data/dev.db` (or on a volume in Docker), on
  Render — in `/data/app.db`.

Reasons for the decision and the cost of dropping Prisma Client — [ADR 0002](adr/0002-sqlite-runtime-and-prisma-migrations.md).

## API contract and SDK

The source of truth is `typespec/main.tsp`. Pipeline:

```text
typespec/main.tsp
  └─ pnpm generate:api
       ├─ tsp compile → typespec/tsp-output/.../openapi.yaml
       └─ @hey-api/openapi-ts → packages/api-client/src/client/
```

The frontend imports types and functions from `api-client`, so a contract/client mismatch is a
compile error rather than a runtime surprise. Backend controllers are hand-written (there is no
suitable server-code generator) and kept in sync with the contract by API e2e tests.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | liveness check |
| `GET /meeting-types` | list Meeting Types (public) |
| `POST /meeting-types` | create a Meeting Type |
| `GET /availability?meetingTypeId&date` | free Slots for a day (date in the owner's timezone) |
| `GET /bookings?scope=upcoming` | upcoming Bookings with the nested Meeting Type |
| `POST /bookings` | create a Booking; overlap → 409 |
| `DELETE /bookings/{id}` | hard-delete a Booking; frees its interval → 204, unknown id → 404 |

## Frontend

| Route | Page | What it does |
| --- | --- | --- |
| `/` | Landing | describes the service and leads to the Booking Page |
| `/book` | Booking Page | Meeting Type → day → Slot → guest form → confirmation |
| `/admin` | Owner Dashboard | creating Meeting Types, listing upcoming Bookings, and deleting them |

- `lib/api.ts` configures the generated client with `VITE_API_URL` (default
  `http://localhost:3000`) and normalizes any error to `{ status, code, message, details }`.
- `lib/owner-days.ts` builds the 14-day horizon in the owner's timezone; the API decides which
  days are available.
- `components/async-section.tsx` — unified loading/error/empty states for pages.
- In production `VITE_API_URL` is empty, so requests go to the same origin.

## Configuration

| Variable | Where it is needed | Default |
| --- | --- | --- |
| `PORT` | backend | `3000`; the platform passes its own (Render — `10000`) |
| `DATABASE_URL` | backend | `file:./data/dev.db` relative to `apps/backend` |
| `FRONTEND_DIST` | backend | `apps/frontend/dist` |
| `VITE_API_URL` | frontend build | `http://localhost:3000`; empty string in the image |

The app uses no secrets: there is no authentication and no external services.

## Build, run and deploy

- **Dev:** `mise run dev:backend` (3000) and `mise run dev:frontend` (5173); the SPA calls the API
  at the address from `VITE_API_URL`.
- **Production image:** multi-stage `Dockerfile` — install → `generate:api` → `nest build` →
  `vite build` → production dependencies. NestJS serves the SPA and API on a single `$PORT`.
- **Permissions:** `docker-entrypoint.sh` starts as root only to set the owner of `/data`, then
  runs the app as the `node` user via `setpriv`.
- **Compose:** the same image with a named `sqlite-data` volume for local production-mode checks.
- **Render:** Blueprint `render.yaml` (Docker, health check `/health`, `plan: free`,
  `autoDeployTrigger: checksPass`). On the free plan there is no disk, so SQLite is ephemeral and
  resets on deploy/restart — an accepted mode for the demo. Details and switching to a persistent
  disk — [`docs/deploy.md`](deploy.md).

## Testing

| Level | Tool | What it covers |
| --- | --- | --- |
| Backend unit | Vitest | `slots` (window, horizon, slicing), parsing and validation, `DatabaseService` and migrations |
| Backend e2e | Vitest + supertest, temporary SQLite | HTTP contract, error codes, Slot race, migrations from scratch |
| Frontend | Vitest + Testing Library | pages, calendar, horizon, API error handling |
| Browser scenarios | Playwright, real servers | the guest golden path (Landing → `/book` → Slot → confirmation) and owner booking deletion (delete → freed Slot → guest rebook) |

The browser scenarios start the backend on `3100` and the frontend on `5273`, use a separate database
in a temporary directory and do not depend on dev data. Both are part of `mise run check` and CI;
`head-browser-evidence` re-runs them against the pull request head SHA for the pre-merge artifact.

## Boundaries and limitations

- No authentication, accounts or roles: the Owner Dashboard is open to anyone who knows the
  address.
- No rescheduling; the Calendar Owner can delete an upcoming Booking. There are
  no notifications and no external calendar sync.
- The timezone is not selectable: it is fixed for the owner (`Europe/Moscow`).
- Data on free Render is ephemeral: the container is recreated and the database is empty.
- The app is designed for a single instance: one SQLite file and one process; there is no
  horizontal scaling.
