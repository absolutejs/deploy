# @absolutejs/deploy changelog

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
