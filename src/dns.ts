/**
 * DNS provider contract for `@absolutejs/deploy`. Provider-specific
 * adapters (Cloudflare, Route 53, etc.) implement `DnsProvider`; the
 * deploy pipeline composes them with a cloud `Target` to point a
 * hostname at a freshly-provisioned IP.
 *
 * Operations are zone-scoped: a `DnsProvider` instance is bound to
 * one zone at construction time. Multi-zone hosts construct one
 * provider per zone.
 */

/** Record types we care about for deploy workflows. */
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';

/** A DNS record as it exists in the provider. */
export type DnsRecord = {
	/** Provider-assigned id (Cloudflare uuid, Route 53 set name, etc.). */
	id: string;
	/** Fully-qualified record name (`api.example.com.`). */
	name: string;
	type: DnsRecordType;
	/** Record value — IP for A/AAAA, hostname for CNAME, text for TXT, etc. */
	content: string;
	ttl?: number;
	/**
	 * Cloudflare's orange-cloud proxy flag. Other providers ignore this
	 * field. Default behavior is provider-specific: Cloudflare defaults
	 * to `true` (proxied) for new records when omitted.
	 */
	proxied?: boolean;
	comment?: string;
};

/** Desired state for an upsert. */
export type DnsRecordSpec = {
	/** Record name. May be `'@'` for the zone apex or relative ('api'). */
	name: string;
	type: DnsRecordType;
	content: string;
	ttl?: number;
	proxied?: boolean;
	comment?: string;
};

export type DnsRecordFilter = {
	name?: string;
	type?: DnsRecordType;
};

/**
 * Zone-scoped DNS operations. Implementations: `cloudflareProvider`,
 * future `route53Provider`, etc.
 */
export type DnsProvider = {
	/** Human-readable description for logs (`'cloudflare zone "example.com"'`). */
	readonly description: string;
	/** List records, optionally filtered by name + type. */
	list: (filter?: DnsRecordFilter) => Promise<DnsRecord[]>;
	/**
	 * Find one record by exact (name, type). Returns undefined if absent.
	 * Throws if multiple records share that key (drifted state — multiple
	 * A records pointing at different IPs, etc.).
	 */
	find: (key: {
		name: string;
		type: DnsRecordType;
	}) => Promise<DnsRecord | undefined>;
	create: (spec: DnsRecordSpec) => Promise<DnsRecord>;
	update: (id: string, spec: DnsRecordSpec) => Promise<DnsRecord>;
	delete: (id: string) => Promise<void>;
	/**
	 * Create or update so the (name, type) record matches `spec`. The
	 * canonical "point this DNS at this IP" entry point — idempotent.
	 */
	upsert: (spec: DnsRecordSpec) => Promise<DnsRecord>;
};

/**
 * Compose a DNS provider with a cloud Target's IPv4. Idempotently
 * ensures an A record (name → target.ipv4) exists. Returns the
 * resulting DNS record.
 *
 * Usage:
 *
 *   const target = await digitalOceanTarget({ ... });
 *   const dns = cloudflareProvider({ token, zoneId });
 *   await ensureDnsForTarget(dns, {
 *     name: 'api.example.com',
 *     target,
 *     ttl: 60,
 *     proxied: false,
 *   });
 */
export const ensureDnsForTarget = async (
	provider: DnsProvider,
	options: {
		/** Record name (FQDN, relative, or `'@'` for zone apex). */
		name: string;
		/** Cloud Target with an `ipv4` field. */
		target: { ipv4: string };
		/** Default 300s. */
		ttl?: number;
		/** Cloudflare orange-cloud. Other providers ignore. */
		proxied?: boolean;
		/** Optional record comment for audit trails. */
		comment?: string;
	}
): Promise<DnsRecord> =>
	provider.upsert({
		content: options.target.ipv4,
		name: options.name,
		type: 'A',
		...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
		...(options.proxied !== undefined ? { proxied: options.proxied } : {}),
		...(options.comment !== undefined ? { comment: options.comment } : {})
	});
