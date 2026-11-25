# Call Calendar

[![hexlet-check](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/juliastetskaya/ai-for-developers-project-387/actions)

Hexlet student project: https://ru.hexlet.io/programs/ai-for-developers
How it should work: https://files.hexlet.app/a/2ipc5m

A simplified cal.com clone: a single calendar owner publishes meeting types, and guests book
free slots without registration. A single-user app with no authentication; the owner's timezone
is fixed (`Europe/Moscow`), while storage and the API work in UTC.

Demo: **https://cal-clone-gqib.onrender.com** — `/book` for guests, `/admin` for the owner.
Render's free plan keeps SQLite on an ephemeral filesystem: data resets on every deploy and
restart (see [deployment](docs/deploy.md)).

## Features

- The owner creates **Meeting Types** (name, description, duration 5–240 minutes), sees all
  upcoming **Bookings**, and can delete an upcoming Booking.
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
| `mise run e2e:golden` | Playwright browser scenarios (guest golden path and owner booking deletion) against real servers |
| `mise run docker:build` / `docker:up` / `docker:down` | production image and local run via Compose |
| `mise run check` | full gate: lint, types, tests, browser scenarios, build, SDK freshness, versions, CI config |
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
- **Authorisation:** the OpenCode step never receives the workflow token
  (`contents: read`, `id-token: write`, `persist-credentials: false`); write access to
  comments and branches comes from the standard
  [OpenCode GitHub App](https://github.com/apps/opencode-agent) installation over OIDC. The
  gate step alone gets `actions: read` (run history) and `pull-requests: write` (one sticky
  budget notice). No custom agent replaces it, so there is no deployment difference to
  explain.
- **Sharing:** sessions are not published — `SHARE: 'false'`. The action's `share` input is
  deprecated and ignored in the pinned version, hence the explicit environment variable.
- **Limits:** `timeout-minutes: 60`; one run per issue/PR at a time (`concurrency` group,
  `cancel-in-progress: false` queues instead of overlapping); one attempt budget per pull
  request (`OPENCODE_PR_ATTEMPT_BUDGET`, currently 3). The gate reads the Actions run
  history tagged by `run-name: opencode ref-<N>`, counts re-runs, cancellations and
  timeouts, and blocks the model with a `limit_exhausted` comment (attempt, SHA, run link,
  needs human) when the budget is spent. A failed budget check blocks the model too.
  Comments cannot reset the budget, and `/oc` on a plain issue is not budgeted. A missing
  `OPENCODE_API_KEY` fails a small preflight step before the agent; any other failure or
  timeout is diagnosed from the linked Actions run, and a human chooses the next step.
- **Results:** a reply in the thread with a link to the Actions run; code changes arrive as a
  branch or a pull request. Smoke test: [issue #2](https://github.com/juliastetskaya/ai-for-developers-project-387/issues/2),
  runs [44295888139](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/44295888139)
  and [44297991064](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/44297991064).

Prerequisites: the App is installed on the repository and the `OPENCODE_API_KEY` secret exists
(*Settings → Secrets and variables → Actions*). Setup and troubleshooting are in
[docs/ci.md](docs/ci.md#comment-driven-agent-opencodeyml).

## Independent AI review

`.github/workflows/review.yml` reviews eligible pull requests independently and publishes
one advisory comment with the reviewed commit SHA. It covers specification compliance,
correctness, regressions, security, tests, repository conventions and relevant risks,
following [`REVIEW.md`](REVIEW.md). The PR template asks for context, tests, risk and
rollback information.

- **When:** `pull_request` events `opened`, `synchronize`, `reopened`,
  `ready_for_review` and `edited` (only when the PR body changes).
- **What is reviewed:** same-repository PRs from `OWNER`, `MEMBER` or `COLLABORATOR`
  authors, plus the repository's `opencode-agent[bot]`. Drafts and fork PRs are skipped; the
  workflow never uses `pull_request_target`.
- **What it may do:** read the checkout and existing PR/issue/CI context. Editing, shell
  execution, network access, delegation and MCP servers are denied, and the OpenCode
  process has no GitHub write token.
- **What it writes:** one general PR comment with the reviewed commit SHA and a link to the
  exact Actions run, updated in place on later pushes through the hidden
  `<!-- ai-review-report -->` marker. A short result also goes to the job summary. It does
  not create inline threads, approve, reject, merge or modify the PR, and it is **not** a
  required check.
- **Criteria:** `REVIEW.md` and `AGENTS.md` come from the base branch only; a missing base
  file fails the review before any model call.
- **Issue context:** closing references and issue links from the PR description are fetched;
  inaccessible external references are marked explicitly.
- **Model and CLI:** the pinned OpenCode V1 CLI `1.19.6` and
  `opencode/deepseek-v4.1-flash` (`variant: low`), the same pair as the manual `/oc`
  workflow. Review runs do not rerun the project's CI.

Details and manual verification steps are in
[docs/ci.md](docs/ci.md#independent-ai-pull-request-review-reviewyml).

## Lighthouse audit

`.github/workflows/lighthouse.yml` audits the deployed app (`vars.APP_URL`) daily, hashes the
Lighthouse reports, gives OpenCode a digest and publishes at most three deduplicated issues.
A finding must name a failing audit from the digest and a real file plus symbol in the
repository; a read-only analysis job runs before the write-scoped publishing job. A manual
`workflow_dispatch` with `test_mode=true` exercises the whole path with a synthetic `[TEST]`
issue. Criteria are in [LIGHTHOUSE.md](LIGHTHOUSE.md); setup, permissions and the cron are in
[docs/ci.md](docs/ci.md#scheduled-lighthouse-audit-lighthouseyml).

Example: the manual run
[45613868880](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/45613868880)
created issues [#25](https://github.com/juliastetskaya/ai-for-developers-project-387/issues/25),
[#26](https://github.com/juliastetskaya/ai-for-developers-project-387/issues/26) and
[#27](https://github.com/juliastetskaya/ai-for-developers-project-387/issues/27). A repeat run
[45614416812](https://github.com/juliastetskaya/ai-for-developers-project-387/actions/runs/45614416812)
found the same three findings and created no duplicates.

Where the results are stored:

- **GitHub issues:** issues carrying the `lighthouse` label, open or closed. Each body starts
  with the fingerprint marker and links to the run that created it.
- **Actions artifact:** `lighthouse-audit` in the run — `reports/` (Lighthouse JSON and HTML),
  `context.md`, `audits.json`, `prompt.md`, `provenance.json`, `events.jsonl`, `opencode.log`,
  `report.md` and `findings.json`; retained for 14 days.
- **Job summary:** the `publish` job writes `decisions.md` to the Actions step summary.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | layers, request flow, domain, data, testing |
| [docs/deploy.md](docs/deploy.md) | Render, port, migrations, free-plan limits |
| [docs/ci.md](docs/ci.md) | pipeline, `check` and `docker` jobs, branch protection, AI review |
| [docs/github-agent.md](docs/github-agent.md) | conclusions from working with the GitHub agent: clarifications, trust boundaries, checks |
| [REVIEW.md](REVIEW.md) | AI review criteria, severity levels and report format |
| [LIGHTHOUSE.md](LIGHTHOUSE.md) | Lighthouse audit criteria and the finding contract |
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
