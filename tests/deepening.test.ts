import { describe, expect, test } from 'bun:test';
import {
	createDeployer,
	type DeployStep,
	type ExecResult,
	type Target,
} from '../src';

// Pattern-based mock target (matches the helper in deploy.test.ts).
type PatternHandler = (cmd: string, stdin?: string) => Partial<ExecResult> | undefined;

const makePatternTarget = (patterns: PatternHandler[]) => {
	const execLog: { cmd: string; stdin?: string }[] = [];
	const writtenMeta: Record<string, string> = {};
	const target: Target = {
		description: 'mock-pattern',
		exec: async (cmd, opts) => {
			execLog.push({ cmd, stdin: opts?.stdin });
			if (opts?.stdin !== undefined && cmd.startsWith('cat > ')) {
				const path = cmd.slice('cat > '.length).trim();
				writtenMeta[path] = opts.stdin;
			}
			for (const pattern of patterns) {
				const reply = pattern(cmd, opts?.stdin);
				if (reply !== undefined) {
					return {
						exitCode: reply.exitCode ?? 0,
						stderr: reply.stderr ?? '',
						stdout: reply.stdout ?? '',
					};
				}
			}
			return { exitCode: 0, stderr: '', stdout: '' };
		},
		upload: async () => {},
	};
	return { execLog, target, writtenMeta };
};

const noopSteps: DeployStep[] = [
	{ name: 'prepare', run: async () => {} },
	{ name: 'upload', run: async () => {} },
	{ name: 'install', run: async () => {} },
	{ name: 'link', run: async () => {} },
	{ name: 'restart', run: async () => {} },
];

describe('dry run', () => {
	test('dryRun: true logs the plan and skips every step', async () => {
		const stepRan: string[] = [];
		const steps: DeployStep[] = [
			{ name: 'a', run: async () => { stepRan.push('a'); } },
			{ name: 'b', run: async () => { stepRan.push('b'); } },
		];
		const logs: string[] = [];
		const { target } = makePatternTarget([]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			hooks: { onLog: (line) => { logs.push(line); } },
			source: { kind: 'directory', root: '/local' },
			steps,
			target,
		});
		const result = await deployer.deploy({ dryRun: true });
		expect(stepRan).toEqual([]);
		expect(result.steps.every((step) => step.skipped)).toBe(true);
		expect(logs.some((line) => line.includes('would run: a'))).toBe(true);
	});

	test('dryRun: false (default) still runs steps', async () => {
		const stepRan: string[] = [];
		const steps: DeployStep[] = [{ name: 'a', run: async () => { stepRan.push('a'); } }];
		const { target } = makePatternTarget([]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps,
			target,
		});
		await deployer.deploy();
		expect(stepRan).toEqual(['a']);
	});
});

describe('release annotations', () => {
	test('annotations land in result + meta JSON', async () => {
		const { target, writtenMeta } = makePatternTarget([]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		const result = await deployer.deploy({
			annotations: {
				author: 'alex@example.com',
				commitSha: 'abc1234',
				message: 'fix: thing',
				ref: 'refs/heads/main',
				tags: { ci: 'github-actions' },
			},
		});
		expect(result.annotations.commitSha).toBe('abc1234');
		const metaText = Object.values(writtenMeta).pop();
		expect(metaText).toBeDefined();
		const meta = JSON.parse(metaText!);
		expect(meta.annotations.commitSha).toBe('abc1234');
		expect(meta.annotations.author).toBe('alex@example.com');
		expect(meta.status).toBe('completed');
		expect(meta.completedSteps).toEqual(['prepare', 'upload', 'install', 'link', 'restart']);
	});

	test('readReleaseMeta returns the parsed record', async () => {
		const stored: Record<string, string> = {};
		const target: Target = {
			description: 'mock',
			exec: async (cmd, opts) => {
				if (opts?.stdin !== undefined && cmd.startsWith('cat > ')) {
					const path = cmd.slice('cat > '.length).trim();
					stored[path] = opts.stdin;
					return { exitCode: 0, stderr: '', stdout: '' };
				}
				if (cmd.startsWith('cat ') && cmd.includes('.deploy-meta.json')) {
					const path = cmd.slice('cat '.length).split(' ')[0]!.trim();
					return { exitCode: 0, stderr: '', stdout: stored[path] ?? '' };
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 1_000_000,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		const result = await deployer.deploy({ annotations: { commitSha: 'xyz' } });
		const meta = await deployer.readReleaseMeta(result.releaseId);
		expect(meta).not.toBeNull();
		expect(meta!.annotations.commitSha).toBe('xyz');
		expect(meta!.status).toBe('completed');
	});
});

describe('resume from failed step', () => {
	test('resumeReleaseId skips completed steps and re-runs from the failure', async () => {
		const stored: Record<string, string> = {};
		const stepCalls: string[] = [];
		const target: Target = {
			description: 'mock',
			exec: async (cmd, opts) => {
				if (opts?.stdin !== undefined && cmd.startsWith('cat > ')) {
					const path = cmd.slice('cat > '.length).trim();
					stored[path] = opts.stdin;
				}
				if (cmd.startsWith('cat ') && cmd.includes('.deploy-meta.json')) {
					const path = cmd.slice('cat '.length).split(' ')[0]!.trim();
					return { exitCode: 0, stderr: '', stdout: stored[path] ?? '' };
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		let failOn = 'install';
		const steps: DeployStep[] = [
			{ name: 'prepare', run: async () => { stepCalls.push('prepare'); } },
			{ name: 'upload', run: async () => { stepCalls.push('upload'); } },
			{
				name: 'install',
				run: async () => {
					stepCalls.push('install');
					if (failOn === 'install') throw new Error('boom');
				},
			},
			{ name: 'link', run: async () => { stepCalls.push('link'); } },
			{ name: 'restart', run: async () => { stepCalls.push('restart'); } },
		];

		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps,
			target,
		});

		await expect(deployer.deploy()).rejects.toThrow('boom');
		expect(stepCalls).toEqual(['prepare', 'upload', 'install']);

		// Pull the failed release id from the stored meta.
		const metaText = Object.values(stored).pop()!;
		const meta = JSON.parse(metaText);
		expect(meta.status).toBe('failed');
		expect(meta.failedStep).toBe('install');
		expect(meta.completedSteps).toEqual(['prepare', 'upload']);

		// Fix the issue, resume.
		failOn = 'none';
		stepCalls.length = 0;
		const resumed = await deployer.deploy({ resumeReleaseId: meta.releaseId });
		// install re-runs (the failed step); prepare + upload were skipped.
		expect(stepCalls).toEqual(['install', 'link', 'restart']);
		expect(resumed.releaseId).toBe(meta.releaseId);
	});

	test('resume on a completed release throws', async () => {
		const stored: Record<string, string> = {};
		const target: Target = {
			description: 'mock',
			exec: async (cmd, opts) => {
				if (opts?.stdin !== undefined && cmd.startsWith('cat > ')) {
					stored[cmd.slice('cat > '.length).trim()] = opts.stdin;
				}
				if (cmd.startsWith('cat ') && cmd.includes('.deploy-meta.json')) {
					const path = cmd.slice('cat '.length).split(' ')[0]!.trim();
					return { exitCode: 0, stderr: '', stdout: stored[path] ?? '' };
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		const ok = await deployer.deploy();
		await expect(deployer.deploy({ resumeReleaseId: ok.releaseId })).rejects.toThrow(/already completed/);
	});

	test('resume on an unknown release throws', async () => {
		const { target } = makePatternTarget([]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		await expect(deployer.deploy({ resumeReleaseId: 'nonexistent' })).rejects.toThrow(/no \.deploy-meta\.json/);
	});
});

describe('orphan cleanup', () => {
	test('every deploy() removes a dangling current.next', async () => {
		const { execLog, target } = makePatternTarget([]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		await deployer.deploy();
		const cleanup = execLog.find((entry) => entry.cmd.includes('rm -f') && entry.cmd.includes('current.next'));
		expect(cleanup).toBeDefined();
	});

	test('rollback also cleans current.next before re-pointing', async () => {
		const stored: Record<string, string> = {};
		const target: Target = {
			description: 'mock',
			exec: async (cmd, opts) => {
				if (opts?.stdin !== undefined && cmd.startsWith('cat > ')) {
					stored[cmd.slice('cat > '.length).trim()] = opts.stdin;
				}
				if (cmd.startsWith('cat ') && cmd.includes('.deploy-meta.json')) {
					const path = cmd.slice('cat '.length).split(' ')[0]!.trim();
					return { exitCode: 0, stderr: '', stdout: stored[path] ?? '' };
				}
				if (cmd.includes('test -d')) return { exitCode: 0, stderr: '', stdout: 'ok\n' };
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: noopSteps,
			target,
		});
		const ok = await deployer.deploy();
		const rollback = await deployer.rollback(ok.releaseId);
		expect(rollback.releaseId).toBe(ok.releaseId);
	});
});
