# @absolutejs/deploy

Generic Bun-project deploy pipeline. A `Target` is anywhere you can run a
command and copy a file — a DigitalOcean Droplet over SSH, a Linode box,
your own laptop. Two ops, four words: **exec and upload**.

The bundled `defaultBunPipeline()` covers the case that matters most for
Bun apps on Linux: `prepare → upload → install → build → link → restart
→ verify`. Releases live in `releases/<id>/`, a `current` symlink swaps
atomically, `rollback(releaseId)` re-points the symlink and restarts.

Zero `ssh2` / `node-ssh` dependency — `sshTarget` shells out to the system
`ssh` / `rsync` binaries that already ship on Mac, Linux, and WSL.

```ts
import {
  createDeployer,
  sshTarget,
  systemdManager,
} from '@absolutejs/deploy';

const deployer = createDeployer({
  appName: 'my-app',
  target: sshTarget({
    host: 'droplet-1.example.com',
    user: 'deploy',
    identity: '~/.ssh/id_ed25519',
  }),
  source: { kind: 'directory', root: './' },
  env: { PORT: '3000', DATABASE_URL: process.env.DATABASE_URL! },
  processManager: systemdManager({ user: 'deploy' }),
  verify: { kind: 'http', url: 'http://localhost:3000/health' },
  hooks: {
    onStepStart: ({ name, releaseId }) => console.log(`▸ ${releaseId} ${name}`),
    onLog: (line, stream, step) => process[stream === 'stderr' ? 'stderr' : 'stdout'].write(`[${step}] ${line}\n`),
  },
});

const release = await deployer.deploy();
console.log(`Deployed ${release.releaseId} in ${release.durationMs}ms`);

// later — atomic rollback
const previous = (await deployer.listReleases()).at(-2);
if (previous) await deployer.rollback(previous);

// optional housekeeping
await deployer.prune({ keep: 5 });
```

## v0.0.1 surface

### Targets

| Adapter | Use |
|---|---|
| `localTarget({ root, env? })` | Tests, local-dev, and "deploy to the same box" workflows. |
| `sshTarget({ host, user?, port?, identity?, sshFlags?, rsync? })` | Any VPS — DigitalOcean Droplets, Linode, Hetzner, Vultr, Lightsail, Scaleway. Uses the system `ssh` / `rsync` — no npm dep. |

A `Target` is just:

```ts
type Target = {
  description: string;
  exec(cmd: string, opts?: { cwd?; env?; timeoutMs?; onLog?; stdin? }): Promise<{ stdout; stderr; exitCode }>;
  upload(local: string, remote: string, opts?: { exclude?; deleteOrphans? }): Promise<void>;
  close?(): Promise<void>;
};
```

If you can implement those two methods, you can deploy through `@absolutejs/deploy`. Provider-specific adapters that don't fit this shape (Cloudflare Workers API, Fly Machines API, AWS Fargate task-run) ship later as sibling packages.

### Process managers

| Manager | What it does |
|---|---|
| `bareManager({ command? })` | Default. `nohup bun run start &`, pid file under `/var/lib/<appName>/`, logs to `/var/log/<appName>/`. Zero remote dependency. |
| `systemdManager({ user?, group?, execStart?, restart?, ... })` | Templated systemd unit pointing at `current/`, `daemon-reload` + `restart`. The production answer for VMs. |

A `ProcessManager` is just `{ reload, stop?, status? }`. Wrap PM2, supervisord, runit, or even `@absolutejs/runtime` — whatever your remote uses.

### Pipeline

The default Bun pipeline:

1. **prepare** — `mkdir -p releases/<id>/`
2. **upload** — `rsync` source → release dir (excludes `node_modules`, `dist`, `build`, `.git`, `*.log`, `.DS_Store` by default)
3. **install** — `bun install --production` in the release dir
4. **build** — if `package.json` has a `build` script, `bun run build`
5. **link** — `ln -sfn release current.next && mv -Tf current.next current` (atomic-ish swap)
6. **restart** — delegate to the configured `ProcessManager`
7. **verify** — HTTP / TCP / custom probe (when `verify` is set)

Replace any step by passing `steps: [...]` — the default is a normal array you can splice into.

### Verify

```ts
{ kind: 'http', url: 'http://localhost:3000/health', retries: 30, intervalMs: 1000, expectStatus: 200 }
{ kind: 'tcp',  host: 'localhost', port: 3000, retries: 30, intervalMs: 1000 }
{ kind: 'custom', check: async (ctx) => ctx.target.exec('myhealthcheck').then((r) => r.exitCode === 0) }
```

Default is `null` (no verify). Recommend always wiring one — a green deploy that nobody can reach is a yellow deploy.

### Release model

- Every `deploy()` mints a new `releases/<YYYYMMDD-HHMMSS>/`.
- `current` symlink → newest release.
- `rollback(releaseId)` re-points the symlink and restarts. No re-upload, no re-build. Fast.
- `listReleases()` returns the sorted list.
- `prune({ keep: N })` removes the N oldest.

## `@absolutejs/deploy/digitalocean` — provision-or-reuse from code (0.2.0)

Skip the click-through DO dashboard. `digitalOceanTarget(options)` looks
up a droplet by name; creates it via the v2 API if absent; waits for
`status === 'active'` + IPv4; waits for SSH; returns a `Target` ready to
hand to `createDeployer`.

```ts
import { createDeployer } from '@absolutejs/deploy';
import { digitalOceanTarget } from '@absolutejs/deploy/digitalocean';

const target = await digitalOceanTarget({
  token: process.env.DO_TOKEN!,
  name: 'absolutejs-prod-1',          // idempotency key
  region: 'nyc3',
  size: 's-1vcpu-1gb',
  image: 'ubuntu-22-04-x64',
  sshKeys: [process.env.DO_KEY_FINGERPRINT!],
  tags: ['absolutejs'],
  userData: '#!/bin/bash\ncurl -fsSL https://bun.sh/install | bash',
  onLog: (line) => console.log(line),
});

console.log(`droplet ${target.dropletId} at ${target.ipv4}`);

const deployer = createDeployer({ appName: 'my-app', target });
await deployer.deploy({ source: { kind: 'directory', path: './build' } });

// Tear it down when you're done:
await target.destroy();
```

Idempotent by `name` — calling twice returns the same droplet, no
duplicates created. Pair with `cloud-init` user data to install Bun /
configure the deploy user / set up firewall rules on first boot, then
the deploy pipeline runs against an SSH-ready box.

Admin helpers: `listDigitalOceanDroplets({ token, tag? })` for
inventory; `destroyDigitalOceanDroplet({ token, id })` for cleanup
(404 is treated as idempotent success). Narrow `DigitalOceanClientLike`
interface so you can BYO `request(method, path, body?)` for retry /
observability — the bundled `createDigitalOceanClient(token)` is just
a sensible default.

## DigitalOcean Droplet — first deploy (manual)

Assuming a fresh Ubuntu/Debian Droplet:

```bash
# 1. Install Bun on the Droplet (one-time):
ssh root@<droplet> 'curl -fsSL https://bun.sh/install | bash && ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun'

# 2. Create a deploy user with sudo for systemctl (one-time):
ssh root@<droplet> 'adduser --disabled-password --gecos "" deploy && mkdir -p /home/deploy/.ssh'
ssh root@<droplet> 'cat >> /home/deploy/.ssh/authorized_keys' < ~/.ssh/id_ed25519.pub
ssh root@<droplet> 'chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys'

# 3. Now deploy:
bun run my-deploy-script.ts
```

The first run creates `/srv/<appName>/releases/<id>/`, drops a systemd unit at `/etc/systemd/system/<appName>.service` (if you're using `systemdManager`), starts the service, and probes. Subsequent runs just add a new release dir and swap the symlink.

## What v0.2.0 does NOT include

- Provider-specific HTTP-API adapters beyond DigitalOcean (Cloudflare Workers, Fly Machines, AWS Fargate, GCP Cloud Run). Hetzner / Linode / Vultr follow the same shape as `digitalOceanTarget` and are next on the list.
- Bun installation on the remote — caller does it once, out of band.
- Multi-target / fan-out deploys (caller iterates).
- Zero-downtime port-swap (start new release on a fresh port, then nginx-reload). The default pipeline does stop-then-start; for true zero-downtime, replace the `restart` step.
- Secrets injection (use `@absolutejs/secrets` alongside, or set them as systemd `Environment=` lines).

## Architectural role

- **`@absolutejs/runtime`** — in-process child-spawning. Use it INSIDE the deployed app for multi-tenant work; `@absolutejs/deploy` is what gets the app onto the box.
- **`@absolutejs/secrets`** — resolves credentials at request time. `deploy`'s `env` option is fine for boot-time config; secrets that rotate live in the secrets broker.
- **`@absolutejs/metering` + `/router`** — operate on the running app inside the deployed process; `deploy` doesn't touch them.

## License

BSL 1.1 with a named carveout for the hosted application-deploy / git-push-deploy / repo-to-URL category (Vercel, Render, Railway, Fly.io's deploy half, Netlify, Heroku, Cloud66, Coolify, Cloudflare Pages, Cloudflare Workers deploy, DigitalOcean App Platform, Azure App Service deploy, AWS Amplify Hosting, AWS Elastic Beanstalk, GCP Cloud Run deploy). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
