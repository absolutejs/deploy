# @absolutejs/deploy changelog

## 0.4.0 — 2026-05-31

DNS automation. After provisioning a Target you still had to log into
Cloudflare and copy-paste the IP into a new A record; this release
closes that loop.

### Added — `@absolutejs/deploy/dns` shared interface

- **`DnsProvider`** contract — zone-scoped DNS operations
  (`list / find / create / update / delete / upsert`). Provider-
  specific adapters implement this; the deploy pipeline composes
  them with cloud Targets.
- **`DnsRecord` / `DnsRecordSpec` / `DnsRecordType`** — record types
  (`A` / `AAAA` / `CNAME` / `TXT` / `MX`) plus the desired-state
  shape used by `upsert`.
- **`ensureDnsForTarget(provider, { name, target, ttl?, proxied?,
  comment? })`** — the canonical "point this hostname at this freshly-
  provisioned IPv4" entry. Idempotent — calls `provider.upsert()`.

### Added — `@absolutejs/deploy/cloudflare` adapter

- **`cloudflareProvider({ token | client, zoneId, zoneName? })`** —
  returns a `DnsProvider` bound to one Cloudflare zone. Uses API
  tokens (`Zone:DNS:Edit` scope); global keys intentionally not
  supported.
- **`upsert` semantics** — finds by exact (name, type); skips the API
  call entirely when the record already matches `spec` (no churn on
  `content`/`ttl`/`proxied`/`comment` agreement); otherwise create
  or update.
- **Exact-name guarantees** — Cloudflare's `name=` filter is sometimes
  substring-loose; the adapter pins matches to exact name (tolerating
  a trailing dot on the API's response).
- **Drift detection** — multiple records sharing the same (name, type)
  throw with a clear "resolve manually" message instead of silently
  picking one.
- **`createCloudflareClient(token, options?)`** — fetch-backed default
  client. Throws `CloudflareError` with `{ status, body }` on non-2xx.
- **404 on delete = idempotent success** (matches the DO + Hetzner
  adapters).

### Build

- New `dns.ts` + `cloudflare.ts` bundle entries; new `./dns` and
  `./cloudflare` subpaths in `package.json` exports.

### Tests

19 new tests across the Cloudflare adapter + the `ensureDnsForTarget`
composer + the fetch-backed client. Test count 65 → 84.

## 0.3.1 — 2026-05-31

Internal refactor — no behavior or public API change. Extracted the
universal "provision-or-reuse + wait-for-ready + wait-for-SSH +
wrap-sshTarget" machinery into `src/cloudTarget.ts` so future
provider adapters (Linode / Vultr / Fly / etc.) are ~80 lines of
provider-specific glue around `createCloudTarget(hooks, options)`.

Internal-only — `createCloudTarget` is not exported from the
package, so the public API is unchanged. Existing `digitalOceanTarget`
and `hetznerTarget` source files dropped ~80 and ~100 lines
respectively. All 65 tests still green.

## 0.3.0 — 2026-05-31

Second cloud-provider adapter — sibling to the DO adapter shipped
in 0.2.0. Same shape, Hetzner Cloud v1 API mappings.

### Added — `@absolutejs/deploy/hetzner` subpath

- **`hetznerTarget(options)`** — provision-or-reuse a Hetzner Cloud
  server by name, wait for `status === 'running'` + IPv4, wait for
  SSH readiness, return a `Target` that wraps `sshTarget` plus
  `{ serverId, ipv4, destroy() }`. Hetzner enforces unique server
  names per project, so idempotency is structural.
- **`createHetznerClient(token, options?)`** — fetch-backed default
  client against `api.hetzner.cloud/v1`. Throws `HetznerError`
  (with `status` + parsed body) on non-2xx.
- **`findHetznerServer(client, name)`** — exact-name lookup; throws
  defensively on (impossible) duplicates.
- **`listHetznerServers({ token?|client?, labelSelector? })`** — list
  all servers or filter by label selector (Hetzner's k=v selector
  syntax, e.g. `'env=prod'`).
- **`destroyHetznerServer({ token?|client?, id })`** — DELETE; 404
  is treated as idempotent success.
- **Public-net flags** — `disablePublicIpv4` / `disablePublicIpv6`
  for private-network-only servers (default: both enabled).
- **Labels + cloud-init + private networks** — `labels`, `userData`,
  `networkId` forwarded to the create payload.

### Build

- Added `src/hetzner.ts` as a third bundle entry, producing
  `dist/hetzner.{js,d.ts,js.map}`. New `./hetzner` subpath in
  `package.json` exports.

### Tests

19 new tests against a mock client. Test count 46 → 65.

## 0.2.0 — 2026-05-31

Cloud-provider Target adapter. The first piece of "manage hosting from
code" — stop the click-through-DO-dashboard / copy-IP / paste-into-config
loop that gates every fresh deploy.

### Added — `@absolutejs/deploy/digitalocean` subpath

- **`digitalOceanTarget(options)`** — provision-or-reuse a DigitalOcean
  droplet by name, wait for `status === 'active'` + IPv4, wait for SSH
  readiness, return a `Target` that wraps `sshTarget`. Idempotent: same
  `name` → same droplet, no duplicates. Returns `{ ...Target,
  dropletId, ipv4, destroy() }`.
- **`createDigitalOceanClient(token, options?)`** — fetch-backed default
  client against `api.digitalocean.com/v2`. Authorization via bearer
  token; throws `DigitalOceanError` (with `status` + parsed body) on
  non-2xx. Pass a custom `fetch` for retries / observability / testing.
- **`findDigitalOceanDroplet(client, name)`** — exact-name lookup;
  throws on ambiguous duplicates (drifted state).
- **`listDigitalOceanDroplets({ token?|client?, tag? })`** — list all
  droplets or filter by tag.
- **`destroyDigitalOceanDroplet({ token?|client?, id })`** — DELETE; 404
  is treated as idempotent success.
- **Narrow `DigitalOceanClientLike` interface** — keep the DO SDK out
  as a hard dep. The fetch-backed default ships with the package; any
  shape satisfying `request(method, path, body?)` works.
- **Injection points for tests** — `probeSsh`, `sleep`, `now` are all
  overridable so tests skip real network IO. Defaults: `Bun.connect`
  TCP probe with 2 s per-attempt timeout; `setTimeout`; `Date.now`.

### Build

- Added `src/digitalocean.ts` as a second bundle entry, producing
  `dist/digitalocean.{js,d.ts,js.map}`. New `./digitalocean` subpath
  in `package.json` exports.

### Tests

17 new tests against a mock client + injectable probe — provision,
reuse, polling until active, provision timeout, SSH readiness
backoff + timeout, destroy, idempotent 404, missing-credentials
guard, exact-name filtering, ambiguous-duplicate error, list-by-tag,
fetch-client authorization, fetch-client error mapping. Test count
29 → 46.

## 0.1.0 — 2026-05-29

Substrate-deepening pass. Backwards-compatible — `deploy()` now accepts
an optional options bag; passing none preserves 0.0.1 behavior.

### Added

- **`deploy({ dryRun: true })`** — log the planned actions via `hooks.onLog`
  and skip every step. No mutation hits the target. Use from CI to verify
  pipeline shape before flipping a real `current` symlink.
- **`deploy({ annotations: { commitSha, ref, message, author, tags } })`**
  — per-release metadata. Stored alongside the release dir as
  `.deploy-meta.json`. Surfaces on `DeployResult.annotations` and via
  `deployer.readReleaseMeta(releaseId)` for status pages, audit logs, and
  rollback inspection.
- **`deploy({ resumeReleaseId })`** — resume a previously-failed release.
  The deployer reads the release's `.deploy-meta.json`, finds the step
  that died, and starts from there. Completed steps are skipped; the
  failed step + everything after re-runs. Use when a deploy fails on
  `verify` (e.g. health-check timeout) but the release is otherwise
  intact on disk.
- **Automatic `current.next` orphan cleanup.** Every `deploy()` and
  `rollback()` removes any dangling `current.next` symlink before the
  link step. Without this, a deploy that crashed between
  `ln -sfn ... current.next` and `mv -Tf current.next current` would
  leave a dangling temp link that future `mv` calls might bind to
  unexpectedly.
- **`deployer.readReleaseMeta(releaseId)`** — read the persisted metadata
  for a specific release. Returns `null` if the release has no meta file.
- **`ReleaseRecord` type** — `{ releaseId, annotations, status: 'in-progress'
  | 'completed' | 'failed', failedStep?, completedSteps[], startedAt,
  endedAt? }`. The shape `readReleaseMeta` returns.

### Fixed

- **`target.exec({ stdin })`** now actually writes the stdin payload to the
  child process. The 0.0.1 code attempted `proc.stdin.getWriter()` (a
  WritableStream API), but Bun.spawn returns a `FileSink` — so the stdin
  buffer was silently dropped. Any consumer using `stdin` (most notably
  the 0.0.1 `systemdManager.reload` writing a unit file) would have
  hung indefinitely. Fixed by using `FileSink.write()` + `.end()` directly.

### Changed (non-breaking)

- `DeployContext` gained `annotations` and `dryRun` fields, available to
  custom step implementations.

## 0.0.1 — 2026-05-29

Initial release.

- `Target` interface: `{ exec(cmd, opts?), upload(localPath, remotePath, opts?), close? }`.
  Anything that can exec a command and upload a file is a valid deploy target
  — DigitalOcean droplets, Linode boxes, Hetzner instances, your laptop.
- Bundled targets:
  - `localTarget({ root, env? })` — runs commands in a local directory.
    Great for tests + dev.
  - `sshTarget({ host, user?, port?, identity?, rsync?, sshFlags? })` — shells
    out to the system `ssh` / `rsync` binaries (no `ssh2` npm dep). Works on
    any Unix-shaped target where the controller has those binaries (mac,
    linux, WSL).
- `createDeployer({ target, source, releases, steps, hooks, processManager, verify })`
  → `{ deploy, rollback, listReleases, prune, dispose }`.
- Default pipeline for a Bun project on a Linux host:
  `prepare → upload → install → build → link → restart → verify`.
- `ProcessManager` interface with two bundled managers:
  - `bareManager` (default) — `nohup bun run start &`, pid file under the
    release dir. Zero dependencies on the remote.
  - `systemdManager({ unit, ... })` — generates a systemd unit pointing at
    `releases/current/`, `systemctl daemon-reload` + `restart`.
- Release model: timestamp-keyed release dirs (`releases/<id>/`), atomic
  `current` symlink swap, `listReleases()` for history, `prune({ keep })`
  drops the oldest.
- `rollback(releaseId)` re-points the `current` symlink and restarts —
  doesn't re-upload anything.
- Hooks: `onStepStart`, `onStepEnd`, `onLog`, `onError`.
- Custom pipelines: pass `steps: DeployStep[]` to replace the default.
- `verify` is pluggable: `{ kind: 'http', url, retries?, intervalMs? }`,
  `{ kind: 'tcp', host, port }`, or `{ kind: 'custom', check: (ctx) => Promise<boolean> }`.

Provider-specific adapters (Cloudflare Workers, Fly Machines, AWS Fargate,
GCP Cloud Run) ship later as sibling packages — they don't fit the
SSH-shaped Target interface and warrant their own surface.
