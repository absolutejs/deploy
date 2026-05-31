/**
 * Cryptographic-correctness tests for @absolutejs/deploy/tls.
 *
 * The mock-server tests in tests/tls.test.ts verify the call shape
 * (what URL gets POSTed, with what body, in what order). These tests
 * verify the bytes: DER encoder against known vectors, JWK
 * thumbprint computed two ways and asserted equal, JWS sign+verify
 * round-trip, ECDSA raw↔DER round-trip, and the CSR piped through
 * openssl for structural + signature validation.
 *
 * Run via `bun test tests/cryptoVectors.test.ts`. The openssl-backed
 * CSR test is skipped automatically if openssl isn't on PATH.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import { __testing, generateAccountKey } from '../src/tls';

const {
	base64UrlEncode,
	base64UrlEncodeString,
	base64UrlDecode,
	derInt,
	derOid,
	derSeq,
	derSet,
	ecdsaRawToDer,
	exportPublicJwk,
	jwkThumbprint,
	buildCsr,
	generateCertKeyPair,
	signJws
} = __testing;

const hex = (bytes: Uint8Array): string =>
	[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (s: string): Uint8Array => {
	const clean = s.replaceAll(/\s+/g, '');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = parseInt(clean.substr(i * 2, 2), 16);
	}
	return out;
};

// =============================================================================
// base64url — RFC 4648 + the JWS examples in RFC 7515
// =============================================================================

describe('base64url encoding', () => {
	test('strips trailing padding', () => {
		// "f" → "Zg" (one byte input would be "Zg==" in standard base64)
		expect(base64UrlEncodeString('f')).toBe('Zg');
		expect(base64UrlEncodeString('fo')).toBe('Zm8');
		expect(base64UrlEncodeString('foo')).toBe('Zm9v');
		expect(base64UrlEncodeString('foob')).toBe('Zm9vYg');
		expect(base64UrlEncodeString('fooba')).toBe('Zm9vYmE');
		expect(base64UrlEncodeString('foobar')).toBe('Zm9vYmFy');
	});

	test('uses URL-safe alphabet (- / _ instead of + / /)', () => {
		// 0xfb 0xff → standard base64 "+/8=", URL-safe "-_8"
		expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
	});

	test('round-trips via base64UrlDecode', () => {
		const input = new Uint8Array([0, 1, 2, 3, 254, 255]);
		const encoded = base64UrlEncode(input);
		const decoded = base64UrlDecode(encoded);
		expect([...decoded]).toEqual([...input]);
	});

	test('decodes JWS sample protected-header from RFC 7515 §A.1', () => {
		// {"typ":"JWT",\r\n "alg":"HS256"}
		const encoded = 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9';
		const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
		expect(decoded).toBe('{"typ":"JWT",\r\n "alg":"HS256"}');
	});
});

// =============================================================================
// DER encoder — byte-exact tests on the failure-prone bits
// =============================================================================

describe('DER encoder — INTEGER', () => {
	test('INTEGER 0 → 02 01 00', () => {
		expect(hex(derInt(0))).toBe('020100');
	});

	test('INTEGER 1 → 02 01 01', () => {
		expect(hex(derInt(1))).toBe('020101');
	});

	test('INTEGER 127 → 02 01 7f (high bit clear, no padding)', () => {
		expect(hex(derInt(127))).toBe('02017f');
	});

	test('INTEGER 128 → 02 02 00 80 (high bit set, prepend 0x00)', () => {
		expect(hex(derInt(128))).toBe('02020080');
	});

	test('INTEGER 255 → 02 02 00 ff (full byte, prepend 0x00)', () => {
		expect(hex(derInt(255))).toBe('020200ff');
	});

	test('INTEGER 256 → 02 02 01 00', () => {
		expect(hex(derInt(256))).toBe('02020100');
	});

	test('INTEGER from positive Uint8Array — strips leading zeros, keeps positive', () => {
		// 0x00 0x42 → INTEGER 0x42 (single byte payload, high bit clear)
		expect(hex(derInt(new Uint8Array([0x00, 0x42])))).toBe('020142');
		// 0x80 0x01 → high bit set, prepend 0x00 to keep positive
		expect(hex(derInt(new Uint8Array([0x80, 0x01])))).toBe('02030080' + '01');
	});
});

describe('DER encoder — OBJECT IDENTIFIER', () => {
	test('ecdsa-with-SHA256 (1.2.840.10045.4.3.2)', () => {
		// Well-known encoding: 06 08 2a 86 48 ce 3d 04 03 02
		expect(hex(derOid('1.2.840.10045.4.3.2'))).toBe('06082a8648ce3d040302');
	});

	test('commonName (2.5.4.3)', () => {
		// 06 03 55 04 03
		expect(hex(derOid('2.5.4.3'))).toBe('0603550403');
	});

	test('subjectAltName (2.5.29.17)', () => {
		// 06 03 55 1d 11
		expect(hex(derOid('2.5.29.17'))).toBe('0603551d11');
	});

	test('PKCS#9 extensionRequest (1.2.840.113549.1.9.14)', () => {
		// 06 09 2a 86 48 86 f7 0d 01 09 0e
		expect(hex(derOid('1.2.840.113549.1.9.14'))).toBe(
			'06092a864886f70d01090e'
		);
	});
});

describe('DER encoder — SEQUENCE / SET length encoding', () => {
	test('short-form length (length < 128)', () => {
		// SEQUENCE { INTEGER 1, INTEGER 2 } → 30 06 02 01 01 02 01 02
		const seq = derSeq([derInt(1), derInt(2)]);
		expect(hex(seq)).toBe('3006020101020102');
	});

	test('long-form length (length >= 128 fits in one length byte)', () => {
		// 64 INTEGER 1s = 64 * (02 01 01) = 192 bytes of payload.
		// SEQUENCE header: 30 81 c0 (long-form length, one length byte = 0xc0 = 192)
		const seq = derSeq(Array.from({ length: 64 }, () => derInt(1)));
		expect(seq[0]).toBe(0x30);
		expect(seq[1]).toBe(0x81); // long-form indicator, 1 length byte
		expect(seq[2]).toBe(0xc0); // 192 bytes of content
		expect(seq.length).toBe(3 + 192);
	});

	test('long-form length (length >= 256 fits in two length bytes)', () => {
		// 256 INTEGER 0s = 256 * (02 01 00) = 768 bytes of payload.
		// SEQUENCE header: 30 82 03 00 (long-form, 2 length bytes for 0x0300)
		const seq = derSeq(Array.from({ length: 256 }, () => derInt(0)));
		expect(seq[0]).toBe(0x30);
		expect(seq[1]).toBe(0x82); // long-form indicator, 2 length bytes
		expect(seq[2]).toBe(0x03);
		expect(seq[3]).toBe(0x00);
		expect(seq.length).toBe(4 + 768);
	});

	test('SET of strings is wrapped with 0x31 tag', () => {
		const set = derSet([derInt(1)]);
		expect(set[0]).toBe(0x31);
	});
});

// =============================================================================
// ECDSA signature raw↔DER conversion
// =============================================================================

describe('ECDSA signature DER conversion', () => {
	test('64-byte raw (P-256) where both r and s are positive', () => {
		const raw = new Uint8Array(64);
		raw[0] = 0x01;
		raw[32] = 0x02;
		const der = ecdsaRawToDer(raw);
		// Expect SEQUENCE { INTEGER r, INTEGER s }
		expect(der[0]).toBe(0x30);
	});

	test('raw r has high bit set — output INTEGER gets leading 0x00', () => {
		const raw = new Uint8Array(64);
		raw[0] = 0xff; // r starts with 0xff — high bit set
		raw[32] = 0x01;
		const der = ecdsaRawToDer(raw);
		// The r INTEGER inside should be 02 21 00 ff 00 ... (length 33 = 0x21,
		// payload starts with 00 ff to keep it positive)
		// Skip past SEQUENCE header → first child is INTEGER
		// SEQUENCE: 30 LL ; INTEGER: 02 21 00 ff ...
		expect(der[2]).toBe(0x02); // INTEGER tag
		expect(der[3]).toBe(33); // length: 32 bytes + leading 0x00
		expect(der[4]).toBe(0x00); // leading zero
		expect(der[5]).toBe(0xff); // r's actual first byte
	});

	test('raw r has leading zero byte — gets stripped', () => {
		const raw = new Uint8Array(64);
		raw[0] = 0x00;
		raw[1] = 0x42;
		raw[32] = 0x01;
		const der = ecdsaRawToDer(raw);
		// r should be INTEGER 02 1F 42 ... (31 bytes, 0x42 first)
		expect(der[2]).toBe(0x02);
		expect(der[3]).toBe(31);
		expect(der[4]).toBe(0x42);
	});
});

// =============================================================================
// JWK thumbprint — computed two ways, asserted equal
// =============================================================================

describe('JWK thumbprint (RFC 7638)', () => {
	test('matches an independent SHA-256-of-canonical-JSON computation', async () => {
		const account = await generateAccountKey();
		const publicJwk = await exportPublicJwk(account.key.publicKey);
		// Our function:
		const ours = await jwkThumbprint(publicJwk);
		// Manual: build canonical JSON ourselves, hash, base64url.
		const canonical = JSON.stringify({
			crv: publicJwk.crv,
			kty: publicJwk.kty,
			x: publicJwk.x,
			y: publicJwk.y
		});
		const hash = new Uint8Array(
			await crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(canonical)
			)
		);
		const expected = base64UrlEncode(hash);
		expect(ours).toBe(expected);
	});

	test('canonical JSON uses lex order of required fields ONLY', async () => {
		// Sneak in extra fields on the JWK; our thumbprint should ignore them.
		const account = await generateAccountKey();
		const publicJwk = await exportPublicJwk(account.key.publicKey);
		const polluted = {
			...publicJwk,
			ext: true,
			key_ops: ['sign']
		};
		const baseline = await jwkThumbprint(publicJwk);
		const polluted_tp = await jwkThumbprint(polluted);
		expect(polluted_tp).toBe(baseline);
	});
});

// =============================================================================
// JWS — sign + verify round-trip
// =============================================================================

describe('JWS signing — Flattened JSON Serialization', () => {
	test('produces a JWS whose signature verifies with the public key', async () => {
		const account = await generateAccountKey();
		const publicJwk = await exportPublicJwk(account.key.publicKey);
		const header = {
			alg: 'ES256' as const,
			jwk: publicJwk,
			nonce: 'test-nonce',
			url: 'https://example.test/new-account'
		};
		const payload = { contact: ['mailto:test@example.com'] };
		const jws = await signJws(account.key.privateKey, header, payload);
		expect(jws.protected.length).toBeGreaterThan(0);
		expect(jws.payload.length).toBeGreaterThan(0);
		expect(jws.signature.length).toBeGreaterThan(0);

		// Verify
		const signingInput = new TextEncoder().encode(
			`${jws.protected}.${jws.payload}`
		);
		const sig = base64UrlDecode(jws.signature);
		const ok = await crypto.subtle.verify(
			{ hash: 'SHA-256', name: 'ECDSA' },
			account.key.publicKey,
			sig as BufferSource,
			signingInput as BufferSource
		);
		expect(ok).toBe(true);
	});

	test('POST-as-GET uses empty payload string, NOT empty object', async () => {
		const account = await generateAccountKey();
		const publicJwk = await exportPublicJwk(account.key.publicKey);
		const jws = await signJws(
			account.key.privateKey,
			{
				alg: 'ES256',
				jwk: publicJwk,
				nonce: 'n',
				url: 'https://example.test/order/1'
			},
			''
		);
		expect(jws.payload).toBe('');
	});
});

// =============================================================================
// CSR — pipe through openssl for structural + signature validation
// =============================================================================

const sniffOpenssl = async (): Promise<boolean> => {
	return new Promise((resolve) => {
		const proc = spawn('openssl', ['version'], { stdio: 'pipe' });
		proc.on('exit', (code) => resolve(code === 0));
		proc.on('error', () => resolve(false));
	});
};

const runOpenssl = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
	new Promise((resolve) => {
		const proc = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		proc.stdout?.on('data', (chunk) => {
			out += chunk.toString();
		});
		proc.stderr?.on('data', (chunk) => {
			err += chunk.toString();
		});
		proc.on('exit', (code) => resolve({ code: code ?? -1, err, out }));
	});

describe('CSR — openssl validation', () => {
	test('openssl req -verify accepts our CSR (signature + structure)', async () => {
		const hasOpenssl = await sniffOpenssl();
		if (!hasOpenssl) {
			console.log('[csr-test] openssl not on PATH; skipping');
			return;
		}
		const domain = 'acme-test.absolutejs.example';
		const keypair = await generateCertKeyPair();
		const csrDer = await buildCsr([domain, `www.${domain}`], keypair);
		const b64 = btoa(String.fromCharCode(...csrDer));
		const lines = b64.match(/.{1,64}/g) ?? [];
		const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
		await mkdir('tests/_tmp', { recursive: true });
		await writeFile('tests/_tmp/csr.pem', csrPem);
		try {
			const verify = await runOpenssl([
				'req',
				'-verify',
				'-noout',
				'-in',
				'tests/_tmp/csr.pem'
			]);
			// openssl prints "Certificate request self-signature verify OK"
			// (or "verify OK" in older versions) to stderr on success.
			if (verify.code !== 0) {
				console.log('openssl stdout:', verify.out);
				console.log('openssl stderr:', verify.err);
			}
			expect(verify.code).toBe(0);
			expect((verify.err + verify.out).toLowerCase()).toContain('verify ok');
		} finally {
			await rm('tests/_tmp/csr.pem', { force: true });
		}
	});

	test('openssl req -text dumps a CSR with our subject + SAN', async () => {
		const hasOpenssl = await sniffOpenssl();
		if (!hasOpenssl) return;
		const domain = 'acme-test.absolutejs.example';
		const keypair = await generateCertKeyPair();
		const csrDer = await buildCsr([domain, `www.${domain}`], keypair);
		const b64 = btoa(String.fromCharCode(...csrDer));
		const lines = b64.match(/.{1,64}/g) ?? [];
		const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
		await mkdir('tests/_tmp', { recursive: true });
		await writeFile('tests/_tmp/csr.pem', csrPem);
		try {
			const dump = await runOpenssl([
				'req',
				'-text',
				'-noout',
				'-in',
				'tests/_tmp/csr.pem'
			]);
			expect(dump.code).toBe(0);
			// Subject should contain the first domain as CN.
			expect(dump.out).toContain(domain);
			// SAN extension should be present and list both domains.
			expect(dump.out).toContain('Subject Alternative Name');
			expect(dump.out).toContain(`DNS:${domain}`);
			expect(dump.out).toContain(`DNS:www.${domain}`);
		} finally {
			await rm('tests/_tmp/csr.pem', { force: true });
		}
	});
});

// =============================================================================
// Sanity: hex round-trip — proves our hex helper for the rest of the file
// =============================================================================

describe('test-file helpers', () => {
	test('fromHex / hex round-trip', () => {
		const input = '00010203fffefd';
		expect(hex(fromHex(input))).toBe(input);
	});
});
