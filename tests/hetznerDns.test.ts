/**
 * Tests for @absolutejs/deploy/hetzner-dns.
 */
import { describe, expect, test } from 'bun:test';
import {
	createHetznerDnsClient,
	hetznerDnsProvider,
	HetznerDnsError,
	type HetznerDnsClientLike
} from '../src/hetznerDns';
import { ensureDnsForTarget } from '../src/dns';

type RecordedCall = { method: string; path: string; body?: unknown };
type Script = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const makeClient = (
	scripts: Script[]
): { client: HetznerDnsClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: HetznerDnsClientLike = {
		request: async <T>(
			method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

const ZONE_ID = 'zone-uuid-abc';
const ZONE_NAME = 'example.com';

const rawRecord = (overrides: Record<string, unknown> = {}) => ({
	id: 'rec-uuid-1',
	name: 'api',
	ttl: 1800,
	type: 'A',
	value: '203.0.113.42',
	zone_id: ZONE_ID,
	...overrides
});

describe('hetznerDnsProvider', () => {
	test('list maps Hetzner records to DnsRecord with FQDN names', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({
					records: [
						rawRecord(),
						rawRecord({ id: 'rec-uuid-2', name: '@' })
					]
				})
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		const records = await provider.list();
		expect(records).toHaveLength(2);
		expect(records[0]?.name).toBe('api.example.com');
		expect(records[1]?.name).toBe('example.com');
	});

	test('upsert creates when absent — converts FQDN to relative name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({ records: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/records',
				respond: () => ({ record: rawRecord() })
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 1800,
			type: 'A'
		});
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.name).toBe('api'); // relative
		expect(body.value).toBe('203.0.113.42');
		expect(body.zone_id).toBe(ZONE_ID);
		expect(body.ttl).toBe(1800);
	});

	test('upsert skips when spec matches existing', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({ records: [rawRecord()] })
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 1800,
			type: 'A'
		});
		expect(calls).toHaveLength(1);
	});

	test('upsert PUTs when content drifts', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({
					records: [rawRecord({ value: '198.51.100.99' })]
				})
			},
			{
				method: 'PUT',
				pathPrefix: '/records/rec-uuid-1',
				respond: () => ({ record: rawRecord() })
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		expect(calls.some((c) => c.method === 'PUT')).toBe(true);
	});

	test('find throws on multiple matches', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({
					records: [rawRecord(), rawRecord({ id: 'rec-uuid-2' })]
				})
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await expect(
			provider.find({ name: 'api.example.com', type: 'A' })
		).rejects.toThrow('multiple A records');
	});

	test('delete is idempotent on 404', async () => {
		const failing: HetznerDnsClientLike = {
			request: async () => {
				throw new HetznerDnsError('not found', 404, undefined);
			}
		};
		const provider = hetznerDnsProvider({
			client: failing,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await expect(provider.delete('abc')).resolves.toBeUndefined();
	});

	test('ensureDnsForTarget composes cleanly', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: '/records?zone_id=',
				respond: () => ({ records: [] })
			},
			{
				method: 'POST',
				pathPrefix: '/records',
				respond: () => ({ record: rawRecord() })
			}
		]);
		const provider = hetznerDnsProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: ZONE_NAME
		});
		await ensureDnsForTarget(provider, {
			name: 'api.example.com',
			target: { ipv4: '203.0.113.42' },
			ttl: 60
		});
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.value).toBe('203.0.113.42');
		expect(body.type).toBe('A');
		expect(body.ttl).toBe(60);
	});
});

describe('createHetznerDnsClient', () => {
	test('uses the Auth-API-Token header (NOT Bearer)', async () => {
		const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			seen.push({ init, url });
			return new Response(JSON.stringify({ records: [] }), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createHetznerDnsClient('test-token', { fetch: fakeFetch });
		await client.request('GET', '/records?zone_id=abc');
		const headers = seen[0]?.init?.headers as Record<string, string>;
		expect(headers['auth-api-token']).toBe('test-token');
		expect(headers.authorization).toBeUndefined();
	});

	test('throws HetznerDnsError on non-2xx', async () => {
		const fakeFetch = (async () =>
			new Response(JSON.stringify({ error: { message: 'bad' } }), {
				status: 401
			})) as unknown as typeof fetch;
		const client = createHetznerDnsClient('bad', { fetch: fakeFetch });
		await expect(client.request('GET', '/records')).rejects.toMatchObject({
			name: 'HetznerDnsError',
			status: 401
		});
	});
});
