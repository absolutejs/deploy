import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  NativeReleaseBlobObject,
  NativeReleaseBlobStore,
} from "./nativeRelease";

export const MOBILE_UPDATE_REGISTRY_FORMAT = 1 as const;
const DEFAULT_PREFIX = "absolutejs/mobile-updates";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_AGE_MS = 30 * DAY_MS;
const DEFAULT_GRACE_PERIOD_MS = 7 * DAY_MS;
const DEFAULT_RETAIN_RECENT = 5;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^amu_[a-f0-9]{64}$/;
const APP_ID = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXPO_DESCRIPTOR = "_absolute/expo-update.json";
const EXPO_CODE_SIGNING_ALGORITHM = "rsa-v1_5-sha256";
const HEALTH_TOKEN_VERSION = 1;
const HEALTH_KINDS = new Set([
  "activated",
  "downloaded",
  "download-failed",
  "quarantined",
  "rolled-back",
]);
const FAILURE_HEALTH_KINDS = new Set(["quarantined", "rolled-back"]);

export type ExpoUpdateCodeSigningOptions = {
  keys: Readonly<
    Record<
      string,
      {
        /** Public X.509 root certificate embedded in matching native apps. */
        certificate: string | Buffer;
        /** RSA private key available only to the trusted update-serving process. */
        privateKey: string | Buffer;
      }
    >
  >;
};

export type MobileUpdateFile = {
  bytes: number;
  path: string;
  sha256: string;
};

export type MobileUpdateManifest = {
  appId: string;
  channel: string;
  classification: "bug-fix" | "content" | "security";
  createdAt: string;
  files: MobileUpdateFile[];
  format: 1;
  releaseId: string;
  runtimeFingerprint: string;
  signature: {
    algorithm: "ecdsa-p256-sha256";
    keyId: string;
    value: string;
  };
  withinSubmittedPurpose: true;
};

export type MobileUpdateChannel = {
  activationId?: string;
  activatedAt?: string;
  appId: string;
  channel: string;
  fallbackReleaseId?: string;
  format: typeof MOBILE_UPDATE_REGISTRY_FORMAT;
  promotionId?: string;
  promotedAt: string;
  releaseId?: string;
  rollout: number;
};

export type MobileUpdatePublication = {
  appId: string;
  channel: string;
  storedBytes?: number;
  storedFiles?: number;
  releaseId: string;
  reused: boolean;
  reusedBytes?: number;
  reusedFiles?: number;
  rollout: number;
  stage: "published";
};

export type MobileUpdatePromotion = {
  appId: string;
  channel: string;
  releaseId: string;
  rollout: number;
  stage: "promoted";
};

export type MobileUpdateRollback = {
  appId: string;
  channel: string;
  releaseId?: string;
  stage: "rolled-back";
};

export type MobileUpdateStorageRelease = {
  bytes: number;
  channel: string;
  createdAt: string;
  markedAt?: string;
  objectCount: number;
  protectedBy: ("active" | "age" | "fallback" | "recent")[];
  releaseId: string;
};

export type MobileUpdateStorageReport = {
  appId: string;
  channelCount: number;
  contentBlobBytes?: number;
  contentBlobCount?: number;
  reclaimableBytes: number;
  reclaimableContentBytes?: number;
  releaseBytes: number;
  releaseCount: number;
  releases: MobileUpdateStorageRelease[];
  totalBytes: number;
  totalObjectCount: number;
  untrackedBytes: number;
};

export type MobileUpdatePruneResult = MobileUpdateStorageReport & {
  dryRun: boolean;
  marked: string[];
  reclaimedBytes: number;
  restored: string[];
  swept: string[];
  sweptContentBlobs?: string[];
};

export type MobileUpdateRetentionOptions = {
  appId: string;
  /** Minimum release age before collection. Defaults to 30 days. */
  minAgeMs?: number;
  /** Number of newest releases retained per channel. Defaults to 5. */
  retainRecent?: number;
  signal?: AbortSignal;
};

export type MobileUpdatePruneOptions = MobileUpdateRetentionOptions & {
  /** Apply marks and sweeps. Omit for a read-only preview. */
  apply?: boolean;
  /** Time between marking and deletion. Defaults to 7 days. */
  gracePeriodMs?: number;
};

export type MobileUpdateResolution =
  | { status: "empty" | "incompatible" }
  | {
      activationId?: string;
      activatedAt?: string;
      manifest: MobileUpdateManifest;
      manifestKey: string;
      status: "selected";
    };

export type MobileUpdateHealthKind =
  | "activated"
  | "downloaded"
  | "download-failed"
  | "quarantined"
  | "rolled-back";

export type MobileUpdateHealthTransfer = {
  avoidedBytes: number;
  downloadedBytes: number;
  durationMs: number;
  resumedBytes: number;
  reusedBytes: number;
  throughputBytesPerSecond: number;
};

export type MobileUpdateHealthReport = {
  activated: number;
  appId: string;
  channel: string;
  downloaded: number;
  downloadFailed: number;
  failureRate: number;
  failures: number;
  paused: boolean;
  promotionId: string;
  quarantined: number;
  releaseId: string;
  reportedInstallations: number;
  rolledBack: number;
  rollout: number;
  terminalReports: number;
  transfer: MobileUpdateHealthTransfer;
};

export type MobileUpdateRolloutStage = {
  /** Maximum failure rate permitted before advancing from this stage. */
  maximumFailureRate: number;
  /** Cumulative terminal installation reports required before advancement. */
  minimumReports: number;
  /** Minimum time spent at this stage before advancement. */
  observationMs: number;
  rollout: number;
};

export type MobileUpdateRolloutOptions = {
  /** Evaluate and advance after terminal health reports. Defaults to false. */
  automatic?: boolean;
  /** Strictly increasing rollout stages. A promotion must start at one stage. */
  stages: readonly MobileUpdateRolloutStage[];
};

export type MobileUpdateRolloutReport = MobileUpdateHealthReport & {
  automatic: boolean;
  currentStage: number;
  enteredAt: string;
  nextStage?: MobileUpdateRolloutStage;
  pausedBy?: "fleet-health" | "operator";
  status: "active" | "cancelled" | "complete" | "paused";
};

export type MobileUpdateRegistry = {
  advanceUpdateRollout?(input: {
    appId: string;
    channel: string;
    rollout?: number;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRolloutReport>;
  cancelUpdateRollout?(input: {
    appId: string;
    channel: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRolloutReport>;
  inspectUpdateHealth?(input: {
    appId: string;
    channel: string;
    releaseId?: string;
  }): Promise<MobileUpdateHealthReport | null>;
  inspectUpdateRollout?(input: {
    appId: string;
    channel: string;
  }): Promise<MobileUpdateRolloutReport | null>;
  pauseUpdateRollout?(input: {
    appId: string;
    channel: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRolloutReport>;
  inspectUpdateStorage(
    input: MobileUpdateRetentionOptions,
  ): Promise<MobileUpdateStorageReport>;
  pruneUpdates(
    input: MobileUpdatePruneOptions,
  ): Promise<MobileUpdatePruneResult>;
  publishUpdate(input: {
    manifest: MobileUpdateManifest;
    releaseDirectory: string;
    rollout: number;
    signal?: AbortSignal;
  }): Promise<MobileUpdatePublication>;
  promoteUpdate(input: {
    appId: string;
    channel: string;
    releaseId: string;
    rollout: number;
    signal?: AbortSignal;
  }): Promise<MobileUpdatePromotion>;
  rollbackUpdate(input: {
    appId: string;
    channel: string;
    releaseId?: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRollback>;
  resolveUpdate(input: {
    appId: string;
    channel: string;
    installationId: string;
    runtimeFingerprint: string;
  }): Promise<{ manifest: MobileUpdateManifest; manifestKey: string } | null>;
  resolveUpdateState?(input: {
    appId: string;
    channel: string;
    installationId: string;
    runtimeFingerprint: string;
  }): Promise<MobileUpdateResolution>;
  readUpdateFile(input: {
    appId: string;
    path: string;
    releaseId: string;
  }): Promise<{ bytes: Uint8Array; file: MobileUpdateFile } | null>;
  issueUpdateHealthToken?(input: {
    appId: string;
    channel: string;
    installationId: string;
    releaseId: string;
    runtimeFingerprint: string;
  }): Promise<string | null>;
  recordUpdateHealth?(input: {
    appId: string;
    channel: string;
    installationId: string;
    kind: MobileUpdateHealthKind;
    reason?: "boot-interrupted" | "boot-timeout";
    releaseId: string;
    runtimeFingerprint: string;
    token: string;
    transfer?: MobileUpdateHealthTransfer;
  }): Promise<MobileUpdateHealthReport>;
  reconcileUpdateRollout?(input: {
    appId: string;
    channel: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRolloutReport | null>;
  resumeUpdateRollout?(input: {
    appId: string;
    channel: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRolloutReport>;
};

export type MobileUpdateHealthOptions = {
  /** Pauses only the exact promotion generation after this many terminal reports. */
  autoPause?: { failureRate?: number; minimumReports?: number };
  /** At least 32 unpredictable server-only characters. */
  secret: string;
};

export type MobileUpdateRegistryOptions = {
  clock?: () => Date;
  health?: MobileUpdateHealthOptions;
  prefix?: string;
  /** Trusted ECDSA P-256 SPKI public keys as canonical base64 DER. */
  publicKeys: Readonly<Record<string, string>>;
  rollout?: MobileUpdateRolloutOptions;
  store: NativeReleaseBlobStore;
};

export class MobileUpdateRegistryError extends Error {}

type ExpoUpdateAsset = { extension?: string; path: string };
type ExpoUpdateDescriptor = {
  engine: "expo";
  expoConfig: Record<string, unknown>;
  format: 1;
  platforms: Partial<
    Record<
      "android" | "ios",
      { assets: ExpoUpdateAsset[]; launchAsset: ExpoUpdateAsset }
    >
  >;
  runtimeVersion: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0)
    throw new MobileUpdateRegistryError(`Mobile update ${field} is invalid`);

  return value;
};

const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const safePath = (value: unknown) => {
  const file = text(value, "file path").replaceAll("\\", "/");
  if (
    file.startsWith("/") ||
    file
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new MobileUpdateRegistryError("Mobile update file path is invalid");

  return file;
};

const expoAsset = (value: unknown): ExpoUpdateAsset => {
  if (!object(value))
    throw new MobileUpdateRegistryError("Expo update asset is invalid");
  const assetPath = safePath(value.path);
  if (
    value.extension !== undefined &&
    (typeof value.extension !== "string" ||
      !/^[A-Za-z0-9]+$/.test(value.extension))
  )
    throw new MobileUpdateRegistryError(
      "Expo update asset extension is invalid",
    );

  return {
    ...(typeof value.extension === "string"
      ? { extension: value.extension }
      : {}),
    path: assetPath,
  };
};

const parseExpoUpdateDescriptor = (bytes: Uint8Array): ExpoUpdateDescriptor => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MobileUpdateRegistryError("Expo update descriptor is invalid");
  }
  if (
    !object(value) ||
    value.engine !== "expo" ||
    value.format !== 1 ||
    !object(value.expoConfig) ||
    !object(value.platforms) ||
    typeof value.runtimeVersion !== "string" ||
    !HASH.test(value.runtimeVersion)
  )
    throw new MobileUpdateRegistryError("Expo update descriptor is invalid");
  const platforms: ExpoUpdateDescriptor["platforms"] = {};
  for (const name of ["android", "ios"] as const) {
    const candidate = value.platforms[name];
    if (candidate === undefined) continue;
    if (
      !object(candidate) ||
      !Array.isArray(candidate.assets) ||
      !object(candidate.launchAsset)
    )
      throw new MobileUpdateRegistryError(
        "Expo update platform descriptor is invalid",
      );
    platforms[name] = {
      assets: candidate.assets.map(expoAsset),
      launchAsset: expoAsset(candidate.launchAsset),
    };
  }
  if (Object.keys(platforms).length === 0)
    throw new MobileUpdateRegistryError(
      "Expo update descriptor has no native platforms",
    );

  return {
    engine: "expo",
    expoConfig: value.expoConfig,
    format: 1,
    platforms,
    runtimeVersion: value.runtimeVersion,
  };
};

export const parseMobileUpdateManifest = (
  value: unknown,
): MobileUpdateManifest => {
  if (!object(value) || value.format !== 1)
    throw new MobileUpdateRegistryError("Mobile update manifest is invalid");
  const appId = text(value.appId, "appId");
  const channel = text(value.channel, "channel");
  const releaseId = text(value.releaseId, "releaseId");
  const runtimeFingerprint = text(value.runtimeFingerprint, "runtime");
  if (!APP_ID.test(appId) || !NAME.test(channel) || !RELEASE.test(releaseId))
    throw new MobileUpdateRegistryError("Mobile update identity is invalid");
  if (!HASH.test(runtimeFingerprint) || !iso(value.createdAt))
    throw new MobileUpdateRegistryError(
      "Mobile update runtime or timestamp is invalid",
    );
  if (
    value.classification !== "bug-fix" &&
    value.classification !== "content" &&
    value.classification !== "security"
  )
    throw new MobileUpdateRegistryError(
      "Mobile update classification is invalid",
    );
  if (value.withinSubmittedPurpose !== true)
    throw new MobileUpdateRegistryError(
      "Mobile update policy attestation is missing",
    );
  if (!Array.isArray(value.files) || value.files.length === 0)
    throw new MobileUpdateRegistryError(
      "Mobile update file inventory is invalid",
    );
  const files = value.files.map((candidate): MobileUpdateFile => {
    if (!object(candidate))
      throw new MobileUpdateRegistryError("Mobile update file is invalid");
    const filePath = safePath(candidate.path);
    if (
      !Number.isSafeInteger(candidate.bytes) ||
      Number(candidate.bytes) < 0 ||
      Number(candidate.bytes) > MAX_FILE_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !HASH.test(candidate.sha256)
    )
      throw new MobileUpdateRegistryError(
        `Mobile update file ${filePath} is invalid`,
      );

    return {
      bytes: Number(candidate.bytes),
      path: filePath,
      sha256: candidate.sha256,
    };
  });
  if (
    files.reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL_BYTES ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) =>
      index > 0
        ? file.path.localeCompare(files[index - 1]?.path ?? "") <= 0
        : false,
    )
  )
    throw new MobileUpdateRegistryError(
      "Mobile update file inventory is invalid",
    );
  const signatureKeyId = object(value.signature)
    ? text(value.signature.keyId, "signature key")
    : "";
  const signatureValue = object(value.signature)
    ? text(value.signature.value, "signature")
    : "";
  if (
    !object(value.signature) ||
    value.signature.algorithm !== "ecdsa-p256-sha256" ||
    !NAME.test(signatureKeyId) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureValue) ||
    Buffer.from(signatureValue, "base64").byteLength !== 64 ||
    Buffer.from(signatureValue, "base64").toString("base64") !== signatureValue
  )
    throw new MobileUpdateRegistryError("Mobile update signature is invalid");

  return {
    appId,
    channel,
    classification: value.classification,
    createdAt: value.createdAt,
    files,
    format: 1,
    releaseId,
    runtimeFingerprint,
    signature: {
      algorithm: "ecdsa-p256-sha256",
      keyId: signatureKeyId,
      value: signatureValue,
    },
    withinSubmittedPurpose: true,
  };
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!object(value)) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const verifyManifestSignature = (
  manifest: MobileUpdateManifest,
  publicKeys: Readonly<Record<string, string>>,
) => {
  const encoded = publicKeys[manifest.signature.keyId];
  if (!encoded)
    throw new MobileUpdateRegistryError(
      "Mobile update signing key is not trusted",
    );
  let publicKey;
  try {
    const der = Buffer.from(encoded, "base64");
    if (der.toString("base64") !== encoded) throw new Error("invalid base64");
    publicKey = createPublicKey({ format: "der", key: der, type: "spki" });
  } catch {
    throw new MobileUpdateRegistryError(
      "Mobile update trusted public key is invalid",
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new MobileUpdateRegistryError(
      "Mobile update trusted public key must use ECDSA P-256",
    );
  const { signature: _signature, ...unsigned } = manifest;
  if (
    !verify(
      "sha256",
      new TextEncoder().encode(JSON.stringify(canonicalValue(unsigned))),
      { dsaEncoding: "ieee-p1363", key: publicKey },
      Buffer.from(manifest.signature.value, "base64"),
    )
  )
    throw new MobileUpdateRegistryError(
      "Mobile update signature verification failed",
    );
};

const parseChannel = (value: unknown): MobileUpdateChannel => {
  if (!object(value) || value.format !== MOBILE_UPDATE_REGISTRY_FORMAT)
    throw new MobileUpdateRegistryError("Mobile update channel is invalid");
  const appId = text(value.appId, "channel appId");
  const channel = text(value.channel, "channel");
  if (
    !APP_ID.test(appId) ||
    !NAME.test(channel) ||
    !iso(value.promotedAt) ||
    typeof value.rollout !== "number" ||
    value.rollout < 0 ||
    value.rollout > 1 ||
    (value.releaseId !== undefined &&
      (typeof value.releaseId !== "string" ||
        !RELEASE.test(value.releaseId))) ||
    (value.fallbackReleaseId !== undefined &&
      (typeof value.fallbackReleaseId !== "string" ||
        !RELEASE.test(value.fallbackReleaseId))) ||
    (value.promotionId !== undefined &&
      (typeof value.promotionId !== "string" ||
        !HASH.test(value.promotionId))) ||
    (value.activationId !== undefined &&
      (typeof value.activationId !== "string" ||
        !HASH.test(value.activationId))) ||
    (value.activatedAt !== undefined && !iso(value.activatedAt)) ||
    (value.activationId === undefined) !== (value.activatedAt === undefined)
  )
    throw new MobileUpdateRegistryError("Mobile update channel is invalid");

  return {
    ...(value.activationId ? { activationId: value.activationId } : {}),
    ...(value.activatedAt ? { activatedAt: value.activatedAt } : {}),
    appId,
    channel,
    ...(value.fallbackReleaseId
      ? { fallbackReleaseId: value.fallbackReleaseId }
      : {}),
    format: MOBILE_UPDATE_REGISTRY_FORMAT,
    ...(value.promotionId ? { promotionId: value.promotionId } : {}),
    promotedAt: value.promotedAt,
    ...(value.releaseId ? { releaseId: value.releaseId } : {}),
    rollout: value.rollout,
  };
};

const normalizedPrefix = (value: string) => {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (
    !prefix ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new MobileUpdateRegistryError("Mobile update prefix is invalid");

  return prefix;
};

const appHash = (appId: string) =>
  createHash("sha256").update(appId).digest("hex");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const decode = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as unknown;
const fileDigest = async (file: Bun.BunFile) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);

  return hasher.digest("hex");
};

const rolloutMember = (input: {
  appId: string;
  channel: string;
  installationId: string;
  releaseId: string;
  rollout: number;
}) => {
  if (input.rollout === 0) return false;
  if (input.rollout === 1) return true;
  const value = createHash("sha256")
    .update(
      `${input.appId}\0${input.channel}\0${input.releaseId}\0${input.installationId}`,
    )
    .digest()
    .readUInt32BE(0);

  return value / 0x1_0000_0000 < input.rollout;
};

type MobileUpdateHealthTokenPayload = {
  appId: string;
  channel: string;
  format: typeof HEALTH_TOKEN_VERSION;
  installationId: string;
  promotionId: string;
  releaseId: string;
  runtimeFingerprint: string;
};

type StoredMobileUpdateRolloutPlan = {
  automatic: boolean;
  createdAt: string;
  format: 1;
  promotionId: string;
  releaseId: string;
  stages: MobileUpdateRolloutStage[];
};

type StoredMobileUpdateRolloutControl = {
  action: "cancel" | "pause" | "resume";
  createdAt: string;
  format: 1;
  id: string;
  promotionId: string;
  releaseId: string;
  resumedPauseIds?: string[];
};

type StoredMobileUpdateRolloutAdvance = {
  createdAt: string;
  failureRate: number;
  format: 1;
  promotionId: string;
  releaseId: string;
  rollout: number;
  stage: number;
  terminalReports: number;
};

const base64Url = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");
const healthPromotionId = (channel: MobileUpdateChannel) =>
  channel.promotionId ??
  digest(
    new TextEncoder().encode(
      `${channel.appId}\0${channel.channel}\0${channel.releaseId ?? "embedded"}\0${channel.promotedAt}`,
    ),
  );
const finiteMetric = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new MobileUpdateRegistryError(
      `Mobile update health ${field} is invalid`,
    );

  return value;
};

const parseHealthTransfer = (
  value: MobileUpdateHealthTransfer | undefined,
): MobileUpdateHealthTransfer | undefined => {
  if (value === undefined) return undefined;
  if (!object(value))
    throw new MobileUpdateRegistryError(
      "Mobile update health transfer is invalid",
    );

  return {
    avoidedBytes: finiteMetric(value.avoidedBytes, "avoidedBytes"),
    downloadedBytes: finiteMetric(value.downloadedBytes, "downloadedBytes"),
    durationMs: finiteMetric(value.durationMs, "durationMs"),
    resumedBytes: finiteMetric(value.resumedBytes, "resumedBytes"),
    reusedBytes: finiteMetric(value.reusedBytes, "reusedBytes"),
    throughputBytesPerSecond: finiteMetric(
      value.throughputBytesPerSecond,
      "throughputBytesPerSecond",
    ),
  };
};

export const createMobileUpdateRegistry = (
  options: MobileUpdateRegistryOptions,
): MobileUpdateRegistry => {
  const prefix = normalizedPrefix(options.prefix ?? DEFAULT_PREFIX);
  const clock = options.clock ?? (() => new Date());
  const health = options.health;
  const rollout = options.rollout;
  if (health && health.secret.length < 32)
    throw new MobileUpdateRegistryError(
      "Mobile update health secret must contain at least 32 characters",
    );
  if (health && !options.store.list)
    throw new MobileUpdateRegistryError(
      "Mobile update health requires storage lifecycle listing",
    );
  if (rollout && (!health || !options.store.list))
    throw new MobileUpdateRegistryError(
      "Mobile update rollout orchestration requires fleet health and storage lifecycle listing",
    );
  if (
    rollout &&
    (rollout.stages.length === 0 ||
      rollout.stages.some(
        (stage, index) =>
          stage.rollout <= 0 ||
          stage.rollout > 1 ||
          !Number.isSafeInteger(stage.minimumReports) ||
          stage.minimumReports < 1 ||
          !Number.isSafeInteger(stage.observationMs) ||
          stage.observationMs < 0 ||
          stage.maximumFailureRate < 0 ||
          stage.maximumFailureRate >= 1 ||
          (index > 0 && stage.rollout <= rollout.stages[index - 1]!.rollout),
      ))
  )
    throw new MobileUpdateRegistryError(
      "Mobile update rollout stages are invalid",
    );
  const minimumReports = health?.autoPause?.minimumReports ?? 20;
  const failureThreshold = health?.autoPause?.failureRate ?? 0.2;
  if (
    health &&
    (!Number.isSafeInteger(minimumReports) ||
      minimumReports < 1 ||
      failureThreshold <= 0 ||
      failureThreshold > 1)
  )
    throw new MobileUpdateRegistryError(
      "Mobile update health auto-pause policy is invalid",
    );
  const root = (appId: string) => `${prefix}/${appHash(appId)}`;
  const releaseRoot = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
  ) => `${root(manifest.appId)}/releases/${manifest.releaseId}`;
  const manifestKey = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
  ) => `${releaseRoot(manifest)}/update.json`;
  const fileKey = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
    file: MobileUpdateFile,
  ) => `${releaseRoot(manifest)}/files/${file.path}`;
  const contentBlobKey = (appId: string, sha256: string) =>
    `${root(appId)}/blobs/${sha256}`;
  const tombstoneKey = (appId: string, releaseId: string) =>
    `${root(appId)}/gc/${releaseId}.json`;
  const healthRoot = (appId: string, promotionId: string, releaseId: string) =>
    `${root(appId)}/health/${promotionId}/${releaseId}`;
  const pauseKey = (appId: string, promotionId: string, releaseId: string) =>
    `${healthRoot(appId, promotionId, releaseId)}/paused.json`;
  const rolloutRoot = (appId: string, promotionId: string, releaseId: string) =>
    `${healthRoot(appId, promotionId, releaseId)}/rollout`;
  const rolloutPlanKey = (
    appId: string,
    promotionId: string,
    releaseId: string,
  ) => `${rolloutRoot(appId, promotionId, releaseId)}/plan.json`;
  const channelKey = (appId: string, channel: string) => {
    if (!APP_ID.test(appId) || !NAME.test(channel))
      throw new MobileUpdateRegistryError(
        "Mobile update channel identity is invalid",
      );

    return `${root(appId)}/channels/${channel}.json`;
  };
  const readManifest = async (appId: string, releaseId: string) => {
    const key = manifestKey({ appId, releaseId });
    const bytes = await options.store.get(key);
    if (!bytes) return null;
    const head = await options.store.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== digest(bytes)
    )
      throw new MobileUpdateRegistryError(
        "Stored mobile update manifest integrity failed",
      );
    const manifest = parseMobileUpdateManifest(decode(bytes));
    verifyManifestSignature(manifest, options.publicKeys);
    if (manifest.appId !== appId || manifest.releaseId !== releaseId)
      throw new MobileUpdateRegistryError(
        "Stored mobile update identity changed",
      );

    return { key, manifest };
  };
  const readChannel = async (appId: string, channel: string) => {
    const bytes = await options.store.get(channelKey(appId, channel));
    if (!bytes) return null;
    const value = parseChannel(decode(bytes));
    if (value.appId !== appId || value.channel !== channel)
      throw new MobileUpdateRegistryError(
        "Stored mobile update channel identity changed",
      );

    return value;
  };
  const listPrefix = async (value: string) => {
    const objects: NativeReleaseBlobObject[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await options.store.list!({
        ...(cursor ? { cursor } : {}),
        prefix: value,
      });
      objects.push(...page.objects);
      if (!page.truncated) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new MobileUpdateRegistryError(
          "Mobile update storage returned an invalid cursor",
        );
      cursors.add(page.cursor);
      cursor = page.cursor;
    } while (true);

    return objects;
  };
  const readVerifiedObject = async (key: string, label: string) => {
    const bytes = await options.store.get(key);
    if (!bytes) return null;
    const head = await options.store.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== digest(bytes)
    )
      throw new MobileUpdateRegistryError(
        `Stored mobile update ${label} integrity failed`,
      );

    return decode(bytes);
  };
  const parseRolloutPlan = (
    value: unknown,
    promotionId: string,
    releaseId: string,
  ): StoredMobileUpdateRolloutPlan => {
    if (
      !object(value) ||
      value.format !== 1 ||
      value.promotionId !== promotionId ||
      value.releaseId !== releaseId ||
      typeof value.automatic !== "boolean" ||
      !iso(value.createdAt) ||
      !Array.isArray(value.stages)
    )
      throw new MobileUpdateRegistryError(
        "Stored mobile update rollout plan is invalid",
      );
    const stages = value.stages.map((stage) => {
      if (
        !object(stage) ||
        typeof stage.rollout !== "number" ||
        typeof stage.maximumFailureRate !== "number" ||
        !Number.isSafeInteger(stage.minimumReports) ||
        !Number.isSafeInteger(stage.observationMs)
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update rollout plan is invalid",
        );

      return {
        maximumFailureRate: stage.maximumFailureRate,
        minimumReports: stage.minimumReports as number,
        observationMs: stage.observationMs as number,
        rollout: stage.rollout,
      };
    });
    if (
      stages.length === 0 ||
      stages.some(
        (stage, index) =>
          stage.rollout <= 0 ||
          stage.rollout > 1 ||
          stage.minimumReports < 1 ||
          stage.observationMs < 0 ||
          stage.maximumFailureRate < 0 ||
          stage.maximumFailureRate >= 1 ||
          (index > 0 && stage.rollout <= stages[index - 1]!.rollout),
      )
    )
      throw new MobileUpdateRegistryError(
        "Stored mobile update rollout plan is invalid",
      );

    return {
      automatic: value.automatic,
      createdAt: value.createdAt,
      format: 1,
      promotionId,
      releaseId,
      stages,
    };
  };
  const initializeRollout = async (
    channel: MobileUpdateChannel,
    signal?: AbortSignal,
  ) => {
    if (!rollout || !channel.releaseId) return;
    if (!rollout.stages.some((stage) => stage.rollout === channel.rollout))
      throw new MobileUpdateRegistryError(
        "Mobile update promotion rollout must match a configured rollout stage",
      );
    const promotionId = healthPromotionId(channel);
    const plan: StoredMobileUpdateRolloutPlan = {
      automatic: rollout.automatic ?? false,
      createdAt: channel.promotedAt,
      format: 1,
      promotionId,
      releaseId: channel.releaseId,
      stages: rollout.stages.map((stage) => ({ ...stage })),
    };
    const bytes = json(plan);
    await options.store.put(
      rolloutPlanKey(channel.appId, promotionId, channel.releaseId),
      bytes,
      {
        cacheControl: "no-store",
        contentType: "application/json",
        maxBytes: bytes.byteLength,
        metadata: { releaseid: channel.releaseId, sha256: digest(bytes) },
        signal,
      },
    );
  };
  const signHealthToken = (payload: MobileUpdateHealthTokenPayload) => {
    if (!health) return null;
    const encoded = base64Url(JSON.stringify(payload));
    const signature = createHmac("sha256", health.secret)
      .update(encoded)
      .digest("base64url");

    return `${encoded}.${signature}`;
  };
  const verifyHealthToken = (token: string) => {
    if (!health)
      throw new MobileUpdateRegistryError(
        "Mobile update health reporting is not configured",
      );
    const [encoded, provided, extra] = token.split(".");
    if (!encoded || !provided || extra)
      throw new MobileUpdateRegistryError(
        "Mobile update health token is invalid",
      );
    const expected = createHmac("sha256", health.secret)
      .update(encoded)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(provided, "base64url");
    } catch {
      actual = Buffer.alloc(0);
    }
    if (
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)
    )
      throw new MobileUpdateRegistryError(
        "Mobile update health token is invalid",
      );
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new MobileUpdateRegistryError(
        "Mobile update health token is invalid",
      );
    }
    if (
      !object(value) ||
      value.format !== HEALTH_TOKEN_VERSION ||
      typeof value.appId !== "string" ||
      typeof value.channel !== "string" ||
      typeof value.installationId !== "string" ||
      typeof value.promotionId !== "string" ||
      typeof value.releaseId !== "string" ||
      typeof value.runtimeFingerprint !== "string"
    )
      throw new MobileUpdateRegistryError(
        "Mobile update health token is invalid",
      );

    return value as MobileUpdateHealthTokenPayload;
  };
  const assertNotMarked = async (appId: string, releaseId: string) => {
    if (!APP_ID.test(appId) || !RELEASE.test(releaseId))
      throw new MobileUpdateRegistryError(
        "Mobile update release identity is invalid",
      );
    if (await options.store.head(tombstoneKey(appId, releaseId)))
      throw new MobileUpdateRegistryError(
        "Mobile update release is marked for collection. Increase retention and apply garbage collection to restore it before promotion",
      );
  };
  const writeChannel = async (
    input: Omit<MobileUpdateChannel, "format" | "promotedAt" | "promotionId">,
    signal?: AbortSignal,
    beforeWrite?: (channel: MobileUpdateChannel) => Promise<void>,
  ) => {
    const promotedAt = clock().toISOString();
    const value: MobileUpdateChannel = {
      ...input,
      format: MOBILE_UPDATE_REGISTRY_FORMAT,
      promotedAt,
      promotionId: digest(
        new TextEncoder().encode(
          `${input.appId}\0${input.channel}\0${input.releaseId ?? "embedded"}\0${promotedAt}\0${randomUUID()}`,
        ),
      ),
    };
    await beforeWrite?.(value);
    const bytes = json(value);
    await options.store.put(channelKey(value.appId, value.channel), bytes, {
      cacheControl: "no-cache",
      contentType: "application/json",
      maxBytes: bytes.byteLength,
      metadata: {
        channel: value.channel,
        ...(value.releaseId ? { releaseId: value.releaseId } : {}),
        sha256: digest(bytes),
      },
      signal,
    });

    return value;
  };
  const rolloutContext = async (channel: MobileUpdateChannel) => {
    if (!options.store.list || !channel.releaseId) return null;
    const promotionId = healthPromotionId(channel);
    const storedPlan = await readVerifiedObject(
      rolloutPlanKey(channel.appId, promotionId, channel.releaseId),
      "rollout plan",
    );
    if (storedPlan === null) return null;
    const plan = parseRolloutPlan(storedPlan, promotionId, channel.releaseId);
    const initialStage = plan.stages.findIndex(
      (stage) => stage.rollout === channel.rollout,
    );
    if (initialStage < 0)
      throw new MobileUpdateRegistryError(
        "Stored mobile update rollout does not match its plan",
      );
    let currentStage = initialStage;
    let enteredAt = plan.createdAt;
    const advances = await listPrefix(
      `${rolloutRoot(channel.appId, promotionId, channel.releaseId)}/advances/`,
    );
    for (const item of advances) {
      const value = await readVerifiedObject(item.key, "rollout advancement");
      if (
        !object(value) ||
        value.format !== 1 ||
        value.promotionId !== promotionId ||
        value.releaseId !== channel.releaseId ||
        !Number.isSafeInteger(value.stage) ||
        Number(value.stage) < initialStage ||
        Number(value.stage) >= plan.stages.length ||
        value.rollout !== plan.stages[Number(value.stage)]!.rollout ||
        !iso(value.createdAt) ||
        typeof value.failureRate !== "number" ||
        !Number.isSafeInteger(value.terminalReports)
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update rollout advancement is invalid",
        );
      if (Number(value.stage) >= currentStage) {
        currentStage = Number(value.stage);
        enteredAt = value.createdAt;
      }
    }
    const controls = await listPrefix(
      `${rolloutRoot(channel.appId, promotionId, channel.releaseId)}/controls/`,
    );
    const parsedControls: StoredMobileUpdateRolloutControl[] = [];
    for (const item of controls) {
      const value = await readVerifiedObject(item.key, "rollout control");
      if (
        !object(value) ||
        value.format !== 1 ||
        value.promotionId !== promotionId ||
        value.releaseId !== channel.releaseId ||
        typeof value.id !== "string" ||
        (value.action !== "pause" &&
          value.action !== "resume" &&
          value.action !== "cancel") ||
        !iso(value.createdAt) ||
        (value.resumedPauseIds !== undefined &&
          (!Array.isArray(value.resumedPauseIds) ||
            value.resumedPauseIds.some((id) => typeof id !== "string")))
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update rollout control is invalid",
        );
      parsedControls.push(value as StoredMobileUpdateRolloutControl);
    }
    const cancelled = parsedControls.some(({ action }) => action === "cancel");
    const resumedPauseIds = new Set(
      parsedControls.flatMap((control) => control.resumedPauseIds ?? []),
    );
    const activePauseIds = parsedControls
      .filter(
        ({ action, id }) => action === "pause" && !resumedPauseIds.has(id),
      )
      .map(({ id }) => id);
    const operatorPaused = activePauseIds.length > 0;
    const fleetPaused = Boolean(
      await options.store.head(
        pauseKey(channel.appId, promotionId, channel.releaseId),
      ),
    );

    return {
      cancelled,
      activePauseIds,
      channel,
      currentStage,
      enteredAt,
      fleetPaused,
      operatorPaused,
      plan,
      promotionId,
      rollout: plan.stages[currentStage]!.rollout,
    };
  };
  const writeRolloutControl = async (
    channel: MobileUpdateChannel,
    action: StoredMobileUpdateRolloutControl["action"],
    signal?: AbortSignal,
  ) => {
    const context = await rolloutContext(channel);
    if (!context)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout orchestration is not configured",
      );
    if (context.cancelled)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout was already cancelled",
      );
    if (action === "resume" && context.fleetPaused)
      throw new MobileUpdateRegistryError(
        "A fleet-health pause requires an explicit re-promotion",
      );
    const releaseId = channel.releaseId;
    if (!releaseId)
      throw new MobileUpdateRegistryError(
        "Mobile update channel does not have an active release",
      );
    const createdAt = clock().toISOString();
    const id = randomUUID();
    const event: StoredMobileUpdateRolloutControl = {
      action,
      createdAt,
      format: 1,
      id,
      promotionId: context.promotionId,
      releaseId,
      ...(action === "resume"
        ? { resumedPauseIds: context.activePauseIds }
        : {}),
    };
    const bytes = json(event);
    await options.store.put(
      `${rolloutRoot(channel.appId, context.promotionId, releaseId)}/controls/${createdAt}-${id}-${action}.json`,
      bytes,
      {
        cacheControl: "no-store",
        contentType: "application/json",
        maxBytes: bytes.byteLength,
        metadata: { action, sha256: digest(bytes) },
        signal,
      },
    );
  };
  const promoteUpdate: MobileUpdateRegistry["promoteUpdate"] = async (
    input,
  ) => {
    input.signal?.throwIfAborted();
    if (input.rollout <= 0 || input.rollout > 1)
      throw new MobileUpdateRegistryError("Mobile update rollout is invalid");
    if (
      rollout &&
      !rollout.stages.some((stage) => stage.rollout === input.rollout)
    )
      throw new MobileUpdateRegistryError(
        "Mobile update promotion rollout must match a configured rollout stage",
      );
    await assertNotMarked(input.appId, input.releaseId);
    const release = await readManifest(input.appId, input.releaseId);
    if (!release || release.manifest.channel !== input.channel)
      throw new MobileUpdateRegistryError(
        "Mobile update was not published to this channel",
      );
    const existing = await readChannel(input.appId, input.channel);
    await writeChannel(
      {
        appId: input.appId,
        channel: input.channel,
        ...(existing?.releaseId && existing.releaseId !== input.releaseId
          ? { fallbackReleaseId: existing.releaseId }
          : existing?.fallbackReleaseId
            ? { fallbackReleaseId: existing.fallbackReleaseId }
            : {}),
        releaseId: input.releaseId,
        rollout: input.rollout,
      },
      input.signal,
      (channel) => initializeRollout(channel, input.signal),
    );

    return {
      appId: input.appId,
      channel: input.channel,
      releaseId: input.releaseId,
      rollout: input.rollout,
      stage: "promoted",
    };
  };
  const resolveUpdateState = async (input: {
    appId: string;
    channel: string;
    installationId: string;
    runtimeFingerprint: string;
  }): Promise<MobileUpdateResolution> => {
    const channel = await readChannel(input.appId, input.channel);
    if (!channel?.releaseId) return { status: "empty" };
    const rolloutState = await rolloutContext(channel);
    let selected = rolloutMember({
      appId: input.appId,
      channel: input.channel,
      installationId: input.installationId,
      releaseId: channel.releaseId,
      rollout: rolloutState?.rollout ?? channel.rollout,
    })
      ? channel.releaseId
      : channel.fallbackReleaseId;
    if (
      selected === channel.releaseId &&
      (rolloutState?.cancelled ||
        rolloutState?.fleetPaused ||
        rolloutState?.operatorPaused ||
        (health &&
          (await options.store.head(
            pauseKey(
              input.appId,
              healthPromotionId(channel),
              channel.releaseId,
            ),
          ))))
    )
      selected = channel.fallbackReleaseId;
    if (!selected) return { status: "empty" };
    const release = await readManifest(input.appId, selected);
    if (
      !release ||
      release.manifest.runtimeFingerprint !== input.runtimeFingerprint
    )
      return { status: "incompatible" };

    return {
      ...(selected === channel.releaseId &&
      channel.activationId &&
      channel.activatedAt
        ? {
            activationId: channel.activationId,
            activatedAt: channel.activatedAt,
          }
        : {}),
      manifest: release.manifest,
      manifestKey: release.key,
      status: "selected",
    };
  };

  const issueUpdateHealthToken: NonNullable<
    MobileUpdateRegistry["issueUpdateHealthToken"]
  > = async (input) => {
    if (!health) return null;
    const channel = await readChannel(input.appId, input.channel);
    if (!channel?.releaseId || channel.releaseId !== input.releaseId)
      return null;
    const resolution = await resolveUpdateState(input);
    if (
      resolution.status !== "selected" ||
      resolution.manifest.releaseId !== input.releaseId
    )
      return null;

    return signHealthToken({
      appId: input.appId,
      channel: input.channel,
      format: HEALTH_TOKEN_VERSION,
      installationId: input.installationId,
      promotionId: healthPromotionId(channel),
      releaseId: input.releaseId,
      runtimeFingerprint: input.runtimeFingerprint,
    });
  };

  const inspectUpdateHealth: NonNullable<
    MobileUpdateRegistry["inspectUpdateHealth"]
  > = async (input) => {
    if (!health)
      throw new MobileUpdateRegistryError(
        "Mobile update health reporting is not configured",
      );
    const channel = await readChannel(input.appId, input.channel);
    const releaseId = input.releaseId ?? channel?.releaseId;
    if (!channel || !releaseId || channel.releaseId !== releaseId) return null;
    const promotionId = healthPromotionId(channel);
    const objects = await listPrefix(
      `${healthRoot(input.appId, promotionId, releaseId)}/events/`,
    );
    const installations = new Set<string>();
    const byKind = new Map<MobileUpdateHealthKind, Set<string>>(
      [...HEALTH_KINDS].map((kind) => [
        kind as MobileUpdateHealthKind,
        new Set(),
      ]),
    );
    const transfer: MobileUpdateHealthTransfer = {
      avoidedBytes: 0,
      downloadedBytes: 0,
      durationMs: 0,
      resumedBytes: 0,
      reusedBytes: 0,
      throughputBytesPerSecond: 0,
    };
    for (const item of objects) {
      const bytes = await options.store.get(item.key);
      if (!bytes) continue;
      const head = await options.store.head(item.key);
      if (
        !head ||
        head.size !== bytes.byteLength ||
        head.metadata?.sha256 !== digest(bytes)
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update health evidence integrity failed",
        );
      const value = decode(bytes);
      if (
        !object(value) ||
        typeof value.installationHash !== "string" ||
        !HEALTH_KINDS.has(String(value.kind))
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update health evidence is invalid",
        );
      const kind = value.kind as MobileUpdateHealthKind;
      installations.add(value.installationHash);
      byKind.get(kind)!.add(value.installationHash);
      if (kind === "downloaded" && object(value.transfer)) {
        const parsed = parseHealthTransfer(
          value.transfer as MobileUpdateHealthTransfer,
        )!;
        for (const key of Object.keys(
          transfer,
        ) as (keyof MobileUpdateHealthTransfer)[])
          transfer[key] += parsed[key];
      }
    }
    const failures = new Set([
      ...byKind.get("quarantined")!,
      ...byKind.get("rolled-back")!,
    ]);
    const terminals = new Set([...byKind.get("activated")!, ...failures]);
    const failureRate =
      terminals.size === 0 ? 0 : failures.size / terminals.size;

    const rolloutState = await rolloutContext(channel);

    return {
      activated: byKind.get("activated")!.size,
      appId: input.appId,
      channel: input.channel,
      downloaded: byKind.get("downloaded")!.size,
      downloadFailed: byKind.get("download-failed")!.size,
      failureRate,
      failures: failures.size,
      paused: Boolean(
        rolloutState?.cancelled ||
        rolloutState?.fleetPaused ||
        rolloutState?.operatorPaused ||
        (await options.store.head(
          pauseKey(input.appId, promotionId, releaseId),
        )),
      ),
      promotionId,
      quarantined: byKind.get("quarantined")!.size,
      releaseId,
      reportedInstallations: installations.size,
      rolledBack: byKind.get("rolled-back")!.size,
      rollout: rolloutState?.rollout ?? channel.rollout,
      terminalReports: terminals.size,
      transfer,
    };
  };

  const inspectUpdateRollout: NonNullable<
    MobileUpdateRegistry["inspectUpdateRollout"]
  > = async (input) => {
    const channel = await readChannel(input.appId, input.channel);
    if (!channel?.releaseId) return null;
    const context = await rolloutContext(channel);
    if (!context)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout orchestration is not configured",
      );
    const healthReport = await inspectUpdateHealth(input);
    if (!healthReport) return null;
    const paused = context.fleetPaused || context.operatorPaused;
    const complete = context.currentStage === context.plan.stages.length - 1;

    return {
      ...healthReport,
      automatic: context.plan.automatic,
      currentStage: context.currentStage,
      enteredAt: context.enteredAt,
      ...(!complete
        ? { nextStage: context.plan.stages[context.currentStage + 1] }
        : {}),
      ...(context.fleetPaused
        ? { pausedBy: "fleet-health" as const }
        : context.operatorPaused
          ? { pausedBy: "operator" as const }
          : {}),
      status: context.cancelled
        ? "cancelled"
        : paused
          ? "paused"
          : complete
            ? "complete"
            : "active",
    };
  };

  const advanceRollout = async (
    input: {
      appId: string;
      channel: string;
      rollout?: number;
      signal?: AbortSignal;
    },
    strict: boolean,
  ) => {
    input.signal?.throwIfAborted();
    const channel = await readChannel(input.appId, input.channel);
    if (!channel?.releaseId)
      throw new MobileUpdateRegistryError(
        "Mobile update channel does not have an active release",
      );
    const context = await rolloutContext(channel);
    if (!context)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout orchestration is not configured",
      );
    const report = await inspectUpdateRollout(input);
    if (!report)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout report is unavailable",
      );
    const nextStage = context.plan.stages[context.currentStage + 1];
    if (!nextStage) return report;
    if (input.rollout !== undefined && input.rollout !== nextStage.rollout)
      throw new MobileUpdateRegistryError(
        "Mobile update rollout can advance only to the next configured stage",
      );
    if (report.status !== "active") {
      if (strict)
        throw new MobileUpdateRegistryError(
          `Mobile update rollout cannot advance while ${report.status}`,
        );

      return report;
    }
    const gate = context.plan.stages[context.currentStage]!;
    const observedMs = clock().getTime() - Date.parse(context.enteredAt);
    const blocked =
      report.terminalReports < gate.minimumReports ||
      report.failureRate > gate.maximumFailureRate ||
      observedMs < gate.observationMs;
    if (blocked) {
      if (strict)
        throw new MobileUpdateRegistryError(
          `Mobile update rollout needs ${gate.minimumReports} terminal reports, at most ${(gate.maximumFailureRate * 100).toFixed(1)}% failures, and ${gate.observationMs}ms observation at the current stage`,
        );

      return report;
    }
    const stage = context.currentStage + 1;
    const event: StoredMobileUpdateRolloutAdvance = {
      createdAt: clock().toISOString(),
      failureRate: report.failureRate,
      format: 1,
      promotionId: context.promotionId,
      releaseId: channel.releaseId,
      rollout: nextStage.rollout,
      stage,
      terminalReports: report.terminalReports,
    };
    const bytes = json(event);
    await options.store.put(
      `${rolloutRoot(input.appId, context.promotionId, channel.releaseId)}/advances/${String(stage).padStart(4, "0")}.json`,
      bytes,
      {
        cacheControl: "no-store",
        contentType: "application/json",
        maxBytes: bytes.byteLength,
        metadata: { releaseid: channel.releaseId, sha256: digest(bytes) },
        signal: input.signal,
      },
    );

    return (await inspectUpdateRollout(input))!;
  };

  const advanceUpdateRollout: NonNullable<
    MobileUpdateRegistry["advanceUpdateRollout"]
  > = (input) => advanceRollout(input, true);
  const reconcileUpdateRollout: NonNullable<
    MobileUpdateRegistry["reconcileUpdateRollout"]
  > = async (input) => {
    const report = await inspectUpdateRollout(input);
    if (!report || !report.automatic) return report;

    return advanceRollout(input, false);
  };
  const rolloutControl =
    (action: StoredMobileUpdateRolloutControl["action"]) =>
    async (input: { appId: string; channel: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      const channel = await readChannel(input.appId, input.channel);
      if (!channel?.releaseId)
        throw new MobileUpdateRegistryError(
          "Mobile update channel does not have an active release",
        );
      await writeRolloutControl(channel, action, input.signal);

      return (await inspectUpdateRollout(input))!;
    };
  const pauseUpdateRollout = rolloutControl("pause");
  const resumeUpdateRollout = rolloutControl("resume");
  const cancelUpdateRollout = rolloutControl("cancel");

  const recordUpdateHealth: NonNullable<
    MobileUpdateRegistry["recordUpdateHealth"]
  > = async (input) => {
    const payload = verifyHealthToken(input.token);
    if (
      payload.appId !== input.appId ||
      payload.channel !== input.channel ||
      payload.installationId !== input.installationId ||
      payload.releaseId !== input.releaseId ||
      payload.runtimeFingerprint !== input.runtimeFingerprint ||
      !HEALTH_KINDS.has(input.kind) ||
      (input.reason !== undefined &&
        input.reason !== "boot-interrupted" &&
        input.reason !== "boot-timeout")
    )
      throw new MobileUpdateRegistryError(
        "Mobile update health evidence does not match its token",
      );
    const release = await readManifest(input.appId, input.releaseId);
    if (
      !release ||
      release.manifest.runtimeFingerprint !== input.runtimeFingerprint
    )
      throw new MobileUpdateRegistryError(
        "Mobile update health release is invalid",
      );
    const activeChannel = await readChannel(input.appId, input.channel);
    if (
      !activeChannel ||
      activeChannel.releaseId !== input.releaseId ||
      healthPromotionId(activeChannel) !== payload.promotionId
    )
      throw new MobileUpdateRegistryError(
        "Mobile update health promotion is no longer active",
      );
    const transfer = parseHealthTransfer(input.transfer);
    const installationHash = createHmac("sha256", health!.secret)
      .update(input.installationId)
      .digest("hex");
    const evidence = {
      format: 1,
      installationHash,
      kind: input.kind,
      observedAt: clock().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(transfer ? { transfer } : {}),
    };
    const bytes = json(evidence);
    await options.store.put(
      `${healthRoot(input.appId, payload.promotionId, input.releaseId)}/events/${installationHash}/${input.kind}.json`,
      bytes,
      {
        cacheControl: "no-store",
        contentType: "application/json",
        maxBytes: bytes.byteLength,
        metadata: { kind: input.kind, sha256: digest(bytes) },
      },
    );
    let report = await inspectUpdateHealth({
      appId: input.appId,
      channel: input.channel,
      releaseId: input.releaseId,
    });
    if (!report)
      throw new MobileUpdateRegistryError(
        "Mobile update health promotion is no longer active",
      );
    if (
      FAILURE_HEALTH_KINDS.has(input.kind) &&
      report.terminalReports >= minimumReports &&
      report.failureRate >= failureThreshold &&
      !report.paused
    ) {
      const marker = json({
        appId: input.appId,
        channel: input.channel,
        failureRate: report.failureRate,
        failures: report.failures,
        format: 1,
        pausedAt: clock().toISOString(),
        promotionId: payload.promotionId,
        releaseId: input.releaseId,
        reports: report.terminalReports,
      });
      await options.store.put(
        pauseKey(input.appId, payload.promotionId, input.releaseId),
        marker,
        {
          cacheControl: "no-store",
          contentType: "application/json",
          maxBytes: marker.byteLength,
          metadata: { releaseid: input.releaseId, sha256: digest(marker) },
        },
      );
      report = { ...report, paused: true };
    }

    if (
      rollout &&
      (input.kind === "activated" || FAILURE_HEALTH_KINDS.has(input.kind))
    )
      return (
        (await reconcileUpdateRollout({
          appId: input.appId,
          channel: input.channel,
        })) ?? report
      );

    return report;
  };

  const retentionValues = (input: MobileUpdateRetentionOptions) => {
    if (!APP_ID.test(input.appId))
      throw new MobileUpdateRegistryError("Mobile update appId is invalid");
    const retainRecent = input.retainRecent ?? DEFAULT_RETAIN_RECENT;
    const minAgeMs = input.minAgeMs ?? DEFAULT_MIN_AGE_MS;
    if (!Number.isSafeInteger(retainRecent) || retainRecent < 0)
      throw new MobileUpdateRegistryError(
        "Mobile update retained release count is invalid",
      );
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0)
      throw new MobileUpdateRegistryError(
        "Mobile update minimum release age is invalid",
      );

    return { minAgeMs, retainRecent };
  };
  const listObjects = async (appId: string, signal?: AbortSignal) => {
    const list = options.store.list;
    if (!list)
      throw new MobileUpdateRegistryError(
        "Mobile update storage does not support lifecycle listing",
      );
    const objects: Awaited<ReturnType<typeof list>>["objects"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await list({
        ...(cursor ? { cursor } : {}),
        prefix: `${root(appId)}/`,
      });
      objects.push(...page.objects);
      if (!page.truncated) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new MobileUpdateRegistryError(
          "Mobile update storage returned an invalid lifecycle cursor",
        );
      cursors.add(page.cursor);
      cursor = page.cursor;
    } while (true);

    return objects;
  };
  const inventory = async (
    input: MobileUpdateRetentionOptions,
  ): Promise<{
    objectKeysByRelease: Map<string, string[]>;
    objectKeysByDigest: Map<string, string>;
    report: MobileUpdateStorageReport;
  }> => {
    const { minAgeMs, retainRecent } = retentionValues(input);
    const objects = await listObjects(input.appId, input.signal);
    const appRoot = `${root(input.appId)}/`;
    const releasePrefix = `${appRoot}releases/`;
    const channelPrefix = `${appRoot}channels/`;
    const markerPrefix = `${appRoot}gc/`;
    const blobPrefix = `${appRoot}blobs/`;
    const objectKeysByRelease = new Map<string, string[]>();
    const objectBytesByRelease = new Map<string, number>();
    const objectKeysByDigest = new Map<string, string>();
    const objectBytesByDigest = new Map<string, number>();
    for (const blobObject of objects) {
      if (blobObject.key.startsWith(blobPrefix)) {
        const sha256 = blobObject.key.slice(blobPrefix.length);
        if (HASH.test(sha256)) {
          objectKeysByDigest.set(sha256, blobObject.key);
          objectBytesByDigest.set(sha256, blobObject.size);
        }
      }
      if (!blobObject.key.startsWith(releasePrefix)) continue;
      const suffix = blobObject.key.slice(releasePrefix.length);
      const releaseId = suffix.slice(0, suffix.indexOf("/"));
      if (!RELEASE.test(releaseId)) continue;
      objectKeysByRelease.set(releaseId, [
        ...(objectKeysByRelease.get(releaseId) ?? []),
        blobObject.key,
      ]);
      objectBytesByRelease.set(
        releaseId,
        (objectBytesByRelease.get(releaseId) ?? 0) + blobObject.size,
      );
    }
    const channels: MobileUpdateChannel[] = [];
    for (const blobObject of objects) {
      if (
        !blobObject.key.startsWith(channelPrefix) ||
        !blobObject.key.endsWith(".json")
      )
        continue;
      const bytes = await options.store.get(blobObject.key);
      if (!bytes)
        throw new MobileUpdateRegistryError(
          "Mobile update channel disappeared during lifecycle inspection",
        );
      const channel = parseChannel(decode(bytes));
      if (channel.appId !== input.appId)
        throw new MobileUpdateRegistryError(
          "Stored mobile update channel identity changed",
        );
      channels.push(channel);
    }
    const markedAt = new Map<string, string>();
    for (const blobObject of objects) {
      if (
        !blobObject.key.startsWith(markerPrefix) ||
        !blobObject.key.endsWith(".json")
      )
        continue;
      const releaseId = blobObject.key.slice(
        markerPrefix.length,
        -".json".length,
      );
      if (!RELEASE.test(releaseId)) continue;
      const bytes = await options.store.get(blobObject.key);
      if (!bytes) continue;
      const marker = decode(bytes);
      if (
        !object(marker) ||
        marker.format !== 1 ||
        marker.appId !== input.appId ||
        marker.releaseId !== releaseId ||
        !iso(marker.markedAt)
      )
        throw new MobileUpdateRegistryError(
          "Mobile update collection marker is invalid",
        );
      markedAt.set(releaseId, marker.markedAt);
    }
    const active = new Set(
      channels.flatMap((channel) =>
        channel.releaseId ? [channel.releaseId] : [],
      ),
    );
    const fallback = new Set(
      channels.flatMap((channel) =>
        channel.fallbackReleaseId ? [channel.fallbackReleaseId] : [],
      ),
    );
    const manifests: MobileUpdateManifest[] = [];
    for (const releaseId of objectKeysByRelease.keys()) {
      const release = await readManifest(input.appId, releaseId);
      if (release) manifests.push(release.manifest);
    }
    const recent = new Set<string>();
    const manifestsByChannel = new Map<string, MobileUpdateManifest[]>();
    for (const manifest of manifests)
      manifestsByChannel.set(manifest.channel, [
        ...(manifestsByChannel.get(manifest.channel) ?? []),
        manifest,
      ]);
    for (const releases of manifestsByChannel.values())
      for (const manifest of releases
        .toSorted((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )
        .slice(0, retainRecent))
        recent.add(manifest.releaseId);
    const now = clock().getTime();
    const releases = manifests
      .map((manifest): MobileUpdateStorageRelease => {
        const protectedBy: MobileUpdateStorageRelease["protectedBy"] = [];
        if (active.has(manifest.releaseId)) protectedBy.push("active");
        if (fallback.has(manifest.releaseId)) protectedBy.push("fallback");
        if (recent.has(manifest.releaseId)) protectedBy.push("recent");
        if (now - Date.parse(manifest.createdAt) < minAgeMs)
          protectedBy.push("age");

        return {
          bytes: objectBytesByRelease.get(manifest.releaseId) ?? 0,
          channel: manifest.channel,
          createdAt: manifest.createdAt,
          ...(markedAt.has(manifest.releaseId)
            ? { markedAt: markedAt.get(manifest.releaseId) }
            : {}),
          objectCount: objectKeysByRelease.get(manifest.releaseId)?.length ?? 0,
          protectedBy,
          releaseId: manifest.releaseId,
        };
      })
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
    const protectedReleaseIds = new Set(
      releases
        .filter((release) => release.protectedBy.length > 0)
        .map((release) => release.releaseId),
    );
    const protectedDigests = new Set(
      manifests
        .filter((manifest) => protectedReleaseIds.has(manifest.releaseId))
        .flatMap((manifest) => manifest.files.map((file) => file.sha256)),
    );
    const reclaimableContentBytes = [...objectBytesByDigest]
      .filter(([sha256]) => !protectedDigests.has(sha256))
      .reduce((total, [, bytes]) => total + bytes, 0);
    const contentBlobBytes = [...objectBytesByDigest.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    );
    const releaseBytes = releases.reduce(
      (total, release) => total + release.bytes,
      0,
    );
    const totalBytes = objects.reduce(
      (total, object) => total + object.size,
      0,
    );

    return {
      objectKeysByRelease,
      objectKeysByDigest,
      report: {
        appId: input.appId,
        channelCount: channels.length,
        contentBlobBytes,
        contentBlobCount: objectKeysByDigest.size,
        reclaimableBytes:
          releases
            .filter((release) => release.protectedBy.length === 0)
            .reduce((total, release) => total + release.bytes, 0) +
          reclaimableContentBytes,
        reclaimableContentBytes,
        releaseBytes,
        releaseCount: releases.length,
        releases,
        totalBytes,
        totalObjectCount: objects.length,
        untrackedBytes: totalBytes - releaseBytes - contentBlobBytes,
      },
    };
  };

  const pruneUpdates: MobileUpdateRegistry["pruneUpdates"] = async (input) => {
    const initial = await inventory(input);
    const result: MobileUpdatePruneResult = {
      ...initial.report,
      dryRun: input.apply !== true,
      marked: [],
      reclaimedBytes: 0,
      restored: [],
      swept: [],
      sweptContentBlobs: [],
    };
    if (input.apply !== true) return result;
    const remove = options.store.delete;
    if (!remove)
      throw new MobileUpdateRegistryError(
        "Mobile update storage does not support lifecycle deletion",
      );
    const gracePeriodMs = input.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0)
      throw new MobileUpdateRegistryError(
        "Mobile update collection grace period is invalid",
      );
    const now = clock();
    for (const release of initial.report.releases) {
      input.signal?.throwIfAborted();
      const marker = tombstoneKey(input.appId, release.releaseId);
      if (release.protectedBy.length > 0) {
        if (release.markedAt) {
          await remove(marker);
          result.restored.push(release.releaseId);
        }
        continue;
      }
      if (!release.markedAt) {
        const bytes = json({
          appId: input.appId,
          format: 1,
          markedAt: now.toISOString(),
          releaseId: release.releaseId,
        });
        await options.store.put(marker, bytes, {
          cacheControl: "no-cache",
          contentType: "application/json",
          maxBytes: bytes.byteLength,
          metadata: { releaseid: release.releaseId, sha256: digest(bytes) },
          signal: input.signal,
        });
        result.marked.push(release.releaseId);
      }
    }
    const current = await inventory(input);
    for (const release of current.report.releases) {
      input.signal?.throwIfAborted();
      if (
        release.protectedBy.length > 0 ||
        !release.markedAt ||
        now.getTime() - Date.parse(release.markedAt) < gracePeriodMs ||
        result.marked.includes(release.releaseId)
      )
        continue;
      const checked = await inventory(input);
      const candidate = checked.report.releases.find(
        (value) => value.releaseId === release.releaseId,
      );
      if (!candidate || candidate.protectedBy.length > 0 || !candidate.markedAt)
        continue;
      const keys = checked.objectKeysByRelease.get(release.releaseId) ?? [];
      for (const key of keys.toSorted((left, right) => {
        const leftManifest = left.endsWith("/update.json");
        const rightManifest = right.endsWith("/update.json");

        return Number(leftManifest) - Number(rightManifest);
      }))
        await remove(key);
      await remove(tombstoneKey(input.appId, release.releaseId));
      result.reclaimedBytes += candidate.bytes;
      result.swept.push(release.releaseId);
    }
    const afterReleaseSweep = await inventory(input);
    const referencedDigests = new Set<string>();
    for (const release of afterReleaseSweep.report.releases) {
      const manifest = await readManifest(input.appId, release.releaseId);
      for (const file of manifest?.manifest.files ?? [])
        referencedDigests.add(file.sha256);
    }
    for (const [sha256, key] of afterReleaseSweep.objectKeysByDigest) {
      if (referencedDigests.has(sha256)) continue;
      const head = await options.store.head(key);
      await remove(key);
      result.reclaimedBytes += head?.size ?? 0;
      result.sweptContentBlobs!.push(sha256);
    }

    return result;
  };

  return {
    ...(health
      ? { inspectUpdateHealth, issueUpdateHealthToken, recordUpdateHealth }
      : {}),
    ...(rollout
      ? {
          advanceUpdateRollout,
          cancelUpdateRollout,
          inspectUpdateRollout,
          pauseUpdateRollout,
          reconcileUpdateRollout,
          resumeUpdateRollout,
        }
      : {}),
    inspectUpdateStorage: async (input) => (await inventory(input)).report,
    pruneUpdates,
    publishUpdate: async (input) => {
      input.signal?.throwIfAborted();
      const manifest = parseMobileUpdateManifest(input.manifest);
      verifyManifestSignature(manifest, options.publicKeys);
      await assertNotMarked(manifest.appId, manifest.releaseId);
      const localRoot = path.resolve(input.releaseDirectory);
      const localManifest = parseMobileUpdateManifest(
        JSON.parse(await readFile(path.join(localRoot, "update.json"), "utf8")),
      );
      if (JSON.stringify(localManifest) !== JSON.stringify(manifest))
        throw new MobileUpdateRegistryError(
          "Local mobile update manifest changed",
        );
      const existing = await readManifest(manifest.appId, manifest.releaseId);
      let reused = existing !== null;
      let storedBytes = 0;
      let storedFiles = 0;
      let reusedBytes = 0;
      let reusedFiles = 0;
      if (
        existing &&
        JSON.stringify(existing.manifest) !== JSON.stringify(manifest)
      )
        throw new MobileUpdateRegistryError(
          "Published mobile update is immutable",
        );
      if (existing) {
        reusedBytes = manifest.files.reduce(
          (total, file) => total + file.bytes,
          0,
        );
        reusedFiles = manifest.files.length;
      }
      if (!existing) {
        for (const file of manifest.files) {
          const local = path.join(localRoot, "files", file.path);
          const metadata = await stat(local).catch(() => null);
          if (!metadata?.isFile() || metadata.size !== file.bytes)
            throw new MobileUpdateRegistryError(
              `Mobile update file ${file.path} size changed`,
            );
          if ((await fileDigest(Bun.file(local))) !== file.sha256)
            throw new MobileUpdateRegistryError(
              `Mobile update file ${file.path} integrity failed`,
            );
          const key = contentBlobKey(manifest.appId, file.sha256);
          const stored = await options.store.head(key);
          if (!stored) {
            await options.store.put(key, Bun.file(local).stream(), {
              cacheControl: "public, max-age=31536000, immutable",
              contentType: "application/octet-stream",
              maxBytes: file.bytes,
              metadata: { sha256: file.sha256 },
              signal: input.signal,
            });
            storedBytes += file.bytes;
            storedFiles += 1;
          } else if (
            stored.size !== file.bytes ||
            stored.metadata?.sha256 !== file.sha256
          )
            throw new MobileUpdateRegistryError(
              "Stored mobile update content identity changed",
            );
          else {
            reusedBytes += file.bytes;
            reusedFiles += 1;
          }
        }
        const bytes = json(manifest);
        await options.store.put(manifestKey(manifest), bytes, {
          cacheControl: "public, max-age=31536000, immutable",
          contentType: "application/json",
          maxBytes: bytes.byteLength,
          metadata: { releaseid: manifest.releaseId, sha256: digest(bytes) },
          signal: input.signal,
        });
        if (!(await readManifest(manifest.appId, manifest.releaseId)))
          throw new MobileUpdateRegistryError(
            "Mobile update publication verification failed",
          );
        reused = false;
      }
      await promoteUpdate({
        appId: manifest.appId,
        channel: manifest.channel,
        releaseId: manifest.releaseId,
        rollout: input.rollout,
        signal: input.signal,
      });

      return {
        appId: manifest.appId,
        channel: manifest.channel,
        storedBytes,
        storedFiles,
        releaseId: manifest.releaseId,
        reused,
        reusedBytes,
        reusedFiles,
        rollout: input.rollout,
        stage: "published",
      };
    },
    promoteUpdate,
    rollbackUpdate: async (input) => {
      input.signal?.throwIfAborted();
      const existing = await readChannel(input.appId, input.channel);
      if (!existing)
        throw new MobileUpdateRegistryError(
          "Mobile update channel does not exist",
        );
      if (input.releaseId) {
        await assertNotMarked(input.appId, input.releaseId);
        const release = await readManifest(input.appId, input.releaseId);
        if (!release || release.manifest.channel !== input.channel)
          throw new MobileUpdateRegistryError(
            "Mobile rollback release was not published",
          );
      }
      const activatedAt = clock().toISOString();
      await writeChannel(
        {
          ...(input.releaseId
            ? {
                activationId: digest(
                  new TextEncoder().encode(
                    `${input.appId}\0${input.channel}\0${input.releaseId}\0${activatedAt}`,
                  ),
                ),
                activatedAt,
              }
            : {}),
          appId: input.appId,
          channel: input.channel,
          ...(existing.releaseId
            ? { fallbackReleaseId: existing.releaseId }
            : {}),
          ...(input.releaseId ? { releaseId: input.releaseId } : {}),
          rollout: input.releaseId ? 1 : 0,
        },
        input.signal,
      );

      return {
        appId: input.appId,
        channel: input.channel,
        ...(input.releaseId ? { releaseId: input.releaseId } : {}),
        stage: "rolled-back",
      };
    },
    resolveUpdate: async (input) => {
      const resolution = await resolveUpdateState(input);

      return resolution.status === "selected"
        ? { manifest: resolution.manifest, manifestKey: resolution.manifestKey }
        : null;
    },
    resolveUpdateState,
    readUpdateFile: async (input) => {
      const release = await readManifest(input.appId, input.releaseId);
      if (!release) return null;
      const requested = safePath(input.path);
      const file = release.manifest.files.find(
        (candidate) => candidate.path === requested,
      );
      if (!file) return null;
      const legacyKey = fileKey(release.manifest, file);
      const legacyHead = await options.store.head(legacyKey);
      const key = legacyHead
        ? legacyKey
        : contentBlobKey(release.manifest.appId, file.sha256);
      const [bytes, head] = await Promise.all([
        options.store.get(key),
        legacyHead ? Promise.resolve(legacyHead) : options.store.head(key),
      ]);
      if (!bytes || !head) return null;
      if (
        bytes.byteLength !== file.bytes ||
        head.size !== file.bytes ||
        head.metadata?.sha256 !== file.sha256 ||
        (legacyHead &&
          (head.metadata?.releaseid ?? head.metadata?.releaseId) !==
            release.manifest.releaseId) ||
        digest(bytes) !== file.sha256
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update file integrity failed",
        );

      return { bytes, file };
    },
  };
};

const expoUpdateId = (releaseId: string) => {
  const hash = RELEASE.test(releaseId)
    ? releaseId.slice("amu_".length, "amu_".length + 32)
    : createHash("sha256").update(releaseId).digest("hex").slice(0, 32);

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

const expoContentType = (extension: string | undefined, launch: boolean) => {
  if (launch) return "application/javascript";
  const normalized = extension?.toLowerCase();
  if (normalized === "png") return "image/png";
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  if (normalized === "svg") return "image/svg+xml";
  if (normalized === "json") return "application/json";
  if (normalized === "ttf") return "font/ttf";
  if (normalized === "otf") return "font/otf";
  if (normalized === "woff") return "font/woff";
  if (normalized === "woff2") return "font/woff2";

  return "application/octet-stream";
};

const encodeUpdatePath = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

const expoProtocolHeaders = {
  "cache-control": "private, max-age=0",
  "content-type": "application/expo+json",
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
};

const resolveExpoCodeSigning = (
  value: ExpoUpdateCodeSigningOptions | undefined,
) => {
  if (!value) return undefined;
  const entries = Object.entries(value.keys);
  if (entries.length === 0)
    throw new MobileUpdateRegistryError(
      "Expo code signing requires at least one key",
    );

  return new Map(
    entries.map(([keyId, material]) => {
      if (!NAME.test(keyId))
        throw new MobileUpdateRegistryError(
          "Expo code-signing key ID is invalid",
        );
      let certificate: X509Certificate;
      let privateKey: ReturnType<typeof createPrivateKey>;
      try {
        certificate = new X509Certificate(material.certificate);
        privateKey = createPrivateKey(material.privateKey);
      } catch (error) {
        throw new MobileUpdateRegistryError(
          "Expo code-signing certificate or private key is invalid",
          { cause: error },
        );
      }
      if (
        certificate.publicKey.asymmetricKeyType !== "rsa" ||
        privateKey.asymmetricKeyType !== "rsa" ||
        certificate.issuer !== certificate.subject ||
        !certificate.verify(certificate.publicKey)
      )
        throw new MobileUpdateRegistryError(
          "Expo code signing requires a self-signed RSA root and private key",
        );
      const certificatePublicKey = certificate.publicKey.export({
        format: "der",
        type: "spki",
      });
      const privatePublicKey = createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
      });
      if (!certificatePublicKey.equals(privatePublicKey))
        throw new MobileUpdateRegistryError(
          "Expo code-signing private key does not match its certificate",
        );
      const now = Date.now();
      if (
        now < Date.parse(certificate.validFrom) ||
        now > Date.parse(certificate.validTo)
      )
        throw new MobileUpdateRegistryError(
          "Expo code-signing certificate is not currently valid",
        );

      return [keyId, { keyId, privateKey }] as const;
    }),
  );
};

type ExpoCodeSigning =
  NonNullable<ReturnType<typeof resolveExpoCodeSigning>> extends Map<
    string,
    infer Signing
  >
    ? Signing
    : never;

const expoSignatureExpectation = (value: string) => {
  const fields = new Map<string, string | true>();
  for (const raw of value.split(",")) {
    const match =
      /^\s*([a-z][a-z0-9_-]*)(?:=(\?1|\?0|"[^"\\]*"|[a-z0-9._-]+))?\s*$/u.exec(
        raw,
      );
    if (!match || fields.has(match[1]!))
      throw new MobileUpdateRegistryError(
        "Expo code-signing expectation is invalid",
      );
    const encoded = match[2];
    fields.set(
      match[1]!,
      encoded === undefined || encoded === "?1"
        ? true
        : encoded.startsWith('"')
          ? encoded.slice(1, -1)
          : encoded,
    );
  }

  return fields;
};

const expoExtraParam = (request: Request, key: string) => {
  const value = request.headers.get("expo-extra-params");
  if (!value) return null;
  for (const raw of value.split(",")) {
    const match =
      /^\s*([a-z][a-z0-9_.*-]*)=(?:"((?:[^"\\]|\\["\\])*)"|([^\s,]+))\s*$/u.exec(
        raw,
      );
    if (!match || match[1] !== key) continue;
    return match[2] !== undefined
      ? match[2].replace(/\\(["\\])/gu, "$1")
      : (match[3] ?? null);
  }

  return null;
};

const requestedExpoSignature = (
  request: Request,
  codeSigning: Map<string, ExpoCodeSigning> | undefined,
) => {
  const expectation = request.headers.get("expo-expect-signature");
  if (!expectation) return undefined;
  if (!codeSigning)
    throw new MobileUpdateRegistryError(
      "Expo end-to-end code signing is not configured",
    );
  const fields = expoSignatureExpectation(expectation);
  const keyId = fields.get("keyid");
  const algorithm = fields.get("alg");
  const signatureRequested = fields.get("sig") === true;
  if (
    !signatureRequested ||
    (keyId !== undefined && typeof keyId !== "string") ||
    (algorithm !== undefined && algorithm !== EXPO_CODE_SIGNING_ALGORITHM)
  )
    throw new MobileUpdateRegistryError(
      "Requested Expo code-signing parameters are unsupported",
    );

  const selected =
    typeof keyId === "string"
      ? codeSigning.get(keyId)
      : codeSigning.size === 1
        ? codeSigning.values().next().value
        : undefined;
  if (!selected)
    throw new MobileUpdateRegistryError(
      "Requested Expo code-signing key is unavailable",
    );

  return selected;
};

const expoSignatureHeader = (body: string, codeSigning: ExpoCodeSigning) => {
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(body),
    codeSigning.privateKey,
  );

  return `sig="${signature.toString("base64")}", keyid="${codeSigning.keyId}", alg="${EXPO_CODE_SIGNING_ALGORITHM}"`;
};

const expoRollbackResponse = (
  request: Request,
  codeSigning: ExpoCodeSigning | undefined,
) => {
  const current = request.headers.get("expo-current-update-id");
  const embedded = request.headers.get("expo-embedded-update-id");
  if (!current || current === embedded)
    return new Response(null, { status: 204 });
  const boundary = `absolutejs-${crypto.randomUUID()}`;
  const directive = JSON.stringify({
    parameters: { commitTime: new Date().toISOString() },
    type: "rollBackToEmbedded",
  });
  const body = [
    `--${boundary}`,
    'content-disposition: form-data; name="directive"',
    "content-type: application/json; charset=utf-8",
    ...(codeSigning
      ? [`expo-signature: ${expoSignatureHeader(directive, codeSigning)}`]
      : []),
    "",
    directive,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return new Response(body, {
    headers: {
      ...expoProtocolHeaders,
      "content-type": `multipart/mixed; boundary=${boundary}`,
    },
  });
};

export const createMobileUpdateHandler = (options: {
  allowedOrigins?: readonly string[];
  appId: string;
  channel: string;
  expoCodeSigning?: ExpoUpdateCodeSigningOptions;
  registry: MobileUpdateRegistry;
  route?: string;
}) => {
  const route = (
    options.route ?? `/__absolute/mobile/updates/${options.channel}`
  ).replace(/^\/+|\/+$/g, "");
  const allowedOrigins = new Set(
    options.allowedOrigins ?? ["capacitor://localhost", "https://localhost"],
  );
  const expoCodeSigning = resolveExpoCodeSigning(options.expoCodeSigning);

  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const cors: Record<string, string> =
      origin && allowedOrigins.has(origin)
        ? {
            "access-control-allow-origin": origin,
            "access-control-expose-headers":
              "content-range,etag,x-absolute-mobile-health-token",
            vary: "Origin",
          }
        : {};
    if (request.method === "OPTIONS") {
      if (!origin || !allowedOrigins.has(origin))
        return new Response(null, { status: 403 });

      return new Response(null, {
        headers: {
          ...cors,
          "access-control-allow-headers":
            "content-type,if-range,range,x-absolute-mobile-app,x-absolute-mobile-channel,x-absolute-mobile-health-token,x-absolute-mobile-installation,x-absolute-mobile-release,x-absolute-mobile-runtime",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-max-age": "600",
        },
        status: 204,
      });
    }
    const pathname = new URL(request.url).pathname.replace(/^\/+/, "");
    const relative = pathname.startsWith(`${route}/`)
      ? pathname.slice(route.length + 1)
      : "";
    if (request.method === "POST" && relative === "health") {
      if (!options.registry.recordUpdateHealth)
        return new Response(null, { status: 404 });
      const appId = request.headers.get("x-absolute-mobile-app");
      const channel = request.headers.get("x-absolute-mobile-channel");
      const installationId = request.headers.get(
        "x-absolute-mobile-installation",
      );
      const runtimeFingerprint = request.headers.get(
        "x-absolute-mobile-runtime",
      );
      const token = request.headers.get("x-absolute-mobile-health-token");
      const declared = Number(request.headers.get("content-length"));
      if (
        appId !== options.appId ||
        channel !== options.channel ||
        !installationId ||
        !runtimeFingerprint ||
        !token ||
        (Number.isFinite(declared) && declared > 4096)
      )
        return new Response(null, { status: 400 });
      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.byteLength > 4096)
        return new Response(null, { status: 413 });
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bodyBytes));
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        !object(body) ||
        typeof body.releaseId !== "string" ||
        typeof body.kind !== "string"
      )
        return new Response(null, { status: 400 });
      try {
        const report = await options.registry.recordUpdateHealth({
          appId,
          channel,
          installationId,
          kind: body.kind as MobileUpdateHealthKind,
          ...(body.reason === "boot-interrupted" ||
          body.reason === "boot-timeout"
            ? { reason: body.reason }
            : {}),
          releaseId: body.releaseId,
          runtimeFingerprint,
          token,
          ...(object(body.transfer)
            ? { transfer: body.transfer as MobileUpdateHealthTransfer }
            : {}),
        });

        return Response.json(
          { paused: report.paused },
          { headers: { ...cors, "cache-control": "no-store" }, status: 202 },
        );
      } catch (error) {
        if (error instanceof MobileUpdateRegistryError)
          return new Response(null, { status: 403 });
        throw error;
      }
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (relative === "update.json") {
      const expoProtocolVersion = request.headers.get("expo-protocol-version");
      const expoProtocol = expoProtocolVersion !== null;
      if (expoProtocol && expoProtocolVersion !== "1")
        return Response.json(
          {
            error: `Unsupported Expo Updates protocol version: ${expoProtocolVersion}`,
          },
          { status: 406 },
        );
      const appId = request.headers.get("x-absolute-mobile-app");
      const channel = request.headers.get("x-absolute-mobile-channel");
      const installationId = expoProtocol
        ? (expoExtraParam(request, "absolute-installation") ??
          request.headers.get("x-absolute-mobile-installation"))
        : request.headers.get("x-absolute-mobile-installation");
      const runtimeFingerprint = expoProtocol
        ? request.headers.get("expo-runtime-version")
        : request.headers.get("x-absolute-mobile-runtime");
      if (
        appId !== options.appId ||
        channel !== options.channel ||
        !installationId ||
        !runtimeFingerprint
      )
        return new Response(null, { status: 400 });
      const resolution = options.registry.resolveUpdateState
        ? await options.registry.resolveUpdateState({
            appId,
            channel,
            installationId,
            runtimeFingerprint,
          })
        : undefined;
      const selected = resolution
        ? resolution.status === "selected"
          ? resolution
          : null
        : await options.registry.resolveUpdate({
            appId,
            channel,
            installationId,
            runtimeFingerprint,
          });
      const healthToken =
        selected && options.registry.issueUpdateHealthToken
          ? await options.registry.issueUpdateHealthToken({
              appId,
              channel,
              installationId,
              releaseId: selected.manifest.releaseId,
              runtimeFingerprint,
            })
          : null;
      if (expoProtocol) {
        let requestedCodeSigning: ExpoCodeSigning | undefined;
        try {
          requestedCodeSigning = requestedExpoSignature(
            request,
            expoCodeSigning,
          );
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Expo code-signing negotiation failed",
            },
            { status: expoCodeSigning ? 406 : 400 },
          );
        }
        if (!selected) {
          if (resolution?.status === "incompatible")
            return new Response(null, { status: 204 });
          return expoRollbackResponse(request, requestedCodeSigning);
        }
        const platform = request.headers.get("expo-platform");
        if (platform !== "android" && platform !== "ios")
          return new Response(null, { status: 400 });
        const updateId = expoUpdateId(
          (resolution?.status === "selected"
            ? resolution.activationId
            : undefined) ?? selected.manifest.releaseId,
        );
        if (request.headers.get("expo-current-update-id") === updateId)
          return new Response(null, { status: 204 });
        const descriptorFile = await options.registry.readUpdateFile({
          appId,
          path: EXPO_DESCRIPTOR,
          releaseId: selected.manifest.releaseId,
        });
        if (!descriptorFile) return new Response(null, { status: 409 });
        const descriptor = parseExpoUpdateDescriptor(descriptorFile.bytes);
        const platformUpdate = descriptor.platforms[platform];
        if (!platformUpdate || descriptor.runtimeVersion !== runtimeFingerprint)
          return new Response(null, { status: 204 });
        const origin = new URL(request.url).origin;
        const releaseRoute = `${origin}/${route}/${selected.manifest.releaseId}/files`;
        const protocolAsset = (asset: ExpoUpdateAsset, launch = false) => {
          const file = selected.manifest.files.find(
            (candidate) => candidate.path === asset.path,
          );
          if (!file)
            throw new MobileUpdateRegistryError(
              `Expo update references missing signed asset ${asset.path}`,
            );

          return {
            contentType: expoContentType(asset.extension, launch),
            ...(asset.extension
              ? { fileExtension: `.${asset.extension}` }
              : {}),
            key: file.sha256,
            hash: Buffer.from(file.sha256, "hex").toString("base64url"),
            url: `${releaseRoute}/${encodeUpdatePath(asset.path)}`,
          };
        };
        const manifest = JSON.stringify({
          assets: platformUpdate.assets.map((asset) => protocolAsset(asset)),
          createdAt:
            (resolution?.status === "selected"
              ? resolution.activatedAt
              : undefined) ?? selected.manifest.createdAt,
          extra: {
            absolutejs: {
              channel: selected.manifest.channel,
              ...(healthToken ? { healthToken } : {}),
              releaseId: selected.manifest.releaseId,
            },
            expoClient: descriptor.expoConfig,
          },
          id: updateId,
          launchAsset: protocolAsset(platformUpdate.launchAsset, true),
          metadata: {
            channel: selected.manifest.channel,
            releaseId: selected.manifest.releaseId,
          },
          runtimeVersion: descriptor.runtimeVersion,
        });
        return new Response(manifest, {
          headers: {
            ...expoProtocolHeaders,
            ...(requestedCodeSigning
              ? {
                  "expo-signature": expoSignatureHeader(
                    manifest,
                    requestedCodeSigning,
                  ),
                }
              : {}),
          },
        });
      }
      if (!selected) return new Response(null, { status: 204 });

      return Response.json(selected.manifest, {
        headers: {
          ...cors,
          "cache-control": "no-store",
          etag: `"${selected.manifest.releaseId}"`,
          ...(healthToken
            ? { "x-absolute-mobile-health-token": healthToken }
            : {}),
        },
      });
    }
    const match = /^(amu_[a-f0-9]{64})\/files\/(.+)$/.exec(relative);
    if (!match?.[1] || !match[2]) return new Response(null, { status: 404 });
    const file = await options.registry.readUpdateFile({
      appId: options.appId,
      path: decodeURIComponent(match[2]),
      releaseId: match[1],
    });
    if (!file) return new Response(null, { status: 404 });

    const etag = `"${file.file.sha256}"`;
    const range = request.headers.get("range");
    const useRange =
      range !== null &&
      (!request.headers.has("if-range") ||
        request.headers.get("if-range") === etag);
    let contents = file.bytes;
    let status = 200;
    let contentRange: string | undefined;
    if (useRange) {
      const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = parsed?.[1] === undefined ? NaN : Number(parsed[1]);
      const requestedEnd =
        parsed?.[2] === undefined || parsed[2] === ""
          ? file.bytes.byteLength - 1
          : Number(parsed[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(requestedEnd) ||
        start < 0 ||
        start >= file.bytes.byteLength ||
        requestedEnd < start
      )
        return new Response(null, {
          headers: {
            ...cors,
            "accept-ranges": "bytes",
            "content-range": `bytes */${file.bytes.byteLength}`,
            etag,
          },
          status: 416,
        });
      const end = Math.min(requestedEnd, file.bytes.byteLength - 1);
      contents = file.bytes.slice(start, end + 1);
      status = 206;
      contentRange = `bytes ${start}-${end}/${file.bytes.byteLength}`;
    }

    return new Response(new Blob([new Uint8Array(contents).buffer]), {
      headers: {
        ...cors,
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(contents.byteLength),
        ...(contentRange ? { "content-range": contentRange } : {}),
        "content-type": expoContentType(
          file.file.path.includes(".")
            ? file.file.path.slice(file.file.path.lastIndexOf(".") + 1)
            : undefined,
          false,
        ),
        etag,
      },
      status,
    });
  };
};
