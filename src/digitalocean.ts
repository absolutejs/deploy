/**
 * @absolutejs/deploy/digitalocean — provision-or-reuse Target adapter
 * for DigitalOcean droplets.
 *
 * What it does:
 *
 *   1. Looks up a droplet by `name`. If present and active, reuses it.
 *   2. If not present, creates it via the DO v2 API and waits for
 *      `status === 'active'` with a public IPv4 assigned.
 *   3. Waits for SSH readiness (TCP connect on port 22 with backoff,
 *      or a caller-supplied probe).
 *   4. Returns a Target that wraps sshTarget against the droplet's
 *      public IPv4, plus `dropletId`, `ipv4`, and a `destroy()` helper.
 *
 * Idempotent by name — calling twice with the same name returns the
 * same droplet, no duplicates created. If multiple droplets share
 * the name, throws (the caller has drifted state to clean up).
 *
 * Narrow DigitalOceanClientLike interface keeps the dots-on-the-i
 * SDK out as a hard dep. Default client uses `fetch` against
 * `api.digitalocean.com`; pass your own for retry / observability.
 */

import type { Target } from './targets';
import { sshTarget } from './targets';

const DO_API_BASE = 'https://api.digitalocean.com/v2';

/**
 * Minimal subset of DO API calls we make. Lets callers BYO a client
 * with retry / observability / etc. (e.g. wrap got, undici, or a
 * tenant-scoped client that injects different tokens per call).
 */
export type DigitalOceanClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown
	) => Promise<T>;
};

/** A DigitalOcean droplet record, narrowed to what we inspect. */
export type DigitalOceanDroplet = {
	id: number;
	name: string;
	status: 'new' | 'active' | 'off' | 'archive';
	region?: { slug: string };
	size_slug?: string;
	networks: {
		v4: Array<{ ip_address: string; type: 'public' | 'private' }>;
		v6?: Array<{ ip_address: string; type: 'public' | 'private' }>;
	};
	tags?: string[];
};

export type DigitalOceanTargetOptions = {
	/** API token (https://cloud.digitalocean.com/account/api/tokens). Required unless `client` is set. */
	token?: string;
	/** Custom client. Overrides token-built default. */
	client?: DigitalOceanClientLike;

	// ── Droplet shape ────────────────────────────────────────────────
	/** Droplet name. Also the idempotency key. */
	name: string;
	/** Region slug — `'nyc3'`, `'sfo3'`, `'ams3'`, etc. */
	region: string;
	/** Size slug — `'s-1vcpu-1gb'`, `'s-2vcpu-4gb'`, etc. */
	size: string;
	/** Image slug, snapshot id, or backup id. e.g. `'ubuntu-22-04-x64'`. */
	image: string | number;
	/** SSH key fingerprints OR numeric ids. At least one required to ssh in. */
	sshKeys: ReadonlyArray<string | number>;
	/** Tags applied at creation. Useful for `listDroplets({ tag })`. */
	tags?: ReadonlyArray<string>;
	/** cloud-init user data — a shell script or YAML config. */
	userData?: string;
	/** VPC UUID. Defaults to the account's default VPC for the region. */
	vpcUuid?: string;
	/** Enable IPv6. Default false. */
	ipv6?: boolean;
	/** Enable monitoring agent. Default false. */
	monitoring?: boolean;

	// ── SSH wrap ────────────────────────────────────────────────────
	/** SSH login user. Default `'root'`. */
	user?: string;
	/** Path to SSH identity file forwarded to sshTarget. */
	identity?: string;
	/** SSH port. Default 22. */
	port?: number;

	// ── Timing ──────────────────────────────────────────────────────
	/** Max time to wait for droplet `active` + IPv4. Default 5 min. */
	provisionTimeoutMs?: number;
	/** Max time to wait for SSH probe to succeed. Default 2 min. */
	sshReadinessTimeoutMs?: number;
	/** Poll interval for provision + ssh probe. Default 5 s. */
	pollIntervalMs?: number;

	// ── Observability + injection points ───────────────────────────
	/** Called with status updates (one line each). Default: noop. */
	onLog?: (line: string) => void;
	/**
	 * Override the SSH readiness probe. Default opens a TCP socket to
	 * `host:port`. Tests pass a fake probe to skip real network IO.
	 */
	probeSsh?: (host: string, port: number) => Promise<boolean>;
	/**
	 * Sleep used between polls. Default `setTimeout`-based. Tests can
	 * pass a synchronous resolver to skip real waits.
	 */
	sleep?: (ms: number) => Promise<void>;
	/** Wall clock. Defaults to `Date.now`. Tests can swap. */
	now?: () => number;
};

export type DigitalOceanTarget = Target & {
	readonly dropletId: number;
	readonly ipv4: string;
	/** Destroy the droplet via the DO API. */
	destroy: () => Promise<void>;
};

export class DigitalOceanError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'DigitalOceanError';
		this.status = status;
		this.body = body;
	}
}

/**
 * fetch-backed default client. Talks JSON to `api.digitalocean.com/v2`.
 * Throws DigitalOceanError on non-2xx with the response body attached
 * so the caller can switch on `err.status`.
 */
export const createDigitalOceanClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): DigitalOceanClientLike => {
	const base = options.baseUrl ?? DO_API_BASE;
	const f = options.fetch ?? fetch;
	return {
		request: async <T>(
			method: 'GET' | 'POST' | 'DELETE',
			path: string,
			body?: unknown
		): Promise<T> => {
			const init: RequestInit = {
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				method
			};
			if (body !== undefined) init.body = JSON.stringify(body);
			const response = await f(`${base}${path}`, init);
			if (response.status === 204) return undefined as T;
			const text = await response.text();
			const parsed = text.length > 0 ? JSON.parse(text) : undefined;
			if (!response.ok) {
				throw new DigitalOceanError(
					`DigitalOcean API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

const resolveClient = (
	options: Pick<DigitalOceanTargetOptions, 'client' | 'token'>
): DigitalOceanClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createDigitalOceanClient(options.token);
	}
	throw new Error(
		'[deploy/digitalocean] either `token` or `client` must be provided'
	);
};

const publicIpv4 = (droplet: DigitalOceanDroplet): string | undefined =>
	droplet.networks.v4.find((net) => net.type === 'public')?.ip_address;

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const defaultProbeSsh = async (host: string, port: number): Promise<boolean> => {
	const PROBE_TIMEOUT_MS = 2_000;
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
		Bun.connect({
			hostname: host,
			port,
			socket: {
				data: () => {},
				error: () => {
					clearTimeout(timer);
					settle(false);
				},
				open: (socket) => {
					clearTimeout(timer);
					socket.end();
					settle(true);
				}
			}
		}).catch(() => {
			clearTimeout(timer);
			settle(false);
		});
	});
};

/**
 * Find a droplet by name. Returns undefined if absent.
 * Throws if more than one droplet shares the name (drifted state).
 */
export const findDigitalOceanDroplet = async (
	client: DigitalOceanClientLike,
	name: string
): Promise<DigitalOceanDroplet | undefined> => {
	// DO's list endpoint supports `name=` exact-match filtering.
	const body = await client.request<{ droplets: DigitalOceanDroplet[] }>(
		'GET',
		`/droplets?name=${encodeURIComponent(name)}`
	);
	const matches = body.droplets.filter((droplet) => droplet.name === name);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(
			`[deploy/digitalocean] multiple droplets named "${name}" (${matches
				.map((droplet) => droplet.id)
				.join(', ')}). Resolve manually before adopting.`
		);
	}
	return matches[0];
};

/** List droplets, optionally filtered by tag. Useful for cleanup tasks. */
export const listDigitalOceanDroplets = async (options: {
	token?: string;
	client?: DigitalOceanClientLike;
	tag?: string;
}): Promise<DigitalOceanDroplet[]> => {
	const client = resolveClient(options);
	const path =
		options.tag !== undefined
			? `/droplets?tag_name=${encodeURIComponent(options.tag)}`
			: '/droplets';
	const body = await client.request<{ droplets: DigitalOceanDroplet[] }>(
		'GET',
		path
	);
	return body.droplets;
};

/** Destroy a droplet by id. No-op if already gone. */
export const destroyDigitalOceanDroplet = async (options: {
	token?: string;
	client?: DigitalOceanClientLike;
	id: number;
}): Promise<void> => {
	const client = resolveClient(options);
	try {
		await client.request('DELETE', `/droplets/${options.id}`);
	} catch (error) {
		if (error instanceof DigitalOceanError && error.status === 404) {
			return; // already destroyed — idempotent
		}
		throw error;
	}
};

/**
 * Provision-or-reuse a DO droplet by name, wait for SSH, return a
 * Target. Idempotent: same name → same droplet.
 */
export const digitalOceanTarget = async (
	options: DigitalOceanTargetOptions
): Promise<DigitalOceanTarget> => {
	const client = resolveClient(options);
	const log = options.onLog ?? (() => {});
	const probeSsh = options.probeSsh ?? defaultProbeSsh;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const pollMs = options.pollIntervalMs ?? 5_000;
	const provisionTimeout = options.provisionTimeoutMs ?? 5 * 60_000;
	const sshTimeout = options.sshReadinessTimeoutMs ?? 2 * 60_000;
	const port = options.port ?? 22;

	const existing = await findDigitalOceanDroplet(client, options.name);
	let current: DigitalOceanDroplet;
	if (existing === undefined) {
		log(`[do] creating droplet "${options.name}" in ${options.region}`);
		const created = await client.request<{ droplet: DigitalOceanDroplet }>(
			'POST',
			'/droplets',
			{
				name: options.name,
				region: options.region,
				size: options.size,
				image: options.image,
				ssh_keys: [...options.sshKeys],
				...(options.tags !== undefined ? { tags: [...options.tags] } : {}),
				...(options.userData !== undefined
					? { user_data: options.userData }
					: {}),
				...(options.vpcUuid !== undefined
					? { vpc_uuid: options.vpcUuid }
					: {}),
				...(options.ipv6 === true ? { ipv6: true } : {}),
				...(options.monitoring === true ? { monitoring: true } : {})
			}
		);
		current = created.droplet;
	} else {
		log(
			`[do] reusing droplet "${options.name}" (id ${existing.id}, status ${existing.status})`
		);
		current = existing;
	}

	// Wait for status=active AND public IPv4 assigned.
	const provisionStart = now();
	let ipv4 = publicIpv4(current);
	while (current.status !== 'active' || ipv4 === undefined) {
		if (now() - provisionStart > provisionTimeout) {
			throw new Error(
				`[deploy/digitalocean] provision timeout after ${provisionTimeout}ms — droplet ${current.id} status "${current.status}", ipv4 ${ipv4 ?? '(unassigned)'}`
			);
		}
		await sleep(pollMs);
		const refreshed: { droplet: DigitalOceanDroplet } = await client.request(
			'GET',
			`/droplets/${current.id}`
		);
		current = refreshed.droplet;
		ipv4 = publicIpv4(current);
		log(`[do] poll: status=${current.status} ipv4=${ipv4 ?? '(none yet)'}`);
	}
	log(`[do] droplet active at ${ipv4}`);

	// Wait for SSH readiness.
	const sshStart = now();
	while (!(await probeSsh(ipv4, port))) {
		if (now() - sshStart > sshTimeout) {
			throw new Error(
				`[deploy/digitalocean] SSH readiness timeout after ${sshTimeout}ms — ${ipv4}:${port} did not accept connections`
			);
		}
		await sleep(pollMs);
		log(`[do] waiting on ssh ${ipv4}:${port}`);
	}
	log(`[do] ssh ready at ${ipv4}:${port}`);

	const ssh = sshTarget({
		host: ipv4,
		...(options.user !== undefined ? { user: options.user } : {}),
		...(options.identity !== undefined ? { identity: options.identity } : {}),
		...(options.port !== undefined ? { port: options.port } : {})
	});

	const dropletId = current.id;
	const resolvedIpv4 = ipv4;

	return {
		description: `digitalocean droplet "${options.name}" (${ssh.description})`,
		dropletId,
		ipv4: resolvedIpv4,
		destroy: () =>
			destroyDigitalOceanDroplet({ client, id: dropletId }).then(() => {
				log(`[do] destroyed droplet ${dropletId}`);
			}),
		exec: ssh.exec,
		upload: ssh.upload,
		...(ssh.close !== undefined ? { close: ssh.close } : {})
	};
};
