# @absolutejs/deploy changelog

## 0.17.0 — 2026-07-14

Adds the provider-neutral global edge ingress lifecycle.

- `EdgeIngressProvider` owns inspect, idempotent reconcile, and removal above
  regional provider-native backend pools. Desired listeners, health checks,
  ordered regional priorities, and TLS passthrough are normalized.
- `createDigitalOceanIngressProvider` reconciles a DigitalOcean Global Load
  Balancer over regional load balancer targets, including health failover,
  dual-stack addressing, and drift updates.
- `createGcpIngressProvider` reconciles a global external TCP proxy load
  balancer over regional instance-group or NEG self-links. It owns the health
  check, backend service, target proxy, Premium static address, forwarding
  rule, operation waiting, drift repair, and dependency-ordered teardown.

Provider calls remain injectable for retry, observability, and testing. This
package owns provider resource shapes; consuming control planes own desired
state and authorization.

## 0.16.1 — 2026-07-14

- Sends GCP provision-time cloud-init through the Compute Engine `user-data`
  metadata key instead of treating it as a shell `startup-script`.

## 0.16.0 — 2026-07-14

- Allows each normalized infrastructure provision request to supply its own
  bootstrap user-data payload. Region defaults remain supported, while control
  planes can mint host-specific Bun agent configuration at provisioning time
  across DigitalOcean, GCP, Hetzner, Linode, and Vultr.

## 0.15.0 — 2026-07-14

Completes the normalized VPS fleet-provider matrix.

### Added

- `createHetznerInfrastructureProvider`
- `createLinodeInfrastructureProvider`
- `createVultrInfrastructureProvider`

Each adapter implements the same capability, inventory, get, idempotent
provision, regional placement, node-agent discovery, and termination contract
as DigitalOcean and GCP. Existing deploy targets remain unchanged; control
planes can now switch among all five compute providers without owning a cloud
API or changing fleet orchestration.

## 0.14.1 — 2026-07-14

- Adds `createGcpIdentityTokenRequest`, keeping Google-signed node-agent and
  edge-service authentication beside the GCP provider instead of leaking a
  Google auth dependency into consuming control planes.

## 0.14.0 — 2026-07-14

Provider-neutral compute fleet lifecycle for control planes.

### Added

- **`InfrastructureProvider`** in `@absolutejs/deploy/infrastructure` defines
  normalized capabilities and node inventory plus get, provision, and
  terminate operations. Application deployment, draining, migration, and edge
  cutover deliberately remain orchestration above this compute boundary.
- **`createDigitalOceanInfrastructureProvider`** lives beside the existing
  DigitalOcean target and client. It inventories a tagged fleet, normalizes
  public/private addressing and node-agent discovery, places new droplets in
  the least-populated configured region, reuses names idempotently, and
  terminates by bounded provider node id.
- **`createGcpInfrastructureProvider`** in `@absolutejs/deploy/gcp` uses
  Application Default Credentials, labeled Compute Engine inventory,
  immutable instance templates, regional least-populated placement, GCP
  request IDs, and normalized node-agent metadata.

All compute-provider implementations now live in `@absolutejs/deploy`; host
applications consume the shared contract instead of owning cloud APIs.

## 0.13.0 — 2026-07-14

Delegated DNS-01 support for hosted custom domains.

### Added

- **`mapDnsChallengeRecord`** on `issueCertificate` and `renewCertificate`
  maps the TXT record written through the configured `DnsProvider` while the
  propagation checker continues to observe the public ACME challenge name.
  This supports customer-owned `_acme-challenge` CNAMEs delegated into a
  platform-controlled validation zone without requiring customer DNS API
  credentials.

## 0.12.0 — 2026-07-14

Cancellation for control-plane deployment races.

### Added

- **`deployer.deploy({ signal })`** checks an `AbortSignal` before and after
  every pipeline step and exposes it on `DeployContext` for custom steps and
  verification probes. A cancelled pipeline records its current step as
  failed and runs the existing error hooks.

This lets a control plane make unpublish authoritative while a build is in
flight: abort the pipeline, stop its process manager, and no later step can
relaunch the release.

## 0.11.0 — 2026-07-14

Active-release lifecycle control for control planes and container-backed
process managers.

### Added

- **`deployer.stop()`** delegates teardown to the configured process manager
  using the active `current` release context. It fails explicitly when a
  custom manager does not implement stop instead of reporting a false success.
- **`deployer.status()`** exposes the configured manager's active status and
  returns `unknown` when the manager has no status probe.

These operations let a control plane own deploy, rollback, inspection, and
sunset through the same substrate object. In particular, Docker-backed hosts
can now implement the existing `ProcessManager` contract without retaining a
parallel teardown path outside `@absolutejs/deploy`.

## 0.10.0 — 2026-05-31

Preview deploys. Closes G10 from the second-pass PaaS audit — the
substrate now has ephemeral-environment orchestration on top of the
release / DNS / target machinery from prior versions.

### Added — `@absolutejs/deploy/preview`

- **`createPreviewFleet({ baseDomain, dns?, ipv4?, makeDeployer,
  stop?, afterTeardown?, store?, ... })`** — tenant-aware fleet that
  composes the existing `Deployer` (release dirs + atomic symlink
  swap + rollback) with a `DnsProvider` and a persistent registry.
- **`fleet.create({ previewId, commitSha?, annotations?, hostname?
  })`** — idempotent on `previewId`: existing previews reuse port +
  `createdAt`, run a fresh `deployer.deploy()` so PR pushes roll
  forward. New previews allocate from the configured port range
  (default `[3100, 3899]`) and upsert an A record at
  `<slug(previewId)>.<baseDomain>` → `ipv4`. Slugifier normalizes
  branch / PR names (`PR/Feature_Branch` → `pr-feature-branch`).
- **`fleet.teardown(previewId)`** — runs `stop` hook → removes DNS
  record → drops registry entry → runs `afterTeardown` hook. Stop
  failures don't block DNS removal. DNS deletes on already-removed
  records are swallowed. Unknown previewIds are no-ops.
- **`fleet.gc({ olderThanMs })`** — sweeps previews older than a
  threshold via `teardown`. Returns `{ removed, errors }` so a
  daily cron can run unattended.
- **`createMemoryPreviewStore()`** — for tests / ephemeral fleets.
- **`createFilePreviewStore(root)`** — single-file JSON registry
  with atomic writes (`tmp` + `rename`). Corrupt files fall back to
  empty so a botched write doesn't strand the next deploy.

### Design notes

- Substrate owns fleet bookkeeping (ports, DNS, registry). The
  caller-supplied `makeDeployer` factory owns *application*
  concerns: target choice, env, processManager, secrets snapshot.
- DNS is optional. When absent, the fleet returns a hostname + URL
  and the caller is responsible for routing.
- `dnsTtl` defaults to 60s — previews come and go, low cache
  lifetime matches the use case.
- No assembly recipe shipped: per the no-public-PaaS-assembly rule,
  the bot that wires a fleet to a webhook lives in the private
  control-plane repo, not in `examples/`.

### Tests

25 new tests covering: hostname slugify + override; port range
allocation + exhaustion; custom `allocatePort`; per-port uniqueness;
idempotent re-create on same previewId reusing port + `createdAt`;
annotation pass-through + commitSha lift; DNS upsert with custom
TTL / proxied flag; missing-ipv4 guard; teardown happy path;
unknown-id no-op; stop-throws isolation; DNS-delete failure
swallowed; gc threshold; file store round-trip + overwrite +
corruption recovery.

## 0.9.0 — 2026-05-31

Route 53 DNS provider. Different shape from the other DNS adapters
(no per-record id, native UPSERT action) so the implementation
differs more than DO/Hetzner did — but the public `DnsProvider`
contract stays uniform.

### Added — `@absolutejs/deploy/route53`

- **`route53DnsProvider({ client, hostedZoneId, zoneName })`** —
  implements `DnsProvider`. Exploits Route 53's native `UPSERT`
  action: one API call replaces the find-then-create-or-update
  dance the other providers need.
- **Narrow `Route53ClientLike` interface** so the package stays
  zero-peer-dep. Wire your `@aws-sdk/client-route-53` Route53Client
  with a 4-line shim — `listResourceRecordSets` +
  `changeResourceRecordSets` are the only methods we touch. Or
  hand-roll a SigV4-signed fetch client if you want zero deps.
- **TXT-value wire encoding**: Route 53 requires TXT values to be
  enclosed in double quotes (and values > 255 chars split into
  multiple quoted chunks). The adapter wraps on write, unwraps on
  read — your code sees raw plaintext, the wire sees quoted form.
- **Synthetic id for delete**: Route 53 deletes require the
  CURRENT record state, not an opaque id. We encode `{ Name, Type,
  Values, TTL }` as a base64-JSON synthetic id at read/write time
  so the `DnsProvider.delete(id)` contract works without a second
  round-trip.
- **Idempotent delete**: "InvalidChangeBatch / not found" errors
  map to `delete()` returning silently — matches the other
  adapters.
- **Pagination handled internally** via `IsTruncated` +
  `NextRecordName` + `NextRecordType`. `list()` returns all pages
  concatenated.
- **Apex shorthand**: `name: '@'` resolves to `${zoneName}.`

### Tests

16 new tests covering UPSERT shape, TXT encoding (short / long /
pre-quoted / round-trip), trailing-dot normalization, apex
shorthand, default TTL, name + type filter, pagination, synthetic-
id delete round-trip, delete idempotency, ensureDnsForTarget
composition.

Test count: 193 → 209.

### Provider matrix at 0.9.0

| Provider | Compute | DNS |
|----------|---------|-----|
| DigitalOcean | ✓ | ✓ |
| Hetzner | ✓ | ✓ |
| Linode | ✓ | — |
| Vultr | ✓ | — |
| Cloudflare | — | ✓ |
| AWS Route 53 | — | ✓ |
| Fly Machines | — | — |

## 0.8.0 — 2026-05-31

Provider fan-out. Four new adapters following the patterns
established by DigitalOcean/Hetzner/Cloudflare in 0.2–0.4: two
compute targets riding `createCloudTarget`, two DNS providers
implementing the `DnsProvider` contract.

### Added — compute targets

- **`@absolutejs/deploy/linode`** — `linodeTarget(options)`
  provisions an instance via the Linode v4 API. Linode-specific
  mappings: `label` as the idempotency key, `type` (e.g.
  `g6-nanode-1`), `image` (e.g. `linode/ubuntu22.04`),
  `authorized_keys` as raw SSH pubkey strings. `root_pass` is
  auto-generated (32 random chars) since Linode requires it; we
  rely entirely on `sshKeys` for actual login. IPv4 selection
  skips RFC 1918 and link-local addresses.
- **`@absolutejs/deploy/vultr`** — `vultrTarget(options)` provisions
  via Vultr v2. Idempotent by `label`. SSH keys are pre-registered
  UUIDs in your Vultr account (not raw key strings — different
  from Linode + DO + Hetzner). `userData` is base64-encoded on the
  way out per Vultr's API requirement. `main_ip === '0.0.0.0'`
  treated as "not yet assigned" so polling continues.

### Added — DNS providers

- **`@absolutejs/deploy/digitalocean-dns`** — `digitalOceanDnsProvider`
  implementing `DnsProvider`. Reuses the existing
  `DigitalOceanClientLike` from the compute adapter (one DO token
  covers both droplets + DNS). Handles DO's "name is relative to
  domain" convention transparently — pass FQDNs like
  `'api.example.com'` and the adapter splits/joins as needed.
- **`@absolutejs/deploy/hetzner-dns`** — `hetznerDnsProvider`
  implementing `DnsProvider`. NOTE: Hetzner DNS is a separate
  service from Hetzner Cloud — different base URL, different auth
  header (`Auth-API-Token`, NOT Bearer). The adapter has its own
  `HetznerDnsClientLike` interface + `createHetznerDnsClient`
  factory to keep them distinct.

### Patch — shared helper

`createCloudTarget` is now generic over its id type: `<Server, Id =
number>`. Lets Vultr (string ids) plug into the same helper as
DO/Hetzner/Linode (number ids) without per-provider hacks.

### Patch — `DigitalOceanClientLike` widened

The interface's `method` union now includes `'PUT'` and `'PATCH'`
to support the DNS adapter. Existing compute callers are
unaffected — the union is wider, not narrower.

### Tests

37 new tests across the four adapters: provision / reuse / list /
find / destroy / upsert / list-with-filter / find-on-duplicate /
PUT-on-drift / 404-idempotent / client-builds-auth-header
/ FQDN-conversion-round-trip / Vultr-base64-user-data /
Linode-private-IP-skipping.

Test count: 156 → 193.

### Provider matrix at 0.8.0

| Provider | Compute | DNS |
|----------|---------|-----|
| DigitalOcean | `/digitalocean` ✓ | `/digitalocean-dns` ✓ |
| Hetzner | `/hetzner` ✓ | `/hetzner-dns` ✓ |
| Linode | `/linode` ✓ | — |
| Vultr | `/vultr` ✓ | — |
| Cloudflare | — | `/cloudflare` ✓ |
| Fly Machines | — | — |
| Route 53 | — | — |

## 0.7.0 — 2026-05-31

Environment-variable propagation. Closes the "I rotate STRIPE_KEY in
my broker — now what?" question that `@absolutejs/secrets` left
open. Composes with `@absolutejs/secrets` via a narrow
`SecretSource` interface — neither library imports the other.

### Added — `@absolutejs/deploy/env` subpath

- **`syncEnvToTarget(deployment, values)`** — push a
  `Record<string, string>` to a remote env file (default
  `/etc/<app>.env`). Atomic write (temp file + `mv`), diffs against
  the existing file, chmod (default 600) + chown, optional reload
  command. Skips write + reload when nothing changed — bouncing a
  service for an identical file is the wrong default.
- **`syncSecretsToDeployments(source, deployments)`** — fan-out.
  Resolves each deployment's `secretNames` via the `SecretSource`,
  merges with `extras` (non-secret env), pushes to each target.
  Best-effort across the fan-out: a per-target failure is captured
  in the result, doesn't stop the rest.
- **`deploymentsUsing(name, deployments)`** — filter helper for
  "only propagate to the deployments that use this secret."
- **`SecretSource`** narrow interface (`{ resolve(name) → ... }`).
  `@absolutejs/secrets`' `SecretBroker` satisfies it structurally;
  any custom store works too.
- **`serializeEnvFile` / `parseEnvFile`** standalone helpers. The
  serializer validates keys against `[A-Z_][A-Z0-9_]*` and rejects
  newlines in values (env files can't represent them).
- **Format guarantees**: alphabetically-sorted output for stable
  diffs; double-quoted values when shell special chars appear; the
  parser ignores `#` comments and blank lines, throws on malformed
  lines (the deploy primitive owns the file — unknown content is
  loud, not silent).

### Rotation propagation

The rotation flow is now one composed call:

```ts
await broker.rotate('STRIPE_KEY');                           // @absolutejs/secrets
await syncSecretsToDeployments(broker, deployments);         // @absolutejs/deploy/env
```

Or, when scoped to only the consumers of one key:

```ts
await broker.rotate('STRIPE_KEY');
await syncSecretsToDeployments(
  broker,
  deploymentsUsing('STRIPE_KEY', deployments)
);
```

`broker.rotate()` fires the existing `onRotate` listeners (long-
lived DB clients swap creds in-process). `syncSecretsToDeployments`
propagates to every deployed box that uses the secret. Together
they make the "rotate everywhere" call exactly the loop the
operator wants.

### Tests

19 new tests (`tests/env.test.ts`): serialize/parse round-trip for
tricky values; rejects newlines + invalid keys; ignores comments +
blank lines; first push creates the file; no-op when unchanged
(skips reload too); detects added/removed/changed/unchanged keys;
atomic temp-file + `mv` pattern; extras merge with secrets;
extras/secret collision throws; custom mode + owner; fan-out
pushes to multiple targets; rotation re-sync picks up the new
value; best-effort fan-out captures per-target failures.

Test count: 137 → 156.

## 0.6.0 — 2026-05-31

Cert-renewal scheduling. The 0.5.0 `issueCertificate` was one-shot;
this release adds the "should we renew yet?" gate so operators can
wire one function call to a weekly cron / scheduled-function and
have it Do The Right Thing.

### Added — `inspectCertificate(pem, { now? }?)`

Parses a PEM certificate via `node:crypto`'s `X509Certificate` and
returns operator-shaped metadata:

  - `subjects` — CN + every SAN, deduplicated
  - `validFrom` / `validTo` — ms since epoch
  - `daysRemaining` — whole days until `validTo` (negative if expired)
  - `expired` — convenience boolean
  - `issuer` — issuer DN string

Standalone primitive — fine for status pages, alerts ("cert expires
in 14 days"), and observability dashboards.

### Added — `renewCertificate(options)`

Conditional renewal driver. Extends `IssueCertificateOptions` with:

  - `currentCertificatePem?` — when present, the cert's `validTo`
    decides; when absent, always issues (first-time path).
  - `renewWhenDaysRemaining?` — re-issue threshold (default 30 days,
    matching certbot's standard schedule on Let's Encrypt's 90-day
    certs — leaves a 60-day error budget).
  - `force?` — bypass the freshness check (default false).
  - `now?` — clock override for tests.

Returns a discriminated `RenewalResult`:

  - `{ renewed: true, certificate, reason }` where `reason` is one of
    `'forced'` / `'no-current-cert'` / `'expiring-soon'`.
  - `{ renewed: false, reason: 'still-fresh', inspection }` — cheap
    no-op when the cert has > threshold days left.

Idempotent: a fresh cert returns `{ renewed: false }` after one PEM
parse, zero network IO. Pair with `installCertificateOnTarget` to
swap on the box only when `result.renewed === true`.

### Tests

11 new tests (`tests/renewal.test.ts`) covering inspection of an
openssl-generated self-signed cert + every renewal-decision branch
(`still-fresh` / `expiring-soon` / `expired` / `forced` /
`no-current-cert` / custom threshold / negative-threshold guard).
Issuance itself is short-circuited via a failing fetch stub so
tests don't hit ACME. Skipped automatically if openssl isn't on
PATH.

Test count: 126 → 137.

## 0.5.1 — 2026-05-31

Crypto-correctness validation for the 0.5.0 ACME client. The
mock-server tests verify the call shape; these add byte-level
verification of the primitives.

### Added — `tests/cryptoVectors.test.ts`

29 new tests against the internal cryptographic helpers (now
exposed via `tls.__testing` with `@internal` marker — not part of
the public API):

- **base64url**: padding-stripped encoding, URL-safe alphabet,
  round-trip via `base64UrlDecode`, RFC 7515 §A.1 sample
  decode.
- **DER INTEGER**: 0 / 1 / 127 / 128 / 255 / 256 byte-exact;
  positive-from-Uint8Array with high-bit-set leading-zero rule;
  leading-zero stripping.
- **DER OBJECT IDENTIFIER**: ecdsa-with-SHA256, commonName,
  subjectAltName, PKCS#9 extensionRequest — all byte-exact
  against well-known encodings.
- **DER SEQUENCE/SET length encoding**: short-form (< 128),
  long-form 1-byte length (128-255), long-form 2-byte length
  (256+).
- **ECDSA raw ↔ DER signature**: high-bit-set leading-zero rule
  on `r` and `s`; leading-zero stripping.
- **JWK thumbprint**: matches an independent SHA-256-of-canonical-
  JSON computation; ignores non-required JWK fields (canonical
  order is required-fields-only).
- **JWS sign+verify round-trip**: signed payload's signature
  verifies with the public key.
- **POST-as-GET**: empty-string payload, NOT empty-object.
- **CSR via openssl**: `openssl req -verify` accepts the CSR
  (validates structure + signature); `openssl req -text` dumps
  it with the expected subject CN + SAN extension covering both
  domains. Skipped automatically if openssl isn't on PATH.

### Added — `scripts/test-staging.ts`

Optional manual end-to-end runner. Reads CLOUDFLARE_TOKEN /
CLOUDFLARE_ZONE_ID / ACME_EMAIL / TEST_DOMAIN from env; issues a
real cert from Let's Encrypt staging; parses the result via
`node:crypto`'s `X509Certificate`. Driven by the developer with
their own zone — not in CI. Pass `--reuse-account` for the
renewal-path validation.

### Patch — internal exports

`tls.__testing` exposes the internal helpers (`base64UrlEncode`,
`derInt`, `derOid`, `derSeq`, `derSet`, `derBitString`,
`ecdsaRawToDer`, `exportPublicJwk`, `jwkThumbprint`, `signJws`,
`buildCsr`, `generateCertKeyPair`, `exportEcPrivateKeyPem`,
`base64UrlEncodeString`, `base64UrlDecode`). Marked `@internal`;
consumers should NOT depend on this surface.

Test count: 97 → 126.

## 0.5.0 — 2026-05-31

TLS / Let's Encrypt automation. After provisioning a Target and
pointing DNS at it, the last manual step ("get a cert for this
hostname") is now in-tree. Zero third-party ACME or JOSE
dependencies — RFC 8555 implemented directly against Bun's
`crypto.subtle`.

### Added — `@absolutejs/deploy/tls` subpath

- **`issueCertificate({ domains, dnsProvider, email })`** — drives the
  full ACME-DNS-01 flow against Let's Encrypt (or any RFC 8555
  compatible CA). Account registration, new order, DNS-01 challenge
  via `DnsProvider.upsert` (Cloudflare today, others slot in),
  authorization polling, CSR finalize with ECDSA P-256 keypair,
  certificate download. Returns
  `{ certificatePem, privateKeyPem, account, domains }`.
- **`installCertificateOnTarget(target, cert, options?)`** — uploads
  PEM cert + private key to a cloud `Target` via the existing
  `exec`/`upload` interface; optional `chmod`, `chown`, and `reload`
  command. Default paths: `/etc/ssl/<domain>/{fullchain,privkey}.pem`,
  mode `600`.
- **Account reuse** — `generateAccountKey() / exportAccount() /
  importAccount()` round-trip the ECDSA P-256 keypair + `kid` so
  cert renewals reuse the same account (cheaper, avoids Let's
  Encrypt's account-creation rate limit).
- **Constants** — `LETSENCRYPT_PRODUCTION` and `LETSENCRYPT_STAGING`
  for the directory URL.
- **`AcmeError`** — carries `{ status, body }` so callers can switch
  on rate-limit / malformed-order error types.

### Why we own the ACME client

Letting a third-party npm pkg drive the deploy's TLS flow means
trusting its JOSE implementation, account-key handling, and
serialization. Owning a ~500-line implementation lives in this
repo's audit surface. RFC 8555 is stable, Bun's `crypto.subtle`
covers JWS (ES256) and DER-encoded CSR signing, so the dep cost
of "use the standard ACME client" buys very little.

### Build

- New `src/tls.ts` bundle entry + `./tls` subpath in `package.json`
  exports.

### Tests

13 new tests: mock ACME server walking the protocol through
account → order → authorization → challenge → finalize → certificate
download; mock DnsProvider verifies the DNS-01 TXT record gets
written + cleaned up; account export/import round-trip with a
sign/verify sanity check; `installCertificateOnTarget` exec
ordering and override paths.

Test count: 84 → 97.

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
