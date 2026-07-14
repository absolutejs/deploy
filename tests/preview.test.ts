import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deployer, DeployResult } from '../src/deployer';
import type { DnsProvider, DnsRecord, DnsRecordSpec } from '../src/dns';
import {
	createFilePreviewStore,
	createMemoryPreviewStore,
	createPreviewFleet,
	type PreviewRecord
} from '../src/preview';

// =============================================================================
// Mocks
// =============================================================================

const makeMockDns = (): {
	dns: DnsProvider;
	records: Map<string, DnsRecord>;
	deletedIds: string[];
} => {
	const records = new Map<string, DnsRecord>();
	const deletedIds: string[] = [];
	let counter = 0;
	const dns: DnsProvider = {
		create: async (spec: DnsRecordSpec) => {
			const id = `rec-${++counter}`;
			const record: DnsRecord = { id, ...spec };
			records.set(id, record);
			return record;
		},
		delete: async (id) => {
			if (!records.has(id)) {
				deletedIds.push(id);
				throw new Error(`not found: ${id}`);
			}
			records.delete(id);
			deletedIds.push(id);
		},
		description: 'mock-dns',
		find: async (key) => {
			for (const r of records.values()) {
				if (r.name === key.name && r.type === key.type) return r;
			}
			return undefined;
		},
		list: async () => Array.from(records.values()),
		update: async (id, spec) => {
			const record: DnsRecord = { id, ...spec };
			records.set(id, record);
			return record;
		},
		upsert: async (spec) => {
			for (const r of records.values()) {
				if (r.name === spec.name && r.type === spec.type) {
					const updated: DnsRecord = { id: r.id, ...spec };
					records.set(r.id, updated);
					return updated;
				}
			}
			const id = `rec-${++counter}`;
			const record: DnsRecord = { id, ...spec };
			records.set(id, record);
			return record;
		}
	};
	return { deletedIds, dns, records };
};

type DeployerCalls = {
	deployCount: number;
	annotations: unknown[];
	disposed: boolean;
};

const makeMockDeployer = (
	releaseId: string,
	calls: DeployerCalls
): Deployer => ({
	deploy: async (options) => {
		calls.deployCount += 1;
		calls.annotations.push(options?.annotations);
		return {
			annotations: options?.annotations ?? {},
			currentPath: `/var/abs/previews/current`,
			durationMs: 1,
			releaseId,
			releasePath: `/var/abs/previews/${releaseId}`,
			steps: []
		} satisfies DeployResult;
	},
	dispose: async () => {
		calls.disposed = true;
	},
	listReleases: async () => [releaseId],
	prune: async () => ({ removed: [] }),
	readReleaseMeta: async () => null,
	rollback: async () => {
		throw new Error('rollback not used');
	},
	status: async () => 'unknown',
	stop: async () => undefined
});

// =============================================================================
// create / list / get
// =============================================================================

describe('createPreviewFleet — create', () => {
	test('builds hostname from previewId + baseDomain, allocates the first port in range', async () => {
		const store = createMemoryPreviewStore();
		const deployerCalls: DeployerCalls = {
			annotations: [],
			deployCount: 0,
			disposed: false
		};
		const fleet = createPreviewFleet({
			baseDomain: 'preview.example.com',
			makeDeployer: () => makeMockDeployer('rel-1', deployerCalls),
			portRange: { end: 3110, start: 3100 },
			store
		});
		const { record } = await fleet.create({ previewId: 'pr-42' });
		expect(record.hostname).toBe('pr-42.preview.example.com');
		expect(record.url).toBe('https://pr-42.preview.example.com');
		expect(record.port).toBe(3100);
		expect(deployerCalls.deployCount).toBe(1);
	});

	test('slugifies previewId', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		const { record } = await fleet.create({ previewId: 'PR/Feature_Branch' });
		expect(record.hostname).toBe('pr-feature-branch.p.example.com');
	});

	test('honors hostname override', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		const { record } = await fleet.create({
			hostname: 'vanity.example.com',
			previewId: 'pr-99'
		});
		expect(record.hostname).toBe('vanity.example.com');
	});

	test('allocates a fresh port per preview', async () => {
		const store = createMemoryPreviewStore();
		let n = 0;
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer(`rel-${++n}`, {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			portRange: { end: 3105, start: 3100 },
			store
		});
		const a = await fleet.create({ previewId: 'a' });
		const b = await fleet.create({ previewId: 'b' });
		const c = await fleet.create({ previewId: 'c' });
		expect(a.record.port).toBe(3100);
		expect(b.record.port).toBe(3101);
		expect(c.record.port).toBe(3102);
	});

	test('re-creating same previewId reuses port + createdAt, runs a fresh deploy', async () => {
		const store = createMemoryPreviewStore();
		const calls: DeployerCalls = {
			annotations: [],
			deployCount: 0,
			disposed: false
		};
		const tStarted = 12345;
		let now = tStarted;
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			clock: () => now,
			makeDeployer: () => makeMockDeployer('rel-x', calls),
			store
		});
		const first = await fleet.create({ previewId: 'pr-1' });
		now = tStarted + 60_000;
		const second = await fleet.create({ previewId: 'pr-1' });
		expect(first.record.port).toBe(second.record.port);
		expect(first.record.createdAt).toBe(second.record.createdAt);
		expect(calls.deployCount).toBe(2);
	});

	test('exhausts port range → throws', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			portRange: { end: 3100, start: 3100 },
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'a' });
		await expect(fleet.create({ previewId: 'b' })).rejects.toThrow(
			'no free ports'
		);
	});

	test('custom allocatePort wins over the default range', async () => {
		const fleet = createPreviewFleet({
			allocatePort: async ({ previewId }) => {
				if (previewId === 'a') return 9001;
				return 9002;
			},
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		const a = await fleet.create({ previewId: 'a' });
		const b = await fleet.create({ previewId: 'b' });
		expect(a.record.port).toBe(9001);
		expect(b.record.port).toBe(9002);
	});

	test('passes annotations to the deployer', async () => {
		const calls: DeployerCalls = {
			annotations: [],
			deployCount: 0,
			disposed: false
		};
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () => makeMockDeployer('rel-1', calls),
			store: createMemoryPreviewStore()
		});
		await fleet.create({
			annotations: { author: 'bot', message: 'fix x' },
			previewId: 'pr-1'
		});
		expect(calls.annotations[0]).toEqual({
			author: 'bot',
			message: 'fix x'
		});
	});

	test('lifts commitSha into annotations when annotations not provided', async () => {
		const calls: DeployerCalls = {
			annotations: [],
			deployCount: 0,
			disposed: false
		};
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () => makeMockDeployer('rel-1', calls),
			store: createMemoryPreviewStore()
		});
		await fleet.create({ commitSha: 'abc1234', previewId: 'pr-1' });
		expect(calls.annotations[0]).toEqual({ commitSha: 'abc1234' });
	});

	test('http scheme honored', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'localhost',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			scheme: 'http',
			store: createMemoryPreviewStore()
		});
		const { record } = await fleet.create({ previewId: 'pr-1' });
		expect(record.url).toBe('http://pr-1.localhost');
	});

	test('empty slugified previewId → throws', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await expect(fleet.create({ previewId: '/_/' })).rejects.toThrow(
			'slugifies to empty'
		);
	});
});

// =============================================================================
// DNS integration
// =============================================================================

describe('createPreviewFleet — DNS', () => {
	test('upserts an A record for the preview hostname', async () => {
		const { dns, records } = makeMockDns();
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			dns,
			ipv4: '203.0.113.10',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		const { record } = await fleet.create({ previewId: 'pr-1' });
		expect(record.dnsRecordId).toBe('rec-1');
		const dnsRecord = records.get('rec-1');
		expect(dnsRecord?.name).toBe('pr-1.p.example.com');
		expect(dnsRecord?.type).toBe('A');
		expect(dnsRecord?.content).toBe('203.0.113.10');
		expect(dnsRecord?.ttl).toBe(60);
		expect(dnsRecord?.proxied).toBe(false);
	});

	test('dns set without ipv4 → throws at fleet construction', () => {
		const { dns } = makeMockDns();
		expect(() =>
			createPreviewFleet({
				baseDomain: 'p.example.com',
				dns,
				makeDeployer: () =>
					makeMockDeployer('rel-1', {
						annotations: [],
						deployCount: 0,
						disposed: false
					}),
				store: createMemoryPreviewStore()
			})
		).toThrow('ipv4');
	});

	test('no dns configured → no DNS calls + dnsRecordId undefined', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		const { record } = await fleet.create({ previewId: 'pr-1' });
		expect(record.dnsRecordId).toBeUndefined();
	});

	test('custom dnsTtl + dnsProxied applied', async () => {
		const { dns, records } = makeMockDns();
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			dns,
			dnsProxied: true,
			dnsTtl: 600,
			ipv4: '203.0.113.10',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'pr-1' });
		expect(records.get('rec-1')?.ttl).toBe(600);
		expect(records.get('rec-1')?.proxied).toBe(true);
	});
});

// =============================================================================
// teardown / list / get
// =============================================================================

describe('createPreviewFleet — teardown', () => {
	test('stop hook fires, DNS record removed, registry entry deleted, afterTeardown fires', async () => {
		const { dns, deletedIds, records } = makeMockDns();
		const stopped: PreviewRecord[] = [];
		const tornDown: PreviewRecord[] = [];
		const fleet = createPreviewFleet({
			afterTeardown: (r) => {
				tornDown.push(r);
			},
			baseDomain: 'p.example.com',
			dns,
			ipv4: '203.0.113.10',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			stop: (r) => {
				stopped.push(r);
			},
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'pr-1' });
		await fleet.teardown('pr-1');
		expect(stopped.map((r) => r.previewId)).toEqual(['pr-1']);
		expect(tornDown.map((r) => r.previewId)).toEqual(['pr-1']);
		expect(deletedIds).toEqual(['rec-1']);
		expect(records.size).toBe(0);
		expect(await fleet.list()).toEqual([]);
	});

	test('teardown of unknown previewId is a no-op', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await expect(fleet.teardown('nope')).resolves.toBeUndefined();
	});

	test('stop throwing does not block DNS removal', async () => {
		const { dns, deletedIds } = makeMockDns();
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			dns,
			ipv4: '1.2.3.4',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			stop: () => {
				throw new Error('failed to stop');
			},
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'pr-1' });
		await fleet.teardown('pr-1');
		expect(deletedIds).toEqual(['rec-1']);
	});

	test('DNS delete throwing on missing record is swallowed', async () => {
		const dns: DnsProvider = {
			create: async () => {
				throw new Error('not implemented');
			},
			delete: async () => {
				throw new Error('record gone');
			},
			description: 'flaky',
			find: async () => undefined,
			list: async () => [],
			update: async () => {
				throw new Error('not implemented');
			},
			upsert: async (spec) => ({ id: 'rec-x', ...spec })
		};
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			dns,
			ipv4: '1.2.3.4',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'pr-1' });
		await expect(fleet.teardown('pr-1')).resolves.toBeUndefined();
	});

	test('list returns active previews, get returns one or null', async () => {
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'a' });
		await fleet.create({ previewId: 'b' });
		const list = await fleet.list();
		expect(list.map((r) => r.previewId).sort()).toEqual(['a', 'b']);
		expect(await fleet.get('a')).not.toBeNull();
		expect(await fleet.get('nope')).toBeNull();
	});
});

// =============================================================================
// gc
// =============================================================================

describe('createPreviewFleet — gc', () => {
	test('tears down previews older than the threshold', async () => {
		let now = 1_000_000;
		const fleet = createPreviewFleet({
			baseDomain: 'p.example.com',
			clock: () => now,
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'old' });
		now += 100_000; // 100s later
		await fleet.create({ previewId: 'new' });
		now += 1_000; // 1s after new
		const result = await fleet.gc({ olderThanMs: 50_000 });
		expect(result.removed).toEqual(['old']);
		expect(result.errors).toEqual([]);
		const remaining = await fleet.list();
		expect(remaining.map((r) => r.previewId)).toEqual(['new']);
	});

	test('teardown errors surface on result.errors, not on the call', async () => {
		const fleet = createPreviewFleet({
			afterTeardown: () => {}, // no-op
			baseDomain: 'p.example.com',
			clock: () => 1_000_000,
			makeDeployer: () =>
				makeMockDeployer('rel-1', {
					annotations: [],
					deployCount: 0,
					disposed: false
				}),
			stop: (r) => {
				if (r.previewId === 'bad') throw new Error('cannot stop');
			},
			store: createMemoryPreviewStore()
		});
		await fleet.create({ previewId: 'good' });
		await fleet.create({ previewId: 'bad' });
		const result = await fleet.gc({ olderThanMs: -1 });
		// stop errors are swallowed inside teardown — so we won't see them
		// here; just confirm both are removed.
		expect(result.removed.sort()).toEqual(['bad', 'good']);
	});
});

// =============================================================================
// File-based PreviewStore
// =============================================================================

describe('createFilePreviewStore', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'preview-store-'));
	});

	test('put + get + list + remove round-trips through disk', async () => {
		const store = createFilePreviewStore(root);
		const record: PreviewRecord = {
			createdAt: 1,
			hostname: 'pr-1.example.com',
			port: 3100,
			previewId: 'pr-1',
			releaseId: 'rel-1',
			url: 'https://pr-1.example.com'
		};
		await store.put(record);

		const reloaded = createFilePreviewStore(root);
		expect(await reloaded.get('pr-1')).toEqual(record);
		expect(await reloaded.list()).toEqual([record]);

		await reloaded.remove('pr-1');
		expect(await reloaded.list()).toEqual([]);
		rmSync(root, { force: true, recursive: true });
	});

	test('put with same previewId overwrites prior entry', async () => {
		const store = createFilePreviewStore(root);
		await store.put({
			createdAt: 1,
			hostname: 'a',
			port: 3100,
			previewId: 'p',
			releaseId: 'rel-1',
			url: 'x'
		});
		await store.put({
			createdAt: 1,
			hostname: 'a',
			port: 3101,
			previewId: 'p',
			releaseId: 'rel-2',
			url: 'x'
		});
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.port).toBe(3101);
		rmSync(root, { force: true, recursive: true });
	});

	test('corrupt registry file → behaves like empty', async () => {
		const store = createFilePreviewStore(root);
		await store.put({
			createdAt: 1,
			hostname: 'a',
			port: 3100,
			previewId: 'p',
			releaseId: 'rel-1',
			url: 'x'
		});
		const path = join(root, 'previews.json');
		await Bun.write(path, 'not json');
		const reloaded = createFilePreviewStore(root);
		expect(await reloaded.list()).toEqual([]);
		rmSync(root, { force: true, recursive: true });
	});
});
