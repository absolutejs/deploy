/**
 * @absolutejs/deploy/hetzner-dns — Hetzner DNS implementing the
 * {@link DnsProvider} contract from `./dns`.
 *
 * NOTE: Hetzner DNS is a SEPARATE service from Hetzner Cloud (compute).
 *   - Compute API: https://api.hetzner.cloud/v1, token = Bearer
 *   - DNS API:     https://dns.hetzner.com/api/v1, token = Auth-API-Token header
 *
 * Different auth header AND different base URL — get them confused
 * and every request fails. We use a separate client type +
 * `createHetznerDnsClient` factory to keep them distinct.
 *
 * Scope: one provider instance is bound to one zone (referenced by
 * `zoneId`). DNS record names in Hetzner are FQDN-style for the
 * apex (`'@'`) and relative for subdomains (`'api'` not
 * `'api.example.com'`).
 */

import type {
	DnsProvider,
	DnsRecord,
	DnsRecordFilter,
	DnsRecordSpec,
	DnsRecordType
} from './dns';

const HETZNER_DNS_API_BASE = 'https://dns.hetzner.com/api/v1';

export type HetznerDnsClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown
	) => Promise<T>;
};

type HetznerDnsRecordRaw = {
	id: string;
	type: string;
	name: string;
	value: string;
	ttl?: number;
	zone_id: string;
};

export class HetznerDnsError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'HetznerDnsError';
		this.status = status;
		this.body = body;
	}
}

/**
 * fetch-backed default client. Uses Hetzner DNS's `Auth-API-Token`
 * header — NOT the Bearer-style auth used by Hetzner Cloud compute.
 */
export const createHetznerDnsClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): HetznerDnsClientLike => {
	const base = options.baseUrl ?? HETZNER_DNS_API_BASE;
	const f = options.fetch ?? fetch;
	return {
		request: async <T>(
			method: 'GET' | 'POST' | 'PUT' | 'DELETE',
			path: string,
			body?: unknown
		): Promise<T> => {
			const init: RequestInit = {
				headers: {
					'auth-api-token': token,
					'content-type': 'application/json'
				},
				method
			};
			if (body !== undefined) init.body = JSON.stringify(body);
			const response = await f(`${base}${path}`, init);
			if (response.status === 204) return undefined as T;
			const text = await response.text();
			const parsed = text.length > 0 ? JSON.parse(text) : undefined;
			if (!response.ok) {
				throw new HetznerDnsError(
					`Hetzner DNS API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

export type HetznerDnsProviderOptions = {
	token?: string;
	client?: HetznerDnsClientLike;
	/** Hetzner DNS zone id (UUID-shaped). */
	zoneId: string;
	/** Optional zone name for log + record-name conversion. */
	zoneName?: string;
};

const resolveClient = (
	options: Pick<HetznerDnsProviderOptions, 'client' | 'token'>
): HetznerDnsClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createHetznerDnsClient(options.token);
	}
	throw new Error(
		'[deploy/hetzner-dns] either `token` or `client` must be provided'
	);
};

const fqdnFromRelative = (relativeName: string, zoneName: string): string => {
	if (relativeName === '@') return zoneName;
	if (zoneName === '') return relativeName;
	if (relativeName.endsWith(`.${zoneName}`)) return relativeName;
	return `${relativeName}.${zoneName}`;
};

const relativeFromFqdn = (fqdn: string, zoneName: string): string => {
	if (zoneName === '') return fqdn;
	const noTrailing = fqdn.endsWith('.') ? fqdn.slice(0, -1) : fqdn;
	if (noTrailing === zoneName) return '@';
	if (noTrailing.endsWith(`.${zoneName}`)) {
		return noTrailing.slice(0, -zoneName.length - 1);
	}
	return noTrailing;
};

const specMatchesRecord = (spec: DnsRecordSpec, record: DnsRecord): boolean => {
	if (record.content !== spec.content) return false;
	if (spec.ttl !== undefined && record.ttl !== spec.ttl) return false;
	return true;
};

export const hetznerDnsProvider = (
	options: HetznerDnsProviderOptions
): DnsProvider => {
	const client = resolveClient(options);
	const { zoneId } = options;
	const zoneName = options.zoneName ?? '';
	const zoneLabel = zoneName !== '' ? zoneName : zoneId;

	const toDnsRecord = (raw: HetznerDnsRecordRaw): DnsRecord => ({
		content: raw.value,
		id: raw.id,
		name: fqdnFromRelative(raw.name, zoneName),
		type: raw.type as DnsRecordType,
		...(raw.ttl !== undefined ? { ttl: raw.ttl } : {})
	});

	const fetchAll = async (): Promise<DnsRecord[]> => {
		const body = await client.request<{ records: HetznerDnsRecordRaw[] }>(
			'GET',
			`/records?zone_id=${encodeURIComponent(zoneId)}&per_page=200`
		);
		return body.records.map(toDnsRecord);
	};

	const list = async (filter?: DnsRecordFilter): Promise<DnsRecord[]> => {
		const all = await fetchAll();
		return all.filter((record) => {
			if (filter?.name !== undefined && record.name !== filter.name) {
				return false;
			}
			if (filter?.type !== undefined && record.type !== filter.type) {
				return false;
			}
			return true;
		});
	};

	const find = async (key: {
		name: string;
		type: DnsRecordType;
	}): Promise<DnsRecord | undefined> => {
		const matches = (await fetchAll()).filter(
			(record) => record.name === key.name && record.type === key.type
		);
		if (matches.length === 0) return undefined;
		if (matches.length > 1) {
			throw new Error(
				`[deploy/hetzner-dns] multiple ${key.type} records for "${key.name}" in zone ${zoneLabel} — drifted state; resolve manually before upsert.`
			);
		}
		return matches[0];
	};

	const create = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const relative = relativeFromFqdn(spec.name, zoneName);
		const response = await client.request<{ record: HetznerDnsRecordRaw }>(
			'POST',
			'/records',
			{
				name: relative,
				type: spec.type,
				value: spec.content,
				zone_id: zoneId,
				...(spec.ttl !== undefined ? { ttl: spec.ttl } : {})
			}
		);
		return toDnsRecord(response.record);
	};

	const update = async (
		id: string,
		spec: DnsRecordSpec
	): Promise<DnsRecord> => {
		const relative = relativeFromFqdn(spec.name, zoneName);
		const response = await client.request<{ record: HetznerDnsRecordRaw }>(
			'PUT',
			`/records/${id}`,
			{
				name: relative,
				type: spec.type,
				value: spec.content,
				zone_id: zoneId,
				...(spec.ttl !== undefined ? { ttl: spec.ttl } : {})
			}
		);
		return toDnsRecord(response.record);
	};

	const deleteRecord = async (id: string): Promise<void> => {
		try {
			await client.request('DELETE', `/records/${id}`);
		} catch (error) {
			if (error instanceof HetznerDnsError && error.status === 404) return;
			throw error;
		}
	};

	const upsert = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const existing = await find({ name: spec.name, type: spec.type });
		if (existing === undefined) return create(spec);
		if (specMatchesRecord(spec, existing)) return existing;
		return update(existing.id, spec);
	};

	return {
		create,
		delete: deleteRecord,
		description: `hetzner dns zone "${zoneLabel}"`,
		find,
		list,
		update,
		upsert
	};
};
