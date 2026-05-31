/**
 * @absolutejs/deploy/tls — ACME (RFC 8555) client for Let's Encrypt and
 * compatible CAs. DNS-01 challenges only — uses the {@link DnsProvider}
 * abstraction from `./dns`, so the same Cloudflare / Route 53 /
 * Hetzner-DNS providers that point hostnames at boxes also satisfy
 * ACME's challenge requirement.
 *
 * Zero peer deps. Bun's `crypto.subtle` covers JWS signing and ECDSA
 * key generation; a small DER encoder builds the CSR.
 *
 * Public API:
 *
 *   issueCertificate({ domains, dnsProvider, email })
 *     → { certificatePem, privateKeyPem, account, domains }
 *
 *   installCertificateOnTarget(target, cert, { certPath, keyPath, reload? })
 *     → uploads PEM files via Target.upload + optional reload exec
 *
 *   exportAccountKey / importAccountKey for persistence between runs
 *     (reuse the same account across cert renewals — cheaper, doesn't
 *      hit Let's Encrypt's account-creation rate limit)
 */

import { X509Certificate } from 'node:crypto';
import type { Target } from './targets';
import type { DnsProvider } from './dns';

// =============================================================================
// Constants
// =============================================================================

export const LETSENCRYPT_PRODUCTION =
	'https://acme-v02.api.letsencrypt.org/directory';
export const LETSENCRYPT_STAGING =
	'https://acme-staging-v02.api.letsencrypt.org/directory';

// =============================================================================
// base64url
// =============================================================================

const base64UrlEncode = (bytes: Uint8Array | ArrayBuffer): string => {
	const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = '';
	for (const byte of buf) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const base64UrlEncodeString = (value: string): string =>
	base64UrlEncode(new TextEncoder().encode(value));

const base64UrlDecode = (value: string): Uint8Array => {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
		Math.ceil(value.length / 4) * 4,
		'='
	);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
};

// =============================================================================
// DER encoding (minimal subset for CSR)
// =============================================================================

const derLength = (length: number): Uint8Array => {
	if (length < 0x80) return Uint8Array.from([length]);
	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining & 0xff);
		remaining >>= 8;
	}
	return Uint8Array.from([0x80 | bytes.length, ...bytes]);
};

const derTag = (tag: number, payload: Uint8Array): Uint8Array => {
	const length = derLength(payload.length);
	const out = new Uint8Array(1 + length.length + payload.length);
	out[0] = tag;
	out.set(length, 1);
	out.set(payload, 1 + length.length);
	return out;
};

const derSeq = (children: Uint8Array[]): Uint8Array => {
	const total = children.reduce((sum, child) => sum + child.length, 0);
	const payload = new Uint8Array(total);
	let offset = 0;
	for (const child of children) {
		payload.set(child, offset);
		offset += child.length;
	}
	return derTag(0x30, payload);
};

const derSet = (children: Uint8Array[]): Uint8Array => {
	const total = children.reduce((sum, child) => sum + child.length, 0);
	const payload = new Uint8Array(total);
	let offset = 0;
	for (const child of children) {
		payload.set(child, offset);
		offset += child.length;
	}
	return derTag(0x31, payload);
};

const derInt = (value: number | Uint8Array): Uint8Array => {
	if (typeof value === 'number') {
		// Small unsigned int — used for the CSR version field (0).
		if (value === 0) return derTag(0x02, Uint8Array.from([0]));
		const bytes: number[] = [];
		let remaining = value;
		while (remaining > 0) {
			bytes.unshift(remaining & 0xff);
			remaining >>= 8;
		}
		if ((bytes[0] as number) & 0x80) bytes.unshift(0); // ensure positive
		return derTag(0x02, Uint8Array.from(bytes));
	}
	// Big-endian unsigned bytes — strip leading zeros, then prepend 0x00 if
	// the high bit is set (DER INTEGER is signed two's complement).
	let start = 0;
	while (start < value.length - 1 && value[start] === 0) start += 1;
	let payload = value.subarray(start);
	if ((payload[0] as number) & 0x80) {
		const padded = new Uint8Array(payload.length + 1);
		padded.set(payload, 1);
		payload = padded;
	}
	return derTag(0x02, payload);
};

const derOid = (oid: string): Uint8Array => {
	const parts = oid.split('.').map((part) => Number.parseInt(part, 10));
	const first = parts[0];
	const second = parts[1];
	if (first === undefined || second === undefined) {
		throw new Error(`[deploy/tls] invalid OID: ${oid}`);
	}
	const bytes: number[] = [first * 40 + second];
	for (let index = 2; index < parts.length; index += 1) {
		const value = parts[index] as number;
		const chunks: number[] = [];
		let remaining = value;
		do {
			chunks.unshift(remaining & 0x7f);
			remaining >>= 7;
		} while (remaining > 0);
		for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex += 1) {
			chunks[chunkIndex] = (chunks[chunkIndex] as number) | 0x80;
		}
		bytes.push(...chunks);
	}
	return derTag(0x06, Uint8Array.from(bytes));
};

const derPrintableString = (value: string): Uint8Array =>
	derTag(0x13, new TextEncoder().encode(value));

const derUtf8String = (value: string): Uint8Array =>
	derTag(0x0c, new TextEncoder().encode(value));

const derIa5String = (value: string): Uint8Array =>
	derTag(0x16, new TextEncoder().encode(value));

const derOctetString = (payload: Uint8Array): Uint8Array =>
	derTag(0x04, payload);

const derBitString = (payload: Uint8Array): Uint8Array => {
	// 0x00 prefix = number of unused bits in the final byte; for byte-aligned
	// signatures + keys this is always zero.
	const bits = new Uint8Array(payload.length + 1);
	bits[0] = 0;
	bits.set(payload, 1);
	return derTag(0x03, bits);
};

const derContextTag = (
	tag: number,
	payload: Uint8Array,
	constructed = true
): Uint8Array => derTag(0xa0 + tag + (constructed ? 0 : -0x20), payload);

// =============================================================================
// ECDSA signature: raw r||s ↔ DER SEQUENCE
// =============================================================================

const ecdsaRawToDer = (rawSig: Uint8Array): Uint8Array => {
	const half = rawSig.length / 2;
	const r = rawSig.subarray(0, half);
	const s = rawSig.subarray(half);
	return derSeq([derInt(r), derInt(s)]);
};

// =============================================================================
// JWS (RFC 7515) Flattened JSON Serialization for ACME
// =============================================================================

type JwsHeader = {
	alg: 'ES256';
	nonce: string;
	url: string;
	jwk?: JsonWebKey;
	kid?: string;
};

type JwsBody = {
	protected: string;
	payload: string;
	signature: string;
};

const signJws = async (
	privateKey: CryptoKey,
	header: JwsHeader,
	payload: object | string
): Promise<JwsBody> => {
	const protectedHeader = base64UrlEncodeString(JSON.stringify(header));
	const payloadEncoded =
		payload === ''
			? '' // POST-as-GET: empty string, NOT empty object
			: base64UrlEncodeString(JSON.stringify(payload));
	const signingInput = new TextEncoder().encode(
		`${protectedHeader}.${payloadEncoded}`
	);
	const rawSig = new Uint8Array(
		await crypto.subtle.sign(
			{ hash: 'SHA-256', name: 'ECDSA' },
			privateKey,
			signingInput
		)
	);
	return {
		payload: payloadEncoded,
		protected: protectedHeader,
		signature: base64UrlEncode(rawSig)
	};
};

// =============================================================================
// JWK helpers — canonical thumbprint, public-key extraction
// =============================================================================

const exportPublicJwk = async (publicKey: CryptoKey): Promise<JsonWebKey> => {
	const jwk = await crypto.subtle.exportKey('jwk', publicKey);
	// Strip private fields if the export included them (shouldn't, on a
	// public key, but be defensive).
	return {
		crv: jwk.crv,
		kty: jwk.kty,
		x: jwk.x,
		y: jwk.y
	};
};

const jwkThumbprint = async (publicJwk: JsonWebKey): Promise<string> => {
	// RFC 7638 — canonical JSON: required fields only, lex order.
	const canonical = JSON.stringify({
		crv: publicJwk.crv,
		kty: publicJwk.kty,
		x: publicJwk.x,
		y: publicJwk.y
	});
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical)
	);
	return base64UrlEncode(hash);
};

// =============================================================================
// Account key — generation + JSON export/import for persistence
// =============================================================================

export type AcmeAccount = {
	key: CryptoKeyPair;
	/** Account URL — set after first registration; persisted for renewals. */
	kid?: string;
};

export type AcmeAccountJson = {
	publicJwk: JsonWebKey;
	privateJwk: JsonWebKey;
	kid?: string;
};

export const generateAccountKey = async (): Promise<AcmeAccount> => {
	const key = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify']
	);
	return { key };
};

export const exportAccount = async (
	account: AcmeAccount
): Promise<AcmeAccountJson> => {
	const publicJwk = await crypto.subtle.exportKey('jwk', account.key.publicKey);
	const privateJwk = await crypto.subtle.exportKey(
		'jwk',
		account.key.privateKey
	);
	return {
		privateJwk,
		publicJwk,
		...(account.kid !== undefined ? { kid: account.kid } : {})
	};
};

export const importAccount = async (
	json: AcmeAccountJson
): Promise<AcmeAccount> => {
	const publicKey = await crypto.subtle.importKey(
		'jwk',
		json.publicJwk,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['verify']
	);
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		json.privateJwk,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign']
	);
	return {
		key: { privateKey, publicKey },
		...(json.kid !== undefined ? { kid: json.kid } : {})
	};
};

// =============================================================================
// CSR — Certificate Signing Request
// =============================================================================

const buildSanExtension = (domains: string[]): Uint8Array => {
	// SubjectAltName extension value: SEQUENCE OF GeneralName
	const generalNames = domains.map((domain) =>
		derTag(0x82, new TextEncoder().encode(domain))
	);
	const sanSequence = derSeq(generalNames);
	const extensionValue = derOctetString(sanSequence);
	return derSeq([derOid('2.5.29.17'), extensionValue]);
};

const buildExtensionRequestAttribute = (domains: string[]): Uint8Array => {
	const extensions = derSeq([buildSanExtension(domains)]);
	return derSeq([
		derOid('1.2.840.113549.1.9.14'), // PKCS#9 extensionRequest
		derSet([extensions])
	]);
};

const generateCertKeyPair = async (): Promise<CryptoKeyPair> =>
	crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify']
	);

const buildCsr = async (
	domains: string[],
	keypair: CryptoKeyPair
): Promise<Uint8Array> => {
	if (domains.length === 0) {
		throw new Error('[deploy/tls] CSR requires at least one domain');
	}
	const commonName = domains[0] as string;

	const spkiDer = new Uint8Array(
		await crypto.subtle.exportKey('spki', keypair.publicKey)
	);

	const version = derInt(0);
	const subject = derSeq([
		derSet([
			derSeq([
				derOid('2.5.4.3'), // commonName
				derUtf8String(commonName)
			])
		])
	]);

	const attributes = derContextTag(0, buildExtensionRequestAttribute(domains));

	const certificationRequestInfo = derSeq([
		version,
		subject,
		spkiDer,
		attributes
	]);

	const rawSig = new Uint8Array(
		await crypto.subtle.sign(
			{ hash: 'SHA-256', name: 'ECDSA' },
			keypair.privateKey,
			certificationRequestInfo as BufferSource
		)
	);
	const sigDer = ecdsaRawToDer(rawSig);

	const sigAlgorithm = derSeq([derOid('1.2.840.10045.4.3.2')]);
	// ecdsa-with-SHA256
	const signatureBits = derBitString(sigDer);

	return derSeq([certificationRequestInfo, sigAlgorithm, signatureBits]);
};

// =============================================================================
// PEM
// =============================================================================

const derToPem = (label: string, der: Uint8Array): string => {
	const b64 = btoa(String.fromCharCode(...der));
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};

const exportEcPrivateKeyPem = async (
	keypair: CryptoKeyPair
): Promise<string> => {
	const pkcs8 = new Uint8Array(
		await crypto.subtle.exportKey('pkcs8', keypair.privateKey)
	);
	return derToPem('PRIVATE KEY', pkcs8);
};

// =============================================================================
// ACME client
// =============================================================================

type AcmeDirectory = {
	newNonce: string;
	newAccount: string;
	newOrder: string;
};

type AcmeOrder = {
	status: string;
	identifiers: Array<{ type: string; value: string }>;
	authorizations: string[];
	finalize: string;
	certificate?: string;
};

type AcmeAuthorization = {
	status: string;
	identifier: { type: string; value: string };
	challenges: Array<{
		type: string;
		status: string;
		url: string;
		token: string;
	}>;
};

export type IssueCertificateOptions = {
	/** Domain(s) to include. First is the CN; all are SANs. */
	domains: string[];
	/** DNS provider used for DNS-01 challenges (must own the zone). */
	dnsProvider: DnsProvider;
	/** Contact email for the ACME account. */
	email: string;
	/** ACME directory URL. Default Let's Encrypt production. */
	directoryUrl?: string;
	/** Reuse an existing account. Pass `exportAccount`'s output via `importAccount`. */
	account?: AcmeAccount;
	/** Override fetch (tests). Default global fetch. */
	fetch?: typeof fetch;
	/** Poll interval. Default 3 s. */
	pollIntervalMs?: number;
	/**
	 * Max wait before notifying ACME that the DNS challenge is ready.
	 * Set ~30-60s for Cloudflare; longer for slower providers. Default 30 s.
	 */
	dnsPropagationDelayMs?: number;
	/** Max wait for the order to become valid. Default 5 min. */
	orderTimeoutMs?: number;
	/** Status log lines. */
	onLog?: (line: string) => void;
	/** Override sleep (tests). */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Optional pre-check: returns true when DNS has propagated globally.
	 * Default: just wait `dnsPropagationDelayMs` then proceed. Override
	 * for production to actually verify (e.g. resolve from multiple
	 * public resolvers).
	 */
	checkDnsPropagated?: (
		recordName: string,
		expectedValue: string
	) => Promise<boolean>;
};

export type IssuedCertificate = {
	certificatePem: string;
	privateKeyPem: string;
	account: AcmeAccount;
	domains: string[];
};

export class AcmeError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'AcmeError';
		this.status = status;
		this.body = body;
	}
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const issueCertificate = async (
	options: IssueCertificateOptions
): Promise<IssuedCertificate> => {
	const log = options.onLog ?? (() => {});
	const sleep = options.sleep ?? defaultSleep;
	const fetcher = options.fetch ?? fetch;
	const directoryUrl = options.directoryUrl ?? LETSENCRYPT_PRODUCTION;
	const pollMs = options.pollIntervalMs ?? 3_000;
	const dnsDelay = options.dnsPropagationDelayMs ?? 30_000;
	const orderTimeout = options.orderTimeoutMs ?? 5 * 60_000;
	const account = options.account ?? (await generateAccountKey());

	if (options.domains.length === 0) {
		throw new Error('[deploy/tls] at least one domain is required');
	}

	// 1. Fetch directory.
	log(`[tls] fetching ACME directory ${directoryUrl}`);
	const directoryResponse = await fetcher(directoryUrl);
	if (!directoryResponse.ok) {
		throw new AcmeError(
			`failed to fetch ACME directory: ${directoryResponse.status}`,
			directoryResponse.status,
			await directoryResponse.text()
		);
	}
	const directory = (await directoryResponse.json()) as AcmeDirectory;

	// 2. Get initial nonce.
	let nonce = await fetchNonce(fetcher, directory.newNonce);

	// Helper: signed POST. Tracks nonce; returns parsed JSON body + headers.
	const post = async (
		url: string,
		payload: object | string,
		identification: { kid?: string; jwk?: JsonWebKey }
	): Promise<{ status: number; body: unknown; headers: Headers }> => {
		const header: JwsHeader = {
			alg: 'ES256',
			nonce,
			url,
			...(identification.kid !== undefined ? { kid: identification.kid } : {}),
			...(identification.jwk !== undefined ? { jwk: identification.jwk } : {})
		};
		const jws = await signJws(account.key.privateKey, header, payload);
		const response = await fetcher(url, {
			body: JSON.stringify(jws),
			headers: { 'content-type': 'application/jose+json' },
			method: 'POST'
		});
		const newNonce = response.headers.get('replay-nonce');
		if (newNonce !== null) nonce = newNonce;
		const text = await response.text();
		const body =
			text.length > 0 && response.headers.get('content-type')?.includes('json')
				? JSON.parse(text)
				: text;
		if (!response.ok) {
			throw new AcmeError(
				`ACME ${url} → ${response.status}`,
				response.status,
				body
			);
		}
		return { body, headers: response.headers, status: response.status };
	};

	// 3. Register the account (or reuse if kid is set).
	const publicJwk = await exportPublicJwk(account.key.publicKey);
	if (account.kid === undefined) {
		log(`[tls] registering ACME account for ${options.email}`);
		const result = await post(
			directory.newAccount,
			{
				contact: [`mailto:${options.email}`],
				termsOfServiceAgreed: true
			},
			{ jwk: publicJwk }
		);
		account.kid = result.headers.get('location') ?? undefined;
		if (account.kid === undefined) {
			throw new Error(
				'[deploy/tls] ACME newAccount response missing Location header'
			);
		}
		log(`[tls] account registered: ${account.kid}`);
	} else {
		log(`[tls] reusing account ${account.kid}`);
	}

	const accountKid = account.kid;

	// 4. Submit the order.
	log(`[tls] submitting order for ${options.domains.join(', ')}`);
	const orderResult = await post(
		directory.newOrder,
		{
			identifiers: options.domains.map((domain) => ({
				type: 'dns',
				value: domain
			}))
		},
		{ kid: accountKid }
	);
	let order = orderResult.body as AcmeOrder;
	const orderUrl = orderResult.headers.get('location');
	if (orderUrl === null) {
		throw new Error(
			'[deploy/tls] ACME newOrder response missing Location header'
		);
	}

	// 5. For each authorization, complete the DNS-01 challenge.
	const cleanups: Array<() => Promise<void>> = [];
	const dnsCreated: Array<{
		recordId: string;
		recordName: string;
		recordValue: string;
	}> = [];

	try {
		const thumbprint = await jwkThumbprint(publicJwk);

		for (const authUrl of order.authorizations) {
			const authResult = await post(authUrl, '', { kid: accountKid });
			const auth = authResult.body as AcmeAuthorization;
			const challenge = auth.challenges.find((c) => c.type === 'dns-01');
			if (challenge === undefined) {
				throw new Error(
					`[deploy/tls] no dns-01 challenge for ${auth.identifier.value}`
				);
			}
			const keyAuthorization = `${challenge.token}.${thumbprint}`;
			const txtBytes = new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(keyAuthorization)
				)
			);
			const txtValue = base64UrlEncode(txtBytes);
			const recordName = `_acme-challenge.${auth.identifier.value}`;
			log(`[tls] DNS-01: setting ${recordName} = "${txtValue}"`);
			const record = await options.dnsProvider.upsert({
				content: txtValue,
				name: recordName,
				ttl: 60,
				type: 'TXT'
			});
			dnsCreated.push({
				recordId: record.id,
				recordName,
				recordValue: txtValue
			});
			cleanups.push(() => options.dnsProvider.delete(record.id));

			if (options.checkDnsPropagated !== undefined) {
				log('[tls] waiting for DNS propagation (custom checker)…');
				const deadline = Date.now() + dnsDelay;
				while (Date.now() < deadline) {
					if (
						await options.checkDnsPropagated(recordName, txtValue)
					) break;
					await sleep(pollMs);
				}
			} else {
				log(`[tls] sleeping ${dnsDelay}ms for DNS propagation`);
				await sleep(dnsDelay);
			}

			log(`[tls] notifying ACME of dns-01 readiness for ${auth.identifier.value}`);
			await post(challenge.url, {}, { kid: accountKid });

			// Poll the authorization until valid/invalid.
			const authDeadline = Date.now() + orderTimeout;
			while (Date.now() < authDeadline) {
				const polledResult = await post(authUrl, '', { kid: accountKid });
				const polled = polledResult.body as AcmeAuthorization;
				if (polled.status === 'valid') break;
				if (polled.status === 'invalid') {
					throw new Error(
						`[deploy/tls] authorization failed for ${auth.identifier.value}: ${JSON.stringify(polled.challenges)}`
					);
				}
				await sleep(pollMs);
			}
		}

		// 6. Finalize — generate cert keypair + CSR.
		log('[tls] generating cert keypair + CSR');
		const certKey = await generateCertKeyPair();
		const csrDer = await buildCsr(options.domains, certKey);
		const csr = base64UrlEncode(csrDer);

		await post(order.finalize, { csr }, { kid: accountKid });

		// 7. Poll the order until valid + certificate URL appears.
		const orderDeadline = Date.now() + orderTimeout;
		while (Date.now() < orderDeadline) {
			const refreshed = await post(orderUrl, '', { kid: accountKid });
			order = refreshed.body as AcmeOrder;
			if (order.status === 'valid' && order.certificate !== undefined) break;
			if (order.status === 'invalid') {
				throw new Error(
					`[deploy/tls] order failed: ${JSON.stringify(order)}`
				);
			}
			await sleep(pollMs);
		}

		if (order.certificate === undefined) {
			throw new Error('[deploy/tls] order timed out before issuing certificate');
		}

		// 8. Download the cert (PEM bundle).
		log(`[tls] downloading certificate from ${order.certificate}`);
		const certResult = await post(order.certificate, '', { kid: accountKid });
		const certificatePem =
			typeof certResult.body === 'string'
				? certResult.body
				: String(certResult.body);

		const privateKeyPem = await exportEcPrivateKeyPem(certKey);

		return {
			account,
			certificatePem,
			domains: options.domains,
			privateKeyPem
		};
	} finally {
		for (const cleanup of cleanups) {
			try {
				await cleanup();
			} catch (error) {
				log(`[tls] cleanup failed (continuing): ${String(error)}`);
			}
		}
		// Suppress unused-variable lint without changing behavior.
		void dnsCreated;
	}
};

const fetchNonce = async (
	fetcher: typeof fetch,
	url: string
): Promise<string> => {
	const response = await fetcher(url, { method: 'HEAD' });
	const nonce = response.headers.get('replay-nonce');
	if (nonce === null) {
		throw new Error('[deploy/tls] newNonce response missing Replay-Nonce header');
	}
	return nonce;
};

// =============================================================================
// installCertificateOnTarget
// =============================================================================

export type InstallCertificateOptions = {
	/** Remote path for the cert chain. Default `/etc/ssl/<firstDomain>/fullchain.pem`. */
	certPath?: string;
	/** Remote path for the private key. Default `/etc/ssl/<firstDomain>/privkey.pem`. */
	keyPath?: string;
	/** Mode (chmod) for the cert + key. Default `600`. */
	mode?: string;
	/** Owner (chown) for the cert + key. Default unchanged. */
	owner?: string;
	/** Optional reload command run after install (e.g. `'systemctl reload nginx'`). */
	reload?: string;
	/** Override the writeTo helper (tests). */
	writeFile?: (target: Target, path: string, contents: string) => Promise<void>;
};

const defaultWriteFile = async (
	target: Target,
	remotePath: string,
	contents: string
): Promise<void> => {
	const escaped = contents.replaceAll("'", "'\\''");
	await target.exec(`mkdir -p "$(dirname '${remotePath}')"`);
	await target.exec(`cat > '${remotePath}' <<'__ABS_TLS_EOF__'\n${contents}__ABS_TLS_EOF__\n`);
	void escaped;
};

/**
 * @internal — exposed for unit testing of cryptographic primitives.
 * Not part of the public API; consumers should NOT depend on this.
 */
export const __testing = {
	base64UrlDecode,
	base64UrlEncode,
	base64UrlEncodeString,
	buildCsr,
	derBitString,
	derInt,
	derOid,
	derSeq,
	derSet,
	ecdsaRawToDer,
	exportEcPrivateKeyPem,
	exportPublicJwk,
	generateCertKeyPair,
	jwkThumbprint,
	signJws
};

/**
 * Upload cert + private key to the target. Composable with the deploy
 * pipeline as a verify-step or post-deploy hook.
 */
export const installCertificateOnTarget = async (
	target: Target,
	cert: IssuedCertificate,
	options: InstallCertificateOptions = {}
): Promise<{ certPath: string; keyPath: string }> => {
	const domain = cert.domains[0];
	if (domain === undefined) {
		throw new Error('[deploy/tls] certificate has no domains');
	}
	const certPath = options.certPath ?? `/etc/ssl/${domain}/fullchain.pem`;
	const keyPath = options.keyPath ?? `/etc/ssl/${domain}/privkey.pem`;
	const mode = options.mode ?? '600';
	const writer = options.writeFile ?? defaultWriteFile;

	await writer(target, certPath, cert.certificatePem);
	await writer(target, keyPath, cert.privateKeyPem);
	await target.exec(`chmod ${mode} '${certPath}' '${keyPath}'`);
	if (options.owner !== undefined) {
		await target.exec(`chown ${options.owner} '${certPath}' '${keyPath}'`);
	}
	if (options.reload !== undefined) {
		await target.exec(options.reload);
	}

	return { certPath, keyPath };
};

// =============================================================================
// Certificate inspection + renewal scheduling
// =============================================================================

export type CertificateInspection = {
	/** CN + every SAN, deduplicated. */
	subjects: string[];
	/** Issuance time, ms since epoch. */
	validFrom: number;
	/** Expiration time, ms since epoch. */
	validTo: number;
	/** Whole days remaining before `validTo`. Negative if expired. */
	daysRemaining: number;
	/** True when the cert is past `validTo`. */
	expired: boolean;
	/** Issuer DN string (for "Let's Encrypt vs staging vs other CA" checks). */
	issuer: string;
};

const parseSubjects = (x509: X509Certificate): string[] => {
	const subjects = new Set<string>();
	const cnMatch = x509.subject.match(/CN=([^,\n]+)/);
	if (cnMatch !== null && cnMatch[1] !== undefined) {
		subjects.add(cnMatch[1].trim());
	}
	const san = x509.subjectAltName;
	if (san !== undefined && san !== null) {
		for (const part of san.split(',')) {
			const dnsMatch = part.trim().match(/^DNS:(.+)$/);
			if (dnsMatch !== null && dnsMatch[1] !== undefined) {
				subjects.add(dnsMatch[1].trim());
			}
		}
	}
	return [...subjects];
};

/**
 * Parse a PEM certificate into operator-shaped metadata. Used by
 * {@link renewCertificate} to decide whether to re-issue; also fine
 * for status pages and observability.
 */
export const inspectCertificate = (
	pem: string,
	options: { now?: () => number } = {}
): CertificateInspection => {
	const x509 = new X509Certificate(pem);
	const validFrom = new Date(x509.validFrom).getTime();
	const validTo = new Date(x509.validTo).getTime();
	const now = (options.now ?? Date.now)();
	const daysRemaining = Math.floor(
		(validTo - now) / (24 * 60 * 60 * 1000)
	);
	return {
		daysRemaining,
		expired: validTo < now,
		issuer: x509.issuer,
		subjects: parseSubjects(x509),
		validFrom,
		validTo
	};
};

export type RenewCertificateOptions = IssueCertificateOptions & {
	/**
	 * Current cert PEM. When provided, the cert's `validTo` decides
	 * whether to re-issue; when absent, renewal always issues.
	 */
	currentCertificatePem?: string;
	/**
	 * Re-issue when fewer than this many days remain. Default 30,
	 * matching certbot's standard schedule (Let's Encrypt issues 90-day
	 * certs; renewing at 30 days leaves a 60-day error budget).
	 */
	renewWhenDaysRemaining?: number;
	/** Force re-issue regardless of remaining days. Default false. */
	force?: boolean;
	/** Override `Date.now()` for testing. */
	now?: () => number;
};

export type RenewalResult =
	| {
			renewed: true;
			certificate: IssuedCertificate;
			reason: 'forced' | 'no-current-cert' | 'expiring-soon';
	  }
	| {
			renewed: false;
			reason: 'still-fresh';
			inspection: CertificateInspection;
	  };

/**
 * Conditional cert renewal. Parses the supplied cert (if any),
 * decides whether to re-issue based on remaining days, and either
 * returns the existing cert info ("still fresh") or issues a new
 * one via {@link issueCertificate}.
 *
 * Wire to a scheduled function (cron / @absolutejs/sync schedule /
 * GitHub Action) running at least once a week. Idempotent: a fresh
 * cert returns `renewed: false` cheaply (one PEM parse, zero
 * network IO).
 *
 * @example
 *   const result = await renewCertificate({
 *     currentCertificatePem: existingPem,  // omit to force first-issue
 *     domains: ['api.example.com'],
 *     dnsProvider: dns,
 *     email: 'ops@example.com',
 *     account: persistedAccount,           // reuse to avoid CA rate limit
 *   });
 *   if (result.renewed) {
 *     await installCertificateOnTarget(target, result.certificate, { reload });
 *   }
 */
export const renewCertificate = async (
	options: RenewCertificateOptions
): Promise<RenewalResult> => {
	const threshold = options.renewWhenDaysRemaining ?? 30;
	if (threshold < 0) {
		throw new Error(
			'[deploy/tls] renewWhenDaysRemaining must be non-negative'
		);
	}

	if (options.force === true) {
		const certificate = await issueCertificate(options);
		return { certificate, reason: 'forced', renewed: true };
	}

	if (options.currentCertificatePem === undefined) {
		const certificate = await issueCertificate(options);
		return { certificate, reason: 'no-current-cert', renewed: true };
	}

	const nowFn = options.now ?? Date.now;
	const inspection = inspectCertificate(options.currentCertificatePem, {
		now: nowFn
	});

	if (!inspection.expired && inspection.daysRemaining >= threshold) {
		return { inspection, reason: 'still-fresh', renewed: false };
	}

	const certificate = await issueCertificate(options);
	return { certificate, reason: 'expiring-soon', renewed: true };
};
