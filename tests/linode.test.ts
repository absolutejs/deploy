/**
 * Tests for @absolutejs/deploy/linode. Mock the LinodeClientLike +
 * skip real TCP/sleep via probeSsh/sleep injection.
 */
import { describe, expect, test } from 'bun:test';
import {
	createLinodeClient,
	destroyLinodeInstance,
	findLinodeInstance,
	linodeTarget,
	LinodeError,
	listLinodeInstances,
	type LinodeClientLike,
	type LinodeInstance,
	type LinodeTargetOptions
} from '../src/linode';

type RecordedCall = { method: string; path: string; body?: unknown };
type Script = {
	method: 'GET' | 'POST' | 'DELETE';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const instance = (overrides: Partial<LinodeInstance> = {}): LinodeInstance => ({
	id: 9001,
	ipv4: ['203.0.113.50'],
	label: 'demo',
	region: 'us-east',
	status: 'running',
	tags: [],
	type: 'g6-nanode-1',
	...overrides
});

const makeClient = (
	scripts: Script[]
): { client: LinodeClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: LinodeClientLike = {
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
	overrides: Partial<LinodeTargetOptions> = {}
): LinodeTargetOptions => ({
	image: 'linode/ubuntu22.04',
	name: 'demo',
	now: () => 1_000,
	pollIntervalMs: 1,
	probeSsh: async () => true,
	region: 'us-east',
	sleep: async () => {},
	sshKeys: ['ssh-ed25519 AAAA…'],
	type: 'g6-nanode-1',
	...overrides
});

describe('linodeTarget', () => {
	test('creates an instance when none exists', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({ data: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/linode/instances',
				respond: () => instance()
			}
		]);
		const target = await linodeTarget(baseOptions({ client }));
		expect(target.instanceId).toBe(9001);
		expect(target.ipv4).toBe('203.0.113.50');
		expect(target.description).toContain('linode "demo"');
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.label).toBe('demo');
		expect(body.region).toBe('us-east');
		expect(body.type).toBe('g6-nanode-1');
		expect(body.image).toBe('linode/ubuntu22.04');
		expect(body.authorized_keys).toEqual(['ssh-ed25519 AAAA…']);
		// We auto-generated a root_pass since none was passed.
		expect(typeof body.root_pass).toBe('string');
		expect((body.root_pass as string).length).toBe(32);
	});

	test('reuses an existing instance with the same label', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({ data: [instance()] })
			}
		]);
		const target = await linodeTarget(baseOptions({ client }));
		expect(target.instanceId).toBe(9001);
		expect(calls).toHaveLength(1); // no POST
	});

	test('skips private/link-local IPv4 addresses when picking the public IP', async () => {
		const withPrivate = instance({
			ipv4: ['10.0.0.5', '169.254.1.1', '198.51.100.42']
		});
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({ data: [withPrivate] })
			}
		]);
		const target = await linodeTarget(baseOptions({ client }));
		expect(target.ipv4).toBe('198.51.100.42');
	});

	test('throws on ambiguous duplicates', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({
					data: [
						instance({ id: 1, label: 'dup' }),
						instance({ id: 2, label: 'dup' })
					]
				})
			}
		]);
		await expect(
			linodeTarget(baseOptions({ client, name: 'dup' }))
		).rejects.toThrow('multiple instances labeled "dup"');
	});

	test('rejects when neither token nor client is provided', async () => {
		await expect(
			linodeTarget({
				image: 'linode/ubuntu22.04',
				name: 'demo',
				region: 'us-east',
				sshKeys: ['x'],
				type: 'g6-nanode-1'
			})
		).rejects.toThrow('either `token` or `client`');
	});

	test('destroy() calls DELETE /linode/instances/:id; 404 idempotent', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({ data: [instance()] })
			},
			{
				method: 'DELETE',
				pathPrefix: '/linode/instances/9001',
				respond: () => undefined
			}
		]);
		const target = await linodeTarget(baseOptions({ client }));
		await target.destroy();

		// idempotent on 404
		const failing: LinodeClientLike = {
			request: async () => {
				throw new LinodeError('not found', 404, undefined);
			}
		};
		await expect(
			destroyLinodeInstance({ client: failing, id: 1 })
		).resolves.toBeUndefined();
	});
});

describe('findLinodeInstance + listLinodeInstances', () => {
	test('find returns undefined when no match', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?page_size=',
				respond: () => ({ data: [] })
			}
		]);
		expect(await findLinodeInstance(client, 'absent')).toBeUndefined();
	});

	test('list with tag filter forwards the query', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/linode/instances?tag=',
				respond: () => ({ data: [instance()] })
			}
		]);
		await listLinodeInstances({ client, tag: 'prod' });
		expect(calls[0]?.path).toContain('tag=prod');
	});
});

describe('createLinodeClient', () => {
	test('authorizes with bearer token', async () => {
		const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			seen.push({ init, url });
			return new Response(JSON.stringify({ data: [] }), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createLinodeClient('test-token', { fetch: fakeFetch });
		await client.request('GET', '/linode/instances');
		const headers = seen[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer test-token');
	});

	test('throws LinodeError on non-2xx', async () => {
		const fakeFetch = (async () =>
			new Response(JSON.stringify({ errors: [{ reason: 'bad' }] }), {
				status: 400
			})) as unknown as typeof fetch;
		const client = createLinodeClient('bad', { fetch: fakeFetch });
		await expect(client.request('GET', '/x')).rejects.toMatchObject({
			name: 'LinodeError',
			status: 400
		});
	});
});
