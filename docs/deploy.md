# Deploying to Render

Production is the same single Docker image built locally: the NestJS backend serves the built
React SPA and the API on one port. The image design is described in
[architecture.md](architecture.md#build-run-and-deploy); Render infrastructure — in
[`render.yaml`](../render.yaml).

Deployment targets Render's **free plan**: the service lives on `*.onrender.com`, no disk is
used, and SQLite is stored on the container's ephemeral filesystem.

## What `render.yaml` describes

| Field | Value and reason |
| --- | --- |
| `runtime: docker` | build from `./Dockerfile` (multi-stage: install → generate SDK → build → prod deps). |
| `plan: free` | free instance: no disk, sleeps after idle time. |
| `branch: main` | only commits from `main` are deployed. |
| `region: frankfurt` | the closest region to the calendar owner (`Europe/Moscow`). |
| `healthCheckPath: /health` | Render considers a deploy successful only on `{"status":"ok"}`. |
| `autoDeployTrigger: checksPass` | deploy starts after the `check` workflow on the commit is green. |
| `DATABASE_URL=file:/data/app.db` | path to SQLite inside the container (ephemeral on the free plan). |
| `PORT=10000` | the port Render forwards into the container and routes traffic to. |

The `disk` block in `render.yaml` is commented out: disks are available only on paid plans.

## Port contract

Render passes the port through the `PORT` environment variable (default `10000`) and expects the
HTTP server to listen on `0.0.0.0:$PORT`.

- `apps/backend/src/main.ts` reads `process.env.PORT` and falls back to `3000` only when the
  variable is not set. There is no hardcoded port in the image — only `EXPOSE 3000` remains in
  the `Dockerfile` as documentation of the local default.
- Nest listens on all interfaces, so binding to `0.0.0.0` happens without extra flags.
- Docker `HEALTHCHECK` and the Render health check use the same `PORT`, so changing the port in
  the Dashboard requires no other edits: change `PORT` in `render.yaml` (or in the Dashboard) —
  the app, healthcheck and routing stay consistent.
- Locally the same behavior is verified with:

  ```bash
  docker build -t cal-clone:local .
  docker run --rm -e PORT=10000 -p 10000:10000 cal-clone:local
  curl -fsS http://localhost:10000/health
  ```

## First deploy

1. In the Render Dashboard: **New → Blueprint**, connect the GitHub repository — Render will find
   `render.yaml` at the root.
2. Confirm creation of the `cal-clone` service. The first build builds the image (several minutes)
   and starts the service. The `onrender.com` subdomain is unique across Render: if `cal-clone` is
   already taken, the platform adds a suffix — the current address is
   `https://cal-clone-3v43.onrender.com`.
3. Check `https://cal-clone-3v43.onrender.com/health` and open the root — the SPA and API should
   work from the same origin (admin — `/admin`, guest booking — `/book`).
4. API requests can be sent through the Render MCP server (`opencode.json`): it can read logs,
   metrics and deploys, change environment variables and trigger a redeploy. Render does not
   support OAuth dynamic client registration, so the server is configured for API-key auth:
   `oauth: false` and the `Authorization: Bearer {env:RENDER_API_KEY}` header. The key is created
   in [Account Settings → API Keys](https://dashboard.render.com/u/settings?add-api-key) and
   passed through the `RENDER_API_KEY` environment variable of the OpenCode process.

## Data and migrations

- On the free plan SQLite lives in `/data/app.db` inside the container. The directory is created
  in the image but **does not survive** deploys, restarts or the service going to sleep: after
  every wake-up the database is empty and migrations run again. This is fine for a demo, but not
  for keeping bookings.
- Prisma migrations (`apps/backend/prisma/migrations`) are applied at container startup in
  `DatabaseService`; a separate `preDeployCommand` is not needed. Re-running is safe: applied
  migrations are recorded in the `_migrations` table.
- The container runs as the `node` user: the entrypoint starts as `root` only to set the owner of
  `/data` (a Render disk arrives root-owned) and immediately drops privileges via `setpriv`. If
  the platform starts the container as non-root, the chown is skipped.

## Enabling persistent storage

Render disks are available only on paid instances. To make data survive deploys:

1. In `render.yaml` replace `plan: free` with a paid plan, for example `plan: 0.5c-512mb`.
2. Uncomment the `disk` block (`mountPath: /data`, `sizeGB: 1`).
3. `DATABASE_URL` already points to `file:/data/app.db` — it must stay inside the mount point,
   otherwise the database ends up on the ephemeral filesystem again.
4. Deploy: the first deploy with a disk creates it and enables daily snapshots (kept for 7 days).

## Free-plan limitations

- **No disk:** SQLite data resets on deploy, restart and after idle time.
- **Sleeping:** after ~15 minutes without traffic the service stops; the first request after a
  pause waits for a cold start (a minute or more).
- **One instance and no zero-downtime:** the service is unavailable during deploys.
- The monthly free-hours limit is exhausted under active use.

## Relationship with CI

Deployment is not part of `mise run check` and requires no secrets in CI: image and Blueprint
builds are verified on Render's side. `autoDeployTrigger: checksPass` only prevents deploying a
commit with a red `check`.

The image itself is built separately in CI by the `docker` job on pull requests
(`mise run docker:build`): a broken `Dockerfile`, `.dockerignore` or entrypoint is visible before
merge. This job is not a required status — a red result must be investigated, but it does not
block merging.
