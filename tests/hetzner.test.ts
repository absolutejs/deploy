/**
 * Tests for @absolutejs/deploy/hetzner. Mock the HetznerClientLike
 * so we never touch the real Hetzner API or open real TCP sockets.
 */
import { describe, expect, test } from 'bun:test';
import {
	createHetznerClient,
	destroyHetznerServer,
	findHetznerServer,
	hetznerTarget,
	HetznerError,
	listHetznerServers,
	type HetznerClientLike,
	type HetznerServer,
	type HetznerTargetOptions
} from '../src/hetzner';

type RecordedCall = {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: unknown;
};

const server = (overrides: Partial<HetznerServer> = {}): HetznerServer => ({
	datacenter: { location: { name: 'nbg1' } },
	id: 7001,
	labels: { env: 'demo' },
	name: 'demo',
	public_net: {
		ipv4: {
			blocked: false,
			id: 1,
			ip: '198.51.100.42'
		},
		ipv6: null
	},
	server_type: { name: 'cx22' },
	status: 'running',
	...overrides
});

type Script = {
	method: 'GET' | 'POST' | 'DELETE';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const makeClient = (
	scripts: Script[]
): { client: HetznerClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: HetznerClientLike = {
		request: async <T>(
			method: 'GET' | 'POST' | 'DELETE',
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
	overrides: Partial<HetznerTargetOptions> = {}
): HetznerTargetOptions => ({
	image: 'ubuntu-22.04',
	location: 'nbg1',
	name: 'demo',
	now: () => 1_000,
	pollIntervalMs: 1,
	probeSsh: async () => true,
	serverType: 'cx22',
	sleep: async () => {},
	sshKeys: ['aa:bb:cc'],
	...overrides
});

describe('hetznerTarget — provision-or-reuse', () => {
	test('creates a server when none exists with the given name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/servers',
				respond: () => ({ server: server() })
			}
		]);
		const target = await hetznerTarget(baseOptions({ client }));
		expect(target.serverId).toBe(7001);
		expect(target.ipv4).toBe('198.51.100.42');
		expect(target.description).toContain('hetzner server "demo"');
		expect(calls[0]?.method).toBe('GET');
		expect(calls[1]).toMatchObject({
			method: 'POST',
			path: '/servers'
		});
		const createBody = calls[1]?.body as Record<string, unknown>;
		expect(createBody.name).toBe('demo');
		expect(createBody.location).toBe('nbg1');
		expect(createBody.server_type).toBe('cx22');
		expect(createBody.image).toBe('ubuntu-22.04');
		expect(createBody.ssh_keys).toEqual(['aa:bb:cc']);
		expect(createBody.start_after_create).toBe(true);
		expect(createBody.public_net).toEqual({
			enable_ipv4: true,
			enable_ipv6: true
		});
	});

	test('reuses an existing server with the same name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [server()] })
			}
		]);
		const logs: string[] = [];
		const target = await hetznerTarget(
			baseOptions({ client, onLog: (line) => logs.push(line) })
		);
		expect(target.ipv4).toBe('198.51.100.42');
		expect(calls).toHaveLength(1); // no POST
		expect(logs.some((line) => line.includes('reusing server'))).toBe(true);
	});

	test('polls until status becomes running and ipv4 is assigned', async () => {
		let nowValue = 1_000;
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/servers',
				respond: () => ({
					server: server({
						public_net: { ipv4: null, ipv6: null },
						status: 'initializing'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/servers/7001',
				respond: () => ({
					server: server({
						public_net: { ipv4: null, ipv6: null },
						status: 'starting'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/servers/7001',
				respond: () => ({ server: server() })
			}
		]);
		const target = await hetznerTarget(
			baseOptions({
				client,
				now: () => {
					const value = nowValue;
					nowValue += 100;
					return value;
				}
			})
		);
		expect(target.ipv4).toBe('198.51.100.42');
		expect(calls.filter((call) => call.path === '/servers/7001')).toHaveLength(
			2
		);
	});

	test('throws on provision timeout', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/servers',
				respond: () => ({
					server: server({
						public_net: { ipv4: null, ipv6: null },
						status: 'initializing'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/servers/7001',
				respond: () => ({
					server: server({
						public_net: { ipv4: null, ipv6: null },
						status: 'initializing'
					})
				})
			}
		]);
		let nowValue = 0;
		await expect(
			hetznerTarget(
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
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [server()] })
			}
		]);
		let probeCalls = 0;
		const target = await hetznerTarget(
			baseOptions({
				client,
				probeSsh: async () => {
					probeCalls += 1;
					return probeCalls >= 3;
				}
			})
		);
		expect(target.ipv4).toBe('198.51.100.42');
		expect(probeCalls).toBeGreaterThanOrEqual(3);
	});

	test('throws on SSH readiness timeout', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [server()] })
			}
		]);
		let nowValue = 0;
		await expect(
			hetznerTarget(
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

	test('returned target.destroy() calls DELETE /servers/:id', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [server()] })
			},
			{
				method: 'DELETE',
				pathPrefix: '/servers/7001',
				respond: () => ({ action: { id: 1, status: 'success' } })
			}
		]);
		const target = await hetznerTarget(baseOptions({ client }));
		await target.destroy();
		expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
	});

	test('forwards labels, userData, and networkId to create payload', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/servers',
				respond: () => ({ server: server() })
			}
		]);
		await hetznerTarget(
			baseOptions({
				client,
				labels: { env: 'prod', team: 'platform' },
				networkId: 12345,
				userData: '#!/bin/bash\necho hello'
			})
		);
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.labels).toEqual({ env: 'prod', team: 'platform' });
		expect(body.user_data).toBe('#!/bin/bash\necho hello');
		expect(body.networks).toEqual([12345]);
	});

	test('respects disablePublicIpv4 / disablePublicIpv6 flags', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/servers',
				respond: () => ({ server: server() })
			}
		]);
		await hetznerTarget(
			baseOptions({
				client,
				disablePublicIpv4: false,
				disablePublicIpv6: true
			})
		);
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.public_net).toEqual({
			enable_ipv4: true,
			enable_ipv6: false
		});
	});

	test('rejects when neither token nor client is provided', async () => {
		await expect(
			hetznerTarget({
				image: 'ubuntu-22.04',
				location: 'nbg1',
				name: 'demo',
				serverType: 'cx22',
				sshKeys: ['aa:bb:cc']
			})
		).rejects.toThrow('either `token` or `client`');
	});
});

describe('findHetznerServer', () => {
	test('returns undefined when no server matches', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({ servers: [] })
			}
		]);
		expect(await findHetznerServer(client, 'absent')).toBeUndefined();
	});

	test('throws if API ever returns duplicates (defensive)', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({
					servers: [
						server({ id: 1, name: 'dup' }),
						server({ id: 2, name: 'dup' })
					]
				})
			}
		]);
		await expect(findHetznerServer(client, 'dup')).rejects.toThrow(
			'multiple servers named "dup"'
		);
	});

	test('exact-matches the name (filters substring matches)', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?name=',
				respond: () => ({
					servers: [server({ name: 'demo-prod' }), server({ name: 'demo' })]
				})
			}
		]);
		const match = await findHetznerServer(client, 'demo');
		expect(match?.name).toBe('demo');
	});
});

describe('listHetznerServers', () => {
	test('lists all servers when label selector is omitted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers',
				respond: () => ({ servers: [server(), server({ id: 2 })] })
			}
		]);
		const result = await listHetznerServers({ client });
		expect(result).toHaveLength(2);
		expect(calls[0]?.path).toBe('/servers');
	});

	test('filters by label selector when supplied', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/servers?label_selector=',
				respond: () => ({ servers: [server()] })
			}
		]);
		await listHetznerServers({ client, labelSelector: 'env=prod' });
		expect(calls[0]?.path).toBe('/servers?label_selector=env%3Dprod');
	});
});

describe('destroyHetznerServer', () => {
	test('treats 404 as success (idempotent)', async () => {
		const client: HetznerClientLike = {
			request: async () => {
				throw new HetznerError('not found', 404, undefined);
			}
		};
		await expect(
			destroyHetznerServer({ client, id: 7001 })
		).resolves.toBeUndefined();
	});

	test('rethrows non-404 errors', async () => {
		const client: HetznerClientLike = {
			request: async () => {
				throw new HetznerError('unauthorized', 401, undefined);
			}
		};
		await expect(
			destroyHetznerServer({ client, id: 7001 })
		).rejects.toThrow('unauthorized');
	});
});

describe('createHetznerClient — default fetch-backed client', () => {
	test('authorizes with the bearer token and parses JSON responses', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			calls.push({ init, url });
			return new Response(JSON.stringify({ servers: [server()] }), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createHetznerClient('test-token', { fetch: fakeFetch });
		const body = await client.request<{ servers: HetznerServer[] }>(
			'GET',
			'/servers'
		);
		expect(body.servers).toHaveLength(1);
		expect(calls[0]?.url).toContain('/v1/servers');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer test-token');
	});

	test('throws HetznerError with response body on non-2xx', async () => {
		const fakeFetch = (async () =>
			new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }), {
				status: 401
			})) as unknown as typeof fetch;
		const client = createHetznerClient('bad', { fetch: fakeFetch });
		await expect(client.request('GET', '/servers')).rejects.toMatchObject({
			name: 'HetznerError',
			status: 401
		});
	});
});
