/**
 * @absolutejs/deploy — generic Bun-project deploy pipeline.
 *
 * Surface:
 *
 *   - `Target` + bundled `localTarget` / `sshTarget`
 *   - `ProcessManager` + bundled `bareManager` / `systemdManager`
 *   - `createDeployer({ target, source, appName, ... })` + `defaultBunPipeline()`
 *   - `VerifySpec` for HTTP / TCP / custom readiness checks
 *
 * See README for the typical "deploy to a DigitalOcean droplet" recipe.
 */

export type {
	ExecOptions,
	ExecResult,
	LocalTargetOptions,
	SshTargetOptions,
	Target,
	UploadOptions,
} from './targets';
export { localTarget, sshTarget } from './targets';

export type {
	BareManagerOptions,
	ProcessManager,
	ProcessManagerContext,
	SystemdManagerOptions,
} from './processManagers';
export { bareManager, systemdManager } from './processManagers';

export type {
	DeployContext,
	DeployHooks,
	DeployOptions,
	DeployResult,
	DeployStep,
	Deployer,
	DeployerOptions,
	ReleaseAnnotations,
	ReleaseRecord,
	Source,
	VerifySpec,
} from './deployer';
export { createDeployer, defaultBunPipeline } from './deployer';
