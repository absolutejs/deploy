/**
 * Tests for @absolutejs/deploy/digitalocean-dns.
 */
import { describe, expect, test } from 'bun:test';
import {
	digitalOceanDnsProvider,
	type DigitalOceanDnsProviderOptions
} from '../src/digitaloceanDns';
import { DigitalOceanError, type DigitalOceanClientLike } from '../src/digitalocean';
import { ensureDnsForTarget } from '../src/dns';

type RecordedCall = { method: string; path: string; body?: unknown };
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

const DOMAIN = 'example.com';
const RECORDS_PATH = `/domains/${DOMAIN}/records`;

const rawRecord = (overrides: Record<string, unknown> = {}) => ({
	data: '203.0.113.42',
	id: 101,
	name: 'api',
	ttl: 1800,
	type: 'A',
	...overrides
});

describe('digitalOceanDnsProvider', () => {
	test('list maps DO records to DnsRecord with FQDN names', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({
					domain_records: [rawRecord(), rawRecord({ id: 102, name: '@' })]
				})
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		const records = await provider.list();
		expect(records).toHaveLength(2);
		expect(records[0]?.name).toBe('api.example.com');
		expect(records[1]?.name).toBe('example.com');
	});

	test('find returns undefined when absent', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_records: [] })
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		const found = await provider.find({
			name: 'api.example.com',
			type: 'A'
		});
		expect(found).toBeUndefined();
	});

	test('find throws on multiple matches', async () => {
		const { client } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({
					domain_records: [rawRecord(), rawRecord({ id: 102 })]
				})
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		await expect(
			provider.find({ name: 'api.example.com', type: 'A' })
		).rejects.toThrow('multiple A records');
	});

	test('upsert creates when absent — converts FQDN to relative name', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_records: [] })
			},
			{
				method: 'POST',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_record: rawRecord() })
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 1800,
			type: 'A'
		});
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.name).toBe('api'); // relative, not FQDN
		expect(body.data).toBe('203.0.113.42');
		expect(body.ttl).toBe(1800);
	});

	test('upsert skips the API call when spec matches existing', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_records: [rawRecord()] })
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 1800,
			type: 'A'
		});
		expect(calls).toHaveLength(1); // GET only, no POST/PUT
	});

	test('upsert PUTs when content has drifted', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({
					domain_records: [rawRecord({ data: '198.51.100.99' })]
				})
			},
			{
				method: 'PUT',
				pathPrefix: `${RECORDS_PATH}/101`,
				respond: () => ({ domain_record: rawRecord() })
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		expect(calls.some((c) => c.method === 'PUT')).toBe(true);
	});

	test('delete is idempotent on 404', async () => {
		const failing: DigitalOceanClientLike = {
			request: async () => {
				throw new DigitalOceanError('not found', 404, undefined);
			}
		};
		const provider = digitalOceanDnsProvider({
			client: failing,
			domain: DOMAIN
		});
		await expect(provider.delete('123')).resolves.toBeUndefined();
	});

	test('ensureDnsForTarget composes cleanly', async () => {
		const { client, calls } = makeClient([
			{
				method: 'GET',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_records: [] })
			},
			{
				method: 'POST',
				pathPrefix: RECORDS_PATH,
				respond: () => ({ domain_record: rawRecord() })
			}
		]);
		const provider = digitalOceanDnsProvider({ client, domain: DOMAIN });
		await ensureDnsForTarget(provider, {
			name: 'api.example.com',
			target: { ipv4: '203.0.113.42' },
			ttl: 60
		});
		const body = calls[1]?.body as Record<string, unknown>;
		expect(body.data).toBe('203.0.113.42');
		expect(body.type).toBe('A');
		expect(body.ttl).toBe(60);
	});
});
