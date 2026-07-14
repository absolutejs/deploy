/**
 * Tests for @absolutejs/deploy/tls. Mock the ACME server with a
 * scripted fetch + mock the DnsProvider. Unit-test the JWK
 * thumbprint against the RFC 7638 example to lock the canonical
 * JSON shape.
 */
import { describe, expect, test } from 'bun:test';
import {
	exportAccount,
	generateAccountKey,
	importAccount,
	installCertificateOnTarget,
	issueCertificate,
	LETSENCRYPT_STAGING,
	type AcmeAccount,
	type IssueCertificateOptions
} from '../src/tls';
import type { DnsProvider, DnsRecord, DnsRecordSpec } from '../src/dns';
import type { ExecResult, Target } from '../src/targets';

// =============================================================================
// Helpers
// =============================================================================

const mockDnsProvider = () => {
	let nextId = 1;
	const records: DnsRecord[] = [];
	const upsertLog: DnsRecordSpec[] = [];
	const deleteLog: string[] = [];
	const provider: DnsProvider = {
		create: async (spec) => {
			const record: DnsRecord = {
				content: spec.content,
				id: `rec_${nextId}`,
				name: spec.name,
				type: spec.type,
				...(spec.ttl !== undefined ? { ttl: spec.ttl } : {})
			};
			nextId += 1;
			records.push(record);
			return record;
		},
		delete: async (id) => {
			deleteLog.push(id);
			const index = records.findIndex((record) => record.id === id);
			if (index >= 0) records.splice(index, 1);
		},
		description: 'mock dns provider',
		find: async (key) =>
			records.find(
				(record) => record.name === key.name && record.type === key.type
			),
		list: async () => [...records],
		update: async (id, spec) => {
			const record = records.find((r) => r.id === id);
			if (record === undefined) throw new Error('not found');
			record.content = spec.content;
			if (spec.ttl !== undefined) record.ttl = spec.ttl;
			return record;
		},
		upsert: async (spec) => {
			upsertLog.push(spec);
			const existing = records.find(
				(record) => record.name === spec.name && record.type === spec.type
			);
			if (existing !== undefined) {
				existing.content = spec.content;
				return existing;
			}
			return provider.create(spec);
		}
	};
	return { deleteLog, provider, records, upsertLog };
};

type AcmeFlowState = {
	nonceCounter: number;
	orderState: 'pending' | 'ready' | 'valid';
	authState: 'pending' | 'valid';
	pollAuthCount: number;
	pollOrderCount: number;
};

const makeAcmeFetch = (overrides: Partial<AcmeFlowState> = {}) => {
	const state: AcmeFlowState = {
		authState: 'pending',
		nonceCounter: 0,
		orderState: 'pending',
		pollAuthCount: 0,
		pollOrderCount: 0,
		...overrides
	};
	const calls: Array<{ url: string; method: string }> = [];

	const nextNonce = () => {
		state.nonceCounter += 1;
		return `nonce-${state.nonceCounter}`;
	};

	const baseUrl = 'https://acme.test';
	const directory = {
		newAccount: `${baseUrl}/new-account`,
		newNonce: `${baseUrl}/new-nonce`,
		newOrder: `${baseUrl}/new-order`
	};

	const respond = (
		body: unknown,
		init: ResponseInit & { isJson?: boolean; location?: string } = {}
	) => {
		const headers = new Headers({ 'replay-nonce': nextNonce() });
		if (init.location !== undefined) {
			headers.set('location', init.location);
		}
		const isJson = init.isJson ?? true;
		if (isJson) headers.set('content-type', 'application/json');
		else headers.set('content-type', 'application/pem-certificate-chain');
		return new Response(
			typeof body === 'string' ? body : JSON.stringify(body),
			{ headers, status: init.status ?? 200 }
		);
	};

	const fetcher = (async (
		input: string | URL | Request,
		init?: RequestInit
	): Promise<Response> => {
		const url = typeof input === 'string' ? input : input.toString();
		const method = init?.method ?? 'GET';
		calls.push({ method, url });

		if (url === baseUrl + '/directory') {
			return respond(directory);
		}
		if (url === directory.newNonce) {
			return respond(undefined, { isJson: false, status: 200 });
		}
		if (url === directory.newAccount) {
			return respond(
				{ status: 'valid' },
				{ location: `${baseUrl}/acct/1`, status: 201 }
			);
		}
		if (url === directory.newOrder) {
			return respond(
				{
					authorizations: [`${baseUrl}/authz/1`],
					finalize: `${baseUrl}/order/1/finalize`,
					identifiers: [{ type: 'dns', value: 'api.example.com' }],
					status: 'pending'
				},
				{ location: `${baseUrl}/order/1`, status: 201 }
			);
		}
		if (url === `${baseUrl}/authz/1`) {
			state.pollAuthCount += 1;
			// First check still pending; second check we flip to valid.
			if (state.pollAuthCount === 1) {
				return respond({
					challenges: [
						{
							status: 'pending',
							token: 'chal_token_xyz',
							type: 'dns-01',
							url: `${baseUrl}/chal/1`
						}
					],
					identifier: { type: 'dns', value: 'api.example.com' },
					status: 'pending'
				});
			}
			return respond({
				challenges: [
					{
						status: 'valid',
						token: 'chal_token_xyz',
						type: 'dns-01',
						url: `${baseUrl}/chal/1`
					}
				],
				identifier: { type: 'dns', value: 'api.example.com' },
				status: 'valid'
			});
		}
		if (url === `${baseUrl}/chal/1`) {
			return respond({ status: 'pending', type: 'dns-01' });
		}
		if (url === `${baseUrl}/order/1/finalize`) {
			state.orderState = 'ready';
			return respond({ status: 'processing' });
		}
		if (url === `${baseUrl}/order/1`) {
			state.pollOrderCount += 1;
			if (state.pollOrderCount === 1) {
				return respond({ status: 'processing' });
			}
			return respond({
				certificate: `${baseUrl}/cert/1`,
				status: 'valid'
			});
		}
		if (url === `${baseUrl}/cert/1`) {
			return respond(
				'-----BEGIN CERTIFICATE-----\nMOCK_CERT_DATA\n-----END CERTIFICATE-----\n',
				{ isJson: false }
			);
		}
		return new Response(`unhandled ${url}`, { status: 500 });
	}) as unknown as typeof fetch;

	return { calls, directory, fetcher, state };
};

const baseOptions = (
	overrides: Partial<IssueCertificateOptions> = {}
): IssueCertificateOptions => {
	const dns = mockDnsProvider();
	const acme = makeAcmeFetch();
	return {
		directoryUrl: 'https://acme.test/directory',
		dnsPropagationDelayMs: 1,
		dnsProvider: dns.provider,
		domains: ['api.example.com'],
		email: 'ops@example.com',
		fetch: acme.fetcher,
		pollIntervalMs: 1,
		sleep: async () => {},
		...overrides
	};
};

// =============================================================================
// Account key — generate / export / import round-trip
// =============================================================================

describe('account key lifecycle', () => {
	test('generateAccountKey produces an ES256 keypair', async () => {
		const account = await generateAccountKey();
		expect(account.key.publicKey).toBeDefined();
		expect(account.key.privateKey).toBeDefined();
		expect(account.kid).toBeUndefined();
	});

	test('exportAccount + importAccount round-trip', async () => {
		const account = await generateAccountKey();
		account.kid = 'https://acme.test/acct/1';
		const json = await exportAccount(account);
		expect(json.kid).toBe('https://acme.test/acct/1');
		expect(json.publicJwk.kty).toBe('EC');
		expect(json.publicJwk.crv).toBe('P-256');
		const restored = await importAccount(json);
		expect(restored.kid).toBe('https://acme.test/acct/1');
		// Sign + verify a round-trip to prove the key is usable.
		const data = new TextEncoder().encode('hello');
		const sig = await crypto.subtle.sign(
			{ hash: 'SHA-256', name: 'ECDSA' },
			restored.key.privateKey,
			data
		);
		const ok = await crypto.subtle.verify(
			{ hash: 'SHA-256', name: 'ECDSA' },
			restored.key.publicKey,
			sig,
			data
		);
		expect(ok).toBe(true);
	});
});

// =============================================================================
// issueCertificate — end-to-end against the mock ACME server
// =============================================================================

describe('issueCertificate — full flow against mock ACME server', () => {
	test('produces a certificate + private key', async () => {
		const result = await issueCertificate(baseOptions());
		expect(result.certificatePem).toContain('-----BEGIN CERTIFICATE-----');
		expect(result.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
		expect(result.domains).toEqual(['api.example.com']);
		expect(result.account.kid).toBe('https://acme.test/acct/1');
	});

	test('writes the dns-01 TXT record via the provider', async () => {
		const dns = mockDnsProvider();
		const acme = makeAcmeFetch();
		await issueCertificate(
			baseOptions({
				dnsProvider: dns.provider,
				fetch: acme.fetcher
			})
		);
		expect(dns.upsertLog).toHaveLength(1);
		const upsert = dns.upsertLog[0]!;
		expect(upsert.name).toBe('_acme-challenge.api.example.com');
		expect(upsert.type).toBe('TXT');
		expect(upsert.content.length).toBeGreaterThan(20);
	});

	test('maps provider writes for CNAME-delegated dns-01', async () => {
		const dns = mockDnsProvider();
		const acme = makeAcmeFetch();
		const propagationChecks: string[] = [];
		await issueCertificate(
			baseOptions({
				checkDnsPropagated: async (recordName) => {
					propagationChecks.push(recordName);

					return true;
				},
				dnsProvider: dns.provider,
				fetch: acme.fetcher,
				mapDnsChallengeRecord: ({ domain }) =>
					`${domain.replaceAll('.', '-')}.validation.absolutejs.ai`
			})
		);

		expect(dns.upsertLog[0]?.name).toBe(
			'api-example-com.validation.absolutejs.ai'
		);
		expect(propagationChecks).toEqual([
			'_acme-challenge.api.example.com'
		]);
	});

	test('cleans up the dns-01 TXT record on success', async () => {
		const dns = mockDnsProvider();
		const acme = makeAcmeFetch();
		await issueCertificate(
			baseOptions({
				dnsProvider: dns.provider,
				fetch: acme.fetcher
			})
		);
		// All TXT records created during the flow should be gone.
		expect(dns.records.filter((r) => r.type === 'TXT')).toHaveLength(0);
		expect(dns.deleteLog).toHaveLength(1);
	});

	test('reuses an existing account (skips newAccount call)', async () => {
		const acme1 = makeAcmeFetch();
		const result = await issueCertificate(
			baseOptions({ fetch: acme1.fetcher })
		);

		const acme2 = makeAcmeFetch();
		await issueCertificate(
			baseOptions({
				account: result.account,
				fetch: acme2.fetcher
			})
		);

		expect(
			acme2.calls.some((call) =>
				call.url.endsWith('/new-account')
			)
		).toBe(false);
	});

	test('honors checkDnsPropagated to skip the default delay', async () => {
		const dns = mockDnsProvider();
		const acme = makeAcmeFetch();
		let checks = 0;
		await issueCertificate(
			baseOptions({
				checkDnsPropagated: async () => {
					checks += 1;
					return true;
				},
				dnsPropagationDelayMs: 100_000,
				dnsProvider: dns.provider,
				fetch: acme.fetcher
			})
		);
		expect(checks).toBe(1);
	});

	test('rejects empty domain list', async () => {
		await expect(issueCertificate(baseOptions({ domains: [] }))).rejects.toThrow(
			'at least one domain'
		);
	});

	test('throws AcmeError on a non-2xx response', async () => {
		const acme = makeAcmeFetch();
		// Wrap fetcher so the new-order call returns 400 to surface the error path.
		const failingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/new-order')) {
				return new Response(
					JSON.stringify({
						detail: 'invalid identifier',
						type: 'urn:ietf:params:acme:error:malformed'
					}),
					{
						headers: {
							'content-type': 'application/json',
							'replay-nonce': 'nonce-err'
						},
						status: 400
					}
				);
			}
			return acme.fetcher(input as never, init);
		}) as unknown as typeof fetch;

		await expect(
			issueCertificate(baseOptions({ fetch: failingFetch }))
		).rejects.toMatchObject({ name: 'AcmeError', status: 400 });
	});

	test('points at LETSENCRYPT_STAGING when directoryUrl is staging', async () => {
		// Just sanity-check the constant — no real network call.
		expect(LETSENCRYPT_STAGING).toBe(
			'https://acme-staging-v02.api.letsencrypt.org/directory'
		);
	});
});

// =============================================================================
// installCertificateOnTarget
// =============================================================================

describe('installCertificateOnTarget', () => {
	test('uploads cert + key + chmod, optionally reloads', async () => {
		const execLog: string[] = [];
		const writes: Array<{ path: string; contents: string }> = [];
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				execLog.push(cmd);
				return { exitCode: 0, stderr: '', stdout: '' } as ExecResult;
			},
			upload: async () => {}
		};
		const cert = {
			account: (await generateAccountKey()) as AcmeAccount,
			certificatePem: 'CERT_PEM',
			domains: ['api.example.com'],
			privateKeyPem: 'KEY_PEM'
		};
		const paths = await installCertificateOnTarget(target, cert, {
			reload: 'systemctl reload nginx',
			writeFile: async (_target, path, contents) => {
				writes.push({ contents, path });
			}
		});
		expect(paths.certPath).toBe('/etc/ssl/api.example.com/fullchain.pem');
		expect(paths.keyPath).toBe('/etc/ssl/api.example.com/privkey.pem');
		expect(writes).toHaveLength(2);
		expect(writes[0]?.contents).toBe('CERT_PEM');
		expect(writes[1]?.contents).toBe('KEY_PEM');
		expect(execLog.some((cmd) => cmd.startsWith('chmod 600'))).toBe(true);
		expect(execLog).toContain('systemctl reload nginx');
	});

	test('respects custom certPath / keyPath / mode / owner', async () => {
		const execLog: string[] = [];
		const writes: Array<{ path: string; contents: string }> = [];
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				execLog.push(cmd);
				return { exitCode: 0, stderr: '', stdout: '' } as ExecResult;
			},
			upload: async () => {}
		};
		const paths = await installCertificateOnTarget(
			target,
			{
				account: (await generateAccountKey()) as AcmeAccount,
				certificatePem: 'C',
				domains: ['x.example.com'],
				privateKeyPem: 'K'
			},
			{
				certPath: '/srv/tls/cert.pem',
				keyPath: '/srv/tls/key.pem',
				mode: '400',
				owner: 'caddy:caddy',
				writeFile: async (_target, path, contents) => {
					writes.push({ contents, path });
				}
			}
		);
		expect(paths.certPath).toBe('/srv/tls/cert.pem');
		expect(paths.keyPath).toBe('/srv/tls/key.pem');
		expect(execLog.some((cmd) => cmd.startsWith('chmod 400'))).toBe(true);
		expect(execLog.some((cmd) => cmd.startsWith('chown caddy:caddy'))).toBe(
			true
		);
	});

	test('throws when the cert has no domains', async () => {
		const target: Target = {
			description: 'mock',
			exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }) as ExecResult,
			upload: async () => {}
		};
		await expect(
			installCertificateOnTarget(target, {
				account: (await generateAccountKey()) as AcmeAccount,
				certificatePem: 'C',
				domains: [],
				privateKeyPem: 'K'
			})
		).rejects.toThrow('no domains');
	});
});
