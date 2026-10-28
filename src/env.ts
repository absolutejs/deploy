/**
 * @absolutejs/deploy/env — push environment-variable files to remote
 * targets and fan-out secret rotations across the fleet.
 *
 * Composes with `@absolutejs/secrets`: that library handles the
 * in-process side (resolve, rotate, redact, in-process listeners);
 * this module handles the deploy-side (push values to remote env
 * files, atomic swap, conditional service reload).
 *
 * Narrow `SecretSource` interface — `@absolutejs/secrets`'
 * `SecretBroker` satisfies it structurally without a hard dep
 * either direction.
 *
 * Standard format: a remote env file at
 * `/etc/<appName>.env` (or wherever you choose) that systemd reads
 * via `EnvironmentFile=`, Docker reads via `--env-file`, and most
 * shell start scripts source. One `KEY=value` per line, no
 * newlines inside values.
 */

import type { Target } from './targets';

// =============================================================================
// SecretSource — narrow interface @absolutejs/secrets' broker satisfies
// =============================================================================

/**
 * Minimal interface this module needs to read secret values. The
 * `SecretBroker` from `@absolutejs/secrets` satisfies it structurally;
 * any other implementation (a Map, an AWS Secrets Manager client
 * wrapper, etc.) works as long as it exposes `resolve(name)`.
 */
export type SecretSource = {
	resolve: (
		name: string
	) => Promise<{ value: string; fingerprint?: string } | null>;
};

// =============================================================================
// Env-file (de)serialization
// =============================================================================

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const NEEDS_QUOTING = /[\s"'`$\\#&|;<>(){}*?!]/;

const validateKey = (key: string): void => {
	if (!KEY_PATTERN.test(key)) {
		throw new Error(
			`[deploy/env] invalid env key "${key}" — must match /^[A-Z_][A-Z0-9_]*$/`
		);
	}
};

const serializeLine = (key: string, value: string): string => {
	validateKey(key);
	if (value.includes('\n') || value.includes('\r')) {
		throw new Error(
			`[deploy/env] value for "${key}" contains a newline — env files cannot represent multi-line values. Use a separate file path for multi-line secrets.`
		);
	}
	if (NEEDS_QUOTING.test(value) || value.startsWith('=') || value === '') {
		const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
		return `${key}="${escaped}"`;
	}
	return `${key}=${value}`;
};

export const serializeEnvFile = (values: Record<string, string>): string => {
	const lines: string[] = [];
	for (const key of Object.keys(values).sort()) {
		const value = values[key];
		if (value === undefined) continue;
		lines.push(serializeLine(key, value));
	}
	return `${lines.join('\n')}\n`;
};

const unquoteValue = (raw: string): string => {
	if (
		raw.length >= 2 &&
		raw.startsWith('"') &&
		raw.endsWith('"')
	) {
		const inner = raw.slice(1, -1);
		return inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
	}
	if (
		raw.length >= 2 &&
		raw.startsWith("'") &&
		raw.endsWith("'")
	) {
		return raw.slice(1, -1);
	}
	return raw;
};

/**
 * Parse a remote env file's contents. Ignores blank lines and `#`
 * comments. Lines that don't match `KEY=VALUE` throw — the deploy
 * primitive owns the file, so unknown content is loud, not silent.
 */
export const parseEnvFile = (text: string): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) {
			throw new Error(`[deploy/env] malformed env line: "${rawLine}"`);
		}
		const key = line.slice(0, eq).trim();
		const value = unquoteValue(line.slice(eq + 1).trim());
		validateKey(key);
		result[key] = value;
	}
	return result;
};

// =============================================================================
// Deployment spec + sync primitive
// =============================================================================

export type EnvDeployment = {
	/** The cloud Target whose remote filesystem we write to. */
	target: Target;
	/** Remote path for the env file (e.g. `/etc/myapp.env`). */
	remotePath: string;
	/**
	 * Names of secrets this deployment consumes from the SecretSource.
	 * Each name is resolved before the file is written.
	 */
	secretNames?: ReadonlyArray<string>;
	/**
	 * Non-secret env vars to merge in (NODE_ENV, PORT, LOG_LEVEL).
	 * If an `extras` key collides with a `secretNames` entry, throws —
	 * silent overrides are worse than a loud rejection.
	 */
	extras?: Record<string, string>;
	/** chmod for the file. Default `'600'`. */
	mode?: string;
	/** chown for the file. Default unchanged. */
	owner?: string;
	/**
	 * Command to run after the file changes. Skipped when the diff is
	 * empty — bouncing a service for an identical file is the wrong
	 * default.
	 */
	reload?: string;
};

export type EnvSyncResult = {
	/** Keys present in the new spec but not the existing file. */
	added: string[];
	/** Keys whose values changed (fingerprints, NOT plaintext, for safety). */
	changed: string[];
	/** Keys removed from the spec (still in the existing file). */
	removed: string[];
	/** Keys whose values matched — file wasn't rewritten for these. */
	unchanged: string[];
	/** True iff `deployment.reload` was invoked. */
	reloaded: boolean;
	/** True iff the file content changed (atomic-write happened). */
	wrote: boolean;
	/** Remote path that was synced. */
	remotePath: string;
};

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

const tryReadRemoteFile = async (
	target: Target,
	remotePath: string
): Promise<string | undefined> => {
	const result = await target.exec(
		`if [ -f ${shellQuote(remotePath)} ]; then cat ${shellQuote(remotePath)}; else echo __ABS_DEPLOY_ENV_ABSENT__; fi`
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`[deploy/env] failed to read ${remotePath}: exit ${result.exitCode}: ${result.stderr || result.stdout}`
		);
	}
	if (result.stdout.trim() === '__ABS_DEPLOY_ENV_ABSENT__') return undefined;
	return result.stdout;
};

const mergeValues = (
	deployment: EnvDeployment,
	resolved: Record<string, string>
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(deployment.extras ?? {})) {
		validateKey(key);
		out[key] = value;
	}
	for (const [key, value] of Object.entries(resolved)) {
		if (out[key] !== undefined) {
			throw new Error(
				`[deploy/env] "${key}" defined in BOTH extras and secretNames for ${deployment.remotePath} — remove one`
			);
		}
		out[key] = value;
	}
	return out;
};

const diffEnv = (
	previous: Record<string, string>,
	next: Record<string, string>
): Pick<EnvSyncResult, 'added' | 'changed' | 'removed' | 'unchanged'> => {
	const added: string[] = [];
	const changed: string[] = [];
	const removed: string[] = [];
	const unchanged: string[] = [];
	const allKeys = new Set([...Object.keys(previous), ...Object.keys(next)]);
	for (const key of [...allKeys].sort()) {
		const prev = previous[key];
		const curr = next[key];
		if (curr === undefined) removed.push(key);
		else if (prev === undefined) added.push(key);
		else if (prev === curr) unchanged.push(key);
		else changed.push(key);
	}
	return { added, changed, removed, unchanged };
};

const writeRemoteFileAtomically = async (
	target: Target,
	remotePath: string,
	contents: string,
	mode: string,
	owner?: string
): Promise<void> => {
	const tempPath = `${remotePath}.new.${Math.floor(Date.now() / 1000)}`;
	const dir = remotePath.split('/').slice(0, -1).join('/') || '/';
	const mkdir = await target.exec(`mkdir -p ${shellQuote(dir)}`);
	if (mkdir.exitCode !== 0) {
		throw new Error(
			`[deploy/env] mkdir ${dir} failed: ${mkdir.stderr || mkdir.stdout}`
		);
	}
	// Write via stdin redirect — no shell escaping of the env file content.
	const writeResult = await target.exec(`cat > ${shellQuote(tempPath)}`, {
		stdin: contents
	});
	if (writeResult.exitCode !== 0) {
		throw new Error(
			`[deploy/env] write to ${tempPath} failed: ${writeResult.stderr || writeResult.stdout}`
		);
	}
	const chmod = await target.exec(
		`chmod ${shellQuote(mode)} ${shellQuote(tempPath)}`
	);
	if (chmod.exitCode !== 0) {
		throw new Error(
			`[deploy/env] chmod failed: ${chmod.stderr || chmod.stdout}`
		);
	}
	if (owner !== undefined) {
		const chown = await target.exec(
			`chown ${shellQuote(owner)} ${shellQuote(tempPath)}`
		);
		if (chown.exitCode !== 0) {
			throw new Error(
				`[deploy/env] chown failed: ${chown.stderr || chown.stdout}`
			);
		}
	}
	const mv = await target.exec(
		`mv ${shellQuote(tempPath)} ${shellQuote(remotePath)}`
	);
	if (mv.exitCode !== 0) {
		throw new Error(`[deploy/env] mv failed: ${mv.stderr || mv.stdout}`);
	}
};

/**
 * Push an env file to a single target. Atomic: write to a `.new`
 * tempfile, chmod / chown, then `mv` into place. Diffs the merged
 * values against the existing file content and skips the
 * write+reload when nothing changed.
 */
export const syncEnvToTarget = async (
	deployment: EnvDeployment,
	values: Record<string, string>
): Promise<EnvSyncResult> => {
	const mode = deployment.mode ?? '600';
	const merged = mergeValues(deployment, values);
	const previousText = await tryReadRemoteFile(
		deployment.target,
		deployment.remotePath
	);
	const previous = previousText === undefined ? {} : parseEnvFile(previousText);
	const diff = diffEnv(previous, merged);
	const changed = diff.added.length + diff.changed.length + diff.removed.length;

	if (changed === 0) {
		return {
			...diff,
			reloaded: false,
			remotePath: deployment.remotePath,
			wrote: false
		};
	}

	const nextText = serializeEnvFile(merged);
	await writeRemoteFileAtomically(
		deployment.target,
		deployment.remotePath,
		nextText,
		mode,
		deployment.owner
	);

	let reloaded = false;
	if (deployment.reload !== undefined) {
		const reload = await deployment.target.exec(deployment.reload);
		if (reload.exitCode !== 0) {
			throw new Error(
				`[deploy/env] reload command failed: ${reload.stderr || reload.stdout}`
			);
		}
		reloaded = true;
	}

	return {
		...diff,
		reloaded,
		remotePath: deployment.remotePath,
		wrote: true
	};
};

// =============================================================================
// Multi-target fan-out via a SecretSource
// =============================================================================

const resolveSecrets = async (
	source: SecretSource,
	names: ReadonlyArray<string>
): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const name of names) {
		const resolved = await source.resolve(name);
		if (resolved === null) {
			throw new Error(
				`[deploy/env] secret "${name}" not found in source`
			);
		}
		out[name] = resolved.value;
	}
	return out;
};

export type DeploymentSyncResult = {
	deployment: EnvDeployment;
	result?: EnvSyncResult;
	error?: Error;
};

/**
 * Fan-out push: for each deployment, resolve its `secretNames` via
 * the source, merge with `extras`, and push to the target. Resolves
 * are fresh every call — so calling this again after
 * `broker.rotate(name)` propagates the new value to every
 * deployment that uses it.
 *
 * Best-effort across the fan-out: a per-target failure is captured
 * in the result, but doesn't stop the rest. Operator inspects the
 * returned array, fixes the broken target, re-runs.
 */
export const syncSecretsToDeployments = async (
	source: SecretSource,
	deployments: ReadonlyArray<EnvDeployment>
): Promise<DeploymentSyncResult[]> => {
	const results: DeploymentSyncResult[] = [];
	for (const deployment of deployments) {
		try {
			const resolved = await resolveSecrets(
				source,
				deployment.secretNames ?? []
			);
			const result = await syncEnvToTarget(deployment, resolved);
			results.push({ deployment, result });
		} catch (error) {
			results.push({
				deployment,
				error: error instanceof Error ? error : new Error(String(error))
			});
		}
	}
	return results;
};

/**
 * Returns just the deployments that use a given secret name. Useful
 * for "rotate one secret and propagate ONLY to the consumers" —
 * `syncSecretsToDeployments(source, deploymentsUsing(name, deployments))`.
 */
export const deploymentsUsing = (
	name: string,
	deployments: ReadonlyArray<EnvDeployment>
): EnvDeployment[] =>
	deployments.filter((d) => (d.secretNames ?? []).includes(name));
