/**
 * createDeployer — drives a step pipeline against a Target.
 *
 * The default pipeline (`defaultBunPipeline`) is the right thing for a Bun
 * project on a Linux host: prepare → upload → install → build → link →
 * restart → verify. Callers can replace steps wholesale or splice their own
 * in via `steps: [...]`.
 *
 * Release model: every `deploy()` creates a fresh timestamped directory
 * under `<root>/releases/`, uploads into it, then atomically swaps the
 * `<root>/current` symlink. `rollback(id)` re-points the symlink and
 * reloads the process manager — no re-upload, no re-build, just a fast
 * switch.
 */

import type { ProcessManager, ProcessManagerContext } from './processManagers';
import { bareManager } from './processManagers';
import type { ExecResult, Target } from './targets';

export type Source = {
	/** Local directory to copy. */
	kind: 'directory';
	root: string;
	/** Globs excluded from upload. Defaults to common dev artifacts. */
	exclude?: string[];
};

export type VerifySpec =
	| { kind: 'http'; url: string; retries?: number; intervalMs?: number; expectStatus?: number }
	| { kind: 'tcp'; host: string; port: number; retries?: number; intervalMs?: number }
	| { kind: 'custom'; check: (ctx: DeployContext) => Promise<boolean> };

export type ReleaseAnnotations = {
	/** Git commit SHA being deployed (40-char hex; truncated forms accepted). */
	commitSha?: string;
	/** Git ref (e.g. `refs/heads/main`, `v1.2.3`). */
	ref?: string;
	/** Commit message (or any human-readable description). */
	message?: string;
	/** Committer / deployer identity. */
	author?: string;
	/** Arbitrary tags for downstream filtering (status pages, audits). */
	tags?: Record<string, string>;
};

export type DeployContext = {
	target: Target;
	source: Source;
	releaseId: string;
	releasePath: string;
	currentPath: string;
	appName: string;
	env: Record<string, string>;
	hooks: ResolvedHooks;
	processManager: ProcessManager;
	verify: VerifySpec | null;
	annotations: ReleaseAnnotations;
	/** When `true`, steps log what they WOULD do via hooks.onLog and do not mutate the target. */
	dryRun: boolean;
};

export type DeployStep = {
	name: string;
	run: (ctx: DeployContext) => Promise<void>;
};

export type DeployHooks = {
	onStepStart?: (step: { name: string; releaseId: string }) => void | Promise<void>;
	onStepEnd?: (step: { name: string; releaseId: string; durationMs: number }) => void | Promise<void>;
	onLog?: (line: string, stream: 'stdout' | 'stderr', step: string) => void;
	onError?: (error: { step: string; releaseId: string; error: Error }) => void | Promise<void>;
};

type ResolvedHooks = Required<{
	[K in keyof DeployHooks]: NonNullable<DeployHooks[K]>;
}>;

export type DeployOptions = {
	/** Per-release annotations stored alongside the release dir as `.deploy-meta.json`. */
	annotations?: ReleaseAnnotations;
	/**
	 * When `true`, the deploy plan is logged but no mutation happens on the
	 * target — steps still call `target.exec` only via `cmd === 'echo'`-style
	 * dry-run probes. Use this from `gh actions` to verify pipeline shape
	 * before flipping a real `current` symlink.
	 */
	dryRun?: boolean;
	/**
	 * Resume a previously-failed release. The deployer reads the release's
	 * `.deploy-meta.json`, finds the step that died, and starts from there.
	 * Steps that completed successfully are skipped. Use this when a deploy
	 * fails on `verify` (e.g. health-check timeout) but the release is
	 * otherwise intact on disk.
	 */
	resumeReleaseId?: string;
};

export type DeployerOptions = {
	target: Target;
	source: Source;
	/** App name; used by ProcessManagers for unit names, pid files, log paths. Required. */
	appName: string;
	/** Where deploys live on the target. Default `/srv/<appName>`. */
	rootPath?: string;
	/** Steps in order. Default: `defaultBunPipeline()`. */
	steps?: DeployStep[];
	/** Env merged into install / build / start. */
	env?: Record<string, string>;
	/** Process manager. Default `bareManager()`. */
	processManager?: ProcessManager;
	/** How to verify the deploy is up. Default null (skip verify). */
	verify?: VerifySpec | null;
	hooks?: DeployHooks;
	/** Override `Date.now` for deterministic release ids in tests. */
	clock?: () => number;
};

export type ReleaseRecord = {
	releaseId: string;
	annotations: ReleaseAnnotations;
	status: 'in-progress' | 'completed' | 'failed';
	failedStep?: string;
	completedSteps: string[];
	startedAt: number;
	endedAt?: number;
};

export type DeployResult = {
	releaseId: string;
	releasePath: string;
	currentPath: string;
	durationMs: number;
	steps: { name: string; durationMs: number; skipped?: boolean }[];
	annotations: ReleaseAnnotations;
};

export type Deployer = {
	deploy: (options?: DeployOptions) => Promise<DeployResult>;
	rollback: (releaseId: string) => Promise<DeployResult>;
	listReleases: () => Promise<string[]>;
	/** Read the deploy meta for a specific release (or null if missing). */
	readReleaseMeta: (releaseId: string) => Promise<ReleaseRecord | null>;
	prune: (options: { keep: number }) => Promise<{ removed: string[] }>;
	dispose: () => Promise<void>;
};

const DEFAULT_EXCLUDES = ['node_modules', 'dist', 'build', '.git', '.DS_Store', '*.log'];

const noopHooks: ResolvedHooks = {
	onError: () => {},
	onLog: () => {},
	onStepEnd: () => {},
	onStepStart: () => {},
};

const resolveHooks = (hooks?: DeployHooks): ResolvedHooks => ({
	onError: hooks?.onError ?? noopHooks.onError,
	onLog: hooks?.onLog ?? noopHooks.onLog,
	onStepEnd: hooks?.onStepEnd ?? noopHooks.onStepEnd,
	onStepStart: hooks?.onStepStart ?? noopHooks.onStepStart,
});

const makeReleaseId = (clock: () => number): string => {
	const t = clock();
	const date = new Date(t);
	const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
};

const requireSuccess = (label: string, result: ExecResult) => {
	if (result.exitCode !== 0) {
		throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout || '(no output)'}`);
	}
};

// -----------------------------------------------------------------------------
// Default Bun pipeline steps
// -----------------------------------------------------------------------------

export const defaultBunPipeline = (): DeployStep[] => [
	{
		name: 'prepare',
		run: async (ctx) => {
			const result = await ctx.target.exec(
				`mkdir -p ${ctx.releasePath}`,
				{ onLog: (line, stream) => ctx.hooks.onLog(line, stream, 'prepare') },
			);
			requireSuccess('prepare: mkdir', result);
		},
	},
	{
		name: 'upload',
		run: async (ctx) => {
			if (ctx.source.kind !== 'directory') {
				throw new Error(`Unsupported source kind: ${(ctx.source as { kind: string }).kind}`);
			}
			// Trailing slash on source = copy contents, not the dir itself.
			const localPath = ctx.source.root.endsWith('/') ? ctx.source.root : `${ctx.source.root}/`;
			await ctx.target.upload(localPath, ctx.releasePath, {
				exclude: ctx.source.exclude ?? DEFAULT_EXCLUDES,
			});
		},
	},
	{
		name: 'install',
		run: async (ctx) => {
			const result = await ctx.target.exec(
				`bun install --production`,
				{
					cwd: ctx.releasePath,
					env: ctx.env,
					onLog: (line, stream) => ctx.hooks.onLog(line, stream, 'install'),
					timeoutMs: 600_000,
				},
			);
			requireSuccess('install', result);
		},
	},
	{
		name: 'build',
		run: async (ctx) => {
			// Run only if the project declares a `build` script. Detect by reading package.json on the remote.
			const probe = await ctx.target.exec(
				`grep -E '"build"\\s*:' package.json || true`,
				{ cwd: ctx.releasePath, timeoutMs: 10_000 },
			);
			if (!probe.stdout.includes('"build"')) return;
			const result = await ctx.target.exec(
				`bun run build`,
				{
					cwd: ctx.releasePath,
					env: ctx.env,
					onLog: (line, stream) => ctx.hooks.onLog(line, stream, 'build'),
					timeoutMs: 600_000,
				},
			);
			requireSuccess('build', result);
		},
	},
	{
		name: 'link',
		run: async (ctx) => {
			// Atomic-ish symlink swap: write a NEW symlink to a temp name, then rename onto current.
			const tmpLink = `${ctx.currentPath}.next`;
			const result = await ctx.target.exec(
				`ln -sfn ${ctx.releasePath} ${tmpLink} && mv -Tf ${tmpLink} ${ctx.currentPath}`,
				{ onLog: (line, stream) => ctx.hooks.onLog(line, stream, 'link'), timeoutMs: 10_000 },
			);
			requireSuccess('link', result);
		},
	},
	{
		name: 'restart',
		run: async (ctx) => {
			await ctx.processManager.reload(ctx.target, {
				appName: ctx.appName,
				currentPath: ctx.currentPath,
				env: ctx.env,
				onLog: (line, stream) => ctx.hooks.onLog(line, stream, 'restart'),
				releaseId: ctx.releaseId,
				releasePath: ctx.releasePath,
			});
		},
	},
	{
		name: 'verify',
		run: async (ctx) => {
			if (!ctx.verify) return;
			await runVerify(ctx);
		},
	},
];

const runVerify = async (ctx: DeployContext): Promise<void> => {
	const spec = ctx.verify!;
	if (spec.kind === 'custom') {
		const ok = await spec.check(ctx);
		if (!ok) throw new Error('verify: custom check returned false');
		return;
	}
	if (spec.kind === 'http') {
		const retries = spec.retries ?? 30;
		const intervalMs = spec.intervalMs ?? 1_000;
		const expectStatus = spec.expectStatus ?? 200;
		for (let attempt = 0; attempt <= retries; attempt++) {
			const probe = await ctx.target.exec(
				`curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${spec.url}`,
				{ timeoutMs: 10_000 },
			);
			const code = Number(probe.stdout.trim());
			if (code === expectStatus) return;
			if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
		throw new Error(`verify: HTTP ${spec.url} did not return ${expectStatus} after ${retries} retries`);
	}
	// tcp
	const retries = spec.retries ?? 30;
	const intervalMs = spec.intervalMs ?? 1_000;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const probe = await ctx.target.exec(
			`bash -c 'cat < /dev/tcp/${spec.host}/${spec.port}' 2>/dev/null && echo open || echo closed`,
			{ timeoutMs: 10_000 },
		);
		if (probe.stdout.includes('open')) return;
		if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`verify: TCP ${spec.host}:${spec.port} not open after ${retries} retries`);
};

// -----------------------------------------------------------------------------
// Deployer
// -----------------------------------------------------------------------------

export const createDeployer = (options: DeployerOptions): Deployer => {
	const clock = options.clock ?? Date.now;
	const hooks = resolveHooks(options.hooks);
	const rootPath = options.rootPath ?? `/srv/${options.appName}`;
	const currentPath = `${rootPath}/current`;
	const releasesPath = `${rootPath}/releases`;
	const env: Record<string, string> = { NODE_ENV: 'production', ...options.env };
	const processManager = options.processManager ?? bareManager();
	const verify = options.verify === undefined ? null : options.verify;
	let disposed = false;

	const buildCtx = (
		releaseId: string,
		opts: { annotations: ReleaseAnnotations; dryRun: boolean },
	): DeployContext => ({
		annotations: opts.annotations,
		appName: options.appName,
		currentPath,
		dryRun: opts.dryRun,
		env,
		hooks,
		processManager,
		releaseId,
		releasePath: `${releasesPath}/${releaseId}`,
		source: options.source,
		target: options.target,
		verify,
	});

	const metaPath = (releaseId: string) => `${releasesPath}/${releaseId}/.deploy-meta.json`;

	const writeMeta = async (releaseId: string, record: ReleaseRecord): Promise<void> => {
		const json = JSON.stringify(record);
		// Use stdin to avoid quoting hassles + so the JSON doesn't appear in `ps`.
		const result = await options.target.exec(`cat > ${metaPath(releaseId)}`, {
			stdin: json,
			timeoutMs: 10_000,
		});
		if (result.exitCode !== 0) {
			// Non-fatal — the deploy doesn't depend on the meta file for success.
			console.warn(`[deploy] writeMeta(${releaseId}) failed: ${result.stderr || result.stdout}`);
		}
	};

	const readMeta = async (releaseId: string): Promise<ReleaseRecord | null> => {
		const result = await options.target.exec(`cat ${metaPath(releaseId)} 2>/dev/null || true`, {
			timeoutMs: 10_000,
		});
		const text = result.stdout.trim();
		if (text.length === 0) return null;
		try {
			return JSON.parse(text) as ReleaseRecord;
		} catch {
			return null;
		}
	};

	const cleanOrphanedSymlink = async (): Promise<void> => {
		// A prior deploy that crashed between `ln -sfn ... current.next` and
		// `mv -Tf current.next current` leaves `current.next` dangling. Clean
		// it so the next link step's `mv -Tf` is unambiguous.
		await options.target.exec(`rm -f ${currentPath}.next`, { timeoutMs: 5_000 });
	};

	const runSteps = async (
		steps: DeployStep[],
		releaseId: string,
		runOpts: {
			annotations: ReleaseAnnotations;
			dryRun: boolean;
			alreadyCompleted: string[];
		},
	): Promise<DeployResult> => {
		const ctx = buildCtx(releaseId, {
			annotations: runOpts.annotations,
			dryRun: runOpts.dryRun,
		});
		const stepDurations: { name: string; durationMs: number; skipped?: boolean }[] = [];
		const startedAt = clock();
		const completedSteps: string[] = [...runOpts.alreadyCompleted];

		const record: ReleaseRecord = {
			annotations: runOpts.annotations,
			completedSteps,
			releaseId,
			startedAt,
			status: 'in-progress',
		};
		// Write the meta-record as soon as the release directory exists, which
		// `prepare` sets up. Until then we have nowhere to put it.

		for (const step of steps) {
			if (completedSteps.includes(step.name) && step.name !== 'verify') {
				// Resume: skip steps already done. (Always re-run verify so a
				// healthy probe is recorded post-resume.)
				stepDurations.push({ durationMs: 0, name: step.name, skipped: true });
				continue;
			}

			const stepStartedAt = clock();
			await hooks.onStepStart({ name: step.name, releaseId });

			if (runOpts.dryRun) {
				hooks.onLog(`[dry-run] would run: ${step.name}`, 'stdout', step.name);
				stepDurations.push({ durationMs: 0, name: step.name, skipped: true });
				await hooks.onStepEnd({ durationMs: 0, name: step.name, releaseId });
				continue;
			}

			try {
				await step.run(ctx);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				record.status = 'failed';
				record.failedStep = step.name;
				record.endedAt = clock();
				// Best-effort meta write so resume() works later.
				await writeMeta(releaseId, record);
				await hooks.onError({ error: err, releaseId, step: step.name });
				throw err;
			}

			const durationMs = clock() - stepStartedAt;
			stepDurations.push({ durationMs, name: step.name });
			completedSteps.push(step.name);
			await hooks.onStepEnd({ durationMs, name: step.name, releaseId });

			// After `prepare` (the first step that creates the dir), persist meta.
			if (step.name === 'prepare') {
				await writeMeta(releaseId, record);
			}
		}

		record.status = 'completed';
		record.endedAt = clock();
		if (!runOpts.dryRun) await writeMeta(releaseId, record);

		return {
			annotations: runOpts.annotations,
			currentPath,
			durationMs: clock() - startedAt,
			releaseId,
			releasePath: ctx.releasePath,
			steps: stepDurations,
		};
	};

	const ensureRoot = async () => {
		const result = await options.target.exec(`mkdir -p ${releasesPath}`, { timeoutMs: 10_000 });
		requireSuccess('ensureRoot', result);
	};

	return {
		deploy: async (deployOpts: DeployOptions = {}) => {
			if (disposed) throw new Error('Deployer is disposed');
			await ensureRoot();
			await cleanOrphanedSymlink();

			const annotations = deployOpts.annotations ?? {};
			const dryRun = deployOpts.dryRun ?? false;

			if (deployOpts.resumeReleaseId !== undefined) {
				const prior = await readMeta(deployOpts.resumeReleaseId);
				if (!prior) {
					throw new Error(
						`resume: no .deploy-meta.json for release ${deployOpts.resumeReleaseId}`,
					);
				}
				if (prior.status === 'completed') {
					throw new Error(
						`resume: release ${deployOpts.resumeReleaseId} already completed`,
					);
				}
				return runSteps(options.steps ?? defaultBunPipeline(), deployOpts.resumeReleaseId, {
					alreadyCompleted: prior.completedSteps,
					annotations: prior.annotations ?? annotations,
					dryRun,
				});
			}

			const releaseId = makeReleaseId(clock);
			return runSteps(options.steps ?? defaultBunPipeline(), releaseId, {
				alreadyCompleted: [],
				annotations,
				dryRun,
			});
		},
		dispose: async () => {
			disposed = true;
			if (options.target.close) await options.target.close();
		},
		listReleases: async () => {
			await ensureRoot();
			const result = await options.target.exec(
				`ls -1 ${releasesPath} 2>/dev/null || true`,
				{ timeoutMs: 10_000 },
			);
			return result.stdout
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.sort();
		},
		prune: async ({ keep }) => {
			if (disposed) throw new Error('Deployer is disposed');
			const all = await (async () => {
				const result = await options.target.exec(
					`ls -1 ${releasesPath} 2>/dev/null || true`,
					{ timeoutMs: 10_000 },
				);
				return result.stdout
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.sort();
			})();
			if (all.length <= keep) return { removed: [] };
			const removed = all.slice(0, all.length - keep);
			for (const releaseId of removed) {
				await options.target.exec(`rm -rf ${releasesPath}/${releaseId}`, { timeoutMs: 60_000 });
			}
			return { removed };
		},
		readReleaseMeta: readMeta,
		rollback: async (releaseId) => {
			if (disposed) throw new Error('Deployer is disposed');
			await ensureRoot();
			await cleanOrphanedSymlink();
			const exists = await options.target.exec(
				`test -d ${releasesPath}/${releaseId} && echo ok || echo missing`,
				{ timeoutMs: 5_000 },
			);
			if (!exists.stdout.includes('ok')) {
				throw new Error(`rollback: release ${releaseId} not found at ${releasesPath}/${releaseId}`);
			}
			// Rollback steps: re-link + restart (no upload, no install, no build).
			const rollbackSteps: DeployStep[] = defaultBunPipeline().filter((step) =>
				step.name === 'link' || step.name === 'restart' || step.name === 'verify',
			);
			const prior = await readMeta(releaseId);
			return runSteps(rollbackSteps, releaseId, {
				alreadyCompleted: [],
				annotations: prior?.annotations ?? {},
				dryRun: false,
			});
		},
	};
};
