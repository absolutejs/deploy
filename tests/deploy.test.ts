import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	bareManager,
	createDeployer,
	defaultBunPipeline,
	localTarget,
	sshTarget,
	systemdManager,
	type DeployStep,
	type ExecResult,
	type ProcessManager,
	type Target,
} from '../src';

// -----------------------------------------------------------------------------
// MockTarget — used for pipeline-driving tests without touching disk or SSH.
// -----------------------------------------------------------------------------

type ExecHandler = (cmd: string) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

const makeMockTarget = (handlers: ExecHandler[] = []) => {
	const execLog: string[] = [];
	const uploadLog: { local: string; remote: string }[] = [];
	let handlerIndex = 0;
	const target: Target = {
		description: 'mock',
		exec: async (cmd) => {
			execLog.push(cmd);
			const next = handlers[handlerIndex];
			if (next) handlerIndex++;
			const partial = next ? await next(cmd) : {};
			return {
				exitCode: partial.exitCode ?? 0,
				stderr: partial.stderr ?? '',
				stdout: partial.stdout ?? '',
			};
		},
		upload: async (local, remote) => {
			uploadLog.push({ local, remote });
		},
	};
	return { execLog, target, uploadLog };
};

// -----------------------------------------------------------------------------
// Pipeline drives steps in order, fires hooks, threads ctx
// -----------------------------------------------------------------------------

describe('createDeployer (pipeline)', () => {
	test('runs every step in order and reports per-step durations', async () => {
		const order: string[] = [];
		const steps: DeployStep[] = [
			{ name: 'first', run: async () => { order.push('first'); } },
			{ name: 'second', run: async () => { order.push('second'); } },
			{ name: 'third', run: async () => { order.push('third'); } },
		];
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'app',
			source: { kind: 'directory', root: '/local' },
			steps,
			target,
		});
		const result = await deployer.deploy();
		expect(order).toEqual(['first', 'second', 'third']);
		expect(result.steps.map((step) => step.name)).toEqual(['first', 'second', 'third']);
	});

	test('hooks fire for start, end, and error', async () => {
		const events: string[] = [];
		const steps: DeployStep[] = [
			{ name: 'ok', run: async () => {} },
			{ name: 'boom', run: async () => { throw new Error('nope'); } },
		];
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'app',
			hooks: {
				onError: ({ step }) => { events.push(`error:${step}`); },
				onStepEnd: ({ name }) => { events.push(`end:${name}`); },
				onStepStart: ({ name }) => { events.push(`start:${name}`); },
			},
			source: { kind: 'directory', root: '/local' },
			steps,
			target,
		});
		await expect(deployer.deploy()).rejects.toThrow('nope');
		expect(events).toEqual([
			'start:ok',
			'end:ok',
			'start:boom',
			'error:boom',
		]);
	});

	test('release id is deterministic with a fixed clock', async () => {
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'app',
			// Epoch 0 = 1970-01-01T00:00:00Z → release id is the UTC YYYYMMDD-HHMMSS form.
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			steps: [{ name: 'noop', run: async () => {} }],
			target,
		});
		const result = await deployer.deploy();
		expect(result.releaseId).toBe('19700101-000000');
		expect(result.releasePath).toBe('/srv/app/releases/19700101-000000');
		expect(result.currentPath).toBe('/srv/app/current');
	});

	test('rootPath override threads through to release + current paths', async () => {
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'app',
			clock: () => 0,
			rootPath: '/opt/myapp',
			source: { kind: 'directory', root: '/local' },
			steps: [{ name: 'noop', run: async () => {} }],
			target,
		});
		const result = await deployer.deploy();
		expect(result.currentPath).toBe('/opt/myapp/current');
		expect(result.releasePath.startsWith('/opt/myapp/releases/')).toBe(true);
	});
});

// -----------------------------------------------------------------------------
// Default Bun pipeline — drives the mock target with sane shell commands
// -----------------------------------------------------------------------------

// Pattern-based mock target: handlers respond to specific command shapes
// rather than a fixed sequential order — robust to new internal exec calls
// (writeMeta, cleanOrphanedSymlink, etc.) being added in later versions.
type PatternHandler = (cmd: string) => Partial<ExecResult> | undefined;

const makePatternTarget = (patterns: PatternHandler[]) => {
	const execLog: string[] = [];
	const uploadLog: { local: string; remote: string }[] = [];
	const target: Target = {
		description: 'mock-pattern',
		exec: async (cmd) => {
			execLog.push(cmd);
			for (const pattern of patterns) {
				const reply = pattern(cmd);
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
		upload: async (local, remote) => {
			uploadLog.push({ local, remote });
		},
	};
	return { execLog, target, uploadLog };
};

describe('defaultBunPipeline', () => {
	test('runs prepare, upload, install, link, restart in order against the target', async () => {
		const { execLog, target, uploadLog } = makePatternTarget([
			(cmd) => (cmd.startsWith('grep -E') ? { stdout: '' } : undefined),
		]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local/project' },
			target,
		});
		const result = await deployer.deploy();
		expect(result.steps.map((step) => step.name)).toEqual([
			'prepare',
			'upload',
			'install',
			'build',
			'link',
			'restart',
			'verify',
		]);
		expect(uploadLog).toHaveLength(1);
		expect(uploadLog[0]!.local.endsWith('/')).toBe(true);
		expect(uploadLog[0]!.remote.startsWith('/srv/demo/releases/')).toBe(true);
		expect(execLog.find((cmd) => cmd.includes('bun install --production'))).toBeDefined();
		expect(execLog.find((cmd) => cmd.includes('ln -sfn') && cmd.includes('/srv/demo/current'))).toBeDefined();
	});

	test('build step is skipped when package.json has no build script', async () => {
		const { execLog, target } = makePatternTarget([
			(cmd) => (cmd.startsWith('grep -E') ? { stdout: '"name": "x"\n' } : undefined),
		]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			target,
		});
		await deployer.deploy();
		expect(execLog.find((cmd) => cmd === 'bun run build')).toBeUndefined();
	});

	test('build step runs when package.json has a build script', async () => {
		const { execLog, target } = makePatternTarget([
			(cmd) => (cmd.startsWith('grep -E') ? { stdout: '"build": "tsc"\n' } : undefined),
		]);
		const deployer = createDeployer({
			appName: 'demo',
			clock: () => 0,
			source: { kind: 'directory', root: '/local' },
			target,
		});
		await deployer.deploy();
		expect(execLog.find((cmd) => cmd === 'bun run build')).toBeDefined();
	});
});

// -----------------------------------------------------------------------------
// Releases: list + prune + rollback
// -----------------------------------------------------------------------------

describe('releases', () => {
	test('listReleases returns sorted release ids from `ls`', async () => {
		const { target } = makeMockTarget([
			() => ({}),
			() => ({ stdout: '20260101-000000\n20260201-000000\n20260301-000000\n' }),
		]);
		const deployer = createDeployer({
			appName: 'demo',
			source: { kind: 'directory', root: '/local' },
			target,
		});
		const releases = await deployer.listReleases();
		expect(releases).toEqual(['20260101-000000', '20260201-000000', '20260301-000000']);
	});

	test('prune deletes the oldest releases, keeping the newest N', async () => {
		const removed: string[] = [];
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				if (cmd.includes('ls -1')) {
					return {
						exitCode: 0,
						stderr: '',
						stdout: ['r1', 'r2', 'r3', 'r4', 'r5'].join('\n') + '\n',
					};
				}
				if (cmd.startsWith('rm -rf ')) {
					removed.push(cmd.replace('rm -rf ', ''));
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			source: { kind: 'directory', root: '/local' },
			target,
		});
		const result = await deployer.prune({ keep: 2 });
		expect(result.removed).toEqual(['r1', 'r2', 'r3']);
		expect(removed).toEqual([
			'/srv/demo/releases/r1',
			'/srv/demo/releases/r2',
			'/srv/demo/releases/r3',
		]);
	});

	test('rollback re-points current at the existing release and reloads', async () => {
		const execLog: string[] = [];
		let restarted = 0;
		const manager: ProcessManager = {
			reload: async () => { restarted += 1; },
		};
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				execLog.push(cmd);
				if (cmd.includes('test -d')) return { exitCode: 0, stderr: '', stdout: 'ok\n' };
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			processManager: manager,
			source: { kind: 'directory', root: '/local' },
			target,
		});
		const result = await deployer.rollback('20260201-000000');
		expect(result.steps.map((step) => step.name)).toEqual(['link', 'restart', 'verify']);
		expect(restarted).toBe(1);
		expect(execLog.find((cmd) => cmd.includes('ln -sfn /srv/demo/releases/20260201-000000'))).toBeDefined();
	});

	test('rollback throws when the release id does not exist', async () => {
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				if (cmd.includes('test -d')) return { exitCode: 0, stderr: '', stdout: 'missing\n' };
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const deployer = createDeployer({
			appName: 'demo',
			source: { kind: 'directory', root: '/local' },
			target,
		});
		await expect(deployer.rollback('nope')).rejects.toThrow(/not found/);
	});
});

// -----------------------------------------------------------------------------
// localTarget — end-to-end against a temp directory
// -----------------------------------------------------------------------------

const TMP_ROOT = join(import.meta.dir, '_tmp');

describe('localTarget (e2e)', () => {
	beforeEach(async () => {
		await rm(TMP_ROOT, { force: true, recursive: true });
		await mkdir(TMP_ROOT, { recursive: true });
	});

	test('exec runs a command and captures output', async () => {
		const target = localTarget({ root: TMP_ROOT });
		const result = await target.exec('echo hello && echo world >&2');
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('hello');
		expect(result.stderr.trim()).toBe('world');
	});

	test('exec forwards env and cwd', async () => {
		const target = localTarget({ root: TMP_ROOT, env: { BASE: 'base-value' } });
		const sub = join(TMP_ROOT, 'sub');
		await mkdir(sub, { recursive: true });
		const result = await target.exec('echo "$BASE-$EXTRA at $(pwd)"', {
			cwd: sub,
			env: { EXTRA: 'extra-value' },
		});
		expect(result.stdout.trim()).toBe(`base-value-extra-value at ${sub}`);
	});

	test('upload copies a directory tree via rsync', async () => {
		const src = join(TMP_ROOT, 'src');
		const dst = join(TMP_ROOT, 'dst');
		await mkdir(src, { recursive: true });
		await writeFile(join(src, 'a.txt'), 'aaa');
		await writeFile(join(src, 'b.txt'), 'bbb');
		const target = localTarget({ root: TMP_ROOT });
		await target.upload(`${src}/`, dst);
		const a = Bun.file(join(dst, 'a.txt'));
		expect(await a.text()).toBe('aaa');
	});

	test('localTarget end-to-end deploy: prepare, upload, link, restart-noop', async () => {
		const src = join(TMP_ROOT, 'project');
		await mkdir(src, { recursive: true });
		await writeFile(join(src, 'package.json'), JSON.stringify({ name: 'demo' }));
		await writeFile(join(src, 'index.ts'), 'console.log("hello");');

		const restarted: string[] = [];
		const noopManager: ProcessManager = {
			reload: async (_target, ctx) => { restarted.push(ctx.releasePath); },
		};

		const target = localTarget({ root: TMP_ROOT });
		const root = join(TMP_ROOT, 'srv', 'demo');
		const steps: DeployStep[] = defaultBunPipeline().filter((step) => step.name !== 'install' && step.name !== 'build');

		const deployer = createDeployer({
			appName: 'demo',
			rootPath: root,
			source: { kind: 'directory', root: src },
			steps,
			processManager: noopManager,
			target,
		});

		const result = await deployer.deploy();
		expect(result.steps.map((step) => step.name)).toEqual(['prepare', 'upload', 'link', 'restart', 'verify']);

		const uploaded = join(result.releasePath, 'package.json');
		expect(await Bun.file(uploaded).text()).toContain('"demo"');

		// `current` symlink resolves to the release path.
		const currentResolved = await target.exec(`readlink ${result.currentPath}`);
		expect(currentResolved.stdout.trim()).toBe(result.releasePath);

		expect(restarted).toEqual([result.releasePath]);
	});
});

// -----------------------------------------------------------------------------
// sshTarget — surface (no real SSH; verifies the lib constructs commands sanely)
// -----------------------------------------------------------------------------

describe('sshTarget', () => {
	test('description includes user@host', () => {
		const target = sshTarget({ host: 'droplet-1.example.com', user: 'deploy' });
		expect(target.description).toBe('ssh deploy@droplet-1.example.com');
	});

	test('description shows non-22 port', () => {
		const target = sshTarget({ host: 'h', port: 2222 });
		expect(target.description).toBe('ssh root@h:2222');
	});
});

// -----------------------------------------------------------------------------
// ProcessManagers — surface (no real systemd; verifies command shape)
// -----------------------------------------------------------------------------

describe('processManagers', () => {
	test('bareManager.reload runs stop then start with pid file in /var/lib/<appName>', async () => {
		const execLog: string[] = [];
		const target: Target = {
			description: 'mock',
			exec: async (cmd) => {
				execLog.push(cmd);
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const manager = bareManager();
		await manager.reload(target, {
			appName: 'demo',
			currentPath: '/srv/demo/current',
			env: { PORT: '3000' },
			releaseId: 'r1',
			releasePath: '/srv/demo/releases/r1',
		});
		expect(execLog.length).toBe(2);
		expect(execLog[0]).toContain('/var/lib/demo/demo.pid');
		expect(execLog[1]).toContain('nohup');
		expect(execLog[1]).toContain("PORT='3000'");
		expect(execLog[1]).toContain('bun run start');
	});

	test('systemdManager.reload writes a unit and restarts via systemctl', async () => {
		const execLog: string[] = [];
		let writtenUnit = '';
		const target: Target = {
			description: 'mock',
			exec: async (cmd, opts) => {
				execLog.push(cmd);
				if (cmd.includes('cat > /etc/systemd/system/demo.service')) {
					writtenUnit = opts?.stdin ?? '';
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			},
			upload: async () => {},
		};
		const manager = systemdManager({ user: 'deploy' });
		await manager.reload(target, {
			appName: 'demo',
			currentPath: '/srv/demo/current',
			env: { PORT: '3000' },
			releaseId: 'r1',
			releasePath: '/srv/demo/releases/r1',
		});
		expect(writtenUnit).toContain('[Unit]');
		expect(writtenUnit).toContain('WorkingDirectory=/srv/demo/current');
		expect(writtenUnit).toContain('Environment=PORT=3000');
		expect(execLog.find((cmd) => cmd === 'systemctl daemon-reload')).toBeDefined();
		expect(execLog.find((cmd) => cmd === 'systemctl enable demo.service')).toBeDefined();
		expect(execLog.find((cmd) => cmd === 'systemctl restart demo.service')).toBeDefined();
	});
});

// -----------------------------------------------------------------------------
// Dispose
// -----------------------------------------------------------------------------

describe('dispose', () => {
	test('subsequent deploys after dispose throw', async () => {
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'demo',
			source: { kind: 'directory', root: '/local' },
			steps: [{ name: 'noop', run: async () => {} }],
			target,
		});
		await deployer.dispose();
		await expect(deployer.deploy()).rejects.toThrow(/disposed/);
	});
});

describe('active process lifecycle', () => {
	test('delegates stop and status with the active release context', async () => {
		const contexts: Array<{ currentPath: string; releaseId: string }> = [];
		const manager: ProcessManager = {
			reload: async () => undefined,
			status: async (_target, context) => {
				contexts.push(context);
				return 'running';
			},
			stop: async (_target, context) => {
				contexts.push(context);
			}
		};
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'demo',
			processManager: manager,
			rootPath: '/opt/demo',
			source: { kind: 'directory', root: '/local' },
			target
		});

		expect(await deployer.status()).toBe('running');
		await deployer.stop();
		expect(contexts.map(({ currentPath, releaseId }) => ({ currentPath, releaseId }))).toEqual([
			{ currentPath: '/opt/demo/current', releaseId: 'current' },
			{ currentPath: '/opt/demo/current', releaseId: 'current' }
		]);
	});

	test('reports unknown without status and rejects unsupported stop', async () => {
		const { target } = makeMockTarget();
		const deployer = createDeployer({
			appName: 'demo',
			processManager: { reload: async () => undefined },
			source: { kind: 'directory', root: '/local' },
			target
		});

		expect(await deployer.status()).toBe('unknown');
		await expect(deployer.stop()).rejects.toThrow(/does not support stop/);
	});
});
