/**
 * Tests for @absolutejs/deploy/route53. Mock Route53ClientLike with
 * an in-memory record store; verify the UPSERT path + TXT encoding
 * + synthetic-id delete round-trip.
 */
import { describe, expect, test } from 'bun:test';
import {
	route53DnsProvider,
	type Route53ChangeInput,
	type Route53ChangeOutput,
	type Route53ClientLike,
	type Route53ListInput,
	type Route53ListOutput,
	type Route53ResourceRecordSet
} from '../src/route53';
import { ensureDnsForTarget } from '../src/dns';

const HOSTED_ZONE_ID = 'Z123ABC';
const ZONE_NAME = 'example.com';

const makeStubClient = (
	initial: Route53ResourceRecordSet[] = []
): {
	client: Route53ClientLike;
	calls: Array<
		| { kind: 'list'; input: Route53ListInput }
		| { kind: 'change'; input: Route53ChangeInput }
	>;
	state: () => Route53ResourceRecordSet[];
} => {
	const records: Route53ResourceRecordSet[] = [...initial];
	const calls: Array<
		| { kind: 'list'; input: Route53ListInput }
		| { kind: 'change'; input: Route53ChangeInput }
	> = [];
	const client: Route53ClientLike = {
		changeResourceRecordSets: async (
			input: Route53ChangeInput
		): Promise<Route53ChangeOutput> => {
			calls.push({ input, kind: 'change' });
			for (const change of input.ChangeBatch.Changes) {
				const target = change.ResourceRecordSet;
				const idx = records.findIndex(
					(r) => r.Name === target.Name && r.Type === target.Type
				);
				if (change.Action === 'CREATE') {
					if (idx >= 0) {
						throw new Error(
							`record ${target.Name}/${target.Type} already exists`
						);
					}
					records.push(target);
				} else if (change.Action === 'UPSERT') {
					if (idx >= 0) records[idx] = target;
					else records.push(target);
				} else if (change.Action === 'DELETE') {
					if (idx === -1) {
						throw new Error(
							`tried to delete ${target.Name}/${target.Type} but it was not found in hosted zone`
						);
					}
					records.splice(idx, 1);
				}
			}
			return { ChangeInfo: { Id: 'C123', Status: 'PENDING' } };
		},
		listResourceRecordSets: async (
			input: Route53ListInput
		): Promise<Route53ListOutput> => {
			calls.push({ input, kind: 'list' });
			return { IsTruncated: false, ResourceRecordSets: [...records] };
		}
	};
	return { calls, client, state: () => [...records] };
};

const recordSet = (
	overrides: Partial<Route53ResourceRecordSet> = {}
): Route53ResourceRecordSet => ({
	Name: 'api.example.com.',
	ResourceRecords: [{ Value: '203.0.113.42' }],
	TTL: 300,
	Type: 'A',
	...overrides
});

// =============================================================================
// upsert — the canonical entry, exercises UPSERT action
// =============================================================================

describe('route53DnsProvider — upsert', () => {
	test('issues a single UPSERT change for create-or-update', async () => {
		const { calls, client, state } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 300,
			type: 'A'
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.kind).toBe('change');
		if (calls[0]?.kind === 'change') {
			expect(calls[0].input.ChangeBatch.Changes[0]?.Action).toBe('UPSERT');
			expect(calls[0].input.HostedZoneId).toBe(HOSTED_ZONE_ID);
		}
		expect(state()).toHaveLength(1);
		expect(state()[0]?.Name).toBe('api.example.com.');
		expect(state()[0]?.TTL).toBe(300);
	});

	test('UPSERT updates an existing record with new content', async () => {
		const { client, state } = makeStubClient([
			recordSet({ ResourceRecords: [{ Value: '198.51.100.1' }] })
		]);
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		expect(state()).toHaveLength(1);
		expect(state()[0]?.ResourceRecords?.[0]?.Value).toBe('203.0.113.42');
	});

	test('ensures trailing dot on record names', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		if (calls[0]?.kind === 'change') {
			expect(calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet.Name).toBe(
				'api.example.com.'
			);
		}
	});

	test('apex shorthand @ resolves to the zone name with trailing dot', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: '@',
			type: 'A'
		});
		if (calls[0]?.kind === 'change') {
			expect(calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet.Name).toBe(
				'example.com.'
			);
		}
	});

	test('default TTL kicks in when spec.ttl is omitted', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			defaultTtl: 60,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		if (calls[0]?.kind === 'change') {
			expect(calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet.TTL).toBe(
				60
			);
		}
	});
});

// =============================================================================
// TXT encoding — Route 53 requires "..." quoting on the wire
// =============================================================================

describe('route53DnsProvider — TXT value encoding', () => {
	test('wraps short TXT values in double quotes on write', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: 'acme-challenge-token-abc',
			name: '_acme-challenge.api.example.com',
			type: 'TXT'
		});
		if (calls[0]?.kind === 'change') {
			expect(
				calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet
					.ResourceRecords?.[0]?.Value
			).toBe('"acme-challenge-token-abc"');
		}
	});

	test('splits long TXT values into 255-byte quoted chunks', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		const long = 'x'.repeat(300);
		await provider.upsert({
			content: long,
			name: 'big.example.com',
			type: 'TXT'
		});
		if (calls[0]?.kind === 'change') {
			const written =
				calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet
					.ResourceRecords?.[0]?.Value;
			expect(written).toBe(`"${'x'.repeat(255)}" "${'x'.repeat(45)}"`);
		}
	});

	test('passes through values that are already quoted', async () => {
		const { calls, client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '"already-quoted"',
			name: 'tagged.example.com',
			type: 'TXT'
		});
		if (calls[0]?.kind === 'change') {
			expect(
				calls[0].input.ChangeBatch.Changes[0]?.ResourceRecordSet
					.ResourceRecords?.[0]?.Value
			).toBe('"already-quoted"');
		}
	});

	test('list decodes TXT values back to raw plaintext', async () => {
		const { client } = makeStubClient([
			recordSet({
				Name: '_acme-challenge.api.example.com.',
				ResourceRecords: [{ Value: '"acme-challenge-token-abc"' }],
				Type: 'TXT'
			})
		]);
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		const records = await provider.list();
		expect(records[0]?.content).toBe('acme-challenge-token-abc');
	});
});

// =============================================================================
// list / find — pagination, filtering, ambiguity
// =============================================================================

describe('route53DnsProvider — list + find', () => {
	test('list maps record sets to DnsRecord without trailing dot in name', async () => {
		const { client } = makeStubClient([recordSet()]);
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		const records = await provider.list();
		expect(records[0]?.name).toBe('api.example.com');
		expect(records[0]?.type).toBe('A');
		expect(records[0]?.content).toBe('203.0.113.42');
		expect(records[0]?.ttl).toBe(300);
	});

	test('list applies name + type filter client-side', async () => {
		const { client } = makeStubClient([
			recordSet({ Name: 'a.example.com.' }),
			recordSet({ Name: 'b.example.com.', Type: 'AAAA' })
		]);
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		const filtered = await provider.list({ name: 'a.example.com', type: 'A' });
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.name).toBe('a.example.com');
	});

	test('list paginates when IsTruncated is true', async () => {
		let page = 0;
		const client: Route53ClientLike = {
			changeResourceRecordSets: async () => {
				throw new Error('unused');
			},
			listResourceRecordSets: async () => {
				page += 1;
				if (page === 1) {
					return {
						IsTruncated: true,
						NextRecordName: 'b.example.com.',
						NextRecordType: 'A',
						ResourceRecordSets: [recordSet({ Name: 'a.example.com.' })]
					};
				}
				return {
					IsTruncated: false,
					ResourceRecordSets: [recordSet({ Name: 'b.example.com.' })]
				};
			}
		};
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		const records = await provider.list();
		expect(records).toHaveLength(2);
		expect(page).toBe(2);
	});

	test('find returns undefined when absent', async () => {
		const { client } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		expect(
			await provider.find({ name: 'absent.example.com', type: 'A' })
		).toBeUndefined();
	});
});

// =============================================================================
// delete — synthetic id round-trip
// =============================================================================

describe('route53DnsProvider — delete via synthetic id', () => {
	test('round-trip: upsert → find → delete removes the record', async () => {
		const { client, state } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			ttl: 300,
			type: 'A'
		});
		expect(state()).toHaveLength(1);
		const found = await provider.find({
			name: 'api.example.com',
			type: 'A'
		});
		expect(found).toBeDefined();
		await provider.delete(found!.id);
		expect(state()).toHaveLength(0);
	});

	test('delete is idempotent when the record no longer exists', async () => {
		const { client, state } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await provider.upsert({
			content: '203.0.113.42',
			name: 'api.example.com',
			type: 'A'
		});
		const found = await provider.find({
			name: 'api.example.com',
			type: 'A'
		});
		await provider.delete(found!.id);
		// Second delete with the same id should NOT throw.
		await expect(provider.delete(found!.id)).resolves.toBeUndefined();
		expect(state()).toHaveLength(0);
	});
});

// =============================================================================
// ensureDnsForTarget — full composition
// =============================================================================

describe('route53DnsProvider — composition', () => {
	test('ensureDnsForTarget points an A record at target.ipv4', async () => {
		const { client, state } = makeStubClient();
		const provider = route53DnsProvider({
			client,
			hostedZoneId: HOSTED_ZONE_ID,
			zoneName: ZONE_NAME
		});
		await ensureDnsForTarget(provider, {
			name: 'api.example.com',
			target: { ipv4: '198.51.100.42' },
			ttl: 60
		});
		expect(state()).toHaveLength(1);
		expect(state()[0]?.ResourceRecords?.[0]?.Value).toBe('198.51.100.42');
		expect(state()[0]?.TTL).toBe(60);
	});
});
