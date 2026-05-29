# @absolutejs/deploy changelog

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
