/**
 * Shared "cloud-provider Target" plumbing used by the
 * provider-specific adapters (`./digitalocean`, `./hetzner`, future
 * `./linode`, `./vultr`, etc.).
 *
 * The provider supplies a small `CloudTargetHooks` bag that knows
 * the provider's:
 *
 *   - find-by-name lookup
 *   - create call (closure over create params)
 *   - fetch-by-id (used to poll for `active`)
 *   - destroy-by-id
 *   - status + ipv4 + id extraction from the provider's Server shape
 *   - readiness predicate (status reached the terminal "running" value)
 *
 * `createCloudTarget()` does the universal machinery: provision-or-
 * reuse, poll until ready + IPv4, wait for SSH probe, build
 * `sshTarget` against the IPv4, return the Target wrapped with
 * `{ id, ipv4, destroy() }`.
 *
 * The public adapter (e.g. `digitalOceanTarget`) is a 30-line facade
 * that wires its provider-specific bits and renames `id` → `dropletId`
 * on the way out.
 */

import type { Target } from './targets';
import { sshTarget } from './targets';

/** Provider-specific hooks. Keep these pure of network IO timing — the helper schedules. */
export type CloudTargetHooks<Server> = {
	/** Find a server by name. Returns undefined if absent. */
	findByName: (name: string) => Promise<Server | undefined>;
	/** Create the server. Closure over provider-specific create params. */
	create: () => Promise<Server>;
	/** Fetch a fresh copy of the server by id. Used to poll. */
	fetch: (id: number) => Promise<Server>;
	/** Destroy a server by id. 404 should be treated as idempotent success. */
	destroy: (id: number) => Promise<void>;
	/** True when the server has reached its terminal "running" status. */
	isReady: (server: Server) => boolean;
	/** Extract the numeric id. */
	getId: (server: Server) => number;
	/** Extract the public IPv4. Returns undefined while one is being assigned. */
	getIpv4: (server: Server) => string | undefined;
	/** Extract the current status as a string (for log lines). */
	getStatus: (server: Server) => string;
};

export type CloudTargetOptions = {
	/** Provider's idempotency key (server name). */
	name: string;
	/** Region / location label — used in the "creating" log line. */
	region: string;

	/** SSH login user. Default `'root'`. */
	user?: string;
	/** SSH identity file. */
	identity?: string;
	/** SSH port. Default 22. */
	port?: number;

	/** Default 5 min. */
	provisionTimeoutMs?: number;
	/** Default 2 min. */
	sshReadinessTimeoutMs?: number;
	/** Default 5 s. */
	pollIntervalMs?: number;

	/** Called with status updates. */
	onLog?: (line: string) => void;
	/** Override SSH probe — tests skip real TCP IO. */
	probeSsh?: (host: string, port: number) => Promise<boolean>;
	/** Override sleep — tests skip real waits. */
	sleep?: (ms: number) => Promise<void>;
	/** Override clock — tests inject deterministic timestamps. */
	now?: () => number;

	/**
	 * Short log prefix, e.g. `'[do]'` or `'[hetzner]'`. Threaded through
	 * every log line so multi-provider deploys distinguish output.
	 */
	logPrefix: string;
	/**
	 * Provider's word for the entity in log copy — `'droplet'` for DO,
	 * `'server'` for Hetzner. Preserves provider-accurate output.
	 */
	entityWord: string;
	/**
	 * Build the Target's `description` field. Receives the resolved
	 * IPv4 + the wrapped sshTarget description.
	 */
	describeTarget: (sshDescription: string) => string;
};

export type CloudTargetResult = {
	id: number;
	ipv4: string;
	description: string;
	exec: Target['exec'];
	upload: Target['upload'];
	close?: Target['close'];
	destroy: () => Promise<void>;
};

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
 * The shared provision-or-reuse + wait-for-ready + wait-for-SSH
 * pipeline. Provider-specific adapters wire their `CloudTargetHooks`
 * + their option-shape mapping and return a typed result.
 */
export const createCloudTarget = async <Server>(
	hooks: CloudTargetHooks<Server>,
	options: CloudTargetOptions
): Promise<CloudTargetResult> => {
	const log = options.onLog ?? (() => {});
	const probeSsh = options.probeSsh ?? defaultProbeSsh;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const pollMs = options.pollIntervalMs ?? 5_000;
	const provisionTimeout = options.provisionTimeoutMs ?? 5 * 60_000;
	const sshTimeout = options.sshReadinessTimeoutMs ?? 2 * 60_000;
	const port = options.port ?? 22;
	const prefix = options.logPrefix;
	const noun = options.entityWord;

	const existing = await hooks.findByName(options.name);
	let current: Server;
	if (existing === undefined) {
		log(`${prefix} creating ${noun} "${options.name}" in ${options.region}`);
		current = await hooks.create();
	} else {
		log(
			`${prefix} reusing ${noun} "${options.name}" (id ${hooks.getId(existing)}, status ${hooks.getStatus(existing)})`
		);
		current = existing;
	}

	// Wait for status=ready AND public IPv4 assigned.
	const provisionStart = now();
	let ipv4 = hooks.getIpv4(current);
	while (!hooks.isReady(current) || ipv4 === undefined) {
		if (now() - provisionStart > provisionTimeout) {
			throw new Error(
				`${prefix} provision timeout after ${provisionTimeout}ms — ${noun} ${hooks.getId(current)} status "${hooks.getStatus(current)}", ipv4 ${ipv4 ?? '(unassigned)'}`
			);
		}
		await sleep(pollMs);
		current = await hooks.fetch(hooks.getId(current));
		ipv4 = hooks.getIpv4(current);
		log(
			`${prefix} poll: status=${hooks.getStatus(current)} ipv4=${ipv4 ?? '(none yet)'}`
		);
	}
	log(`${prefix} ${noun} ready at ${ipv4}`);

	// Wait for SSH readiness.
	const sshStart = now();
	while (!(await probeSsh(ipv4, port))) {
		if (now() - sshStart > sshTimeout) {
			throw new Error(
				`${prefix} SSH readiness timeout after ${sshTimeout}ms — ${ipv4}:${port} did not accept connections`
			);
		}
		await sleep(pollMs);
		log(`${prefix} waiting on ssh ${ipv4}:${port}`);
	}
	log(`${prefix} ssh ready at ${ipv4}:${port}`);

	const ssh = sshTarget({
		host: ipv4,
		...(options.user !== undefined ? { user: options.user } : {}),
		...(options.identity !== undefined ? { identity: options.identity } : {}),
		...(options.port !== undefined ? { port: options.port } : {})
	});

	const id = hooks.getId(current);
	const resolvedIpv4 = ipv4;

	return {
		description: options.describeTarget(ssh.description),
		destroy: () =>
			hooks.destroy(id).then(() => {
				log(`${prefix} destroyed ${noun} ${id}`);
			}),
		exec: ssh.exec,
		id,
		ipv4: resolvedIpv4,
		upload: ssh.upload,
		...(ssh.close !== undefined ? { close: ssh.close } : {})
	};
};
