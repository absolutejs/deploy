/**
 * Tests for @absolutejs/deploy/vultr. Mock the VultrClientLike + skip
 * real TCP/sleep via probeSsh/sleep injection.
 */
import { describe, expect, test } from 'bun:test';
import {
	createVultrClient,
	destroyVultrInstance,
	findVultrInstance,
	vultrTarget,
	VultrError,
	listVultrInstances,
	type VultrClientLike,
	type VultrInstance,
	type VultrTargetOptions
} from '../src/vultr';

type RecordedCall = { method: string; path: string; body?: unknown };
type Script = {
	method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const instance = (overrides: Partial<VultrInstance> = {}): VultrInstance => ({
	id: 'vlt_abc123',
	label: 'demo',
	main_ip: '203.0.113.60',
	plan: 'vc2-1c-1gb',
	power_status: 'running',
	region: 'ewr',
	status: 'active',
	tags: [],
	...overrides
});

const makeClient = (
	scripts: Script[]
): { client: VultrClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: VultrClientLike = {
		request: async <T>(
			method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
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
	overrides: Partial<VultrTargetOptions> = {}
): VultrTargetOptions => ({
	name: 'demo',
	now: () => 1_000,
	osId: 1743,
	plan: 'vc2-1c-1gb',
	pollIntervalMs: 1,
	probeSsh: async () => true,
	region: 'ewr',
	sleep: async () => {},
	sshKeys: ['ssh-key-uuid-abc'],
	...overrides
});

describe('vultrTarget', () => {
	test('creates an instance when none exists', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/instances',
				respond: () => ({ instance: instance() })
			}
		]);
		const target = await vultrTarget(baseOptions({ client }));
		expect(target.instanceId).toBe('vlt_abc123');
		expect(target.ipv4).toBe('203.0.113.60');
		expect(target.description).toContain('vultr "demo"');
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.label).toBe('demo');
		expect(body.region).toBe('ewr');
		expect(body.plan).toBe('vc2-1c-1gb');
		expect(body.os_id).toBe(1743);
		expect(body.sshkey_id).toEqual(['ssh-key-uuid-abc']);
	});

	test('reuses an existing instance with the same label', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [instance()] })
			}
		]);
		const target = await vultrTarget(baseOptions({ client }));
		expect(target.instanceId).toBe('vlt_abc123');
		expect(calls).toHaveLength(1);
	});

	test('treats main_ip of 0.0.0.0 as unassigned (polls until ready)', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/instances',
				respond: () => ({
					instance: instance({
						main_ip: '0.0.0.0',
						power_status: 'starting',
						status: 'pending'
					})
				})
			},
			{
				method: 'GET',
				pathPrefix: '/instances/vlt_abc123',
				respond: () => ({ instance: instance() })
			}
		]);
		let nowValue = 1_000;
		const target = await vultrTarget(
			baseOptions({
				client,
				now: () => {
					const value = nowValue;
					nowValue += 100;
					return value;
				}
			})
		);
		expect(target.ipv4).toBe('203.0.113.60');
		expect(
			calls.some((call) => call.path === '/instances/vlt_abc123')
		).toBe(true);
	});

	test('base64-encodes user_data on the way out', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/instances',
				respond: () => ({ instance: instance() })
			}
		]);
		await vultrTarget(
			baseOptions({ client, userData: '#!/bin/bash\necho hi' })
		);
		const body = calls[1]?.body as Record<string, unknown>;
		// Vultr expects base64-encoded user_data.
		expect(body.user_data).toBe(btoa('#!/bin/bash\necho hi'));
	});

	test('destroy() calls DELETE /instances/:id; 404 idempotent', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [instance()] })
			},
			{
				method: 'DELETE',
				pathPrefix: '/instances/vlt_abc123',
				respond: () => undefined
			}
		]);
		const target = await vultrTarget(baseOptions({ client }));
		await target.destroy();

		const failing: VultrClientLike = {
			request: async () => {
				throw new VultrError('not found', 404, undefined);
			}
		};
		await expect(
			destroyVultrInstance({ client: failing, id: 'absent' })
		).resolves.toBeUndefined();
	});

	test('throws on ambiguous duplicates', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({
					instances: [
						instance({ id: 'a', label: 'dup' }),
						instance({ id: 'b', label: 'dup' })
					]
				})
			}
		]);
		await expect(
			vultrTarget(baseOptions({ client, name: 'dup' }))
		).rejects.toThrow('multiple instances labeled "dup"');
	});

	test('rejects when neither token nor client is provided', async () => {
		await expect(
			vultrTarget({
				name: 'demo',
				osId: 1743,
				plan: 'vc2-1c-1gb',
				region: 'ewr',
				sshKeys: ['x']
			})
		).rejects.toThrow('either `token` or `client`');
	});
});

describe('findVultrInstance + listVultrInstances', () => {
	test('find returns undefined when no match', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?label=',
				respond: () => ({ instances: [] })
			}
		]);
		expect(await findVultrInstance(client, 'absent')).toBeUndefined();
	});

	test('list with tag filter forwards the query', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/instances?tag=',
				respond: () => ({ instances: [instance()] })
			}
		]);
		await listVultrInstances({ client, tag: 'prod' });
		expect(calls[0]?.path).toContain('tag=prod');
	});
});

describe('createVultrClient', () => {
	test('authorizes with bearer token', async () => {
		const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			seen.push({ init, url });
			return new Response(JSON.stringify({ instances: [] }), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createVultrClient('test-token', { fetch: fakeFetch });
		await client.request('GET', '/instances');
		const headers = seen[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer test-token');
	});
});
