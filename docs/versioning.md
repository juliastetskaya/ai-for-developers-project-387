# Monorepo versioning

## Decision

The project uses one version for the whole monorepo. Independent workspace package releases are
not needed: `apps/backend` and `apps/frontend` are private applications, and
`packages/api-client` and `typespec` are internal artifacts that are never published. Nothing is
shipped externally, so the version describes the project as a whole rather than individual
packages.

## Single source of version

The source of truth is the `version` field in the **root** `package.json` (currently `1.4.0`).

Every workspace package must have exactly the same version. The package list comes from
`pnpm-workspace.yaml` (`apps/*`, `packages/*`, `typespec`), so a new package automatically falls
under the rule.

## Synchronization rule

The `scripts/sync-versions.mjs` script (Node, no extra dependencies) reads the version from the
root manifest and sets `version` in every workspace manifest to it:

```bash
pnpm sync-versions          # write the version to every workspace package
pnpm check-versions         # check only; exits 1 on mismatch
```

`pnpm check-versions` is part of `mise run check` (the `check:versions` task) together with unit
tests for the script itself. If versions drift, the gate fails with the list of files and the
expected version:

```
Workspace package versions do not match the root version 1.0.0:
  apps/backend/package.json: 0.0.1 -> 1.0.0
Run 'pnpm sync-versions' to fix.
```

### How to change the version

1. Change `version` in the root `package.json`.
2. Run `pnpm sync-versions`.
3. Commit the root manifest and the updated package `package.json` files together.

Versions in packages are never edited by hand: the script always overwrites them.

## Relationship with release-please (#24)

Releases are managed by release-please through `release-please-config.json` (`release-type`
`node`) for the root package. It updates the root `package.json` itself, but workspace manifests
must be explicitly listed in `extra-files` with the JSON updater for the `version` field;
otherwise the release PR changes only the root and breaks `check:versions`. The full release flow,
commit types and rules are in [releases.md](releases.md).

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "extra-files": [
        { "type": "json", "path": "apps/backend/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "apps/frontend/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/api-client/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "typespec/package.json", "jsonpath": "$.version" }
      ]
    }
  }
}
```

When adding a new workspace package, add its `package.json` to `extra-files` too; otherwise its
version will stay old and `mise run check` will catch it.
