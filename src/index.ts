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
} from "./targets";
export { localTarget, sshTarget } from "./targets";

export type {
  BareManagerOptions,
  ProcessManager,
  ProcessManagerContext,
  SystemdManagerOptions,
} from "./processManagers";
export { bareManager, systemdManager } from "./processManagers";

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
} from "./deployer";
export { createDeployer, defaultBunPipeline } from "./deployer";

export type {
  CreatedReleaseArtifact,
  ReleaseArtifactMetadata,
} from "./releaseArtifact";
export {
  createReleaseArtifact,
  extractReleaseArtifact,
  receiveReleaseArtifact,
  ReleaseArtifactError,
} from "./releaseArtifact";

export type {
  AndroidNativeReleaseMetadata,
  IosNativeReleaseMetadata,
  NativeReleaseBlobObject,
  NativeReleaseBlobStore,
  NativeReleaseChannel,
  NativeReleaseMetadata,
  NativeReleasePublication,
  NativeReleaseRecord,
  NativeReleaseRegistry,
  NativeReleaseRegistryOptions,
} from "./nativeRelease";
export {
  createNativeReleaseRegistry,
  NATIVE_RELEASE_REGISTRY_FORMAT,
  NativeReleaseRegistryError,
} from "./nativeRelease";

export type {
  MobileUpdateChannel,
  MobileUpdateFile,
  MobileUpdateManifest,
  MobileUpdatePublication,
  MobileUpdatePromotion,
  MobileUpdateRegistry,
  MobileUpdateRegistryOptions,
  MobileUpdateRollback,
} from "./mobileUpdate";
export {
  createMobileUpdateHandler,
  createMobileUpdateRegistry,
  MOBILE_UPDATE_REGISTRY_FORMAT,
  MobileUpdateRegistryError,
  parseMobileUpdateManifest,
} from "./mobileUpdate";

export type {
  GooglePlayAuth,
  GooglePlayBundle,
  GooglePlayClient,
  GooglePlayEdit,
  GooglePlayNativeReleasePublication,
  GooglePlayNativeReleasePublisher,
  GooglePlayReleaseIntent,
  GooglePlayReleasePublisherOptions,
  GooglePlayReleaseReceipt,
  GooglePlayReleaseStatus,
  GooglePlayReleaseTarget,
  GooglePlayReviewBehavior,
  GooglePlayTrack,
  GooglePlayTrackRelease,
} from "./googlePlay";
export {
  createGooglePlayClient,
  createGooglePlayReleasePublisher,
  GooglePlayReleaseError,
} from "./googlePlay";

export type {
  AppStoreConnectAuth,
  AppStoreConnectBuild,
  AppStoreConnectBuildUpload,
  AppStoreConnectClient,
  AppStoreConnectNativeReleasePublication,
  AppStoreConnectNativeReleasePublisher,
  AppStoreConnectReleaseIntent,
  AppStoreConnectReleasePublisherOptions,
  AppStoreConnectReleaseReceipt,
  AppStoreConnectReleaseTarget,
  AppStoreConnectTestFlightGroup,
} from "./appStoreConnect";
export {
  createAppStoreConnectClient,
  createAppStoreConnectReleasePublisher,
  AppStoreConnectReleaseError,
} from "./appStoreConnect";

export type {
  EdgeIngress,
  EdgeIngressBackend,
  EdgeIngressCapabilities,
  EdgeIngressProtocol,
  EdgeIngressProvider,
  EdgeIngressSpec,
  EdgeIngressState,
} from "./edgeIngress";
export {
  EdgeIngressValidationError,
  normalizedEdgeIngressBackends,
  validateEdgeIngressSpec,
} from "./edgeIngress";
