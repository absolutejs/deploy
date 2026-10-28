/**
 * @absolutejs/deploy/linode — provision-or-reuse Target adapter for
 * Linode (Akamai Cloud) instances. Sibling to digitalOceanTarget +
 * hetznerTarget; same shape, Linode v4 API mappings.
 *
 * Idempotent by label — Linode allows duplicate labels per account
 * but we treat duplicates as drifted state (throw on the second).
 *
 * Narrow LinodeClientLike interface keeps `@linode/api-v4` out as a
 * hard dep. Default client uses `fetch` against `api.linode.com/v4`.
 */

import type { Target } from './targets';
import { createCloudTarget, type CloudTargetHooks } from './cloudTarget';

const LINODE_API_BASE = 'https://api.linode.com/v4';

export type LinodeClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown
	) => Promise<T>;
};

/** A Linode instance, narrowed to what we inspect. */
export type LinodeInstance = {
	id: number;
	label: string;
	status:
		| 'running'
		| 'offline'
		| 'booting'
		| 'rebooting'
		| 'shutting_down'
		| 'provisioning'
		| 'deleting'
		| 'migrating'
		| 'rebuilding'
		| 'cloning'
		| 'restoring'
		| 'stopped';
	/** Linode returns IPv4 as a flat string array; public IPs first. */
	ipv4: string[];
	region?: string;
	type?: string;
	tags?: string[];
};

export type LinodeTargetOptions = {
	/** Linode Personal Access Token. Required unless `client` is set. */
	token?: string;
	/** Custom client. Overrides token-built default. */
	client?: LinodeClientLike;

	// ── Instance shape ──────────────────────────────────────────────
	/** Instance label. Idempotency key. */
	name: string;
	/** Region slug — `'us-east'`, `'us-west'`, `'ap-south'`, etc. */
	region: string;
	/** Type slug — `'g6-nanode-1'`, `'g6-standard-1'`, etc. */
	type: string;
	/** Image slug — e.g. `'linode/ubuntu22.04'`. */
	image: string;
	/**
	 * SSH public keys (raw `ssh-rsa AAAA…` / `ssh-ed25519 AAAA…` strings)
	 * authorized for root login. At least one required for a usable target.
	 */
	sshKeys: ReadonlyArray<string>;
	/** Tags applied to the instance. */
	tags?: ReadonlyArray<string>;
	/** Cloud-init / StackScript user data, base64-encoded by us. */
	userData?: string;
	/**
	 * Root password. Linode requires a password at creation. Defaults to
	 * a random 32-char string — you should rely on `sshKeys` and never
	 * type this. Override only if you have a specific reason.
	 */
	rootPass?: string;
	/** Enable private IP. Default false. */
	privateIp?: boolean;
	/** Enable backups. Default false. */
	backupsEnabled?: boolean;

	// ── SSH wrap ────────────────────────────────────────────────────
	/** SSH login user. Default `'root'`. */
	user?: string;
	/** SSH identity file. */
	identity?: string;
	/** SSH port. Default 22. */
	port?: number;

	// ── Timing ──────────────────────────────────────────────────────
	provisionTimeoutMs?: number;
	sshReadinessTimeoutMs?: number;
	pollIntervalMs?: number;

	// ── Observability + injection ───────────────────────────────────
	onLog?: (line: string) => void;
	probeSsh?: (host: string, port: number) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

export type LinodeTarget = Target & {
	readonly instanceId: number;
	readonly ipv4: string;
	destroy: () => Promise<void>;
};

export class LinodeError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'LinodeError';
		this.status = status;
		this.body = body;
	}
}

export const createLinodeClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): LinodeClientLike => {
	const base = options.baseUrl ?? LINODE_API_BASE;
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
				throw new LinodeError(
					`Linode API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

const resolveClient = (
	options: Pick<LinodeTargetOptions, 'client' | 'token'>
): LinodeClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createLinodeClient(options.token);
	}
	throw new Error(
		'[deploy/linode] either `token` or `client` must be provided'
	);
};

const publicIpv4 = (instance: LinodeInstance): string | undefined => {
	// Linode's first IPv4 entry is the primary public address.
	for (const ip of instance.ipv4) {
		// Skip private RFC1918 + link-local. Crude but good enough.
		if (
			!ip.startsWith('10.') &&
			!ip.startsWith('192.168.') &&
			!ip.startsWith('172.') &&
			!ip.startsWith('169.254.')
		) {
			return ip;
		}
	}
	return undefined;
};

const randomPassword = (length: number): string => {
	const chars =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const byte of bytes) out += chars[byte % chars.length];
	return out;
};

/** Find an instance by label. Throws on ambiguous duplicates. */
export const findLinodeInstance = async (
	client: LinodeClientLike,
	name: string
): Promise<LinodeInstance | undefined> => {
	const body = await client.request<{ data: LinodeInstance[] }>(
		'GET',
		'/linode/instances?page_size=500'
	);
	const matches = body.data.filter((instance) => instance.label === name);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(
			`[deploy/linode] multiple instances labeled "${name}" (${matches
				.map((instance) => instance.id)
				.join(', ')}). Resolve manually before adopting.`
		);
	}
	return matches[0];
};

export const listLinodeInstances = async (options: {
	token?: string;
	client?: LinodeClientLike;
	tag?: string;
}): Promise<LinodeInstance[]> => {
	const client = resolveClient(options);
	const path =
		options.tag !== undefined
			? `/linode/instances?tag=${encodeURIComponent(options.tag)}&page_size=500`
			: '/linode/instances?page_size=500';
	const body = await client.request<{ data: LinodeInstance[] }>('GET', path);
	return body.data;
};

export const destroyLinodeInstance = async (options: {
	token?: string;
	client?: LinodeClientLike;
	id: number;
}): Promise<void> => {
	const client = resolveClient(options);
	try {
		await client.request('DELETE', `/linode/instances/${options.id}`);
	} catch (error) {
		if (error instanceof LinodeError && error.status === 404) return;
		throw error;
	}
};

export const linodeTarget = async (
	options: LinodeTargetOptions
): Promise<LinodeTarget> => {
	const client = resolveClient(options);
	const rootPass = options.rootPass ?? randomPassword(32);

	const hooks: CloudTargetHooks<LinodeInstance> = {
		create: async () => {
			const created = await client.request<LinodeInstance>(
				'POST',
				'/linode/instances',
				{
					authorized_keys: [...options.sshKeys],
					image: options.image,
					label: options.name,
					region: options.region,
					root_pass: rootPass,
					type: options.type,
					...(options.tags !== undefined ? { tags: [...options.tags] } : {}),
					...(options.userData !== undefined
						? { stackscript_data: { user_data: options.userData } }
						: {}),
					...(options.privateIp === true ? { private_ip: true } : {}),
					...(options.backupsEnabled === true ? { backups_enabled: true } : {})
				}
			);
			return created;
		},
		destroy: (id) => destroyLinodeInstance({ client, id }),
		fetch: (id) => client.request<LinodeInstance>('GET', `/linode/instances/${id}`),
		findByName: (name) => findLinodeInstance(client, name),
		getId: (instance) => instance.id,
		getIpv4: publicIpv4,
		getStatus: (instance) => instance.status,
		isReady: (instance) => instance.status === 'running'
	};

	const result = await createCloudTarget(hooks, {
		describeTarget: (sshDescription) =>
			`linode "${options.name}" (${sshDescription})`,
		entityWord: 'instance',
		logPrefix: '[linode]',
		name: options.name,
		region: options.region,
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
		instanceId: result.id,
		ipv4: result.ipv4,
		upload: result.upload,
		...(result.close !== undefined ? { close: result.close } : {})
	};
};
