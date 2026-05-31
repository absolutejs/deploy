/**
 * Preview-deploys fleet for `@absolutejs/deploy`.
 *
 * A `PreviewFleet` is a tenant-aware orchestrator that creates,
 * lists, and tears down ephemeral environments — one per PR /
 * branch / commit. It composes the existing `Deployer` (release
 * dirs + atomic symlink swap + rollback) with a `DnsProvider` and a
 * persistent registry so a deploy bot can:
 *
 *   const url = await fleet.create({ previewId: 'pr-42', ... });
 *
 *   await fleet.teardown('pr-42');
 *
 *   await fleet.gc({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
 *
 * Substrate responsibilities:
 *
 *   - allocate a free port from a configurable pool
 *   - build the hostname `<previewId>.<baseDomain>`
 *   - upsert an A record for that hostname (DNS provider injected)
 *   - call a caller-supplied `makeDeployer({ previewId, port,
 *     hostname })` factory, then run `deployer.deploy()` so the
 *     preview lands as a normal release on disk
 *   - persist the preview registry so we can list / GC later
 *   - on teardown, run a caller-supplied stop callback, remove the
 *     DNS record, drop the registry entry
 *
 * Everything tenant-specific (secrets snapshotting, db seeding,
 * stopping the process) is a caller-supplied hook. The fleet owns
 * fleet bookkeeping, not application logic.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
	Deployer,
	DeployResult,
	ReleaseAnnotations
} from './deployer';
import type { DnsProvider, DnsRecord, DnsRecordSpec } from './dns';

// =============================================================================
// Registry shape
// =============================================================================

export type PreviewRecord = {
	previewId: string;
	hostname: string;
	url: string;
	port: number;
	dnsRecordId?: string;
	releaseId: string;
	commitSha?: string;
	createdAt: number;
	annotations?: ReleaseAnnotations;
};

export type PreviewStore = {
	list: () => Promise<PreviewRecord[]>;
	get: (previewId: string) => Promise<PreviewRecord | null>;
	put: (record: PreviewRecord) => Promise<void>;
	remove: (previewId: string) => Promise<void>;
};

// =============================================================================
// Hooks + options
// =============================================================================

export type PreviewDeployerContext = {
	previewId: string;
	port: number;
	hostname: string;
	url: string;
};

export type PreviewFleetOptions = {
	/**
	 * Apex used to build preview hostnames: `<previewId>.<baseDomain>`.
	 * `previewId` is slugified before use (alphanumeric + `-`).
	 */
	baseDomain: string;
	/**
	 * Optional URL scheme. Defaults to `'https'`. Set `'http'` for
	 * local-loop previews behind a localhost proxy.
	 */
	scheme?: 'http' | 'https';
	/**
	 * DNS provider — `cloudflareProvider`, `route53Provider`, etc.
	 * Optional: when absent, `fleet.create` skips DNS work and the
	 * caller is responsible for routing requests at the hostname.
	 */
	dns?: DnsProvider;
	/**
	 * Public IPv4 the A record should point at. Required when `dns`
	 * is set. The fleet calls `dns.upsert({ name, type: 'A',
	 * content: ipv4 })`.
	 */
	ipv4?: string;
	/**
	 * TTL applied to created A records. Default 60s — previews come
	 * and go and we want low cache lifetime.
	 */
	dnsTtl?: number;
	/**
	 * Proxied flag (Cloudflare orange-cloud). Default `false` — most
	 * previews want a real IP, not a Cloudflare proxy.
	 */
	dnsProxied?: boolean;
	/**
	 * Port range that the fleet allocates from. Default `[3100, 3899]`
	 * (3000 squat is documented in memory).
	 */
	portRange?: { start: number; end: number };
	/** Override port allocation entirely (e.g. talk to a port-leaser). */
	allocatePort?: (record: {
		previewId: string;
		hostname: string;
	}) => Promise<number>;
	/**
	 * REQUIRED. Build a `Deployer` for an individual preview. The
	 * factory receives the resolved id, port, hostname, and URL —
	 * use them to set the right env, processManager, and target.
	 */
	makeDeployer: (
		ctx: PreviewDeployerContext
	) => Deployer | Promise<Deployer>;
	/**
	 * Stop callback. Called by `teardown` BEFORE DNS removal so the
	 * preview process stops accepting connections before the record
	 * disappears. Use it to call `processManager.stop()`, kill the
	 * port, etc.
	 */
	stop?: (record: PreviewRecord) => Promise<void> | void;
	/**
	 * After-teardown callback. Called after DNS + registry removal —
	 * good place to delete the release directory, drop a tenant
	 * schema, clear secrets, etc.
	 */
	afterTeardown?: (record: PreviewRecord) => Promise<void> | void;
	/** Registry. Default = filesystem store at `<root>`. */
	store?: PreviewStore;
	/** Directory the file-based default store writes into. */
	registryRoot?: string;
	/** Override `Date.now()` for tests. */
	clock?: () => number;
};

// =============================================================================
// File-based PreviewStore (default)
// =============================================================================

/**
 * Single-file JSON registry. Reads + writes atomically (temp-file
 * + rename). Adequate for a deploy bot on one host — swap in a
 * Postgres-backed store for distributed deploy bots.
 */
export const createFilePreviewStore = (root: string): PreviewStore => {
	const path = join(root, 'previews.json');

	const readAll = (): PreviewRecord[] => {
		if (!existsSync(path)) return [];
		try {
			const raw = readFileSync(path, 'utf8');
			if (raw.trim() === '') return [];
			const parsed = JSON.parse(raw) as { previews?: PreviewRecord[] };
			return Array.isArray(parsed.previews) ? parsed.previews : [];
		} catch {
			return [];
		}
	};

	const writeAll = (records: PreviewRecord[]): void => {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify({ previews: records }, null, 2));
		renameSync(tmp, path);
	};

	return {
		get: async (previewId) =>
			readAll().find((r) => r.previewId === previewId) ?? null,
		list: async () => readAll(),
		put: async (record) => {
			const records = readAll().filter(
				(r) => r.previewId !== record.previewId
			);
			records.push(record);
			writeAll(records);
		},
		remove: async (previewId) => {
			const records = readAll().filter((r) => r.previewId !== previewId);
			writeAll(records);
		}
	};
};

// =============================================================================
// In-memory store (for tests + ephemeral fleets)
// =============================================================================

export const createMemoryPreviewStore = (): PreviewStore => {
	const map = new Map<string, PreviewRecord>();
	return {
		get: async (previewId) => map.get(previewId) ?? null,
		list: async () => Array.from(map.values()),
		put: async (record) => {
			map.set(record.previewId, record);
		},
		remove: async (previewId) => {
			map.delete(previewId);
		}
	};
};

// =============================================================================
// Helpers
// =============================================================================

const slugify = (id: string): string =>
	id
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 50);

const defaultAllocatePort = (
	used: Set<number>,
	range: { start: number; end: number }
): number => {
	for (let port = range.start; port <= range.end; port += 1) {
		if (!used.has(port)) return port;
	}
	throw new Error(
		`preview-fleet: no free ports in [${range.start}, ${range.end}] (${used.size} in use)`
	);
};

// =============================================================================
// Fleet
// =============================================================================

export type CreatePreviewInput = {
	previewId: string;
	commitSha?: string;
	annotations?: ReleaseAnnotations;
	/**
	 * Override hostname. Default = `<slug(previewId)>.<baseDomain>`.
	 * Use this for previews with a vanity name that shouldn't echo
	 * the PR id directly.
	 */
	hostname?: string;
};

export type CreatePreviewResult = {
	record: PreviewRecord;
	deploy: DeployResult;
};

export type PreviewFleet = {
	/**
	 * Spin up a preview. Idempotent on `previewId` — if a record
	 * already exists, the fleet re-uses its port + DNS and runs a
	 * fresh `deployer.deploy()` (so PRs that push new commits roll
	 * forward).
	 */
	create: (input: CreatePreviewInput) => Promise<CreatePreviewResult>;
	/** Tear down a single preview (stop → DNS remove → registry remove → afterTeardown). */
	teardown: (previewId: string) => Promise<void>;
	/** List active previews. */
	list: () => Promise<PreviewRecord[]>;
	/** Get one preview by id. */
	get: (previewId: string) => Promise<PreviewRecord | null>;
	/**
	 * Tear down all previews older than `olderThanMs`. Returns the
	 * list of preview ids torn down. Failures on individual previews
	 * are swallowed and reported on `errors`.
	 */
	gc: (options: { olderThanMs: number }) => Promise<{
		removed: string[];
		errors: { previewId: string; error: Error }[];
	}>;
};

export const createPreviewFleet = (
	options: PreviewFleetOptions
): PreviewFleet => {
	const scheme = options.scheme ?? 'https';
	const portRange = options.portRange ?? { end: 3899, start: 3100 };
	const dnsTtl = options.dnsTtl ?? 60;
	const dnsProxied = options.dnsProxied ?? false;
	const clock = options.clock ?? Date.now;
	const store =
		options.store ??
		createFilePreviewStore(
			options.registryRoot ?? join(process.cwd(), '.preview-fleet')
		);

	if (options.dns !== undefined && options.ipv4 === undefined) {
		throw new Error(
			'preview-fleet: `ipv4` is required when `dns` is configured'
		);
	}

	const ensureDns = async (
		hostname: string
	): Promise<DnsRecord | undefined> => {
		if (options.dns === undefined) return undefined;
		const spec: DnsRecordSpec = {
			content: options.ipv4!,
			name: hostname,
			proxied: dnsProxied,
			ttl: dnsTtl,
			type: 'A'
		};
		return await options.dns.upsert(spec);
	};

	const removeDns = async (record: PreviewRecord): Promise<void> => {
		if (options.dns === undefined || record.dnsRecordId === undefined) {
			return;
		}
		try {
			await options.dns.delete(record.dnsRecordId);
		} catch {
			// Idempotent teardown — the record may already be gone. Don't
			// block the rest of teardown on a stale id.
		}
	};

	const buildHostname = (previewId: string, override?: string): string => {
		if (override !== undefined) return override;
		const slug = slugify(previewId);
		if (slug === '') {
			throw new Error(
				`preview-fleet: previewId ${JSON.stringify(previewId)} slugifies to empty`
			);
		}
		return `${slug}.${options.baseDomain}`;
	};

	const create = async (
		input: CreatePreviewInput
	): Promise<CreatePreviewResult> => {
		const existing = await store.get(input.previewId);
		const hostname = buildHostname(input.previewId, input.hostname);
		const url = `${scheme}://${hostname}`;

		// Allocate a port — reuse existing if we're re-deploying.
		let port: number;
		if (existing !== null) {
			port = existing.port;
		} else if (options.allocatePort !== undefined) {
			port = await options.allocatePort({ hostname, previewId: input.previewId });
		} else {
			const used = new Set(
				(await store.list()).map((record) => record.port)
			);
			port = defaultAllocatePort(used, portRange);
		}

		const deployer = await options.makeDeployer({
			hostname,
			port,
			previewId: input.previewId,
			url
		});

		const deployOptions =
			input.annotations !== undefined
				? { annotations: input.annotations }
				: input.commitSha !== undefined
					? { annotations: { commitSha: input.commitSha } }
					: undefined;
		const deployResult = await deployer.deploy(deployOptions);

		// DNS only after the deploy succeeded — no point flipping the
		// record at a half-baked release.
		const dnsRecord = await ensureDns(hostname);

		const record: PreviewRecord = {
			createdAt: existing?.createdAt ?? clock(),
			hostname,
			port,
			previewId: input.previewId,
			releaseId: deployResult.releaseId,
			url,
			...(dnsRecord !== undefined ? { dnsRecordId: dnsRecord.id } : {}),
			...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
			...(input.annotations !== undefined
				? { annotations: input.annotations }
				: {})
		};

		await store.put(record);
		return { deploy: deployResult, record };
	};

	const teardown = async (previewId: string): Promise<void> => {
		const record = await store.get(previewId);
		if (record === null) return;

		if (options.stop !== undefined) {
			try {
				await options.stop(record);
			} catch {
				// Don't block DNS removal on a stop failure. The caller
				// can see the error via afterTeardown by re-querying.
			}
		}

		await removeDns(record);
		await store.remove(previewId);

		if (options.afterTeardown !== undefined) {
			try {
				await options.afterTeardown(record);
			} catch {
				// Caller's own teardown errors are their problem; the
				// substrate has already removed the record + DNS.
			}
		}
	};

	const gc = async ({
		olderThanMs
	}: {
		olderThanMs: number;
	}): Promise<{
		removed: string[];
		errors: { previewId: string; error: Error }[];
	}> => {
		const cutoff = clock() - olderThanMs;
		const all = await store.list();
		const expired = all.filter((record) => record.createdAt < cutoff);
		const removed: string[] = [];
		const errors: { previewId: string; error: Error }[] = [];
		for (const record of expired) {
			try {
				await teardown(record.previewId);
				removed.push(record.previewId);
			} catch (e) {
				errors.push({
					error: e instanceof Error ? e : new Error(String(e)),
					previewId: record.previewId
				});
			}
		}
		return { errors, removed };
	};

	return {
		create,
		gc,
		get: (previewId) => store.get(previewId),
		list: () => store.list(),
		teardown
	};
};
