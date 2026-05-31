/**
 * @absolutejs/deploy/vultr — provision-or-reuse Target adapter for
 * Vultr instances. Sibling to digitalOceanTarget + hetznerTarget +
 * linodeTarget; same shape, Vultr v2 API mappings.
 *
 * Idempotent by label. Vultr stores the public IP as `main_ip`
 * (single string, not an array). SSH keys are pre-registered with
 * Vultr and referenced by UUID — different from Linode (raw keys)
 * and DO/Hetzner (fingerprints/ids/names).
 */

import type { Target } from './targets';
import { createCloudTarget, type CloudTargetHooks } from './cloudTarget';

const VULTR_API_BASE = 'https://api.vultr.com/v2';

export type VultrClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
		path: string,
		body?: unknown
	) => Promise<T>;
};

/** A Vultr instance, narrowed to what we inspect. */
export type VultrInstance = {
	id: string;
	label: string;
	status: 'active' | 'pending' | 'suspended' | 'resizing';
	power_status?: 'running' | 'stopped' | 'starting';
	server_status?: string;
	main_ip: string;
	internal_ip?: string;
	region?: string;
	plan?: string;
	tags?: string[];
};

export type VultrTargetOptions = {
	/** Vultr API key. Required unless `client` is set. */
	token?: string;
	client?: VultrClientLike;

	// ── Instance shape ──────────────────────────────────────────────
	/** Instance label. Idempotency key. */
	name: string;
	/** Region slug — `'ewr'`, `'lax'`, `'sgp'`, etc. */
	region: string;
	/** Plan slug — `'vc2-1c-1gb'`, `'vc2-2c-4gb'`, etc. */
	plan: string;
	/** OS id. Numeric — e.g. `1743` for Ubuntu 22.04. */
	osId: number;
	/**
	 * SSH key UUIDs already registered in your Vultr account
	 * (https://my.vultr.com/settings/#ssh-keys). Vultr does NOT accept
	 * raw key strings — you upload them once, then reference the UUIDs.
	 */
	sshKeys: ReadonlyArray<string>;
	/** Tags applied to the instance. */
	tags?: ReadonlyArray<string>;
	/** Cloud-init user data (will be base64-encoded by us). */
	userData?: string;
	/** Enable IPv6. Default false. */
	enableIpv6?: boolean;
	/** Enable backups. Default false. */
	backups?: boolean;
	/** Enable DDoS protection. Default false. */
	ddosProtection?: boolean;
	/** Hostname (Vultr distinguishes label from hostname). Default = name. */
	hostname?: string;

	// ── SSH wrap ────────────────────────────────────────────────────
	user?: string;
	identity?: string;
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

export type VultrTarget = Target & {
	readonly instanceId: string;
	readonly ipv4: string;
	destroy: () => Promise<void>;
};

export class VultrError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'VultrError';
		this.status = status;
		this.body = body;
	}
}

export const createVultrClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): VultrClientLike => {
	const base = options.baseUrl ?? VULTR_API_BASE;
	const f = options.fetch ?? fetch;
	return {
		request: async <T>(
			method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
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
				throw new VultrError(
					`Vultr API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

const resolveClient = (
	options: Pick<VultrTargetOptions, 'client' | 'token'>
): VultrClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createVultrClient(options.token);
	}
	throw new Error(
		'[deploy/vultr] either `token` or `client` must be provided'
	);
};

const publicIpv4 = (instance: VultrInstance): string | undefined => {
	if (instance.main_ip === '' || instance.main_ip === '0.0.0.0') {
		return undefined;
	}
	return instance.main_ip;
};

/** Find an instance by label. Throws on ambiguous duplicates. */
export const findVultrInstance = async (
	client: VultrClientLike,
	name: string
): Promise<VultrInstance | undefined> => {
	const body = await client.request<{ instances: VultrInstance[] }>(
		'GET',
		`/instances?label=${encodeURIComponent(name)}&per_page=500`
	);
	const matches = body.instances.filter((instance) => instance.label === name);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(
			`[deploy/vultr] multiple instances labeled "${name}" (${matches
				.map((instance) => instance.id)
				.join(', ')}). Resolve manually before adopting.`
		);
	}
	return matches[0];
};

export const listVultrInstances = async (options: {
	token?: string;
	client?: VultrClientLike;
	tag?: string;
}): Promise<VultrInstance[]> => {
	const client = resolveClient(options);
	const path =
		options.tag !== undefined
			? `/instances?tag=${encodeURIComponent(options.tag)}&per_page=500`
			: '/instances?per_page=500';
	const body = await client.request<{ instances: VultrInstance[] }>('GET', path);
	return body.instances;
};

export const destroyVultrInstance = async (options: {
	token?: string;
	client?: VultrClientLike;
	id: string;
}): Promise<void> => {
	const client = resolveClient(options);
	try {
		await client.request('DELETE', `/instances/${options.id}`);
	} catch (error) {
		if (error instanceof VultrError && error.status === 404) return;
		throw error;
	}
};

export const vultrTarget = async (
	options: VultrTargetOptions
): Promise<VultrTarget> => {
	const client = resolveClient(options);

	const hooks: CloudTargetHooks<VultrInstance, string> = {
		create: async () => {
			const created = await client.request<{ instance: VultrInstance }>(
				'POST',
				'/instances',
				{
					hostname: options.hostname ?? options.name,
					label: options.name,
					os_id: options.osId,
					plan: options.plan,
					region: options.region,
					sshkey_id: [...options.sshKeys],
					...(options.tags !== undefined ? { tags: [...options.tags] } : {}),
					...(options.userData !== undefined
						? { user_data: btoa(options.userData) }
						: {}),
					...(options.enableIpv6 === true ? { enable_ipv6: true } : {}),
					...(options.backups === true ? { backups: 'enabled' } : {}),
					...(options.ddosProtection === true ? { ddos_protection: true } : {})
				}
			);
			return created.instance;
		},
		destroy: (id) => destroyVultrInstance({ client, id }),
		fetch: async (id) => {
			const body = await client.request<{ instance: VultrInstance }>(
				'GET',
				`/instances/${id}`
			);
			return body.instance;
		},
		findByName: (name) => findVultrInstance(client, name),
		getId: (instance) => instance.id,
		getIpv4: publicIpv4,
		getStatus: (instance) =>
			instance.power_status ?? instance.server_status ?? instance.status,
		isReady: (instance) =>
			instance.status === 'active' &&
			(instance.power_status === 'running' || instance.power_status === undefined)
	};

	const result = await createCloudTarget<VultrInstance, string>(hooks, {
		describeTarget: (sshDescription) =>
			`vultr "${options.name}" (${sshDescription})`,
		entityWord: 'instance',
		logPrefix: '[vultr]',
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
