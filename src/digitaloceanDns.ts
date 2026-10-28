/**
 * @absolutejs/deploy/digitalocean-dns — DigitalOcean DNS implementing
 * the {@link DnsProvider} contract from `./dns`. Sibling to
 * `cloudflareProvider`; same shape, DO v2 API mappings.
 *
 * Reuses the existing `DigitalOceanClientLike` from the compute
 * adapter — one DO token covers both droplets and DNS.
 *
 * Scope: one provider instance is bound to one domain (zone). Pass
 * `'example.com'` as the domain; records `name` field is RELATIVE
 * to that domain (DO stores `'api'` not `'api.example.com'` in the
 * name column).
 */

import {
	createDigitalOceanClient,
	DigitalOceanError,
	type DigitalOceanClientLike
} from './digitalocean';
import type {
	DnsProvider,
	DnsRecord,
	DnsRecordFilter,
	DnsRecordSpec,
	DnsRecordType
} from './dns';

/** Raw DO DNS record from the API. */
type DigitalOceanDnsRecordRaw = {
	id: number;
	type: string;
	name: string;
	data: string;
	priority?: number | null;
	port?: number | null;
	ttl?: number;
	weight?: number | null;
	flags?: number | null;
	tag?: string | null;
};

export type DigitalOceanDnsProviderOptions = {
	token?: string;
	client?: DigitalOceanClientLike;
	/** The DO domain — e.g. `'example.com'`. */
	domain: string;
};

const resolveClient = (
	options: Pick<DigitalOceanDnsProviderOptions, 'client' | 'token'>
): DigitalOceanClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createDigitalOceanClient(options.token);
	}
	throw new Error(
		'[deploy/digitalocean-dns] either `token` or `client` must be provided'
	);
};

const fqdnFromRelative = (relativeName: string, domain: string): string => {
	if (relativeName === '@') return domain;
	// DO sometimes returns the bare relative name, sometimes appends a dot.
	if (relativeName.endsWith(`.${domain}`)) return relativeName;
	return `${relativeName}.${domain}`;
};

const relativeFromFqdn = (fqdn: string, domain: string): string => {
	const noTrailing = fqdn.endsWith('.') ? fqdn.slice(0, -1) : fqdn;
	if (noTrailing === domain) return '@';
	if (noTrailing.endsWith(`.${domain}`)) {
		return noTrailing.slice(0, -domain.length - 1);
	}
	return noTrailing;
};

const toDnsRecord = (raw: DigitalOceanDnsRecordRaw, domain: string): DnsRecord => ({
	content: raw.data,
	id: String(raw.id),
	name: fqdnFromRelative(raw.name, domain),
	type: raw.type as DnsRecordType,
	...(raw.ttl !== undefined ? { ttl: raw.ttl } : {})
});

const specMatchesRecord = (spec: DnsRecordSpec, record: DnsRecord): boolean => {
	if (record.content !== spec.content) return false;
	if (spec.ttl !== undefined && record.ttl !== spec.ttl) return false;
	return true;
};

export const digitalOceanDnsProvider = (
	options: DigitalOceanDnsProviderOptions
): DnsProvider => {
	const client = resolveClient(options);
	const { domain } = options;
	const recordsPath = `/domains/${encodeURIComponent(domain)}/records`;

	const fetchAll = async (): Promise<DnsRecord[]> => {
		// DO doesn't support per-name filtering — list everything (page_size=200).
		const body = await client.request<{
			domain_records: DigitalOceanDnsRecordRaw[];
		}>('GET', `${recordsPath}?per_page=200`);
		return body.domain_records.map((raw) => toDnsRecord(raw, domain));
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
				`[deploy/digitalocean-dns] multiple ${key.type} records for "${key.name}" in zone ${domain} — drifted state; resolve manually before upsert.`
			);
		}
		return matches[0];
	};

	const create = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const relative = relativeFromFqdn(spec.name, domain);
		const response = await client.request<{
			domain_record: DigitalOceanDnsRecordRaw;
		}>('POST', recordsPath, {
			data: spec.content,
			name: relative,
			type: spec.type,
			...(spec.ttl !== undefined ? { ttl: spec.ttl } : {})
		});
		return toDnsRecord(response.domain_record, domain);
	};

	const update = async (
		id: string,
		spec: DnsRecordSpec
	): Promise<DnsRecord> => {
		const relative = relativeFromFqdn(spec.name, domain);
		const response = await client.request<{
			domain_record: DigitalOceanDnsRecordRaw;
		}>('PUT', `${recordsPath}/${id}`, {
			data: spec.content,
			name: relative,
			type: spec.type,
			...(spec.ttl !== undefined ? { ttl: spec.ttl } : {})
		});
		return toDnsRecord(response.domain_record, domain);
	};

	const deleteRecord = async (id: string): Promise<void> => {
		try {
			await client.request('DELETE', `${recordsPath}/${id}`);
		} catch (error) {
			if (error instanceof DigitalOceanError && error.status === 404) return;
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
		description: `digitalocean dns zone "${domain}"`,
		find,
		list,
		update,
		upsert
	};
};
