# Call Calendar

[![hexlet-check](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/juliastetskaya/ai-for-developers-project-387/actions)

Hexlet student project: https://ru.hexlet.io/programs/ai-for-developers
How it should work: https://files.hexlet.app/a/2ipc5m

A simplified cal.com clone: a single calendar owner publishes meeting types, and guests book
free slots without registration. A single-user app with no authentication; the owner's timezone
is fixed (`Europe/Moscow`), while storage and the API work in UTC.

Demo: **https://cal-clone-3v43.onrender.com** — `/book` for guests, `/admin` for the owner.
Render's free plan keeps SQLite on an ephemeral filesystem: data resets on every deploy and
restart (see [deployment](docs/deploy.md)).

## Features

- The owner creates **Meeting Types** (name, description, duration 5–240 minutes) and sees all
  upcoming **Bookings**.
- A guest picks a meeting type, a day within the 14-day horizon and a free **Slot**, then leaves
  a name, email and comment.
- Free slots = the 09:00–18:00 working window minus occupied intervals; any time overlap blocks
  the slot globally for all meeting types.
- A booking is created atomically: a race for the same slot ends with `409 slot_unavailable` for
  the loser.

For details on the architecture, layers and invariants, see [docs/architecture.md](docs/architecture.md).

## Quick start

[mise](https://mise.jdx.dev/) pins the environment and tool versions: Node 22, pnpm 10, hk and
pitchfork.

```bash
git clone https://github.com/juliastetskaya/ai-for-developers-project-387.git
cd ai-for-developers-project-387
mise install     # tools from mise.toml
mise run setup   # dependencies + generated API SDK
mise run dev:backend    # API on http://localhost:3000
mise run dev:frontend   # SPA on http://localhost:5173
```

## Commands

| Command | What it does |
| --- | --- |
| `mise run dev:backend` / `dev:frontend` | run the dev servers separately; `mise daemons start` runs both in the background |
| `mise run build` | build the backend and frontend |
| `mise run test` | backend unit and e2e tests, frontend tests |
| `mise run e2e:golden` | Playwright guest golden path against real servers |
| `mise run docker:build` / `docker:up` / `docker:down` | production image and local run via Compose |
| `mise run check` | full gate: lint, types, tests, golden path, build, SDK freshness, versions, CI config |
| `pnpm generate:api` | regenerate OpenAPI and the SDK after changes in `typespec/` |

`mise run check` is what CI runs; it must be green before merging.
Git hooks (hk): lint on commit, `mise run check` on push, Conventional Commits in the message.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | layers, request flow, domain, data, testing |
| [docs/deploy.md](docs/deploy.md) | Render, port, migrations, free-plan limits |
| [docs/ci.md](docs/ci.md) | pipeline, `check` and `docker` jobs, branch protection |
| [docs/releases.md](docs/releases.md) | release-please, tags and CHANGELOG |
| [docs/versioning.md](docs/versioning.md) | a single version across all packages |
| [GLOSSARY.md](GLOSSARY.md) | domain language: Meeting Type, Booking, Slot, Working Window |
| [docs/adr/](docs/adr/) | accepted architecture decisions |
| [Original specification](https://github.com/juliastetskaya/ai-for-developers-project-386/issues/15) | first project's spec: scenarios, data model, API, testing |
| [First project decisions](https://github.com/juliastetskaya/ai-for-developers-project-386/issues/3) | decision map #4–#14 the specification was synthesized from |
| [AGENTS.md](AGENTS.md) | conventions for agents and contributors |

## Stack

NestJS 12 + better-sqlite3 on the backend, React 19 + Vite + Tailwind CSS 4 on the frontend,
TypeSpec → OpenAPI → typed SDK in `packages/api-client`, pnpm workspace, Docker and a Render
Blueprint.

---

<details>
<summary>Hexlet automated tests</summary>

Tests run on every commit. `.github/workflows/hexlet-check.yml` is responsible for running them —
do not delete or rename that file or the repository.

</details>

## About Hexlet

[Hexlet](https://ru.hexlet.io/) is a programming school: hands-on learning programs with mentor
support and real projects that stay on your résumé. This repository is one of those projects.
