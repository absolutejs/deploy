/**
 * Tests for @absolutejs/deploy/digitalocean. Mock the
 * DigitalOceanClientLike so we never touch the real DO API or open
 * real TCP sockets — the probe is injected via `probeSsh` and sleeps
 * are skipped via `sleep`.
 */
import { describe, expect, test } from 'bun:test';
import {
	createDigitalOceanClient,
	destroyDigitalOceanDroplet,
	digitalOceanTarget,
	DigitalOceanError,
	findDigitalOceanDroplet,
	listDigitalOceanDroplets,
	type DigitalOceanClientLike,
	type DigitalOceanDroplet,
	type DigitalOceanTargetOptions
} from '../src/digitalocean';

type RecordedCall = {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	body?: unknown;
};

const droplet = (
	overrides: Partial<DigitalOceanDroplet> = {}
): DigitalOceanDroplet => ({
	id: 1001,
	name: 'demo',
	networks: {
		v4: [
			{ ip_address: '203.0.113.42', type: 'public' },
			{ ip_address: '10.0.0.1', type: 'private' }
		]
	},
	region: { slug: 'nyc3' },
	size_slug: 's-1vcpu-1gb',
	status: 'active',
	tags: ['absolutejs'],
	...overrides
});

type Script = {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const makeClient = (
	scripts: Script[]
): { client: DigitalOceanClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: DigitalOceanClientLike = {
		request: async <T>(
			method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
			path: string,
			body?: unknown
		): Promise<T> => {
			calls.push({ body, method, path });
			while (cursor < scripts.length) {
				const script = scripts[cursor] as Script;
				if (
					script.method === method &&
					path.startsWith(script.pathPrefix)
				) {
					cursor += 1;
					return script.respond(body) as T;
				}
				cursor += 1;
			}
			throw new Error(
				`[mock] no script matched ${method} ${path} (call ${calls.length})`
			);
		}
	};
	return { calls, client };
};

const baseOptions = (
	overrides: Partial<DigitalOceanTargetOptions> = {}
): DigitalOceanTargetOptions => ({
	image: 'ubuntu-22-04-x64',
	name: 'demo',
	now: () => 1_000,
	pollIntervalMs: 1,
	probeSsh: async () => true,
	region: 'nyc3',
	size: 's-1vcpu-1gb',
	sleep: async () => {},
	sshKeys: ['aa:bb:cc'],
	...overrides
});

describe('digitalOceanTarget — provision-or-reuse', () => {
	test('creates a droplet when none exists with the given name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/droplets',
				respond: () => ({ droplet: droplet() })
			}
		]);
		const target = await digitalOceanTarget(baseOptions({ client }));
		expect(target.dropletId).toBe(1001);
		expect(target.ipv4).toBe('203.0.113.42');
		expect(target.description).toContain('digitalocean droplet "demo"');
		expect(calls[0]?.method).toBe('GET');
		expect(calls[1]).toMatchObject({
			method: 'POST',
			path: '/droplets'
		});
		const createBody = calls[1]?.body as Record<string, unknown>;
		expect(createBody.name).toBe('demo');
		expect(createBody.region).toBe('nyc3');
		expect(createBody.size).toBe('s-1vcpu-1gb');
		expect(createBody.image).toBe('ubuntu-22-04-x64');
		expect(createBody.ssh_keys).toEqual(['aa:bb:cc']);
	});

	test('reuses an existing droplet with the same name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [droplet()] })
			}
		]);
		const logs: string[] = [];
		const target = await digitalOceanTarget(
			baseOptions({ client, onLog: (line) => logs.push(line) })
		);
		expect(target.ipv4).toBe('203.0.113.42');
		expect(calls).toHaveLength(1); // no POST
		expect(logs.some((line) => line.includes('reusing droplet'))).toBe(true);
	});

	test('polls until status becomes active and ipv4 is assigned', async () => {
		let nowValue = 1_000;
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/droplets',
				respond: () => ({
					droplet: droplet({
						networks: { v4: [] },
						status: 'new'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/droplets/1001',
				respond: () => ({
					droplet: droplet({
						networks: { v4: [] },
						status: 'new'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/droplets/1001',
				respond: () => ({ droplet: droplet() })
			}
		]);
		const target = await digitalOceanTarget(
			baseOptions({
				client,
				now: () => {
					const value = nowValue;
					nowValue += 100;
					return value;
				}
			})
		);
		expect(target.ipv4).toBe('203.0.113.42');
		expect(calls.filter((call) => call.path === '/droplets/1001')).toHaveLength(
			2
		);
	});

	test('throws on provision timeout', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/droplets',
				respond: () => ({
					droplet: droplet({ networks: { v4: [] }, status: 'new' })
				})
			},
			{
				method: 'GET',
				pathPrefix: '/droplets/1001',
				respond: () => ({
					droplet: droplet({ networks: { v4: [] }, status: 'new' })
				})
			}
		]);
		let nowValue = 0;
		await expect(
			digitalOceanTarget(
				baseOptions({
					client,
					now: () => {
						const value = nowValue;
						nowValue += 600_000;
						return value;
					},
					provisionTimeoutMs: 10_000
				})
			)
		).rejects.toThrow('provision timeout');
	});

	test('waits for SSH probe to succeed before returning', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [droplet()] })
			}
		]);
		let probeCalls = 0;
		const target = await digitalOceanTarget(
			baseOptions({
				client,
				probeSsh: async () => {
					probeCalls += 1;
					return probeCalls >= 3;
				}
			})
		);
		expect(target.ipv4).toBe('203.0.113.42');
		expect(probeCalls).toBeGreaterThanOrEqual(3);
	});

	test('throws on SSH readiness timeout', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [droplet()] })
			}
		]);
		let nowValue = 0;
		await expect(
			digitalOceanTarget(
				baseOptions({
					client,
					now: () => {
						const value = nowValue;
						nowValue += 200_000;
						return value;
					},
					probeSsh: async () => false,
					sshReadinessTimeoutMs: 10_000
				})
			)
		).rejects.toThrow('SSH readiness timeout');
	});

	test('returned target.destroy() calls DELETE /droplets/:id', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [droplet()] })
			},
			{
				method: 'DELETE',
				pathPrefix: '/droplets/1001',
				respond: () => undefined
			}
		]);
		const target = await digitalOceanTarget(baseOptions({ client }));
		await target.destroy();
		expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
	});

	test('rejects when neither token nor client is provided', async () => {
		await expect(
			digitalOceanTarget({
				image: 'ubuntu-22-04-x64',
				name: 'demo',
				region: 'nyc3',
				size: 's-1vcpu-1gb',
				sshKeys: ['aa:bb:cc']
			})
		).rejects.toThrow('either `token` or `client`');
	});
});

describe('findDigitalOceanDroplet', () => {
	test('returns undefined when no droplet matches', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({ droplets: [] })
			}
		]);
		expect(await findDigitalOceanDroplet(client, 'absent')).toBeUndefined();
	});

	test('throws on ambiguous duplicates', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({
					droplets: [
						droplet({ id: 1, name: 'dup' }),
						droplet({ id: 2, name: 'dup' })
					]
				})
			}
		]);
		await expect(findDigitalOceanDroplet(client, 'dup')).rejects.toThrow(
			'multiple droplets named "dup"'
		);
	});

	test('filters by exact name (DO list endpoint is substring-loose)', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?name=',
				respond: () => ({
					droplets: [
						droplet({ name: 'demo-prod' }),
						droplet({ name: 'demo' })
					]
				})
			}
		]);
		const match = await findDigitalOceanDroplet(client, 'demo');
		expect(match?.name).toBe('demo');
	});
});

describe('listDigitalOceanDroplets', () => {
	test('lists all droplets when tag is omitted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets',
				respond: () => ({ droplets: [droplet(), droplet({ id: 2 })] })
			}
		]);
		const result = await listDigitalOceanDroplets({ client });
		expect(result).toHaveLength(2);
		expect(calls[0]?.path).toBe('/droplets');
	});

	test('filters by tag when supplied', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/droplets?tag_name=',
				respond: () => ({ droplets: [droplet()] })
			}
		]);
		await listDigitalOceanDroplets({ client, tag: 'prod' });
		expect(calls[0]?.path).toBe('/droplets?tag_name=prod');
	});
});

describe('destroyDigitalOceanDroplet', () => {
	test('treats 404 as success (idempotent)', async () => {
		const client: DigitalOceanClientLike = {
			request: async () => {
				throw new DigitalOceanError('not found', 404, undefined);
			}
		};
		await expect(
			destroyDigitalOceanDroplet({ client, id: 1001 })
		).resolves.toBeUndefined();
	});

	test('rethrows non-404 errors', async () => {
		const client: DigitalOceanClientLike = {
			request: async () => {
				throw new DigitalOceanError('unauthorized', 401, undefined);
			}
		};
		await expect(
			destroyDigitalOceanDroplet({ client, id: 1001 })
		).rejects.toThrow('unauthorized');
	});
});

describe('createDigitalOceanClient — default fetch-backed client', () => {
	test('authorizes with the bearer token and parses JSON responses', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (
			url: string,
			init?: RequestInit
		) => {
			calls.push({ init, url });
			return new Response(JSON.stringify({ droplets: [droplet()] }), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createDigitalOceanClient('test-token', { fetch: fakeFetch });
		const body = await client.request<{ droplets: DigitalOceanDroplet[] }>(
			'GET',
			'/droplets'
		);
		expect(body.droplets).toHaveLength(1);
		expect(calls[0]?.url).toContain('/v2/droplets');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer test-token');
	});

	test('throws DigitalOceanError with response body on non-2xx', async () => {
		const fakeFetch = (async () =>
			new Response(JSON.stringify({ id: 'unauthorized', message: 'bad' }), {
				status: 401
			})) as unknown as typeof fetch;
		const client = createDigitalOceanClient('bad', { fetch: fakeFetch });
		await expect(client.request('GET', '/droplets')).rejects.toMatchObject({
			name: 'DigitalOceanError',
			status: 401
		});
	});
});
