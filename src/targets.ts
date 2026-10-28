/**
 * Target interface + bundled adapters (localTarget, sshTarget).
 *
 * A Target is the narrowest abstraction over "a place I can deploy to":
 *
 *   - `exec(cmd, opts?)` — run a shell command, capture stdout/stderr/exitCode.
 *   - `upload(localPath, remotePath, opts?)` — copy a local file or directory
 *     to the target. Implementation is free to use whatever is fast (rsync,
 *     scp, mv).
 *   - `close?()` — optional teardown.
 *
 * Two adapters are bundled:
 *
 *   - `localTarget` runs in a temp directory on the local filesystem. Useful
 *     for tests and for "deploy" workflows that happen on the same host.
 *   - `sshTarget` shells out to the system `ssh` and `rsync` binaries. No
 *     `ssh2` npm dependency — the controller machine just needs `ssh` and
 *     (optionally) `rsync` in PATH, which is universal on Mac/Linux/WSL.
 *
 * Provider-specific targets (Cloudflare Workers HTTP API, Fly Machines API,
 * AWS Fargate) don't fit "exec + upload" and ship as siblings later.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ExecOptions = {
	/** Working directory on the target. Default: target's root. */
	cwd?: string;
	/** Env vars to set for this command (merged onto target.env). */
	env?: Record<string, string>;
	/** Hard kill after this many ms. Default 600_000 (10 min). 0 disables. */
	timeoutMs?: number;
	/** Pipe stdout/stderr through here as it streams (lines, newline-stripped). */
	onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
	/** Stdin payload — a string is written verbatim. */
	stdin?: string;
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type UploadOptions = {
	/** Exclude paths matching these globs from a directory upload. */
	exclude?: string[];
	/** When uploading a directory, delete remote files not present locally. */
	deleteOrphans?: boolean;
};

export type Target = {
	/** Human-readable description (e.g. "ssh root@droplet-1.example.com"). */
	readonly description: string;
	exec: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;
	upload: (localPath: string, remotePath: string, opts?: UploadOptions) => Promise<void>;
	close?: () => Promise<void>;
};

// -----------------------------------------------------------------------------
// localTarget
// -----------------------------------------------------------------------------

export type LocalTargetOptions = {
	/** Root directory the target operates in. Created if missing. */
	root: string;
	/** Env merged into every exec. */
	env?: Record<string, string>;
};

const decodeChunks = async (
	reader: ReadableStream<Uint8Array> | null,
	onLine: ((line: string) => void) | undefined,
): Promise<string> => {
	if (!reader) return '';
	const decoder = new TextDecoder();
	let buffer = '';
	let collected = '';
	const stream = reader.getReader();
	try {
		while (true) {
			const { done, value } = await stream.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			collected += chunk;
			if (!onLine) continue;
			buffer += chunk;
			let newline = buffer.indexOf('\n');
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				if (line.length > 0) onLine(line);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf('\n');
			}
		}
		const tail = decoder.decode();
		collected += tail;
		if (onLine && (buffer + tail).length > 0) onLine((buffer + tail).replace(/\r$/, ''));
	} finally {
		stream.releaseLock();
	}
	return collected;
};

const runSpawn = async (
	argv: string[],
	options: {
		cwd?: string;
		env?: Record<string, string>;
		timeoutMs?: number;
		onLog?: ExecOptions['onLog'];
		stdin?: string;
	},
): Promise<ExecResult> => {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: options.env,
		stderr: 'pipe',
		stdin: options.stdin === undefined ? 'ignore' : 'pipe',
		stdout: 'pipe',
	});

	if (options.stdin !== undefined && proc.stdin) {
		// Bun.spawn returns a FileSink for piped stdin — `write` + `end`, not a
		// WritableStream. (We use a permissive cast because @types/bun's
		// Subprocess.stdin discriminant flips based on the stdin generic.)
		const sink = proc.stdin as unknown as {
			write: (chunk: string | Uint8Array) => number | Promise<number>;
			end: () => void | Promise<void>;
		};
		const wrote = sink.write(options.stdin);
		if (wrote && typeof (wrote as Promise<number>).then === 'function') {
			await wrote;
		}
		const ended = sink.end();
		if (ended && typeof (ended as Promise<void>).then === 'function') {
			await ended;
		}
	}

	const timeout = options.timeoutMs ?? 600_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeout > 0) {
		timer = setTimeout(() => {
			try { proc.kill(); } catch { /* already gone */ }
		}, timeout);
	}

	const stdoutPromise = decodeChunks(
		proc.stdout as unknown as ReadableStream<Uint8Array>,
		options.onLog ? (line) => options.onLog!(line, 'stdout') : undefined,
	);
	const stderrPromise = decodeChunks(
		proc.stderr as unknown as ReadableStream<Uint8Array>,
		options.onLog ? (line) => options.onLog!(line, 'stderr') : undefined,
	);

	const [stdout, stderr, exitCode] = await Promise.all([
		stdoutPromise,
		stderrPromise,
		proc.exited,
	]);
	if (timer) clearTimeout(timer);

	return { exitCode: exitCode ?? -1, stderr, stdout };
};

export const localTarget = (options: LocalTargetOptions): Target => {
	const baseEnv = { ...options.env };
	const ensureRoot = async () => { await mkdir(options.root, { recursive: true }); };

	return {
		description: `local ${options.root}`,
		exec: async (cmd, opts) => {
			await ensureRoot();
			return runSpawn(['sh', '-c', cmd], {
				cwd: opts?.cwd ?? options.root,
				env: { ...process.env, ...baseEnv, ...(opts?.env ?? {}) } as Record<string, string>,
				onLog: opts?.onLog,
				stdin: opts?.stdin,
				timeoutMs: opts?.timeoutMs,
			});
		},
		upload: async (localPath, remotePath, opts) => {
			await ensureRoot();
			const dest = remotePath.startsWith('/') ? remotePath : join(options.root, remotePath);
			const argv = ['rsync', '-a'];
			if (opts?.deleteOrphans) argv.push('--delete');
			for (const pattern of opts?.exclude ?? []) argv.push('--exclude', pattern);
			// rsync semantics: a trailing slash on the source copies *contents*; without it the dir itself is nested.
			argv.push(localPath, dest);
			const result = await runSpawn(argv, { timeoutMs: 600_000 });
			if (result.exitCode !== 0) {
				throw new Error(`local upload failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			}
		},
	};
};

// -----------------------------------------------------------------------------
// sshTarget
// -----------------------------------------------------------------------------

export type SshTargetOptions = {
	/** Hostname or IP of the remote. */
	host: string;
	/** Login user. Default `root`. */
	user?: string;
	/** SSH port. Default 22. */
	port?: number;
	/** Path to SSH identity file. Default: ssh's own search. */
	identity?: string;
	/** Extra flags appended to every `ssh` invocation. */
	sshFlags?: string[];
	/**
	 * Use rsync for `upload`. Default true. When false, falls back to `scp`
	 * which is universal but doesn't support delete / exclude.
	 */
	rsync?: boolean;
	/**
	 * Env vars to forward via `ssh -o SendEnv=...`. Most remote sshd configs
	 * accept only `LANG` and `LC_*` by default; for app env vars use the
	 * step `env` option instead, which prepends `KEY=value` to the command.
	 */
	forwardEnv?: string[];
};

const sshTargetString = (options: SshTargetOptions): string => {
	const user = options.user ?? 'root';
	return `${user}@${options.host}`;
};

const sshBaseFlags = (options: SshTargetOptions): string[] => {
	const flags: string[] = [];
	if (options.port !== undefined && options.port !== 22) flags.push('-p', String(options.port));
	if (options.identity !== undefined) flags.push('-i', options.identity);
	// Never get stuck on a host-key prompt; treat unknown hosts as a fatal config issue rather than a UX detour.
	flags.push('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new');
	for (const flag of options.sshFlags ?? []) flags.push(flag);
	return flags;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const buildRemoteCmd = (cmd: string, opts: ExecOptions | undefined): string => {
	const env = opts?.env;
	const envPrefix = env
		? Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ') + ' '
		: '';
	if (opts?.cwd) {
		return `cd ${shellQuote(opts.cwd)} && ${envPrefix}${cmd}`;
	}
	return `${envPrefix}${cmd}`;
};

export const sshTarget = (options: SshTargetOptions): Target => {
	const remote = sshTargetString(options);
	const useRsync = options.rsync ?? true;

	return {
		description: `ssh ${remote}${options.port && options.port !== 22 ? `:${options.port}` : ''}`,
		exec: async (cmd, opts) => {
			const argv = ['ssh', ...sshBaseFlags(options)];
			for (const name of options.forwardEnv ?? []) argv.push('-o', `SendEnv=${name}`);
			argv.push(remote, buildRemoteCmd(cmd, opts));
			return runSpawn(argv, {
				onLog: opts?.onLog,
				stdin: opts?.stdin,
				timeoutMs: opts?.timeoutMs,
			});
		},
		upload: async (localPath, remotePath, opts) => {
			if (useRsync) {
				const sshCmd = ['ssh', ...sshBaseFlags(options)].map((part) => part.includes(' ') ? `'${part}'` : part).join(' ');
				const argv = ['rsync', '-az', '-e', sshCmd];
				if (opts?.deleteOrphans) argv.push('--delete');
				for (const pattern of opts?.exclude ?? []) argv.push('--exclude', pattern);
				argv.push(localPath, `${remote}:${remotePath}`);
				const result = await runSpawn(argv, { timeoutMs: 600_000 });
				if (result.exitCode !== 0) {
					throw new Error(`rsync upload failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
				}
				return;
			}
			// scp fallback — no exclude, no delete. We still need -r to copy directories.
			const argv = ['scp', '-r', ...sshBaseFlags(options), localPath, `${remote}:${remotePath}`];
			const result = await runSpawn(argv, { timeoutMs: 600_000 });
			if (result.exitCode !== 0) {
				throw new Error(`scp upload failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			}
		},
	};
};
