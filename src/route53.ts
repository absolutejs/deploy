/**
 * @absolutejs/deploy/route53 — AWS Route 53 DNS implementing the
 * {@link DnsProvider} contract from `./dns`.
 *
 * Different shape from Cloudflare/DO/Hetzner DNS: Route 53 has no
 * per-record id. Records are identified by their (Name, Type)
 * composite, and mutations are done via `ChangeResourceRecordSets`
 * with a batch of CREATE / UPSERT / DELETE actions. We exploit
 * Route 53's native `UPSERT` action — one API call replaces the
 * find-then-create-or-update dance the other providers need.
 *
 * Narrow `Route53ClientLike` interface so the package stays free
 * of an `@aws-sdk/client-route-53` dependency. Wire your existing
 * AWS SDK client with a 4-line shim — see README.
 */

import type {
	DnsProvider,
	DnsRecord,
	DnsRecordFilter,
	DnsRecordSpec,
	DnsRecordType
} from './dns';

// =============================================================================
// AWS API shapes — narrowed to what we use
// =============================================================================

export type Route53ResourceRecord = { Value: string };

export type Route53ResourceRecordSet = {
	Name: string;
	Type: string;
	TTL?: number;
	ResourceRecords?: Route53ResourceRecord[];
	AliasTarget?: {
		HostedZoneId: string;
		DNSName: string;
		EvaluateTargetHealth: boolean;
	};
	SetIdentifier?: string;
};

export type Route53Change = {
	Action: 'CREATE' | 'DELETE' | 'UPSERT';
	ResourceRecordSet: Route53ResourceRecordSet;
};

export type Route53ListInput = {
	HostedZoneId: string;
	StartRecordName?: string;
	StartRecordType?: string;
	MaxItems?: string;
};

export type Route53ListOutput = {
	ResourceRecordSets: Route53ResourceRecordSet[];
	IsTruncated?: boolean;
	NextRecordName?: string;
	NextRecordType?: string;
};

export type Route53ChangeInput = {
	HostedZoneId: string;
	ChangeBatch: { Changes: Route53Change[]; Comment?: string };
};

export type Route53ChangeOutput = {
	ChangeInfo: { Id: string; Status: string };
};

/**
 * Minimal subset of the Route 53 client we need. Wire your
 * `@aws-sdk/client-route-53` `Route53Client` with a shim:
 *
 * ```ts
 * import {
 *   Route53Client,
 *   ListResourceRecordSetsCommand,
 *   ChangeResourceRecordSetsCommand,
 * } from '@aws-sdk/client-route-53';
 *
 * const aws = new Route53Client({ region: 'us-east-1' });
 * const client: Route53ClientLike = {
 *   listResourceRecordSets: (input) =>
 *     aws.send(new ListResourceRecordSetsCommand(input)) as any,
 *   changeResourceRecordSets: (input) =>
 *     aws.send(new ChangeResourceRecordSetsCommand(input)) as any,
 * };
 * ```
 *
 * Or hand-roll a SigV4-signed fetch client if you want zero deps.
 */
export type Route53ClientLike = {
	listResourceRecordSets: (
		input: Route53ListInput
	) => Promise<Route53ListOutput>;
	changeResourceRecordSets: (
		input: Route53ChangeInput
	) => Promise<Route53ChangeOutput>;
};

export type Route53ProviderOptions = {
	client: Route53ClientLike;
	/** Hosted zone id, e.g. `'Z2FDTNDATAQYW2'`. */
	hostedZoneId: string;
	/** Zone name for log + name conversion, e.g. `'example.com'`. */
	zoneName: string;
	/** Default TTL when `spec.ttl` is omitted. Default 300. */
	defaultTtl?: number;
};

// =============================================================================
// Name + TXT-value normalization
// =============================================================================

const ensureFqdn = (name: string, zoneName: string): string => {
	if (name === '@') return ensureTrailingDot(zoneName);
	if (name === zoneName) return ensureTrailingDot(name);
	if (name.endsWith('.')) return name;
	return `${name}.`;
};

const ensureTrailingDot = (s: string): string => (s.endsWith('.') ? s : `${s}.`);

const stripTrailingDot = (s: string): string =>
	s.endsWith('.') ? s.slice(0, -1) : s;

/**
 * Route 53 TXT values MUST be enclosed in double quotes in the wire
 * format. Strings > 255 chars get split into multiple quoted chunks.
 * Bare unquoted input → wrap. Already-quoted input → pass through.
 */
const encodeTxtValue = (raw: string): string => {
	if (raw.startsWith('"') && raw.endsWith('"')) return raw;
	const CHUNK = 255;
	const chunks: string[] = [];
	for (let i = 0; i < raw.length; i += CHUNK) {
		chunks.push(`"${raw.slice(i, i + CHUNK).replaceAll('"', '\\"')}"`);
	}
	return chunks.join(' ');
};

/** Inverse of encodeTxtValue: unwrap " ... " " ... " back to raw. */
const decodeTxtValue = (wire: string): string => {
	const parts = wire.match(/"((?:\\.|[^"])*)"/g);
	if (parts === null) return wire;
	return parts
		.map((part) => part.slice(1, -1).replaceAll('\\"', '"'))
		.join('');
};

// =============================================================================
// Synthetic-id encoding — Route 53 has no per-record id
// =============================================================================

/**
 * Route 53 deletes require the CURRENT record state (Name + Type +
 * TTL + Values), not an opaque id. We encode that state as a
 * base64-JSON synthetic id so the DnsProvider contract (which
 * expects `delete(id)`) works without a second API round-trip.
 */
type Route53IdPayload = {
	n: string; // Name (FQDN with trailing dot)
	t: string; // Type
	v: string[]; // Values (as written to ResourceRecords[])
	l?: number; // TTL
};

const encodeId = (payload: Route53IdPayload): string =>
	btoa(JSON.stringify(payload))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');

const decodeId = (id: string): Route53IdPayload => {
	const padded = id
		.replaceAll('-', '+')
		.replaceAll('_', '/')
		.padEnd(Math.ceil(id.length / 4) * 4, '=');
	return JSON.parse(atob(padded)) as Route53IdPayload;
};

// =============================================================================
// Conversion: AWS RecordSet ↔ DnsRecord
// =============================================================================

const toDnsRecord = (
	set: Route53ResourceRecordSet,
	zoneName: string
): DnsRecord | undefined => {
	// Alias records (no ResourceRecords) don't fit our string-content model.
	const values = set.ResourceRecords?.map((r) => r.Value) ?? [];
	if (values.length === 0) return undefined;
	// For TXT, decode the wire format back to raw plaintext.
	const content =
		set.Type === 'TXT' ? decodeTxtValue(values.join(' ')) : (values[0] as string);
	const idPayload: Route53IdPayload = {
		n: set.Name,
		t: set.Type,
		v: values,
		...(set.TTL !== undefined ? { l: set.TTL } : {})
	};
	const fqdn = stripTrailingDot(set.Name);
	const name = fqdn === zoneName ? zoneName : fqdn;
	return {
		content,
		id: encodeId(idPayload),
		name,
		type: set.Type as DnsRecordType,
		...(set.TTL !== undefined ? { ttl: set.TTL } : {})
	};
};

const buildRecordSet = (
	spec: DnsRecordSpec,
	zoneName: string,
	defaultTtl: number
): Route53ResourceRecordSet => {
	const Name = ensureFqdn(spec.name, zoneName);
	const ttl = spec.ttl ?? defaultTtl;
	const value = spec.type === 'TXT' ? encodeTxtValue(spec.content) : spec.content;
	return {
		Name,
		ResourceRecords: [{ Value: value }],
		TTL: ttl,
		Type: spec.type
	};
};

// =============================================================================
// Provider factory
// =============================================================================

export const route53DnsProvider = (
	options: Route53ProviderOptions
): DnsProvider => {
	const { client, hostedZoneId, zoneName } = options;
	const defaultTtl = options.defaultTtl ?? 300;
	const zoneLabel = zoneName;

	const fetchAll = async (
		filter?: DnsRecordFilter
	): Promise<DnsRecord[]> => {
		const out: DnsRecord[] = [];
		let startName: string | undefined;
		let startType: string | undefined;
		for (;;) {
			const params: Route53ListInput = {
				HostedZoneId: hostedZoneId,
				MaxItems: '500',
				...(startName !== undefined ? { StartRecordName: startName } : {}),
				...(startType !== undefined ? { StartRecordType: startType } : {})
			};
			const page = await client.listResourceRecordSets(params);
			for (const set of page.ResourceRecordSets) {
				const dnsRecord = toDnsRecord(set, zoneName);
				if (dnsRecord === undefined) continue;
				if (
					filter?.name !== undefined &&
					dnsRecord.name !== filter.name
				) {
					continue;
				}
				if (
					filter?.type !== undefined &&
					dnsRecord.type !== filter.type
				) {
					continue;
				}
				out.push(dnsRecord);
			}
			if (page.IsTruncated !== true) break;
			startName = page.NextRecordName;
			startType = page.NextRecordType;
		}
		return out;
	};

	const list = (filter?: DnsRecordFilter): Promise<DnsRecord[]> =>
		fetchAll(filter);

	const find = async (key: {
		name: string;
		type: DnsRecordType;
	}): Promise<DnsRecord | undefined> => {
		const matches = await fetchAll(key);
		if (matches.length === 0) return undefined;
		if (matches.length > 1) {
			throw new Error(
				`[deploy/route53] multiple ${key.type} records for "${key.name}" in zone ${zoneLabel} — drifted state; resolve manually before upsert.`
			);
		}
		return matches[0];
	};

	const submitChange = async (change: Route53Change): Promise<void> => {
		await client.changeResourceRecordSets({
			ChangeBatch: { Changes: [change] },
			HostedZoneId: hostedZoneId
		});
	};

	const create = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const set = buildRecordSet(spec, zoneName, defaultTtl);
		await submitChange({ Action: 'CREATE', ResourceRecordSet: set });
		const synthesized = toDnsRecord(set, zoneName);
		if (synthesized === undefined) {
			throw new Error(
				'[deploy/route53] internal: built record had no ResourceRecords'
			);
		}
		return synthesized;
	};

	const upsert = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const set = buildRecordSet(spec, zoneName, defaultTtl);
		await submitChange({ Action: 'UPSERT', ResourceRecordSet: set });
		const synthesized = toDnsRecord(set, zoneName);
		if (synthesized === undefined) {
			throw new Error(
				'[deploy/route53] internal: built record had no ResourceRecords'
			);
		}
		return synthesized;
	};

	const update = async (
		_id: string,
		spec: DnsRecordSpec
	): Promise<DnsRecord> => upsert(spec);

	const deleteRecord = async (id: string): Promise<void> => {
		// Route 53's DELETE requires the exact current state. We reconstruct
		// it from the synthetic id we issued at read/write time.
		const payload = decodeId(id);
		const set: Route53ResourceRecordSet = {
			Name: payload.n,
			ResourceRecords: payload.v.map((Value) => ({ Value })),
			Type: payload.t,
			...(payload.l !== undefined ? { TTL: payload.l } : {})
		};
		try {
			await submitChange({ Action: 'DELETE', ResourceRecordSet: set });
		} catch (error) {
			// Route 53 throws InvalidChangeBatch when the record doesn't exist
			// (or its state has drifted from what we encoded). Treat the
			// "doesn't exist" subset as idempotent success.
			const message =
				error instanceof Error ? error.message : String(error);
			if (
				message.includes('not found') ||
				message.includes('NoSuchHostedZone') ||
				message.includes(
					'but it was not found'
				)
			) {
				return;
			}
			throw error;
		}
	};

	return {
		create,
		delete: deleteRecord,
		description: `route53 zone "${zoneLabel}"`,
		find,
		list,
		update,
		upsert
	};
};
