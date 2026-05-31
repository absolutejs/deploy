#!/usr/bin/env bun
/**
 * Manual end-to-end validation of @absolutejs/deploy/tls against
 * Let's Encrypt staging. NOT run in CI — driven by the developer
 * with their own Cloudflare token + a domain they own.
 *
 * The mock-server tests in tests/tls.test.ts verify the call shape;
 * this script verifies cryptographic correctness (DER encoding, JWS
 * signing, JWK thumbprint, CSR shape) by getting a real staging
 * cert and parsing the result.
 *
 * Usage:
 *
 *   CLOUDFLARE_TOKEN=...                          \
 *   CLOUDFLARE_ZONE_ID=...                        \
 *   ACME_EMAIL=ops@example.com                    \
 *   TEST_DOMAIN=acme-test.example.com             \
 *   bun run scripts/test-staging.ts
 *
 * Flags:
 *   --reuse-account   Load ./scripts/.staging-account.json instead
 *                     of generating a fresh account key. Tests the
 *                     renewal path.
 *   --help            Print this usage and exit.
 *
 * Artifacts persisted to ./scripts/.staging-out/:
 *   - account.json    AcmeAccountJson (publicJwk + privateJwk + kid)
 *   - cert.pem        Issued certificate chain
 *   - key.pem         Cert private key
 *
 * .gitignore ./scripts/.staging-out/ so artifacts don't escape.
 */

import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cloudflareProvider } from '../src/cloudflare';
import {
	exportAccount,
	importAccount,
	issueCertificate,
	LETSENCRYPT_STAGING,
	type AcmeAccount,
	type AcmeAccountJson
} from '../src/tls';

const ACCOUNT_PATH = 'scripts/.staging-out/account.json';
const CERT_PATH = 'scripts/.staging-out/cert.pem';
const KEY_PATH = 'scripts/.staging-out/key.pem';

const usage = (): never => {
	console.error(
		`Usage: bun run scripts/test-staging.ts [--reuse-account] [--help]

Env vars required:
  CLOUDFLARE_TOKEN     — API token with Zone:DNS:Edit on the test zone
  CLOUDFLARE_ZONE_ID   — Cloudflare zone id
  ACME_EMAIL           — contact email for the ACME account
  TEST_DOMAIN          — domain the issued cert will cover (you must own this zone)

Artifacts persisted to scripts/.staging-out/.
`
	);
	process.exit(1);
};

const main = async () => {
	const args = process.argv.slice(2);
	if (args.includes('--help')) usage();
	const reuseAccount = args.includes('--reuse-account');

	const cfToken = process.env.CLOUDFLARE_TOKEN;
	const cfZoneId = process.env.CLOUDFLARE_ZONE_ID;
	const acmeEmail = process.env.ACME_EMAIL;
	const testDomain = process.env.TEST_DOMAIN;

	if (
		cfToken === undefined ||
		cfZoneId === undefined ||
		acmeEmail === undefined ||
		testDomain === undefined
	) {
		console.error(
			'[test-staging] missing one of CLOUDFLARE_TOKEN / CLOUDFLARE_ZONE_ID / ACME_EMAIL / TEST_DOMAIN'
		);
		usage();
	}

	await mkdir('scripts/.staging-out', { recursive: true });

	const dns = cloudflareProvider({
		token: cfToken,
		zoneId: cfZoneId,
		zoneName: testDomain.split('.').slice(-2).join('.')
	});

	let account: AcmeAccount | undefined;
	if (reuseAccount) {
		console.log(`[test-staging] loading account from ${ACCOUNT_PATH}`);
		const text = await readFile(ACCOUNT_PATH, 'utf8');
		const json = JSON.parse(text) as AcmeAccountJson;
		account = await importAccount(json);
	}

	console.log(`[test-staging] issuing cert for ${testDomain} via staging ACME`);
	const start = Date.now();
	const cert = await issueCertificate({
		...(account !== undefined ? { account } : {}),
		directoryUrl: LETSENCRYPT_STAGING,
		dnsPropagationDelayMs: 30_000,
		dnsProvider: dns,
		domains: [testDomain],
		email: acmeEmail,
		onLog: (line) => console.log(line)
	});
	const elapsedMs = Date.now() - start;
	console.log(`[test-staging] issuance complete in ${elapsedMs}ms`);

	// Persist artifacts.
	const accountJson = await exportAccount(cert.account);
	await writeFile(ACCOUNT_PATH, JSON.stringify(accountJson, null, 2));
	await writeFile(CERT_PATH, cert.certificatePem);
	await writeFile(KEY_PATH, cert.privateKeyPem);
	console.log(`[test-staging] wrote ${ACCOUNT_PATH}, ${CERT_PATH}, ${KEY_PATH}`);

	// Validate: parse the cert and assert it matches expectations.
	const x509 = new X509Certificate(cert.certificatePem);
	console.log('[test-staging] parsed cert:');
	console.log(`  subject:     ${x509.subject}`);
	console.log(`  issuer:      ${x509.issuer}`);
	console.log(`  valid from:  ${x509.validFrom}`);
	console.log(`  valid to:    ${x509.validTo}`);
	console.log(`  subject alt: ${x509.subjectAltName ?? '(none)'}`);

	const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

	checks.push({
		detail: x509.subject,
		name: 'subject CN contains TEST_DOMAIN',
		ok: x509.subject.includes(testDomain)
	});

	checks.push({
		detail: x509.subjectAltName ?? '(none)',
		name: 'SAN extension contains TEST_DOMAIN',
		ok: (x509.subjectAltName ?? '').includes(testDomain)
	});

	checks.push({
		detail: x509.issuer,
		name: 'issuer is a Let\'s Encrypt staging cert',
		ok: x509.issuer.toUpperCase().includes('STG')
	});

	const validTo = new Date(x509.validTo).getTime();
	const daysOut = Math.round((validTo - Date.now()) / (24 * 60 * 60 * 1000));
	checks.push({
		detail: `${daysOut} days`,
		name: 'cert valid for at least 80 days',
		ok: daysOut >= 80
	});

	const accountReused = reuseAccount && cert.account.kid !== undefined;
	if (reuseAccount) {
		checks.push({
			detail: cert.account.kid ?? '(none)',
			name: 'account.kid preserved across reuse',
			ok: accountReused
		});
	}

	console.log('');
	console.log('[test-staging] validation:');
	let allOk = true;
	for (const check of checks) {
		const mark = check.ok ? '✓' : '✗';
		console.log(`  ${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
		if (!check.ok) allOk = false;
	}

	if (!allOk) {
		console.error('\n[test-staging] one or more checks failed — investigate');
		process.exit(2);
	}

	console.log('\n[test-staging] all checks passed');
	console.log(
		'[test-staging] re-run with --reuse-account to validate the renewal path'
	);
};

main().catch((error) => {
	console.error('[test-staging] FAILED:', error);
	process.exit(1);
});
