/**
 * Tests for @absolutejs/deploy/env. Mock the Target so we never touch
 * a real SSH connection; build a simple in-memory SecretSource and
 * drive the rotation + fan-out flow.
 */
import { describe, expect, test } from 'bun:test';
import {
	deploymentsUsing,
	parseEnvFile,
	serializeEnvFile,
	syncEnvToTarget,
	syncSecretsToDeployments,
	type EnvDeployment,
	type SecretSource
} from '../src/env';
import type { ExecOptions, ExecResult, Target } from '../src/targets';

// =============================================================================
// Mock target — captures exec calls + simulates a remote filesystem
// =============================================================================

type ExecRecord = {
	cmd: string;
	stdin?: string;
};

const makeTarget = (
	initialFiles: Record<string, string> = {}
): {
	target: Target;
	files: Map<string, string>;
	execLog: ExecRecord[];
} => {
	const files = new Map(Object.entries(initialFiles));
	const execLog: ExecRecord[] = [];

	const target: Target = {
		description: 'mock',
		exec: async (cmd, opts?: ExecOptions) => {
			execLog.push({
				cmd,
				...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {})
			});

			// Simulate the "read file if exists" pattern.
			const readMatch = cmd.match(
				/^if \[ -f '([^']+)' \]; then cat '([^']+)'; else echo __ABS_DEPLOY_ENV_ABSENT__; fi$/
			);
			if (readMatch !== null) {
				const path = readMatch[1] as string;
				const existing = files.get(path);
				if (existing === undefined) {
					return {
						exitCode: 0,
						stderr: '',
						stdout: '__ABS_DEPLOY_ENV_ABSENT__\n'
					} satisfies ExecResult;
				}
				return { exitCode: 0, stderr: '', stdout: existing } satisfies ExecResult;
			}

			// `cat > '<path>'` with stdin — simulates the write.
			const writeMatch = cmd.match(/^cat > '([^']+)'$/);
			if (writeMatch !== null) {
				const path = writeMatch[1] as string;
				files.set(path, opts?.stdin ?? '');
				return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
			}

			// `mkdir -p ...`
			if (cmd.startsWith('mkdir -p ')) {
				return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
			}

			// `chmod ...`
			if (cmd.startsWith('chmod ')) {
				return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
			}

			// `chown ...`
			if (cmd.startsWith('chown ')) {
				return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
			}

			// `mv '<src>' '<dst>'` — simulates the atomic move.
			const mvMatch = cmd.match(/^mv '([^']+)' '([^']+)'$/);
			if (mvMatch !== null) {
				const src = mvMatch[1] as string;
				const dst = mvMatch[2] as string;
				const content = files.get(src);
				if (content !== undefined) {
					files.set(dst, content);
					files.delete(src);
				}
				return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
			}

			// Anything else (reload commands etc.) — return success by default.
			return { exitCode: 0, stderr: '', stdout: '' } satisfies ExecResult;
		},
		upload: async () => {}
	};

	return { execLog, files, target };
};

const makeSource = (initial: Record<string, string> = {}): SecretSource & {
	put: (name: string, value: string) => void;
	rotate: (name: string) => string;
} => {
	const store = new Map(Object.entries(initial));
	return {
		put: (name, value) => store.set(name, value),
		resolve: async (name) => {
			const value = store.get(name);
			if (value === undefined) return null;
			return { fingerprint: value.slice(0, 6), value };
		},
		rotate: (name) => {
			const next = `rotated-${name}-${Math.floor(Math.random() * 1_000_000)}`;
			store.set(name, next);
			return next;
		}
	};
};

// =============================================================================
// serializeEnvFile / parseEnvFile
// =============================================================================

describe('serializeEnvFile / parseEnvFile', () => {
	test('serializes simple key=value pairs sorted alphabetically', () => {
		const text = serializeEnvFile({
			DATABASE_URL: 'postgres://localhost',
			PORT: '3000',
			NODE_ENV: 'production'
		});
		const lines = text.trimEnd().split('\n');
		expect(lines).toEqual([
			'DATABASE_URL=postgres://localhost',
			'NODE_ENV=production',
			'PORT=3000'
		]);
	});

	test('quotes values with spaces or special characters', () => {
		const text = serializeEnvFile({
			KEY: 'value with spaces',
			SECRET: 'a"b\\c',
			URL: 'https://x.example.com'
		});
		const parsed = parseEnvFile(text);
		expect(parsed.KEY).toBe('value with spaces');
		expect(parsed.SECRET).toBe('a"b\\c');
		expect(parsed.URL).toBe('https://x.example.com');
	});

	test('serialize/parse round-trip for tricky values', () => {
		const original = {
			DOLLAR: 'a$b',
			EMPTY: '',
			EQUALS_INSIDE: 'a=b=c',
			QUOTES: 'a"b\'c',
			SEMICOLON: 'a;b',
			SPACES: 'a b c'
		};
		const parsed = parseEnvFile(serializeEnvFile(original));
		expect(parsed).toEqual(original);
	});

	test('rejects newline in value', () => {
		expect(() =>
			serializeEnvFile({ KEY: 'line1\nline2' })
		).toThrow('newline');
	});

	test('rejects invalid key names', () => {
		expect(() => serializeEnvFile({ 'lowercase': 'x' })).toThrow(
			'invalid env key'
		);
		expect(() => serializeEnvFile({ '1STARTS_WITH_NUM': 'x' })).toThrow(
			'invalid env key'
		);
		expect(() => serializeEnvFile({ 'HAS-DASH': 'x' })).toThrow(
			'invalid env key'
		);
	});

	test('parseEnvFile ignores comments and blank lines', () => {
		const parsed = parseEnvFile(
			'# comment\n\nKEY=value\n# another\nOTHER=2\n'
		);
		expect(parsed).toEqual({ KEY: 'value', OTHER: '2' });
	});

	test('parseEnvFile throws on malformed lines', () => {
		expect(() => parseEnvFile('NO_EQUALS\n')).toThrow('malformed');
		expect(() => parseEnvFile('=NO_KEY\n')).toThrow('malformed');
	});
});

// =============================================================================
// syncEnvToTarget — first push, no-op, change detection, atomic write
// =============================================================================

describe('syncEnvToTarget', () => {
	test('creates the file when none exists', async () => {
		const { execLog, files, target } = makeTarget();
		const result = await syncEnvToTarget(
			{ remotePath: '/etc/myapp.env', target },
			{ DATABASE_URL: 'postgres://x', PORT: '3000' }
		);
		expect(result.wrote).toBe(true);
		expect(result.added).toEqual(['DATABASE_URL', 'PORT']);
		expect(result.changed).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(files.get('/etc/myapp.env')).toContain('DATABASE_URL=postgres://x');
		expect(files.get('/etc/myapp.env')).toContain('PORT=3000');
		// chmod 600 by default
		expect(execLog.some((e) => e.cmd.startsWith("chmod '600' "))).toBe(true);
	});

	test('skips write + reload when nothing changed', async () => {
		const initial = 'DATABASE_URL=postgres://x\nPORT=3000\n';
		const { execLog, files, target } = makeTarget({
			'/etc/myapp.env': initial
		});
		let reloadCalled = false;
		const target2: Target = {
			description: target.description,
			exec: async (cmd, opts) => {
				if (cmd === 'systemctl reload myapp') {
					reloadCalled = true;
					return { exitCode: 0, stderr: '', stdout: '' };
				}
				return target.exec(cmd, opts);
			},
			upload: target.upload
		};
		const result = await syncEnvToTarget(
			{
				reload: 'systemctl reload myapp',
				remotePath: '/etc/myapp.env',
				target: target2
			},
			{ DATABASE_URL: 'postgres://x', PORT: '3000' }
		);
		expect(result.wrote).toBe(false);
		expect(result.reloaded).toBe(false);
		expect(reloadCalled).toBe(false);
		expect(result.unchanged).toEqual(['DATABASE_URL', 'PORT']);
		expect(execLog.every((e) => !e.cmd.startsWith('cat > '))).toBe(true);
		void files;
	});

	test('runs reload when content changes', async () => {
		const { files, target } = makeTarget({
			'/etc/myapp.env': 'PORT=3000\n'
		});
		let reloadCalled = false;
		const target2: Target = {
			description: target.description,
			exec: async (cmd, opts) => {
				if (cmd === 'systemctl reload myapp') {
					reloadCalled = true;
					return { exitCode: 0, stderr: '', stdout: '' };
				}
				return target.exec(cmd, opts);
			},
			upload: target.upload
		};
		const result = await syncEnvToTarget(
			{
				reload: 'systemctl reload myapp',
				remotePath: '/etc/myapp.env',
				target: target2
			},
			{ PORT: '4000' }
		);
		expect(result.wrote).toBe(true);
		expect(result.changed).toEqual(['PORT']);
		expect(reloadCalled).toBe(true);
		expect(result.reloaded).toBe(true);
		expect(files.get('/etc/myapp.env')).toContain('PORT=4000');
	});

	test('detects added / removed / unchanged keys in one pass', async () => {
		const { target } = makeTarget({
			'/etc/myapp.env': 'PORT=3000\nGOING_AWAY=bye\nKEEPS=same\n'
		});
		const result = await syncEnvToTarget(
			{ remotePath: '/etc/myapp.env', target },
			{ KEEPS: 'same', NEW_KEY: 'hi', PORT: '3000' }
		);
		expect(result.added).toEqual(['NEW_KEY']);
		expect(result.removed).toEqual(['GOING_AWAY']);
		expect(result.unchanged).toEqual(['KEEPS', 'PORT']);
		expect(result.changed).toEqual([]);
	});

	test('writes via temp file + mv (atomic on the remote)', async () => {
		const { execLog, target } = makeTarget();
		await syncEnvToTarget(
			{ remotePath: '/etc/myapp.env', target },
			{ KEY: 'value' }
		);
		const writeCmd = execLog.find((e) => e.cmd.startsWith('cat > '));
		expect(writeCmd).toBeDefined();
		expect(writeCmd?.cmd).toMatch(/cat > '\/etc\/myapp\.env\.new\.\d+'/);
		const mvCmd = execLog.find((e) => e.cmd.startsWith('mv '));
		expect(mvCmd?.cmd).toMatch(
			/mv '\/etc\/myapp\.env\.new\.\d+' '\/etc\/myapp\.env'/
		);
	});

	test('merges extras with resolved secrets; throws on collision', async () => {
		const { target } = makeTarget();
		await syncEnvToTarget(
			{
				extras: { LOG_LEVEL: 'info', NODE_ENV: 'production' },
				remotePath: '/etc/myapp.env',
				target
			},
			{ DATABASE_URL: 'postgres://x' }
		);
		await expect(
			syncEnvToTarget(
				{
					extras: { PORT: '3000' },
					remotePath: '/etc/myapp.env',
					target
				},
				{ PORT: 'will-collide' }
			)
		).rejects.toThrow('defined in BOTH');
	});

	test('honors custom mode + owner', async () => {
		const { execLog, target } = makeTarget();
		await syncEnvToTarget(
			{
				mode: '400',
				owner: 'myapp:myapp',
				remotePath: '/etc/myapp.env',
				target
			},
			{ KEY: 'value' }
		);
		expect(execLog.some((e) => e.cmd.startsWith("chmod '400' "))).toBe(true);
		expect(execLog.some((e) => e.cmd.startsWith("chown 'myapp:myapp' "))).toBe(
			true
		);
	});
});

// =============================================================================
// syncSecretsToDeployments — fan-out + rotation propagation
// =============================================================================

describe('syncSecretsToDeployments — fan-out', () => {
	test('pushes the same secret value to multiple deployments', async () => {
		const source = makeSource({
			DATABASE_URL: 'postgres://master',
			STRIPE_KEY: 'sk_test_abc'
		});
		const t1 = makeTarget();
		const t2 = makeTarget();
		const deployments: EnvDeployment[] = [
			{
				remotePath: '/etc/api.env',
				secretNames: ['STRIPE_KEY', 'DATABASE_URL'],
				target: t1.target
			},
			{
				remotePath: '/etc/worker.env',
				secretNames: ['DATABASE_URL'],
				target: t2.target
			}
		];
		const results = await syncSecretsToDeployments(source, deployments);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.error === undefined)).toBe(true);
		expect(t1.files.get('/etc/api.env')).toContain('STRIPE_KEY=sk_test_abc');
		expect(t1.files.get('/etc/api.env')).toContain('DATABASE_URL=postgres://master');
		expect(t2.files.get('/etc/worker.env')).toContain(
			'DATABASE_URL=postgres://master'
		);
		expect(t2.files.get('/etc/worker.env')).not.toContain('STRIPE_KEY');
	});

	test('propagates rotation: re-running picks up the new value', async () => {
		const source = makeSource({ STRIPE_KEY: 'sk_test_old' });
		const t1 = makeTarget();
		const deployments: EnvDeployment[] = [
			{
				remotePath: '/etc/api.env',
				secretNames: ['STRIPE_KEY'],
				target: t1.target
			}
		];
		await syncSecretsToDeployments(source, deployments);
		expect(t1.files.get('/etc/api.env')).toContain('STRIPE_KEY=sk_test_old');

		// Rotate at the source and re-sync.
		source.rotate('STRIPE_KEY');
		const newValue = (await source.resolve('STRIPE_KEY'))?.value;
		const results = await syncSecretsToDeployments(source, deployments);
		expect(t1.files.get('/etc/api.env')).toContain(`STRIPE_KEY=${newValue}`);
		expect(t1.files.get('/etc/api.env')).not.toContain('sk_test_old');
		// The diff captures STRIPE_KEY as changed (NOT added).
		const result = results[0]?.result;
		expect(result?.changed).toContain('STRIPE_KEY');
	});

	test('best-effort: one failed deployment does not stop the rest', async () => {
		const source = makeSource({ STRIPE_KEY: 'sk_test_abc' });
		const t1 = makeTarget();
		const broken: Target = {
			description: 'broken',
			exec: async () => {
				throw new Error('ssh refused');
			},
			upload: async () => {}
		};
		const deployments: EnvDeployment[] = [
			{
				remotePath: '/etc/api.env',
				secretNames: ['STRIPE_KEY'],
				target: broken
			},
			{
				remotePath: '/etc/worker.env',
				secretNames: ['STRIPE_KEY'],
				target: t1.target
			}
		];
		const results = await syncSecretsToDeployments(source, deployments);
		expect(results[0]?.error?.message).toContain('ssh refused');
		expect(results[1]?.error).toBeUndefined();
		expect(t1.files.get('/etc/worker.env')).toContain(
			'STRIPE_KEY=sk_test_abc'
		);
	});

	test('throws (captured in result) if a secret is missing from the source', async () => {
		const source = makeSource({ KNOWN: 'v' });
		const t1 = makeTarget();
		const results = await syncSecretsToDeployments(source, [
			{
				remotePath: '/etc/api.env',
				secretNames: ['MISSING'],
				target: t1.target
			}
		]);
		expect(results[0]?.error?.message).toContain('"MISSING" not found');
	});
});

describe('deploymentsUsing', () => {
	test('filters deployments by secret name', () => {
		const t = makeTarget();
		const deployments: EnvDeployment[] = [
			{
				remotePath: '/etc/api.env',
				secretNames: ['STRIPE_KEY', 'DATABASE_URL'],
				target: t.target
			},
			{
				remotePath: '/etc/worker.env',
				secretNames: ['DATABASE_URL'],
				target: t.target
			},
			{
				remotePath: '/etc/static.env',
				secretNames: [],
				target: t.target
			}
		];
		expect(deploymentsUsing('STRIPE_KEY', deployments)).toHaveLength(1);
		expect(deploymentsUsing('DATABASE_URL', deployments)).toHaveLength(2);
		expect(deploymentsUsing('UNUSED', deployments)).toHaveLength(0);
	});
});
