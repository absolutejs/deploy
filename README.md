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

## Native application releases (0.22.0)

`@absolutejs/deploy/native-release` publishes the immutable release directory
created by `absolute mobile build android` through any `@absolutejs/blob`
adapter. It verifies the local AAB's declared size and SHA-256 digest again,
requires a signed build by default, and writes the binary only once under its
content-derived release identity.

```ts
import { createNativeReleaseRegistry } from '@absolutejs/deploy/native-release';
import { s3BlobStore } from '@absolutejs/blob/s3';

const store = s3BlobStore({ client, bucket: 'absolute-releases' });
const releases = createNativeReleaseRegistry({ store });

const published = await releases.publish({
  releaseRoot:
    '.absolutejs/mobile/releases/android/amobile_android_<sha256>',
  channel: 'internal'
});

await releases.promote({
  appId: published.record.metadata.appId,
  platform: 'android',
  releaseId: published.record.metadata.releaseId,
  channel: 'production'
});
```

Channels are small mutable pointers; release records and AAB bytes are
immutable. Promoting an older retained release is therefore a rollback without
rebuilding or copying the binary. Passing `allowUnsigned: true` is required on
both publication and promotion for intentionally non-publishable local-testing
artifacts. The registry uses the structural BlobStore shape, so Deploy does not
take a runtime dependency on `@absolutejs/blob` or a cloud SDK.

## Infrastructure providers (0.14.0)

Control planes use the normalized `InfrastructureProvider` contract from
`@absolutejs/deploy/infrastructure`. Cloud inventory and lifecycle adapters
live in this package beside their deploy targets so providers never become
scattered across host applications.

```ts
import { createDigitalOceanInfrastructureProvider } from '@absolutejs/deploy/digitalocean-infrastructure';

const provider = createDigitalOceanInfrastructureProvider({
  token: process.env.DIGITALOCEAN_TOKEN!,
  tag: 'absolutejs-paas-node',
  regions: [{
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    image: 'ubuntu-24-04-x64',
    sshKeys: [process.env.DIGITALOCEAN_SSH_KEY!],
    userData: process.env.ABSOLUTEJS_NODE_CLOUD_INIT,
  }],
  agent: { preferPrivateNetwork: true, port: 8081 },
});

await provider.listNodes();
await provider.provisionNode({
  idempotencyKey: crypto.randomUUID(),
  name: 'absolutejs-node-01',
});
```

The same contract is implemented by GCP, Hetzner, Linode, and Vultr adapters:

- `@absolutejs/deploy/gcp`
- `@absolutejs/deploy/hetzner-infrastructure`
- `@absolutejs/deploy/linode-infrastructure`
- `@absolutejs/deploy/vultr-infrastructure`

GCP uses Application Default Credentials and an immutable instance template.
Every adapter exposes declared capabilities, normalized node identity/state/
address data, list/get/provision/terminate, and regional placement. Application
deployment, draining, migration, and edge cutover remain higher-level
orchestration concerns.

## Global edge ingress (0.17.0)

`EdgeIngressProvider` is the shared lifecycle for a public global ingress over
regional edge pools. It normalizes the listener, backend health check, ordered
regional failover priority, provider resource references, addresses, state,
and idempotent removal. Provider resource construction stays here instead of
leaking DigitalOcean or GCP APIs into a control plane.

```ts
import { createDigitalOceanIngressProvider } from '@absolutejs/deploy/digitalocean-ingress';

const ingress = createDigitalOceanIngressProvider({
  token: process.env.DIGITALOCEAN_TOKEN!,
});

await ingress.reconcileIngress({
  name: 'absolutejs-edge',
  idempotencyKey: crypto.randomUUID(),
  backends: [
    { region: 'nyc3', resourceId: 'regional-lb-east', priority: 1 },
    { region: 'sfo3', resourceId: 'regional-lb-west', priority: 2 },
  ],
  listener: {
    port: 443,
    protocol: 'https',
    targetPort: 443,
    tlsPassthrough: true,
  },
  healthCheck: { protocol: 'tcp', port: 443 },
});
```

DigitalOcean uses a Global Load Balancer whose backends are regional load
balancer UUIDs. GCP uses a global external TCP proxy whose backends are
provider-native instance-group or NEG self-links; the adapter also owns its
health check, backend service, proxy, Premium address, and forwarding rule.
Both preserve TLS termination at the regional edge and wait for provider
operations before advancing dependent resources. Creating an adapter does not
provision anything; only `reconcileIngress()` mutates provider state.

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

console.log(await deployer.status());

// later — atomic rollback
const previous = (await deployer.listReleases()).at(-2);
if (previous) await deployer.rollback(previous);

// optional housekeeping
await deployer.prune({ keep: 5 });

// sunset the active process through the same process-manager contract
await deployer.stop();

// control planes can make teardown win a publish/unpublish race
const controller = new AbortController();
const pending = deployer.deploy({ signal: controller.signal });
controller.abort();
await pending.catch(() => undefined);
await deployer.stop();
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

## `@absolutejs/deploy/hetzner` — provision-or-reuse from code (0.3.0)

Same shape as the DigitalOcean adapter, Hetzner Cloud v1 API
mappings underneath. Hetzner-specific differences: locations
(`nbg1` / `fsn1` / `hel1` / `ash` / `hil`), server types
(`cx22` / `cpx11` / `ccx13` / …), labels (key-value, not array),
and public-net IPv4/IPv6 are independently toggleable.

```ts
import { createDeployer } from '@absolutejs/deploy';
import { hetznerTarget } from '@absolutejs/deploy/hetzner';

const target = await hetznerTarget({
  token: process.env.HETZNER_TOKEN!,
  name: 'absolutejs-prod-1',
  location: 'nbg1',
  serverType: 'cx22',
  image: 'ubuntu-22.04',
  sshKeys: [process.env.HETZNER_KEY_FINGERPRINT!],
  labels: { env: 'prod', team: 'platform' },
  userData: '#!/bin/bash\ncurl -fsSL https://bun.sh/install | bash',
});

const deployer = createDeployer({ appName: 'my-app', target });
await deployer.deploy({ source: { kind: 'directory', path: './build' } });
await target.destroy();
```

Hetzner enforces unique server names per project, so the
idempotency contract is structural — `name` collisions never
happen. Admin helpers: `listHetznerServers({ token, labelSelector?
})` (Hetzner's `'env=prod'` / `'env in (prod,staging)'` syntax);
`destroyHetznerServer({ token, id })` (404 idempotent success).

## `@absolutejs/deploy/cloudflare` — DNS automation (0.4.0)

After provisioning a Target, point a hostname at its IP without
leaving the deploy script. `cloudflareProvider({ token, zoneId })`
implements the shared `DnsProvider` contract from
`@absolutejs/deploy/dns`.

```ts
import { hetznerTarget } from '@absolutejs/deploy/hetzner';
import { cloudflareProvider } from '@absolutejs/deploy/cloudflare';
import { ensureDnsForTarget } from '@absolutejs/deploy/dns';

const target = await hetznerTarget({ /* … */ });
const dns = cloudflareProvider({
  token: process.env.CLOUDFLARE_TOKEN!,
  zoneId: process.env.CLOUDFLARE_ZONE_ID!,
});

// Idempotent — create or update so the A record points at target.ipv4.
await ensureDnsForTarget(dns, {
  name: 'api.example.com',
  target,
  ttl: 60,
  proxied: false,
});
```

`upsert` is the canonical entry: finds by exact (name, type); skips
the API call entirely when the existing record already matches the
spec (no churn on TTL / proxied / comment agreement). Multiple
records sharing the same (name, type) throw with a "resolve
manually" message instead of silently picking one.

Auth uses Cloudflare API tokens with `Zone:DNS:Edit` scope (global
keys not supported). Pair with `provider.list({ name?, type? })`
for inventory, `provider.delete(id)` for tear-down (404 idempotent
success).

The same `DnsProvider` contract applies to other providers — Route
53 / DigitalOcean DNS / etc. follow next.

## `@absolutejs/deploy/tls` — Let's Encrypt automation (0.5.0)

The last step. After provisioning a Target and pointing DNS at it,
`issueCertificate(...)` drives the full ACME-DNS-01 flow against
Let's Encrypt: account registration, new order, DNS-01 challenge
via the same `DnsProvider` you used for DNS, polling, CSR
finalize, cert download. Then `installCertificateOnTarget(...)`
uploads the PEM files to the box.

Zero third-party ACME / JOSE deps — RFC 8555 implemented directly
against Bun's `crypto.subtle`. The audit surface stays in this
repo.

```ts
import { hetznerTarget } from '@absolutejs/deploy/hetzner';
import { cloudflareProvider } from '@absolutejs/deploy/cloudflare';
import { ensureDnsForTarget } from '@absolutejs/deploy/dns';
import {
  issueCertificate,
  installCertificateOnTarget,
  LETSENCRYPT_PRODUCTION,
} from '@absolutejs/deploy/tls';

const target = await hetznerTarget({ /* … */ });
const dns = cloudflareProvider({
  token: process.env.CLOUDFLARE_TOKEN!,
  zoneId: process.env.CLOUDFLARE_ZONE_ID!,
});

// 1. Point DNS at the box.
await ensureDnsForTarget(dns, { name: 'api.example.com', target, ttl: 60 });

// 2. Issue a cert via DNS-01.
const cert = await issueCertificate({
  domains: ['api.example.com'],
  dnsProvider: dns,
  email: 'ops@example.com',
  directoryUrl: LETSENCRYPT_PRODUCTION,
  onLog: (line) => console.log(line),
});

// 3. Install on the box.
await installCertificateOnTarget(target, cert, {
  reload: 'systemctl reload nginx',
});
```

For hosted platforms, customers can delegate only the ACME challenge instead
of granting access to their DNS account. Ask them to CNAME
`_acme-challenge.app.customer.com` into a validation zone you control, then
map the provider write while leaving propagation checks on the public name:

```ts
const cert = await issueCertificate({
  domains: ['app.customer.com'],
  dnsProvider: platformValidationDns,
  email: 'ops@platform.example',
  mapDnsChallengeRecord: ({ domain }) =>
    `${stableDomainToken(domain)}.acme.platform.example`,
});
```

`generateAccountKey()` / `exportAccount()` / `importAccount()`
round-trip the ECDSA P-256 keypair + `kid` so cert renewals reuse
the same account (avoids Let's Encrypt's account-creation rate
limit). Persist the JSON; pass `account` back to subsequent
`issueCertificate` calls.

`installCertificateOnTarget`'s defaults:
`/etc/ssl/<domain>/fullchain.pem` + `/etc/ssl/<domain>/privkey.pem`,
mode `600`. Override `certPath` / `keyPath` / `mode` / `owner` /
`reload` as needed.

## `@absolutejs/deploy/env` — env-file sync + secret propagation (0.7.0)

The "universal place to rotate a key across the myriad of services"
loop. Composes with `@absolutejs/secrets`: that library handles the
in-process side (resolve, rotate, redact, in-process listeners);
this module handles the deploy-side (push values to remote env
files, atomic swap, conditional service reload).

```ts
import { createSecretBroker, inMemoryAdapter } from '@absolutejs/secrets';
import { hetznerTarget } from '@absolutejs/deploy/hetzner';
import {
  syncSecretsToDeployments,
  deploymentsUsing,
  type EnvDeployment,
} from '@absolutejs/deploy/env';

// One source of truth — the SecretBroker. Swap in whatever adapter
// (env, file, vault, etc.) makes sense for your team.
const broker = createSecretBroker({
  adapter: inMemoryAdapter({
    initial: {
      DATABASE_URL: 'postgres://prod-db',
      STRIPE_KEY: 'sk_live_old',
    },
  }),
});

// Each deployed service is one EnvDeployment.
const api = await hetznerTarget({ name: 'api-1', /* … */ });
const worker = await hetznerTarget({ name: 'worker-1', /* … */ });

const deployments: EnvDeployment[] = [
  {
    target: api,
    remotePath: '/etc/api.env',
    secretNames: ['STRIPE_KEY', 'DATABASE_URL'],
    extras: { NODE_ENV: 'production', PORT: '3000' },
    reload: 'systemctl reload api',
  },
  {
    target: worker,
    remotePath: '/etc/worker.env',
    secretNames: ['DATABASE_URL'],
    extras: { NODE_ENV: 'production' },
    reload: 'systemctl restart worker',
  },
];

// First-time push (and every subsequent re-sync — idempotent).
await syncSecretsToDeployments(broker, deployments);

// Rotate STRIPE_KEY everywhere it's used:
await broker.rotate('STRIPE_KEY');
await syncSecretsToDeployments(
  broker,
  deploymentsUsing('STRIPE_KEY', deployments)
);
```

`broker.rotate()` updates the broker's underlying store + fires the
existing `onRotate` listeners (long-lived DB clients swap creds in
place). `syncSecretsToDeployments` propagates to every deployed box
that uses the secret, atomically rewrites the env file, runs the
reload command only if the diff was non-empty.

Format: standard `KEY=value` per line, sorted alphabetically (stable
diffs), values double-quoted when needed. systemd reads it via
`EnvironmentFile=`; Docker via `--env-file`; most shell start
scripts source it. The serializer rejects newlines in values + keys
that don't match `[A-Z_][A-Z0-9_]*`.

Best-effort fan-out: one broken target doesn't stop the rest. Each
result carries either `result: EnvSyncResult` or `error: Error`.
The operator inspects the array, fixes the broken target, re-runs —
re-runs are idempotent.

## Renewals — `renewCertificate` (0.6.0)

`issueCertificate` is one-shot; `renewCertificate` is the conditional
driver you wire to a cron / scheduled function. Reads the current
cert PEM, parses its `validTo`, and either returns `{ renewed: false
}` (cheap, no network IO) or runs the full issuance flow.

```ts
import {
  renewCertificate,
  installCertificateOnTarget,
  importAccount,
} from '@absolutejs/deploy/tls';
import { readFile, writeFile } from 'node:fs/promises';

const currentCertificatePem = await readFile('./cert.pem', 'utf8').catch(() => undefined);
const account = await importAccount(
  JSON.parse(await readFile('./account.json', 'utf8'))
);

const result = await renewCertificate({
  currentCertificatePem,
  domains: ['api.example.com'],
  dnsProvider: dns,
  email: 'ops@example.com',
  account,
  renewWhenDaysRemaining: 30,        // default
});

if (result.renewed) {
  console.log(`renewed (${result.reason})`);
  await installCertificateOnTarget(target, result.certificate, {
    reload: 'systemctl reload nginx',
  });
  await writeFile('./cert.pem', result.certificate.certificatePem);
  await writeFile('./key.pem', result.certificate.privateKeyPem);
} else {
  console.log(
    `still fresh — ${result.inspection.daysRemaining} days remaining`
  );
}
```

Pair with `inspectCertificate(pem)` for status pages, expiry
alerts, and observability:

```ts
const info = inspectCertificate(certificatePem);
// { subjects, validFrom, validTo, daysRemaining, expired, issuer }
```

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

## Streamed release artifacts

Control planes that activate a release through a remote host agent can use the
`@absolutejs/deploy/release-artifact` boundary instead of inventing archive and
integrity handling:

```ts
const artifact = await createReleaseArtifact({
  sourceRoot: workspace,
  exclude: ["node_modules", "build", ".git"],
});

await upload(artifact.file.stream(), artifact.metadata);
await artifact.dispose();
```

`receiveReleaseArtifact` streams a bounded body to disk and verifies its exact
byte count and SHA-256 digest. `extractReleaseArtifact` rejects traversal,
links, and special entries before extracting a project with a root
`package.json`. Authorization, durable state, target selection, activation,
and traffic cutover remain control-plane responsibilities.

## Provider adapters (0.8.0)

Compute (`Target` via `createCloudTarget`):

  - `@absolutejs/deploy/digitalocean` — droplets
  - `@absolutejs/deploy/hetzner` — Hetzner Cloud servers
  - `@absolutejs/deploy/linode` — Linode instances
  - `@absolutejs/deploy/vultr` — Vultr instances

DNS (`DnsProvider`):

  - `@absolutejs/deploy/cloudflare`
  - `@absolutejs/deploy/digitalocean-dns`
  - `@absolutejs/deploy/hetzner-dns`
  - `@absolutejs/deploy/route53` — narrow client interface; BYO `@aws-sdk/client-route-53` via a 4-line shim, or hand-roll a SigV4 fetch client.

All compute adapters share the same `createCloudTarget` machinery
(find-or-create + wait-for-ready + wait-for-SSH + sshTarget wrap)
so adding a fifth provider is ~80 lines of glue. All DNS providers
implement the same `DnsProvider` contract (`list / find / create /
update / delete / upsert`) so swapping providers is a one-line
constructor change.

## What v0.9.0 does NOT include

- Fly Machines compute (different abstraction — ephemeral machines
  with app-scoped naming).
- A CLI front-end. Library is complete; the CLI is sugar.
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
