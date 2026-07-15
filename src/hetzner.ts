/**
 * @absolutejs/deploy/hetzner — provision-or-reuse Target adapter for
 * Hetzner Cloud servers. Sibling to {@link digitalOceanTarget}; same
 * shape, different API.
 *
 * What it does:
 *
 *   1. Looks up a server by `name`. If present and running, reuses it.
 *   2. If not present, creates it via the Hetzner Cloud v1 API and
 *      waits for `status === 'running'` with a public IPv4 assigned.
 *   3. Waits for SSH readiness (TCP connect on port 22 with backoff,
 *      or a caller-supplied probe).
 *   4. Returns a Target that wraps sshTarget against the server's
 *      public IPv4, plus `serverId`, `ipv4`, and a `destroy()` helper.
 *
 * Idempotent by name — Hetzner enforces unique server names per
 * project, so calling twice with the same name returns the same
 * server.
 *
 * Narrow HetznerClientLike interface keeps the official `hcloud-js`
 * SDK out as a hard dep. Default client uses `fetch` against
 * `api.hetzner.cloud/v1`; pass your own for retry / observability.
 */

import type { Target } from './targets';
import { createCloudTarget, type CloudTargetHooks } from './cloudTarget';

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

/**
 * Minimal subset of Hetzner Cloud API calls we make. Lets callers
 * BYO a client with retry / observability / etc.
 */
export type HetznerClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown
	) => Promise<T>;
};

/** A Hetzner Cloud server, narrowed to what we inspect. */
export type HetznerServer = {
	id: number;
	name: string;
	status:
		| 'initializing'
		| 'starting'
		| 'running'
		| 'stopping'
		| 'off'
		| 'deleting'
		| 'migrating'
		| 'rebuilding'
		| 'unknown';
	public_net: {
		ipv4: { id: number; ip: string; blocked: boolean; dns_ptr?: string } | null;
		ipv6: { id: number; ip: string; blocked: boolean } | null;
	};
	server_type?: { name: string };
	datacenter?: { location: { name: string } };
	labels?: Record<string, string>;
	private_net?: Array<{ ip: string; network: number }>;
};

export type HetznerTargetOptions = {
	/** API token (https://docs.hetzner.cloud/#authentication). Required unless `client` is set. */
	token?: string;
	/** Custom client. Overrides token-built default. */
	client?: HetznerClientLike;

	// ── Server shape ─────────────────────────────────────────────────
	/** Server name. Hetzner-unique per project; also our idempotency key. */
	name: string;
	/** Location slug — `'nbg1'`, `'fsn1'`, `'hel1'`, `'ash'`, `'hil'`. */
	location: string;
	/** Server type slug — `'cx22'`, `'cpx11'`, `'ccx13'`, etc. */
	serverType: string;
	/** Image slug or numeric id, e.g. `'ubuntu-22.04'`. */
	image: string | number;
	/** SSH key fingerprints, numeric ids, or names. At least one required. */
	sshKeys: ReadonlyArray<string | number>;
	/** Labels (Hetzner's key-value tags). */
	labels?: Record<string, string>;
	/** cloud-init user data — a shell script or YAML config. */
	userData?: string;
	/** Attach to a Cloud Network (by id). */
	networkId?: number;
	/** Disable IPv4 public addressing. Default: enabled. */
	disablePublicIpv4?: boolean;
	/** Disable IPv6 public addressing. Default: enabled. */
	disablePublicIpv6?: boolean;

	// ── SSH wrap ────────────────────────────────────────────────────
	/** SSH login user. Default `'root'`. */
	user?: string;
	/** Path to SSH identity file forwarded to sshTarget. */
	identity?: string;
	/** SSH port. Default 22. */
	port?: number;

	// ── Timing ──────────────────────────────────────────────────────
	/** Max time to wait for server `running` + IPv4. Default 5 min. */
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
	/** Sleep used between polls. Tests can pass a synchronous resolver. */
	sleep?: (ms: number) => Promise<void>;
	/** Wall clock. Defaults to `Date.now`. Tests can swap. */
	now?: () => number;
};

export type HetznerTarget = Target & {
	readonly serverId: number;
	readonly ipv4: string;
	/** Destroy the server via the Hetzner API. */
	destroy: () => Promise<void>;
};

export class HetznerError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'HetznerError';
		this.status = status;
		this.body = body;
	}
}

/**
 * fetch-backed default client. Talks JSON to `api.hetzner.cloud/v1`.
 * Throws HetznerError on non-2xx with the response body attached so
 * the caller can switch on `err.status`.
 */
export const createHetznerClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): HetznerClientLike => {
	const base = options.baseUrl ?? HETZNER_API_BASE;
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
				throw new HetznerError(
					`Hetzner Cloud API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

const resolveClient = (
	options: Pick<HetznerTargetOptions, 'client' | 'token'>
): HetznerClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createHetznerClient(options.token);
	}
	throw new Error(
		'[deploy/hetzner] either `token` or `client` must be provided'
	);
};

const publicIpv4 = (server: HetznerServer): string | undefined =>
	server.public_net.ipv4?.ip;

/**
 * Find a server by name. Returns undefined if absent. Hetzner
 * enforces unique server names per project, so duplicates aren't
 * possible — but if the API ever returns >1 we still surface that
 * loudly.
 */
export const findHetznerServer = async (
	client: HetznerClientLike,
	name: string
): Promise<HetznerServer | undefined> => {
	const body = await client.request<{ servers: HetznerServer[] }>(
		'GET',
		`/servers?name=${encodeURIComponent(name)}`
	);
	const matches = body.servers.filter((server) => server.name === name);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(
			`[deploy/hetzner] multiple servers named "${name}" (${matches
				.map((server) => server.id)
				.join(', ')}). Hetzner shouldn't allow this — resolve manually.`
		);
	}
	return matches[0];
};

/** List servers, optionally filtered by label selector. */
export const listHetznerServers = async (options: {
	token?: string;
	client?: HetznerClientLike;
	/** Label selector, e.g. `'env=prod'` or `'env in (prod,staging)'`. */
	labelSelector?: string;
}): Promise<HetznerServer[]> => {
	const client = resolveClient(options);
	const path =
		options.labelSelector !== undefined
			? `/servers?label_selector=${encodeURIComponent(options.labelSelector)}`
			: '/servers';
	const body = await client.request<{ servers: HetznerServer[] }>('GET', path);
	return body.servers;
};

/** Destroy a server by id. 404 treated as idempotent success. */
export const destroyHetznerServer = async (options: {
	token?: string;
	client?: HetznerClientLike;
	id: number;
}): Promise<void> => {
	const client = resolveClient(options);
	try {
		await client.request('DELETE', `/servers/${options.id}`);
	} catch (error) {
		if (error instanceof HetznerError && error.status === 404) {
			return; // already destroyed — idempotent
		}
		throw error;
	}
};

/**
 * Provision-or-reuse a Hetzner Cloud server by name, wait for SSH,
 * return a Target. Idempotent: same name → same server.
 */
export const hetznerTarget = async (
	options: HetznerTargetOptions
): Promise<HetznerTarget> => {
	const client = resolveClient(options);
	const publicIpv4Enabled = options.disablePublicIpv4 !== true;
	const publicIpv6Enabled = options.disablePublicIpv6 !== true;

	const hooks: CloudTargetHooks<HetznerServer> = {
		create: async () => {
			const created = await client.request<{ server: HetznerServer }>(
				'POST',
				'/servers',
				{
					name: options.name,
					location: options.location,
					server_type: options.serverType,
					image: options.image,
					ssh_keys: [...options.sshKeys],
					start_after_create: true,
					public_net: {
						enable_ipv4: publicIpv4Enabled,
						enable_ipv6: publicIpv6Enabled
					},
					...(options.labels !== undefined
						? { labels: options.labels }
						: {}),
					...(options.userData !== undefined
						? { user_data: options.userData }
						: {}),
					...(options.networkId !== undefined
						? { networks: [options.networkId] }
						: {})
				}
			);
			return created.server;
		},
		destroy: (id) => destroyHetznerServer({ client, id }),
		fetch: async (id) => {
			const refreshed: { server: HetznerServer } = await client.request(
				'GET',
				`/servers/${id}`
			);
			return refreshed.server;
		},
		findByName: (name) => findHetznerServer(client, name),
		getId: (server) => server.id,
		getIpv4: publicIpv4,
		getStatus: (server) => server.status,
		isReady: (server) => server.status === 'running'
	};

	const result = await createCloudTarget(hooks, {
		describeTarget: (sshDescription) =>
			`hetzner server "${options.name}" (${sshDescription})`,
		entityWord: 'server',
		logPrefix: '[hetzner]',
		name: options.name,
		region: options.location,
		...(options.user !== undefined ? { user: options.user } : {}),
		...(options.identity !== undefined ? { identity: options.identity } : {}),
		...(options.port !== undefined ? { port: options.port } : {}),
		...(options.provisionTimeoutMs !== undefined
			? { provisionTimeoutMs: options.provisionTimeoutMs }
			: {}),
		...(options.sshReadinessTimeoutMs !== undefined
			? { sshReadinessTimeoutMs: options.sshReadinessTimeoutMs }
			: {}),
		...(options.pollIntervalMs !== undefined
			? { pollIntervalMs: options.pollIntervalMs }
			: {}),
		...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
		...(options.probeSsh !== undefined ? { probeSsh: options.probeSsh } : {}),
		...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		...(options.now !== undefined ? { now: options.now } : {})
	});

	return {
		description: result.description,
		destroy: result.destroy,
		exec: result.exec,
		ipv4: result.ipv4,
		serverId: result.id,
		upload: result.upload,
		...(result.close !== undefined ? { close: result.close } : {})
	};
};
