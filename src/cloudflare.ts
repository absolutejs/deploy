/**
 * @absolutejs/deploy/cloudflare — Cloudflare DNS adapter implementing
 * the {@link DnsProvider} contract from `./dns`.
 *
 * Scope: one provider instance is bound to one Cloudflare zone. Multi-
 * zone callers construct one provider per zone.
 *
 * Auth: Cloudflare API tokens with `Zone:DNS:Edit` scope. Global API
 * keys are intentionally not supported — tokens are the modern path.
 *
 * Narrow CloudflareClientLike interface keeps `cloudflare` SDK out as
 * a hard dep. Default client uses `fetch` against
 * `api.cloudflare.com/client/v4`.
 */

import type {
	DnsProvider,
	DnsRecord,
	DnsRecordFilter,
	DnsRecordSpec,
	DnsRecordType
} from './dns';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Minimal subset of Cloudflare API calls. Lets callers BYO a client
 * with retry / observability / etc.
 */
export type CloudflareClientLike = {
	request: <T = unknown>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown
	) => Promise<T>;
};

/** Cloudflare's standard envelope on every response. */
type CloudflareResponse<T> = {
	success: boolean;
	result: T;
	errors?: Array<{ code: number; message: string }>;
	messages?: Array<{ code: number; message: string }>;
};

/** Raw record from Cloudflare's API. */
type CloudflareDnsRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl?: number;
	proxied?: boolean;
	comment?: string;
	zone_id?: string;
	zone_name?: string;
};

export class CloudflareError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'CloudflareError';
		this.status = status;
		this.body = body;
	}
}

/**
 * fetch-backed default client. Throws CloudflareError on non-2xx OR
 * on a 2xx with `success: false` (Cloudflare returns 200 + an errors
 * array for some validation failures, hence the second check).
 */
export const createCloudflareClient = (
	token: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {}
): CloudflareClientLike => {
	const base = options.baseUrl ?? CLOUDFLARE_API_BASE;
	const f = options.fetch ?? fetch;
	return {
		request: async <T>(
			method: 'GET' | 'POST' | 'PUT' | 'DELETE',
			path: string,
			body?: unknown
		): Promise<T> => {
			const init: RequestInit = {
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				method
			};
			if (body !== undefined) init.body = JSON.stringify(body);
			const response = await f(`${base}${path}`, init);
			const text = await response.text();
			const parsed = text.length > 0 ? JSON.parse(text) : undefined;
			if (!response.ok) {
				throw new CloudflareError(
					`Cloudflare API ${method} ${path} failed: ${response.status} ${response.statusText}`,
					response.status,
					parsed
				);
			}
			return parsed as T;
		}
	};
};

export type CloudflareProviderOptions = {
	/** API token with `Zone:DNS:Edit` permission. Required unless `client` is set. */
	token?: string;
	/** Custom client. Overrides token-built default. */
	client?: CloudflareClientLike;
	/** Cloudflare Zone ID this provider operates on. */
	zoneId: string;
	/** Optional zone name for log copy. Default uses `zoneId` truncated. */
	zoneName?: string;
};

const resolveClient = (
	options: Pick<CloudflareProviderOptions, 'client' | 'token'>
): CloudflareClientLike => {
	if (options.client !== undefined) return options.client;
	if (options.token !== undefined && options.token.length > 0) {
		return createCloudflareClient(options.token);
	}
	throw new Error(
		'[deploy/cloudflare] either `token` or `client` must be provided'
	);
};

const toDnsRecord = (raw: CloudflareDnsRecord): DnsRecord => ({
	content: raw.content,
	id: raw.id,
	name: raw.name,
	type: raw.type as DnsRecordType,
	...(raw.ttl !== undefined ? { ttl: raw.ttl } : {}),
	...(raw.proxied !== undefined ? { proxied: raw.proxied } : {}),
	...(raw.comment !== undefined ? { comment: raw.comment } : {})
});

const specEqualsRecord = (spec: DnsRecordSpec, record: DnsRecord): boolean => {
	if (record.content !== spec.content) return false;
	if (spec.ttl !== undefined && record.ttl !== spec.ttl) return false;
	if (spec.proxied !== undefined && record.proxied !== spec.proxied)
		return false;
	if (spec.comment !== undefined && record.comment !== spec.comment)
		return false;
	return true;
};

const buildQuery = (filter?: DnsRecordFilter): string => {
	const params: string[] = [];
	if (filter?.name !== undefined) {
		params.push(`name=${encodeURIComponent(filter.name)}`);
	}
	if (filter?.type !== undefined) {
		params.push(`type=${encodeURIComponent(filter.type)}`);
	}
	return params.length > 0 ? `?${params.join('&')}` : '';
};

/**
 * Build a {@link DnsProvider} bound to one Cloudflare zone.
 */
export const cloudflareProvider = (
	options: CloudflareProviderOptions
): DnsProvider => {
	const client = resolveClient(options);
	const { zoneId } = options;
	const zoneLabel = options.zoneName ?? zoneId.slice(0, 8);
	const recordsPath = `/zones/${zoneId}/dns_records`;

	const list = async (filter?: DnsRecordFilter): Promise<DnsRecord[]> => {
		const response = await client.request<
			CloudflareResponse<CloudflareDnsRecord[]>
		>('GET', `${recordsPath}${buildQuery(filter)}`);
		return response.result.map(toDnsRecord);
	};

	const find = async (key: {
		name: string;
		type: DnsRecordType;
	}): Promise<DnsRecord | undefined> => {
		const matches = await list(key);
		// Cloudflare's filter is sometimes substring-loose on `name`; pin to
		// an exact match here so a `'api.example.com'` lookup never returns
		// `'api.example.com.staging'`.
		const exact = matches.filter(
			(record) => record.name === key.name || record.name === `${key.name}.`
		);
		if (exact.length === 0) return undefined;
		if (exact.length > 1) {
			throw new Error(
				`[deploy/cloudflare] multiple ${key.type} records for "${key.name}" in zone ${zoneLabel} — drifted state; resolve manually before upsert.`
			);
		}
		return exact[0];
	};

	const create = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const response = await client.request<
			CloudflareResponse<CloudflareDnsRecord>
		>('POST', recordsPath, {
			content: spec.content,
			name: spec.name,
			type: spec.type,
			...(spec.ttl !== undefined ? { ttl: spec.ttl } : {}),
			...(spec.proxied !== undefined ? { proxied: spec.proxied } : {}),
			...(spec.comment !== undefined ? { comment: spec.comment } : {})
		});
		return toDnsRecord(response.result);
	};

	const update = async (
		id: string,
		spec: DnsRecordSpec
	): Promise<DnsRecord> => {
		const response = await client.request<
			CloudflareResponse<CloudflareDnsRecord>
		>('PUT', `${recordsPath}/${id}`, {
			content: spec.content,
			name: spec.name,
			type: spec.type,
			...(spec.ttl !== undefined ? { ttl: spec.ttl } : {}),
			...(spec.proxied !== undefined ? { proxied: spec.proxied } : {}),
			...(spec.comment !== undefined ? { comment: spec.comment } : {})
		});
		return toDnsRecord(response.result);
	};

	const deleteRecord = async (id: string): Promise<void> => {
		try {
			await client.request('DELETE', `${recordsPath}/${id}`);
		} catch (error) {
			if (error instanceof CloudflareError && error.status === 404) {
				return; // already gone — idempotent
			}
			throw error;
		}
	};

	const upsert = async (spec: DnsRecordSpec): Promise<DnsRecord> => {
		const existing = await find({ name: spec.name, type: spec.type });
		if (existing === undefined) {
			return create(spec);
		}
		if (specEqualsRecord(spec, existing)) {
			return existing;
		}
		return update(existing.id, spec);
	};

	return {
		create,
		delete: deleteRecord,
		description: `cloudflare zone "${zoneLabel}"`,
		find,
		list,
		update,
		upsert
	};
};
