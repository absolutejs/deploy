/**
 * Tests for @absolutejs/deploy/cloudflare. Mock CloudflareClientLike
 * so we never touch the real Cloudflare API.
 */
import { describe, expect, test } from 'bun:test';
import {
	cloudflareProvider,
	CloudflareError,
	createCloudflareClient,
	type CloudflareClientLike
} from '../src/cloudflare';
import { ensureDnsForTarget, type DnsRecord } from '../src/dns';

type RecordedCall = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	path: string;
	body?: unknown;
};

type Script = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	pathPrefix: string;
	respond: (body?: unknown) => unknown;
};

const makeClient = (
	scripts: Script[]
): { client: CloudflareClientLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const client: CloudflareClientLike = {
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

const cfEnvelope = <T>(result: T) => ({ errors: [], messages: [], result, success: true });

const rawRecord = (overrides: Partial<DnsRecord> & { id?: string } = {}) => ({
	content: '203.0.113.42',
	id: 'rec_1',
	name: 'api.example.com',
	proxied: false,
	ttl: 300,
	type: 'A',
	...overrides
});

const ZONE_ID = 'zone_abc';
const RECORDS_PATH = `/zones/${ZONE_ID}/dns_records`;

describe('cloudflareProvider — list / find / create / update / delete', () => {
	test('list calls the records endpoint and maps the response', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () =>
					cfEnvelope([
						rawRecord(),
						rawRecord({ id: 'rec_2', name: 'www.example.com' })
					])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const records = await provider.list();
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			content: '203.0.113.42',
			id: 'rec_1',
			name: 'api.example.com',
			type: 'A'
		});
		expect(calls[0]?.path).toBe(RECORDS_PATH);
	});

	test('list forwards name + type filters as query params', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord()])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await provider.list({ name: 'api.example.com', type: 'A' });
		expect(calls[0]?.path).toContain('name=api.example.com');
		expect(calls[0]?.path).toContain('type=A');
	});

	test('find returns undefined when no match', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		expect(
			await provider.find({ name: 'absent.example.com', type: 'A' })
		).toBeUndefined();
	});

	test('find rejects substring-loose matches (exact-name only)', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () =>
					cfEnvelope([
						rawRecord({ name: 'api.example.com.staging' }),
						rawRecord({ id: 'rec_2', name: 'api.example.com' })
					])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const match = await provider.find({
			name: 'api.example.com',
			type: 'A'
		});
		expect(match?.id).toBe('rec_2');
	});

	test('find tolerates a trailing dot on the returned name', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord({ name: 'api.example.com.' })])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const match = await provider.find({
			name: 'api.example.com',
			type: 'A'
		});
		expect(match?.id).toBe('rec_1');
	});

	test('find throws on multiple matches (drifted state)', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () =>
					cfEnvelope([
						rawRecord({ id: 'rec_1', name: 'api.example.com' }),
						rawRecord({ id: 'rec_2', name: 'api.example.com' })
					])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await expect(
			provider.find({ name: 'api.example.com', type: 'A' })
		).rejects.toThrow('multiple A records');
	});

	test('create POSTs the record spec and returns the parsed record', async () => {
		const { client, calls } = makeClient([
			{
				method: 'POST',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope(rawRecord())
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const record = await provider.create({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 300,
			type: 'A'
		});
		expect(record.id).toBe('rec_1');
		expect(calls[0]?.method).toBe('POST');
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body).toMatchObject({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 300,
			type: 'A'
		});
	});

	test('update PUTs to the per-id record URL', async () => {
		const { client, calls } = makeClient([
			{
				method: 'PUT',
				pathPrefix: `${RECORDS_PATH}/rec_1`,
				respond: () => cfEnvelope(rawRecord({ content: '198.51.100.1' }))
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const record = await provider.update('rec_1', {
			content: '198.51.100.1',
			name: 'api.example.com',
			type: 'A'
		});
		expect(record.content).toBe('198.51.100.1');
		expect(calls[0]?.method).toBe('PUT');
		expect(calls[0]?.path).toBe(`${RECORDS_PATH}/rec_1`);
	});

	test('delete returns void on success; 404 is idempotent', async () => {
		const { client } = makeClient([
			{
				method: 'DELETE',
				pathPrefix: `${RECORDS_PATH}/rec_1`,
				respond: () => cfEnvelope({ id: 'rec_1' })
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await expect(provider.delete('rec_1')).resolves.toBeUndefined();

		const failing: CloudflareClientLike = {
			request: async () => {
				throw new CloudflareError('not found', 404, undefined);
			}
		};
		const provider2 = cloudflareProvider({ client: failing, zoneId: ZONE_ID });
		await expect(provider2.delete('absent')).resolves.toBeUndefined();
	});
});

describe('cloudflareProvider — upsert (the canonical entry)', () => {
	test('creates when no record exists', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([])
			},
			{
				method: 'POST',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope(rawRecord())
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const record = await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		expect(record.id).toBe('rec_1');
		expect(calls.some((call) => call.method === 'POST')).toBe(true);
	});

	test('skips the API call when record already matches spec', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord()])
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			proxied: false,
			ttl: 300,
			type: 'A'
		});
		// One GET, no PUT/POST — already correct.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('GET');
	});

	test('updates when content has drifted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord({ content: '198.51.100.99' })])
			},
			{
				method: 'PUT',
				pathPrefix: `${RECORDS_PATH}/rec_1`,
				respond: () => cfEnvelope(rawRecord({ content: '203.0.113.42' }))
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		const record = await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		expect(record.content).toBe('203.0.113.42');
		expect(calls.some((call) => call.method === 'PUT')).toBe(true);
	});

	test('updates when TTL has drifted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord({ ttl: 3600 })])
			},
			{
				method: 'PUT',
				pathPrefix: `${RECORDS_PATH}/rec_1`,
				respond: () => cfEnvelope(rawRecord({ ttl: 60 }))
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 60,
			type: 'A'
		});
		expect(calls.some((call) => call.method === 'PUT')).toBe(true);
	});

	test('updates when proxied has drifted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([rawRecord({ proxied: true })])
			},
			{
				method: 'PUT',
				pathPrefix: `${RECORDS_PATH}/rec_1`,
				respond: () => cfEnvelope(rawRecord({ proxied: false }))
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			proxied: false,
			type: 'A'
		});
		expect(calls.some((call) => call.method === 'PUT')).toBe(true);
	});
});

describe('ensureDnsForTarget — composes Target.ipv4 with provider.upsert', () => {
	test('points an A record at the target IPv4', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope([])
			},
			{
				method: 'POST',
				pathPrefix: RECORDS_PATH,
				respond: () => cfEnvelope(rawRecord({ content: '198.51.100.42' }))
			}
		]);
		const provider = cloudflareProvider({ client, zoneId: ZONE_ID });
		await ensureDnsForTarget(provider, {
			name: 'api.example.com',
			proxied: false,
			target: { ipv4: '198.51.100.42' },
			ttl: 60
		});
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.content).toBe('198.51.100.42');
		expect(body.ttl).toBe(60);
		expect(body.proxied).toBe(false);
		expect(body.type).toBe('A');
	});
});

describe('cloudflareProvider — guards', () => {
	test('throws when neither token nor client is provided', () => {
		expect(() =>
			cloudflareProvider({ zoneId: ZONE_ID } as never)
		).toThrow('either `token` or `client`');
	});

	test('description references the zone label', () => {
		const { client } = makeClient([]);
		const provider = cloudflareProvider({
			client,
			zoneId: ZONE_ID,
			zoneName: 'example.com'
		});
		expect(provider.description).toBe('cloudflare zone "example.com"');
	});
});

describe('createCloudflareClient — default fetch-backed client', () => {
	test('authorizes with bearer token and parses success envelopes', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			calls.push({ init, url });
			return new Response(JSON.stringify(cfEnvelope([rawRecord()])), {
				headers: { 'content-type': 'application/json' },
				status: 200
			});
		}) as unknown as typeof fetch;
		const client = createCloudflareClient('test-token', { fetch: fakeFetch });
		const body = await client.request<{ success: boolean }>(
			'GET',
			'/zones/zone_abc/dns_records'
		);
		expect(body.success).toBe(true);
		expect(calls[0]?.url).toContain('/client/v4/zones/zone_abc/dns_records');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer test-token');
	});

	test('throws CloudflareError with response body on non-2xx', async () => {
		const fakeFetch = (async () =>
			new Response(
				JSON.stringify({
					errors: [{ code: 7003, message: 'No route for that URI' }],
					success: false
				}),
				{ status: 404 }
			)) as unknown as typeof fetch;
		const client = createCloudflareClient('bad', { fetch: fakeFetch });
		await expect(
			client.request('GET', '/zones/missing/dns_records')
		).rejects.toMatchObject({ name: 'CloudflareError', status: 404 });
	});
});
