/**
 * Tests for inspectCertificate + renewCertificate. Generates short-lived
 * self-signed certs via openssl to drive the renewal decision logic. The
 * `issueCertificate` step itself is monkey-patched off (we don't want
 * tests to hit a real ACME server), so the renewal tests only exercise
 * the "should we renew?" branch.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	inspectCertificate,
	renewCertificate,
	type RenewCertificateOptions
} from '../src/tls';
import type { DnsProvider } from '../src/dns';

// =============================================================================
// Helpers
// =============================================================================

const opensslPresent = async (): Promise<boolean> =>
	new Promise((resolve) => {
		const proc = spawn('openssl', ['version'], { stdio: 'pipe' });
		proc.on('exit', (code) => resolve(code === 0));
		proc.on('error', () => resolve(false));
	});

const runOpenssl = async (args: string[]): Promise<number> =>
	new Promise((resolve) => {
		const proc = spawn('openssl', args, { stdio: 'pipe' });
		proc.on('exit', (code) => resolve(code ?? -1));
	});

let tmpDir: string;
let HAS_OPENSSL = false;

beforeAll(async () => {
	HAS_OPENSSL = await opensslPresent();
	if (HAS_OPENSSL) {
		tmpDir = await mkdtemp(join(tmpdir(), 'absdeploy-renew-'));
	}
});

afterAll(async () => {
	if (tmpDir !== undefined) {
		await rm(tmpDir, { force: true, recursive: true });
	}
});

const makeSelfSignedCert = async (options: {
	cn: string;
	sans?: string[];
	daysValid: number;
}): Promise<string> => {
	const keyPath = join(tmpDir, `${options.cn}.key.pem`);
	const certPath = join(tmpDir, `${options.cn}.cert.pem`);

	const sanLine =
		options.sans !== undefined && options.sans.length > 0
			? `subjectAltName=${options.sans.map((s) => `DNS:${s}`).join(',')}`
			: 'subjectAltName=DNS:placeholder';

	const code = await runOpenssl([
		'req',
		'-x509',
		'-newkey',
		'ec:<(openssl ecparam -name prime256v1)',
		'-keyout',
		keyPath,
		'-out',
		certPath,
		'-days',
		String(options.daysValid),
		'-nodes',
		'-subj',
		`/CN=${options.cn}`,
		'-addext',
		sanLine
	]);
	if (code !== 0) {
		// `ec:<(...)` is a bash process-substitution; spawn doesn't expand it.
		// Fall back to the two-step form.
		const paramPath = join(tmpDir, `${options.cn}.param.pem`);
		await runOpenssl(['ecparam', '-name', 'prime256v1', '-out', paramPath]);
		const code2 = await runOpenssl([
			'req',
			'-x509',
			'-newkey',
			`ec:${paramPath}`,
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-days',
			String(options.daysValid),
			'-nodes',
			'-subj',
			`/CN=${options.cn}`,
			'-addext',
			sanLine
		]);
		if (code2 !== 0) {
			throw new Error(
				`[test] openssl req failed for ${options.cn} (exit ${code2})`
			);
		}
	}
	return readFile(certPath, 'utf8');
};

const noopDnsProvider: DnsProvider = {
	create: async () => {
		throw new Error('not used');
	},
	delete: async () => {},
	description: 'noop',
	find: async () => undefined,
	list: async () => [],
	update: async () => {
		throw new Error('not used');
	},
	upsert: async () => {
		throw new Error('not used');
	}
};

const baseOptions = (
	overrides: Partial<RenewCertificateOptions> = {}
): RenewCertificateOptions => ({
	dnsProvider: noopDnsProvider,
	domains: ['api.example.com'],
	email: 'ops@example.com',
	...overrides
});

// =============================================================================
// inspectCertificate
// =============================================================================

describe('inspectCertificate', () => {
	test('parses CN, SAN, validFrom, validTo from a self-signed cert', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'api.example.com',
			daysValid: 365,
			sans: ['api.example.com', 'www.api.example.com']
		});
		const inspected = inspectCertificate(pem);
		expect(inspected.subjects).toContain('api.example.com');
		expect(inspected.subjects).toContain('www.api.example.com');
		expect(inspected.expired).toBe(false);
		expect(inspected.daysRemaining).toBeGreaterThan(360);
		expect(inspected.daysRemaining).toBeLessThan(366);
		expect(inspected.validFrom).toBeLessThan(inspected.validTo);
	});

	test('daysRemaining is negative for an expired cert (now in the future)', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'api.example.com',
			daysValid: 7
		});
		const futureNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
		const inspected = inspectCertificate(pem, { now: () => futureNow });
		expect(inspected.expired).toBe(true);
		expect(inspected.daysRemaining).toBeLessThan(0);
	});

	test('issuer is set (self-signed = subject)', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'self-issuer.example.com',
			daysValid: 30
		});
		const inspected = inspectCertificate(pem);
		expect(inspected.issuer).toContain('self-issuer.example.com');
	});

	test('throws on malformed PEM', () => {
		expect(() => inspectCertificate('not a cert')).toThrow();
	});
});

// =============================================================================
// renewCertificate — decision branches (issuance itself is monkey-patched off)
// =============================================================================

describe('renewCertificate — decision logic', () => {
	test('returns still-fresh when cert has > threshold days remaining', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'fresh.example.com',
			daysValid: 90
		});
		const result = await renewCertificate(
			baseOptions({
				currentCertificatePem: pem,
				renewWhenDaysRemaining: 30
			})
		);
		expect(result.renewed).toBe(false);
		if (result.renewed === false) {
			expect(result.reason).toBe('still-fresh');
			expect(result.inspection.daysRemaining).toBeGreaterThan(30);
		}
	});

	test('issues when cert has < threshold days remaining', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'expiring.example.com',
			daysValid: 90
		});
		// Pretend we're 70 days into the cert's lifespan → ~20 days remaining.
		const lateNow = Date.now() + 70 * 24 * 60 * 60 * 1000;
		// Stub: issueCertificate would hit real ACME. We expect renewCertificate
		// to attempt issuance; we catch the resulting failure and inspect that
		// the path got walked. Cleaner: pass a fetch that rejects so we know we
		// got past the decision branch.
		let issuanceAttempted = false;
		try {
			await renewCertificate(
				baseOptions({
					currentCertificatePem: pem,
					directoryUrl: 'https://acme.test/directory',
					fetch: (async () => {
						issuanceAttempted = true;
						return new Response('boom', { status: 500 });
					}) as unknown as typeof fetch,
					now: () => lateNow,
					renewWhenDaysRemaining: 30
				})
			);
		} catch {
			// Expected — the stubbed fetch fails the directory call.
		}
		expect(issuanceAttempted).toBe(true);
	});

	test('issues when no currentCertificatePem is supplied (first-time issuance)', async () => {
		let issuanceAttempted = false;
		try {
			await renewCertificate(
				baseOptions({
					directoryUrl: 'https://acme.test/directory',
					fetch: (async () => {
						issuanceAttempted = true;
						return new Response('boom', { status: 500 });
					}) as unknown as typeof fetch
				})
			);
		} catch {
			// Expected
		}
		expect(issuanceAttempted).toBe(true);
	});

	test('issues when force=true regardless of cert freshness', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'forced.example.com',
			daysValid: 365
		});
		let issuanceAttempted = false;
		try {
			await renewCertificate(
				baseOptions({
					currentCertificatePem: pem,
					directoryUrl: 'https://acme.test/directory',
					fetch: (async () => {
						issuanceAttempted = true;
						return new Response('boom', { status: 500 });
					}) as unknown as typeof fetch,
					force: true
				})
			);
		} catch {
			// Expected
		}
		expect(issuanceAttempted).toBe(true);
	});

	test('issues when cert is already expired', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'expired.example.com',
			daysValid: 1
		});
		// Pretend we're a week past the cert's lifespan.
		const futureNow = Date.now() + 10 * 24 * 60 * 60 * 1000;
		let issuanceAttempted = false;
		try {
			await renewCertificate(
				baseOptions({
					currentCertificatePem: pem,
					directoryUrl: 'https://acme.test/directory',
					fetch: (async () => {
						issuanceAttempted = true;
						return new Response('boom', { status: 500 });
					}) as unknown as typeof fetch,
					now: () => futureNow
				})
			);
		} catch {
			// Expected
		}
		expect(issuanceAttempted).toBe(true);
	});

	test('rejects negative renewWhenDaysRemaining (programmer error)', async () => {
		await expect(
			renewCertificate(baseOptions({ renewWhenDaysRemaining: -1 }))
		).rejects.toThrow('non-negative');
	});

	test('respects custom renewWhenDaysRemaining', async () => {
		if (!HAS_OPENSSL) return;
		const pem = await makeSelfSignedCert({
			cn: 'long-window.example.com',
			daysValid: 90
		});
		// Threshold of 60: a 90-day cert with 90 days remaining is fresh.
		const result = await renewCertificate(
			baseOptions({
				currentCertificatePem: pem,
				renewWhenDaysRemaining: 60
			})
		);
		expect(result.renewed).toBe(false);

		// Threshold of 100: a 90-day cert with 90 days remaining is "expiring."
		let issuanceAttempted = false;
		try {
			await renewCertificate(
				baseOptions({
					currentCertificatePem: pem,
					directoryUrl: 'https://acme.test/directory',
					fetch: (async () => {
						issuanceAttempted = true;
						return new Response('boom', { status: 500 });
					}) as unknown as typeof fetch,
					renewWhenDaysRemaining: 100
				})
			);
		} catch {
			// Expected
		}
		expect(issuanceAttempted).toBe(true);
	});
});
