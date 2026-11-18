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

## Comment-driven agent

`.github/workflows/opencode.yml` runs the [OpenCode](https://opencode.ai) agent on demand: a
comment with `/oc` or `/opencode` in an issue, a pull request or a review thread starts a run
that answers in the same thread and, when asked, pushes a branch or opens a pull request. It
is not part of the PR gate, and it only ever starts from a comment.

- **Event:** `issue_comment` and `pull_request_review_comment`, `types: [created]` only.
- **Who:** `author_association` must be `OWNER`, `MEMBER` or `COLLABORATOR`; comments from
  `Bot` users are ignored. The workflow file always comes from `main`, so an untrusted fork
  cannot change it, start a run or obtain the API key.
- **Commands:** `mentions: /oc,/opencode` — these two phrases are the only accepted triggers.
- **Model:** `opencode/deepseek-v4.1-flash` (`variant: low`). The key is the
  `OPENCODE_API_KEY` GitHub Actions secret and is never stored in the repository.
- **Authorisation:** the workflow token is read-only (`contents: read`, `id-token: write`,
  `persist-credentials: false`); write access to comments and branches comes from the standard
  [OpenCode GitHub App](https://github.com/apps/opencode-agent) installation over OIDC. No
  custom agent replaces it, so there is no deployment difference to explain.
- **Sharing:** sessions are not published — `SHARE: 'false'`. The action's `share` input is
  deprecated and ignored in the pinned version, hence the explicit environment variable.
- **Limits:** `timeout-minutes: 15`; one run per issue/PR at a time (`concurrency` group,
  `cancel-in-progress: false` queues instead of overlapping).
- **Results:** a reply in the thread with a link to the Actions run; code changes arrive as a
  branch or a pull request. Smoke test: [issue #2](https://github.com/juliastetskaya/ai-for-developers-project-387/issues/2),
  runs [44295888139](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/44295888139)
  and [44297991064](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/44297991064).

Prerequisites: the App is installed on the repository and the `OPENCODE_API_KEY` secret exists
(*Settings → Secrets and variables → Actions*). Setup and troubleshooting are in
[docs/ci.md](docs/ci.md#comment-driven-agent-opencodeyml).

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
