/**
 * ProcessManager — the abstraction that turns "files are on the target" into
 * "the app is running." Two strategies ship: `bareManager` (nohup, lowest
 * dependency) and `systemdManager` (templated unit file, the way production
 * VMs should run).
 *
 * Callers can supply their own — anything that implements `start` / `stop` /
 * `reload` / `status` against a `Target` works. PM2, supervisord, runit,
 * @absolutejs/runtime all fit if someone writes the adapter.
 */

import type { Target } from './targets';

export type ProcessManagerContext = {
	/** Absolute path on the target to the active release dir (the symlink target). */
	currentPath: string;
	/** Absolute path on the target to the new release dir we just uploaded. */
	releasePath: string;
	/** Release id (timestamped). */
	releaseId: string;
	/** App name — supplied via deployer config; used for unit names, pid files, etc. */
	appName: string;
	/** Optional env to set on the process. */
	env: Record<string, string>;
	/** Log sink for any commands the manager runs. */
	onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
};

export type ProcessManager = {
	/** Bring the new release up. Called after the `current` symlink has been swapped. */
	reload: (target: Target, ctx: ProcessManagerContext) => Promise<void>;
	/** Stop the running process. */
	stop?: (target: Target, ctx: ProcessManagerContext) => Promise<void>;
	/** Return current status (best-effort; used by callers for diagnostics). */
	status?: (target: Target, ctx: ProcessManagerContext) => Promise<'running' | 'stopped' | 'unknown'>;
};

// -----------------------------------------------------------------------------
// bareManager — nohup background + pid file
// -----------------------------------------------------------------------------

export type BareManagerOptions = {
	/** Command to run. Default `bun run start`. */
	command?: string;
	/** Log files inside the app's data dir (default: alongside pid). */
	logFileBaseName?: string;
};

const pidPath = (appName: string) => `/var/lib/${appName}/${appName}.pid`;
const logDir = (appName: string) => `/var/log/${appName}`;

export const bareManager = (options: BareManagerOptions = {}): ProcessManager => {
	const command = options.command ?? 'bun run start';
	const logBase = options.logFileBaseName ?? 'app';

	const envPrefix = (env: Record<string, string>) =>
		Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ');

	const startCmd = (ctx: ProcessManagerContext): string => {
		const env = envPrefix(ctx.env);
		const pid = pidPath(ctx.appName);
		const out = `${logDir(ctx.appName)}/${logBase}.out.log`;
		const err = `${logDir(ctx.appName)}/${logBase}.err.log`;
		return `
mkdir -p $(dirname ${pid}) ${logDir(ctx.appName)} &&
cd ${ctx.currentPath} &&
nohup env ${env} sh -c '${command.replace(/'/g, `'\\''`)}' >> ${out} 2>> ${err} &
echo $! > ${pid}
`.trim();
	};

	const stopCmd = (ctx: ProcessManagerContext): string => `
PID=$(cat ${pidPath(ctx.appName)} 2>/dev/null || true);
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true;
  for i in 1 2 3 4 5; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi;
    sleep 1;
  done;
  kill -9 "$PID" 2>/dev/null || true;
fi
rm -f ${pidPath(ctx.appName)}
`.trim();

	return {
		reload: async (target, ctx) => {
			const stop = await target.exec(stopCmd(ctx), { onLog: ctx.onLog, timeoutMs: 30_000 });
			if (stop.exitCode !== 0) {
				throw new Error(`bareManager.stop failed (exit ${stop.exitCode}): ${stop.stderr}`);
			}
			const start = await target.exec(startCmd(ctx), { onLog: ctx.onLog, timeoutMs: 30_000 });
			if (start.exitCode !== 0) {
				throw new Error(`bareManager.start failed (exit ${start.exitCode}): ${start.stderr}`);
			}
		},
		status: async (target, ctx) => {
			const result = await target.exec(
				`PID=$(cat ${pidPath(ctx.appName)} 2>/dev/null || true); if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo running; else echo stopped; fi`,
				{ timeoutMs: 5_000 },
			);
			const out = result.stdout.trim();
			if (out === 'running') return 'running';
			if (out === 'stopped') return 'stopped';
			return 'unknown';
		},
		stop: async (target, ctx) => {
			const result = await target.exec(stopCmd(ctx), { onLog: ctx.onLog, timeoutMs: 30_000 });
			if (result.exitCode !== 0) {
				throw new Error(`bareManager.stop failed (exit ${result.exitCode}): ${result.stderr}`);
			}
		},
	};
};

// -----------------------------------------------------------------------------
// systemdManager — generates a unit file pointing at current/, restarts via systemctl
// -----------------------------------------------------------------------------

export type SystemdManagerOptions = {
	/** Unit file name (defaults to `${appName}.service`). */
	unitName?: string;
	/** ExecStart command. Default `/usr/local/bin/bun run start`. */
	execStart?: string;
	/** User to run as. Default the deploy user. */
	user?: string;
	/** Group. Default the deploy user. */
	group?: string;
	/** Restart policy. Default `always`. */
	restart?: 'always' | 'on-failure' | 'no';
	/** systemctl path. Default `systemctl`. */
	systemctl?: string;
	/** Unit file directory. Default `/etc/systemd/system`. */
	unitDir?: string;
};

const renderSystemdUnit = (
	ctx: ProcessManagerContext,
	options: SystemdManagerOptions,
): string => {
	const user = options.user ?? 'deploy';
	const group = options.group ?? user;
	const execStart = options.execStart ?? '/usr/local/bin/bun run start';
	const restart = options.restart ?? 'always';
	const envLines = Object.entries(ctx.env)
		.map(([k, v]) => `Environment=${k}=${v.replace(/"/g, '\\"')}`)
		.join('\n');
	return `[Unit]
Description=${ctx.appName} (managed by @absolutejs/deploy)
After=network.target

[Service]
Type=simple
WorkingDirectory=${ctx.currentPath}
ExecStart=${execStart}
Restart=${restart}
RestartSec=2
User=${user}
Group=${group}
${envLines}
StandardOutput=append:/var/log/${ctx.appName}/app.out.log
StandardError=append:/var/log/${ctx.appName}/app.err.log

[Install]
WantedBy=multi-user.target
`;
};

export const systemdManager = (options: SystemdManagerOptions = {}): ProcessManager => {
	const systemctl = options.systemctl ?? 'systemctl';
	const unitDir = options.unitDir ?? '/etc/systemd/system';
	const unitName = (ctx: ProcessManagerContext) => options.unitName ?? `${ctx.appName}.service`;

	return {
		reload: async (target, ctx) => {
			const unit = renderSystemdUnit(ctx, options);
			const name = unitName(ctx);
			// Write the unit via a heredoc executed by the remote shell. tee/cat work but
			// stdin is the cleanest path that doesn't reveal unit text in `ps`.
			const writeUnit = await target.exec(
				`mkdir -p /var/log/${ctx.appName} && cat > ${unitDir}/${name}`,
				{ onLog: ctx.onLog, stdin: unit, timeoutMs: 30_000 },
			);
			if (writeUnit.exitCode !== 0) {
				throw new Error(`systemdManager: writing unit failed (exit ${writeUnit.exitCode}): ${writeUnit.stderr}`);
			}
			const reload = await target.exec(`${systemctl} daemon-reload`, { onLog: ctx.onLog, timeoutMs: 15_000 });
			if (reload.exitCode !== 0) {
				throw new Error(`systemdManager: daemon-reload failed (exit ${reload.exitCode}): ${reload.stderr}`);
			}
			const enable = await target.exec(`${systemctl} enable ${name}`, { onLog: ctx.onLog, timeoutMs: 15_000 });
			if (enable.exitCode !== 0) {
				throw new Error(`systemdManager: enable failed (exit ${enable.exitCode}): ${enable.stderr}`);
			}
			const restart = await target.exec(`${systemctl} restart ${name}`, { onLog: ctx.onLog, timeoutMs: 60_000 });
			if (restart.exitCode !== 0) {
				throw new Error(`systemdManager: restart failed (exit ${restart.exitCode}): ${restart.stderr}`);
			}
		},
		status: async (target, ctx) => {
			const result = await target.exec(`${systemctl} is-active ${unitName(ctx)} || true`, { timeoutMs: 10_000 });
			const out = result.stdout.trim();
			if (out === 'active') return 'running';
			if (out === 'inactive' || out === 'failed') return 'stopped';
			return 'unknown';
		},
		stop: async (target, ctx) => {
			const result = await target.exec(`${systemctl} stop ${unitName(ctx)}`, { onLog: ctx.onLog, timeoutMs: 30_000 });
			if (result.exitCode !== 0) {
				throw new Error(`systemdManager: stop failed (exit ${result.exitCode}): ${result.stderr}`);
			}
		},
	};
};
